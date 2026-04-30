# D7_RETENTION_PG_CRON

Daily 90d retention purge for `feed_events_raw` (preserving `mic_tap` forever) + 30d cleanup for `anon_feed_sessions` orphans, scheduled via `pg_cron`. Plan v5 — final pre-implementation, after 4 audit rounds (2 self-spawned auditor + 2 external reviews).

**Status:** ready to implement. v5 closes round-4's three mediums (Supabase JS doesn't surface `RAISE WARNING` so manual-purge wrappers must return jsonb with `hit_cap`; the v4 deploy-checklist instruction for local pg_cron was fabricated — real fix is `CREATE EXTENSION IF NOT EXISTS pg_cron;` at the head of the migration; `target_kind='system'` is a new convention worth documenting) plus all five smalls (positive-grant assertions on wrappers, anon-id breakage scope clarification, profile-cascade GDPR caveat in COMMENT, advisory-lock-vs-cron-BG-worker rationale inline, enum-snapshot recovery menu embedded in the test SQL). The structural choices stayed stable across all four rounds; bugs were entirely in execution details.

---

## 0. Files

**New (apply order = filename order):**
- `supabase/migrations/20260504000007_retention_pg_cron.sql`
- `supabase/tests/algo_retention_*.test.sql` (10 files; §3)

**Edited (companion fix — release blocker, not the migration itself):**
- `src/lib/feed/anon-id.ts` — `readOrMintAnonId` must re-mint when cookied anon_id no longer exists in `anon_feed_sessions`. Without this, a 31d-silent visitor returns with a now-purged anon row → all event emission silently 401s for the rest of their session. See §2.

**Optional UI surface (deferred to D7.5 polish; admin RPC ships in this migration so it's not blocking):**
- A read view of `retention_run_log` somewhere in `/admin` (probably under `/admin/algo` or a new `/admin/ops`). RPC is `admin_retention_recent_runs`; UI can land in a follow-up PR.

---

## 1. Migration `20260504000007_retention_pg_cron.sql`

> **Filename note:** the original outline named this `…06_retention_pg_cron.sql`, which collides with D6 (`20260504000006_admin_algo_inspect_rpcs.sql`). Bumped to `…07`.

Header style matches existing migrations (`-- 0504-07 — retention pg_cron (algo plan §9.7)`). Cite `20260503000002_feed_events_raw.sql:51` (the existing "DELETE is permitted" comment) inline so future reviewers don't ask "wait, isn't this append-only?"

### 1.1 Auto-enable + fail-fast — `CREATE EXTENSION IF NOT EXISTS pg_cron`

**Round-3 C4 + Round-4 M2 fix.** The existing rate-limit cron migration (`20260425000003`) wraps `cron.schedule` in `EXCEPTION WHEN OTHERS THEN RAISE NOTICE`, which means a project without `pg_cron` quietly applies the migration and runs forever with zero retention. For D7 we both auto-enable the extension AND fail-fast — the precondition check catches the case where the Postgres binary doesn't include the extension at all:

```sql
-- Auto-enable. Idempotent on Supabase Cloud (already installed) and on local
-- Supabase Docker (the bundled Postgres image ships pg_cron). Fails loudly on
-- any vanilla Postgres without pg_cron available — which is the correct signal.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Belt-and-suspenders precondition — surfaces a clear error if CREATE EXTENSION
-- silently no-ops in some future Supabase configuration we haven't anticipated.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron required for D7 retention migration; '
      'CREATE EXTENSION above did not register the extension.';
  END IF;
END $$;
```

> **Round-4 M2 note:** v4 deploy-checklist instructed `[db.cron] enabled = true` in `supabase/config.toml`. That section does not exist in the Supabase config schema — the instruction was made up. The actual local-dev pg_cron enablement IS this `CREATE EXTENSION IF NOT EXISTS` statement; the bundled Supabase Postgres Docker image already includes pg_cron, so this works on a clean `supabase db reset` without any config.toml change.

### 1.2 `public.retention_run_log` table — observability

```sql
CREATE TABLE public.retention_run_log (
  id            bigserial   PRIMARY KEY,
  job_name      text        NOT NULL,
  ran_at        timestamptz NOT NULL DEFAULT now(),
  rows_deleted  int         NOT NULL,
  duration_ms   int         NOT NULL,
  batches_run   int         NOT NULL,
  hit_cap       boolean     NOT NULL DEFAULT false
);

CREATE INDEX retention_run_log_job_time_idx
  ON public.retention_run_log (job_name, ran_at DESC);

ALTER TABLE public.retention_run_log ENABLE ROW LEVEL SECURITY;
-- Zero policies: service-role only. Reads go through admin_retention_recent_runs RPC (§1.6).

REVOKE ALL ON public.retention_run_log FROM PUBLIC, anon, authenticated;
```

> **Round-3 C2 note:** v3 carried an `error_msg` column intended for failure markers. Dropped. The EXCEPTION-block INSERT pattern doesn't survive `RAISE` rollback (whole sub-tx unwinds before the re-raise propagates). Failure visibility comes from `cron.job_run_details` + `RAISE WARNING` in the function body — both are protocol-level signals that survive rollback. Keeping the column would be lying about the contract.

> **Self-purge:** intentionally none. ~730 rows/year (2 jobs × daily). No third cron job to clean its own log.

> **Round-4 M3 — `target_kind='system'` convention.** The admin-purge wrappers (§1.5) write `admin_audit_log` rows with `target_kind = 'system'`, a new value. Existing usage in this codebase: `'profile'` (admin_set_profile_tier) and `'session'` (admin_force_close_session). No CHECK constraint exists on `target_kind`, so a typo (`'sytem'`) would land silently. v1 keeps this as a convention-by-comment — a future migration can add an enum or CHECK once the value set stabilizes:
>
> ```sql
> COMMENT ON COLUMN public.admin_audit_log.target_kind IS
>   'Convention: profile | session | system. Used for filtering admin views by '
>   'target type. No CHECK enforced — add one when the set stabilizes.';
> ```
>
> Land this `COMMENT ON COLUMN` in the D7 migration alongside the new `'system'` usage.

### 1.3 `public.purge_feed_events_raw() RETURNS int` — postgres-only raw purge

```sql
CREATE OR REPLACE FUNCTION public.purge_feed_events_raw()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total    int := 0;
  v_n        int;
  v_batches  int := 0;
  v_hit_cap  boolean := false;
  v_started  timestamptz := clock_timestamp();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('purge_feed_events_raw')::bigint);
  -- ↑ Round-3 C2 fix: explicit ::bigint cast. hashtext returns int; without
  --   the cast, overload resolution to pg_advisory_xact_lock(bigint) is
  --   fragile across PG versions.
  --
  -- Round-4 S4: xact-scoped (not session-scoped) is sufficient because pg_cron
  -- runs each scheduled invocation as a fresh BackgroundWorker transaction —
  -- the lock auto-releases at function return and there is no session-state
  -- carry-over between runs. Concurrent firings (e.g., manual admin purge
  -- during a cron run) serialize cleanly on this lock.

  SET LOCAL lock_timeout = '5s';
  SET LOCAL statement_timeout = '30min';
  -- ↑ Round-3 M3 fix: 30min gives 3x headroom over worst-case 100 batches × 6s.
  --   Below the cap math is bounded; above it we WARN and exit cleanly.

  LOOP
    WITH d AS (
      SELECT id
        FROM public.feed_events_raw
       WHERE created_at < now() - interval '90 days'
         AND event_name <> 'mic_tap'
       ORDER BY created_at         -- aligns with feed_events_raw_created_at_idx
       LIMIT 10000
       FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.feed_events_raw f
     USING d
     WHERE f.id = d.id;

    GET DIAGNOSTICS v_n = ROW_COUNT;
    -- ↑ Round-3 C1 fix. ROW_COUNT is not a referencable identifier in plpgsql;
    --   it must be read via GET DIAGNOSTICS into a declared variable.

    EXIT WHEN v_n = 0;
    v_total   := v_total + v_n;
    v_batches := v_batches + 1;

    IF v_batches >= 100 THEN  -- 1M rows / run hard cap
      v_hit_cap := true;
      EXIT;
    END IF;
  END LOOP;

  IF v_hit_cap THEN
    RAISE WARNING 'purge_feed_events_raw hit batch cap (1M rows); backlog remaining';
    -- ↑ Round-3 C3 fix. WARNING is captured by Postgres logs +
    --   cron.job_run_details.return_message; silent log-table inserts are not.
  END IF;

  INSERT INTO public.retention_run_log
    (job_name, rows_deleted, duration_ms, batches_run, hit_cap)
    VALUES ('feed_events_raw_purge',
            v_total,
            (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
            v_batches,
            v_hit_cap);

  RETURN v_total;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'purge_feed_events_raw FAILED after % batches: %', v_batches, SQLERRM;
  -- No log-row write here: it would roll back with the RAISE. Visibility comes
  -- from this WARNING + cron.job_run_details. (Round-3 C2.)
  RAISE;
END;
$$;

ALTER FUNCTION public.purge_feed_events_raw() OWNER TO postgres;

REVOKE EXECUTE ON FUNCTION public.purge_feed_events_raw()
  FROM PUBLIC, anon, authenticated;
-- Round-3 M4 fix: NO grant to service_role. Underlying purge is postgres-only.
-- On-demand admin path goes through admin_purge_feed_events_raw (§1.5), which
-- writes admin_audit_log + checks admin_roles before delegating here.

COMMENT ON FUNCTION public.purge_feed_events_raw() IS
  '90d retention; preserves mic_tap forever at raw level (rollup tables also '
  'retain compressed signal) — for retention only; profile-cascade still '
  'applies, so GDPR profile deletion wipes mic_taps. Single-transaction '
  'batched purge — autovacuum does not interleave; dead tuples reclaim '
  'post-commit. Manual backlog drain: re-invoke until returns 0. NOT '
  'compatible with logical-replication subscribers without slot bookkeeping. '
  'See ALGO_IMPLEMENTATION_PLAN.md §9.7.';
-- ↑ Round-4 S3 fix: "preserves mic_tap forever" was true for retention but
--   could be misread as a durability guarantee. Profile DELETE → CASCADE wipes
--   them (correct GDPR behavior). Half-sentence prevents operator confusion.
```

### 1.4 `public.purge_anon_feed_sessions() RETURNS int` — postgres-only raw purge

**Round-3 C1 fix:** batched identically to `purge_feed_events_raw`. The mint path `src/lib/feed/anon-id.ts:46-50` does `INSERT INTO anon_feed_sessions {}` once per cookieless `/api/feed` request with no per-IP rate limit before the insert. Bot-driven (or accidental) cookie-stripping at scale lands unbounded rows. Single-DELETE was a denial-of-service amplifier waiting to fire.

Same shape as §1.3:
- Distinct advisory lock: `pg_advisory_xact_lock(hashtext('purge_anon_feed_sessions')::bigint)` with the same Round-4 S4 inline comment about pg_cron BG-worker fresh-tx semantics.
- Predicate: `WHERE last_active_at < now() - interval '30 days'`. `last_active_at` is bumped on every event by `ingest_feed_events_anon` (`20260503000000_anon_feed_identity.sql:285`), so engaged anons stay alive; only true 30d-silent rows die.
- Same `ORDER BY last_active_at LIMIT 10000 FOR UPDATE SKIP LOCKED` shape (uses `anon_feed_sessions_last_active_idx`).
- Same 100-batch cap, `RAISE WARNING` on cap-hit, EXCEPTION block with `RAISE WARNING` + re-raise (no rollback-prone INSERT marker), run-log row.

`COMMENT ON FUNCTION` cross-references master plan §9.7 (`anon_gc_deletes_30d_inactive`) and acknowledges the trade-off: a 31d+ silent lurker returning loses pre-signup signal; `merge_anon_feed_state` silently no-ops on missing anon_id (`20260503000000_anon_feed_identity.sql:113-120`). Master plan accepts. Companion frontend fix (§2) prevents user-visible breakage on return. No GDPR caveat needed here — anon rows have no FK back to profiles.

### 1.5 Admin wrappers — `admin_purge_*` SECURITY DEFINER, return `jsonb`

**Round-3 M4 + Round-4 M1 fix.** No naked `GRANT EXECUTE` on destructive primitives to `service_role`. On-demand admin purge goes through guarded wrappers. **Wrappers return `jsonb` carrying both `rows_deleted` and `hit_cap`**, because Supabase JS does not surface PostgreSQL `RAISE WARNING` to the client — an int-only return would hide cap-hit from the operator's click-time UI:

```sql
CREATE OR REPLACE FUNCTION public.admin_purge_feed_events_raw()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_rows     int;
  v_hit_cap  boolean;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_roles
     WHERE user_id = v_admin_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;

  v_rows := public.purge_feed_events_raw();

  -- Round-4 M1: pull hit_cap from the run-log row the inner function just
  -- wrote. Supabase JS can't see RAISE WARNING; the wrapper must materialize
  -- the flag into the return value so the admin UI can render a banner.
  SELECT r.hit_cap INTO v_hit_cap
    FROM public.retention_run_log r
   WHERE r.job_name = 'feed_events_raw_purge'
   ORDER BY r.ran_at DESC
   LIMIT 1;

  INSERT INTO public.admin_audit_log
    (admin_user_id, action, target_kind, target_id, before, after)
    VALUES (v_admin_id, 'admin_purge_feed_events_raw', 'system', NULL, NULL,
            jsonb_build_object('rows_deleted', v_rows, 'hit_cap', v_hit_cap));

  RETURN jsonb_build_object('rows_deleted', v_rows, 'hit_cap', COALESCE(v_hit_cap, false));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_purge_feed_events_raw()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_purge_feed_events_raw() TO authenticated;
-- Body asserts admin_roles before delegating; matches D6 admin_algo_* pattern.
```

Same wrapper shape for `admin_purge_anon_feed_sessions` (jsonb return, jsonb audit `after`, run-log read keyed on `job_name = 'anon_feed_sessions_purge'`).

> Audit-row pattern matches `admin_set_profile_tier` (`20260502000004_admin_audit_and_tier_flip.sql:116`). `admin_audit_log.admin_user_id` is `NOT NULL REFERENCES admin_roles(user_id) ON DELETE RESTRICT` — only real admins can fire this; the cron-triggered raw purge does NOT write to `admin_audit_log` (no admin actor), it writes only to `retention_run_log`. The `target_kind = 'system'` value is documented via `COMMENT ON COLUMN` per §1.2's Round-4 M3 note.

### 1.6 `public.admin_retention_recent_runs(p_limit int)` — read RPC

**Round-3 C3 fix.** With `retention_run_log` RLS-enabled-zero-policies, the table is unreadable from any cookie-bound admin page. Add a SECURITY DEFINER read RPC mirroring D6's admin_algo pattern:

```sql
CREATE OR REPLACE FUNCTION public.admin_retention_recent_runs(p_limit int DEFAULT 50)
RETURNS TABLE(
  id           bigint,
  job_name     text,
  ran_at       timestamptz,
  rows_deleted int,
  duration_ms  int,
  batches_run  int,
  hit_cap      boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE v_admin_id uuid := auth.uid();
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_roles
     WHERE user_id = v_admin_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'p_limit must be 1..500' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT r.id, r.job_name, r.ran_at, r.rows_deleted,
           r.duration_ms, r.batches_run, r.hit_cap
      FROM public.retention_run_log r
     ORDER BY r.ran_at DESC
     LIMIT p_limit;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_retention_recent_runs(int) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.admin_retention_recent_runs(int) TO authenticated;
```

### 1.7 Cron registration — fail-fast `cron.schedule`, idempotent `cron.unschedule`

```sql
-- unschedule wrapped in DO/EXCEPTION so re-running the migration is idempotent
-- when the named jobs already exist or never existed:
DO $guard$
BEGIN
  PERFORM cron.unschedule('feed_events_raw_purge');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'unschedule of feed_events_raw_purge skipped: %', SQLERRM;
END;
$guard$;

DO $guard$
BEGIN
  PERFORM cron.unschedule('anon_feed_sessions_purge');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'unschedule of anon_feed_sessions_purge skipped: %', SQLERRM;
END;
$guard$;

-- schedule is NOT wrapped in EXCEPTION (Round-3 C4): a failure here must be
-- surfaced loudly. The §1.1 precondition already guarantees pg_cron exists.
SELECT cron.schedule(
  'feed_events_raw_purge',
  '0 9 * * *',                              -- 09:00 UTC = 5 AM EST / 1 AM PST
  $job$ SELECT public.purge_feed_events_raw(); $job$
);
SELECT cron.schedule(
  'anon_feed_sessions_purge',
  '0 10 * * *',                             -- 10:00 UTC = 6 AM EST / 2 AM PST
  $job$ SELECT public.purge_anon_feed_sessions(); $job$
);
-- 1h gap is safe even with batched runs hitting 30min statement_timeout.
-- UTC times are intentionally pre-EST-commute for off-peak global behavior.
```

---

## 2. Companion fix — `src/lib/feed/anon-id.ts`

**Release-blocker** (round-3 M5, round-4 S2 scope clarification). Without this, D7's anon-session purge creates a user-visible failure: a 31d-silent visitor returns with a cookie pointing at a now-purged anon_id; events emitted between SSR render and the next client-side GET `/api/feed` 401 silently (the client at `src/lib/feed/client-events.ts:71-74` swallows the error). After the next GET fires, the fix re-mints and subsequent events flow normally — so the impact window is small (one client tick), not the entire session. Still a release-blocker because that one-tick window is exactly when the visitor's first dwell/swipe/tap signal is most valuable for the cold-start scorer.

`feed_ranked_anon_page` already handles the stale anon_id case gracefully — it falls back to global-quality ordering when the row is missing (verified at `20260504000004_feed_ranked_anon_page_long_form_available.sql:62-68`). So the SSR `readAnonId` path stays untouched; only the GET `/api/feed` mint path needs the existence check.

Fix in `readOrMintAnonId`: after reading the cookie, verify the row still exists. If not, drop the cookie and mint fresh. Single round-trip on the cookieful happy path adds one cheap PK lookup; on the orphaned-cookie unhappy path it self-heals.

```typescript
export async function readOrMintAnonId(): Promise<string> {
  const existing = await readAnonId();
  const admin = supabaseAdmin();

  if (existing) {
    const { data: row } = await admin
      .from('anon_feed_sessions')
      .select('anon_id')
      .eq('anon_id', existing)
      .maybeSingle();
    if (row) return existing;
    // Row was purged (D7 retention) or never committed. Fall through to mint.
  }

  const { data, error } = await admin
    .from('anon_feed_sessions')
    .insert({})
    .select('anon_id')
    .single<{ anon_id: string }>();
  // … (existing mint + cookie-set logic unchanged)
}
```

> **Performance note:** the extra PK lookup runs only on cookieful GET `/api/feed` calls (not on every POST events flush). At feed-page-load cadence this is one round-trip per session. Acceptable.

---

## 3. pgTAP tests — 10 files, `algo_retention_*` prefix

| # | File | Asserts |
|---|---|---|
| 1 | `algo_retention_feed_events_raw_purges_old_rows.test.sql` | Insert 91d-old + 89d-old `hook_impression` (skipped_reason='test_fixture' → rollup trigger short-circuits per `feed_events_raw_rollup` line 34). Call `purge_feed_events_raw()`. Assert old gone, new kept, function returns 1, retention_run_log row written with `rows_deleted=1, hit_cap=false`. |
| 2 | `algo_retention_feed_events_raw_preserves_mic_taps.test.sql` | Insert 200d-old `mic_tap` + 200d-old `hook_impression`. Purge. Assert mic_tap survives, impression purged. |
| 3 | `algo_retention_feed_events_raw_preserves_seeded_rollup_row.test.sql` | Real profile + valid topic_slug; INSERT a `user_topic_affinity` row directly; INSERT a feed event with `skipped_reason='test_fixture'` backdated 91d; purge; assert rollup row still present with original values. Comment: "if a future rollup change processes skipped_reason events, rework this test." |
| 4 | `algo_retention_anon_sessions_purges_30d_inactive.test.sql` | Two `anon_feed_sessions` rows with `last_active_at` 31d/29d ago. Call `purge_anon_feed_sessions()`. Assert old purged, new kept. |
| 5 | `algo_retention_purge_functions_grant_matrix.test.sql` | Header cites `admin_algo_rpcs_deny_anon.test.sql`. **Negative** (raw purges, round-3 M4): `has_function_privilege('anon'/'authenticated'/'service_role', oid, 'EXECUTE') = false` for both `purge_feed_events_raw` and `purge_anon_feed_sessions`. **Positive** (admin wrappers + read RPC, round-4 S1 — guards against future REVOKE accidents): `has_function_privilege('authenticated', oid, 'EXECUTE') = true` AND `has_function_privilege('anon', oid, 'EXECUTE') = false` for `admin_purge_feed_events_raw`, `admin_purge_anon_feed_sessions`, and `admin_retention_recent_runs(int)`. Renamed from `…_revoked_from_anon_and_authenticated` to reflect the broader matrix. |
| 6 | `algo_retention_feed_event_name_enum_snapshot.test.sql` | `enum_range(NULL::feed_event_name)` equals exactly `'{hook_impression,hook_dwell_end,hook_swipe,full_video_open,full_video_quartile,creator_carousel_open,creator_carousel_hook_open,mic_tap}'::feed_event_name[]`. **Round-4 S5: failure-recovery menu embedded in the SQL file** so the engineer reading CI output at 11pm has the answer in front of them, not in a doc that may have rotted: <br/>`-- IF THIS FAILS: a new feed_event_name value was added. AUDIT purge_feed_events_raw:` <br/>`--   (a) If the new event IS north-star (deserves forever-retention like mic_tap):` <br/>`--       add it to the predicate: AND event_name NOT IN ('mic_tap', '<new>').` <br/>`--   (b) If the new event is normal-retention: extend the array literal in this` <br/>`--       test to include it, no purge change needed.` |
| 7 | `algo_retention_purge_returns_zero_on_empty_window.test.sql` | Empty matching set; `purge_feed_events_raw()` returns 0; no error; retention_run_log got a row with `rows_deleted=0, hit_cap=false`. |
| 8 | `algo_retention_purge_functions_security_definer.test.sql` | `prosecdef = true` and `proowner IN (SELECT oid FROM pg_roles WHERE rolname IN ('postgres','supabase_admin'))` for both raw purge functions. Comment: "Owner-role divergence between local and hosted Supabase is documented and accepted." |
| 9 | `algo_retention_admin_purge_writes_audit_row_and_returns_jsonb.test.sql` | Authenticated as admin; call `admin_purge_feed_events_raw()`. **Round-4 M1: assert return type is jsonb** with keys `rows_deleted` (numeric) AND `hit_cap` (boolean). Assert exactly one new `admin_audit_log` row with `action='admin_purge_feed_events_raw'`, `admin_user_id=v_admin`, `target_kind='system'`, `after->>'rows_deleted'` numeric, `after->>'hit_cap'` boolean. |
| 10 | `algo_retention_admin_purge_denies_non_admin.test.sql` | Authenticated as non-admin user; call `admin_purge_feed_events_raw()`; assert SQLSTATE `42501`. Same for `admin_purge_anon_feed_sessions` and `admin_retention_recent_runs(50)`. |

> Cron-job-presence test deliberately skipped — local Supabase Docker has no `pg_cron` extension, gating with `pg_extension WHERE extname='pg_cron'` makes the test always-skip locally and a no-op on prod where it's already running. Verifying cron registration is in the deploy checklist (§6) instead.

---

## 4. Audit trail — what each round caught

| Round | Category | Findings | Closed in |
|---|---|---|---|
| Self-spawned auditor #1 | Critical | RLS bypass risk, rollup-trigger test pollution, enum drift, anon 30d trade-off, single unbatched DELETE locks at scale | v2 |
| Self-spawned auditor #2 | Critical | Anon purge IS DoS surface (mint has no per-IP rate limit), `pg_advisory_xact_lock` overload-resolution fragility, 1M-row cap creates invisible backlog, `OWNER TO postgres` may not survive on hosted Supabase | v3 |
| External round-3 | Critical | `EXIT WHEN ROW_COUNT=0` invalid plpgsql, EXCEPTION-block INSERT rolled back by RAISE, run-log invisible to admin UI, `cron.schedule` wrapped in EXCEPTION → silent no-retention | v4 (this doc) |
| External round-3 | Medium | log-drain → Sentry pipeline unverified, index citation missing, 10min timeout undersized for 1M cap path, naked service_role grant on destructive function, anon_session_not_found client handling unverified, missing positive grant test, no backlog-recovery procedure | v4 |
| External round-4 | Medium | Supabase JS doesn't surface `RAISE WARNING` (manual-purge wrapper must return jsonb with `hit_cap`), `[db.cron]` config.toml section was fabricated (real fix: `CREATE EXTENSION IF NOT EXISTS pg_cron` at migration head), `target_kind='system'` convention undocumented | v5 (this doc) |
| External round-4 | Small | positive-grant assertions on wrappers, anon-id breakage scope overstated (one client tick, not whole session), profile-cascade GDPR caveat in COMMENT, advisory-lock-vs-cron-BG-worker rationale inline, enum-snapshot recovery menu in the SQL file (not just the plan doc) | v5 |

The structural choices were stable across all four rounds. Bug surface was entirely in details — exactly the failure mode the round-2 audit warned about ("look for new bugs introduced by round-1's fixes"). Round-4 confirmed advisory-lock semantics under pg_cron's BackgroundWorker (xact-scoped is sufficient; fresh-tx-per-invocation auto-releases) — that uncertainty from §7's hand-off note is now closed.

---

## 5. Open trade-offs — sign off explicitly

1. **1M rows / run hard cap.** At YC steady-state (~100k events/day) cap is never hit. At post-launch viral-spike scale it caps backlog growth at 1M/day. WARNING fires + `hit_cap=true` row written → operator sees it via `admin_retention_recent_runs`. Acceptable for v1?
2. **30d anon cut-off.** Matches master plan §9.7. A 31d-returning lurker loses pre-signup signal. Companion fix (§2) prevents user-visible breakage on return.
3. **Admin wrapper requires authenticated caller.** No service-role direct path. If we ever need a webhook or job runner to fire on-demand purge without a logged-in admin, we add a separate `system_purge_*` function with its own auth scheme. Don't reach for `service_role` GRANT shortcuts.
4. **No retention_run_log self-purge.** ~730 rows/year. Add a comment with manual `DELETE FROM retention_run_log WHERE ran_at < now() - interval '5 years'` snippet for when it ever matters.
5. **Test #3 uses `skipped_reason='test_fixture'` for isolation.** Couples the test to the rollup trigger's short-circuit semantics. If a future migration adds rollup-on-skipped processing, the test must be reworked. Comment notes this.
6. **Local-dev breaks without pg_cron.** Round-3 C4 trade-off: fail-fast in production correctness costs local-dev convenience. Document `supabase/config.toml` enablement instructions in the deploy notes.

---

## 6. Deploy checklist

Before `git push origin main`:

- [ ] All 10 pgTAP tests green on a clean DB (`npm run test:db`).
- [ ] TypeScript clean.
- [ ] `src/lib/feed/anon-id.ts` companion fix lands in the same PR — verify a 31d-stale cookie self-heals via a manual browser test (set `oak_anon_id` cookie value to a random uuid via DevTools, hit `/`, confirm new cookie minted + subsequent `/api/feed/events` POSTs return 200 instead of 401).
- [ ] `npx supabase db reset` from a clean checkout applies all migrations through D7 cleanly. The `CREATE EXTENSION IF NOT EXISTS pg_cron;` at the head of `…07_retention_pg_cron.sql` is what enables local pg_cron — no `config.toml` change needed (round-4 M2 fix; the v4 instruction to set `[db.cron] enabled = true` was made up — that section does not exist in the Supabase config schema).
- [ ] Confirm Supabase project's log-drain (Sentry / Logflare / etc.) captures Postgres `WARNING` level events. If not, document that cron-driven `hit_cap=true` is observable only via `admin_retention_recent_runs(50)` until the pipe is wired. **Manual-purge UX is unaffected** — the wrapper returns `{rows_deleted, hit_cap}` jsonb (round-4 M1), so an admin UI built on the wrapper sees `hit_cap` directly without depending on Postgres logs.

After deploy:

- [ ] Verify both jobs landed: `SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE '%_purge';` should return 3 rows (rate_limit_log_purge, feed_events_raw_purge, anon_feed_sessions_purge), all `active = true`.
- [ ] After first cron firing (next day), verify run-log via the admin RPC: `SELECT * FROM admin_retention_recent_runs(10);` — expect rows for both jobs with `hit_cap = false` at YC scale.
- [ ] If `hit_cap = true` ever appears, run manual drain: `SELECT public.admin_purge_feed_events_raw();` until returns 0 (each call audits to admin_audit_log).

---

## 7. Hand-off note for further review

After 4 rounds the structural design has stabilized. Closed in round 4: advisory-lock semantics under pg_cron's BackgroundWorker (xact-scoped is sufficient — pg_cron runs each invocation as a fresh transaction; lock auto-releases at function return), feed_ranked_anon_page graceful handling of stale anon_id cookies (fallback to global-quality, no crash), and the enum-snapshot test now embeds its own (a)/(b) recovery menu in the SQL file (round-4 S5).

Remaining unknowns worth a final review pass:

1. **Supabase hosted `statement_timeout` ceiling on cron context.** The function does `SET LOCAL statement_timeout = '30min'`, but if Supabase's cron worker sets a session-level cap below 30min, our `SET LOCAL` is bounded by that ceiling. Verify against Supabase's pg_cron config or by observing a real run in a forked project. If the hosted ceiling is lower (e.g., 10min default), our 100-batch cap drops effectively to whatever-fits.
2. **The companion `anon-id.ts` two-step race.** Tab A reads cookie → row exists → returns. Tab B simultaneously reads same cookie → row gone (in-flight purge between A and B) → mints new row → sets cookie. Tab A's events go to the now-orphaned old anon_id until the next page load. Acceptable v1 (rare race, low impact, recovers on next GET), but worth flagging.
3. **Postgres logical-replication subscribers.** Migration comment warns `purge_*` is "NOT compatible with logical-replication subscribers without slot bookkeeping." If we ever turn on logical replication for warehousing, audit this assumption — `FOR UPDATE SKIP LOCKED` interacts in subtle ways with replica WAL streams.
4. **Run-log read scaling.** `admin_retention_recent_runs(p_limit int DEFAULT 50)` is unbounded by date range — fine at ~730 rows/year for the foreseeable, but the query plan should use `retention_run_log_job_time_idx` for the ORDER BY ran_at DESC LIMIT. Verify with EXPLAIN once the table has real rows.
5. **`COMMENT ON COLUMN public.admin_audit_log.target_kind`.** Round-4 M3 doc-only convention. If the value set churns past `'profile' | 'session' | 'system'` in future migrations, escalate to a CHECK constraint or enum.
