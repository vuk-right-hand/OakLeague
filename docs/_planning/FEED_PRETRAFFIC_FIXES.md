# FEED_PRETRAFFIC_FIXES — retrieval blend · slate diversity · quality decay · live weights

Pre-traffic hardening of the v1 feed algorithm. Four fixes from the 2026-06-12
algo assessment (finding #4 — anon exclusion — was already shipped in
migration 0504-04 + `/api/feed`; verified test `algo_feed_ranked_anon_page_exclude_hook_ids`).

**Branch:** `feat/feed-pretraffic-fixes` off `main` (worktree; deep-brain WIP untouched).
**Status:** BUILT 2026-06-12 (plan v3 after 2 audit rounds; all findings applied).
Migrations 20260613000001-3 + 21 pgTAP tests green + admin weights UI
(/admin/algo/weights). Pre-commit diff audit + full-suite run before merge.

## Audit response index (round 2)

| ID | Finding | Resolution |
|---|---|---|
| C-R2-1 | creator_seq computed before explore-exclusion poisons single-creator inertness trace | §3.2 rewired: diversity CTEs run AFTER the `NOT EXISTS (top_explore)` filter; single-creator monotonicity proof now holds for the dual_score test's exact shape |
| C-R2-2 | top_exploit/exploit_positions chain unverified under re-rank | §3.2 shows the FULL chain. Note: ROW_NUMBER over the penalized key is gapless 1..N by definition — hook_rn/slot_rn join cannot misalign; traced explicitly |
| C-R2-3 | Cast-fidelity across three re-creations of feed_ranked_page | New test `algo_feed_ranked_page_source_hardened_casts.test.sql`: pg_get_functiondef must contain `_jsonb_int`/`_jsonb_real` and must NOT match naked-cast patterns. Runs against final state; A-stage fidelity verified by full-suite run after A |
| M-R2-1 | VALUES-arm Laplace shown with hardcoded numerator | §2.2 formula stated as derived from the row's OWN decayed values; impression-first ⇒ 1/11, open-first ⇒ 2/11 |
| M-R2-2 | Bucket-upsert column list hand-waved | §2.2 full column list: `(hook_id, impressions_top3, impressions_rest)` only — every other column has a NOT NULL DEFAULT; bucket arm placed AFTER the weight-gated arm; bucket DO UPDATE touches only the two bucket columns |
| M-R2-3 | Defaults duplicated helper+seed without guard discipline | §4 seeded-defaults test derives expectations from `_feed_algo_weights_jsonb()` after DELETE — no third hardcoded list |
| M-R2-4 | False rationale for authenticated grant on helper | §1.2 rationale corrected: weights are operational config, intentionally readable; grant is load-bearing because compute_hook_score is INVOKER |
| M-R2-5 | 120–200 divergence window untested by existing suite | Accepted + documented; new 230-hook test is the only >120 coverage |
| M-R2-6 | 230-hook seed vs lesson-cap + verify_hook_topic_slugs | §4 seed spec: 46 videos × 5 hooks, single registered creator_topics slug |
| S-R2-1 | compute_hook_score direct-call test count is 3 not 5 | §1.3 corrected |
| S-R2-2 | explain RPC 8-arg positional call | Verified resolves to 9-arg fn with default; listed in §1.3 |
| S-R2-3 | diversity breakdown only on exploit rows | §4 test asserts exploit rows only |
| S-R2-4 | breakdown shape test is presence-check | Safe; added to known-sensitive list |
| S-R2-5 | decay constant literal typo risk | §2.3 uses `pow(0.5, 1.0/30.0)` inline, never a literal; test asserts to 1e-5 |
| S-R2-6 | anon scorer test role context | §4: called as postgres (service-role-only fn) |

**Invariant for the whole package: zero behavior change at today's data scale.**
Every fix must be provably inert until its threshold (catalog >200 hooks,
≥3 creators, decayed counters diverging, or an admin touching a weight).

---

## Audit response index (round 1)

| ID | Finding | Resolution |
|---|---|---|
| C1 | Invoker helper → `permission denied` on direct authenticated `compute_hook_score` call | §1.2 helper is SECURITY DEFINER owner-postgres; §1.3 hot paths pass weights as 9th arg so the helper is rarely hit; new test calls scorer AS authenticated |
| C2 | Decay trigger editing only DO-UPDATE arm leaves `*_decayed`=0 on first insert → laplace test RED | §2.2 BOTH the INSERT VALUES arm and DO UPDATE arm set decayed cols, slot buckets, and global_quality |
| C3 | Slot buckets gated behind `v_weight > 0` → biased counts | §2.2 buckets move to a separate unconditional upsert (all non-skipped `hook_impression` rows) |
| C4 | `base` CTE aliases hand-waved; DISTINCT ON discipline; `gq` column trace | §3.1 full `cand_*` alias list + `gq`; `DISTINCT ON (cand_hook_id) … ORDER BY cand_hook_id`; gq traced through every `SELECT *` (merged projects explicitly → dropped) |
| M1 | Shared weight keys silently tune auth+anon together | §1.1 anon keys namespaced: `W_GLOBAL_ANON` / `W_RECENCY_ANON` / `W_COLD_ANON`, seeded to today's values |
| M2 | Audit row target_id is uuid; weight key is text | §1.4 `target_id => NULL` explicit; key + old/new inside `before`/`after` jsonb; documents `target_kind='system'` as new value (plain text col, no CHECK — verified) |
| M3 | 400 helper calls/page | §1.3 adopts 9-arg `p_weights jsonb DEFAULT NULL` design NOW (not as fallback); feed RPCs load once per page |
| M4 | avg_completion_pct stays all-time while quality decays | §2.1 explicit decision: all-time by design, comment in migration + CLEANUP_BACKLOG entry |
| M5 | Daily multiply decays just-earned counters | §2.3 documented as discretized exponential decay (≤2.3% bias on <1-day-old counters); applies to ALL rows; no last_event_at gate |
| M6 | Cron-jobs test count | Verified: test filters `jobname IN (...)` — additive job can't break it. New sibling test for the decay job |
| S1 | Missing explicit table REVOKE | §1.1 adds `REVOKE ALL … FROM PUBLIC, anon, authenticated` |
| S2 | hashtextextended signedness | No abs() needed (pure ORDER BY); noted in migration comment |
| S3 | Nested-window pseudo-SQL won't compile | §3.2 shows the real two-CTE form |
| S4 | Server action guard order | §1.5 `assertAdminFromSession()` BEFORE the RPC, mirroring explain-action.ts |
| S5 | "Inert under 200" cross-version diff impossible | §4 replaced with property assertions (membership completeness + single-creator order == score order + step-0 kill switch) |
| S6 | Seeding UPDATE idempotency | One-shot; ADD COLUMN DEFAULT 0 is the re-apply guard. Noted |
| S7 | 0613 vs 0612 numbering | Verified ordered correctly; no action |

---

## 0. Current state (verified)

- Latest `feed_ranked_page` body: [20260504000005_payload_typeof_hardening.sql:485](../../supabase/migrations/20260504000005_payload_typeof_hardening.sql#L485) (structure from 0504-03: dual-score explore/exploit, video-level cooldowns, hardened casts). **All edits base on THIS body.**
- Latest `feed_events_raw_rollup` body: 0504-05:111.
- Latest `compute_hook_score`: 0503-10:47 — INVOKER (not secdef), `GRANT … TO authenticated, service_role` ⇒ directly callable via PostgREST.
- Latest `feed_ranked_anon_page`: 0504-04 (has `p_exclude_hook_ids`).
- `admin_algo_score_explain` (0504-06) calls `compute_hook_score` — no-drift invariant must survive.
- `hook_global_stats` (0503-05): bigint counters, `global_quality` CHECK ≥ 0, no decay, no slot attribution.
- Candidate pool: `ORDER BY h.created_at DESC LIMIT 200` — recency-only retrieval.
- pg_cron pattern: DO/EXCEPTION wrapper, unschedule-then-schedule (20260425000003). pg_cron IS required in test env since 20260504000007.
- `admin_audit_log`: `target_id uuid NULL`, `target_kind text` (no CHECK) — `'system'` + NULL target_id is valid.
- 32 pgTAP files reference the touched functions; full `npm run db:test` is the gate.

---

## 1. Migration A — `20260613000001_feed_algo_weights.sql` (Fix 5)

### 1.1 Table

```sql
CREATE TABLE public.feed_algo_weights (
  weight_key   text PRIMARY KEY,
  weight_value real NOT NULL,
  min_value    real NOT NULL,
  max_value    real NOT NULL,
  description  text NOT NULL,
  updated_by   uuid REFERENCES auth.users(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (weight_value >= min_value AND weight_value <= max_value),
  CHECK (min_value <= max_value)
);
ALTER TABLE public.feed_algo_weights ENABLE ROW LEVEL SECURITY;
-- zero policies (service-role only)
REVOKE ALL ON TABLE public.feed_algo_weights FROM PUBLIC, anon, authenticated;  -- S1
GRANT ALL ON TABLE public.feed_algo_weights TO service_role;                    -- Oct-30 grant rule
```

Seed rows = today's exact constants (scores bit-identical at ship). 11 rows:

| key | value | min | max | consumer |
|---|---|---|---|---|
| W_TOPIC | 1.0 | 0 | 3 | compute_hook_score |
| W_CREATOR | 0.6 | 0 | 3 | compute_hook_score |
| W_RECENCY | 0.3 | 0 | 3 | compute_hook_score |
| W_GLOBAL | 0.4 | 0 | 3 | compute_hook_score |
| W_EXPLORE | 0.8 | 0 | 3 | compute_hook_score |
| W_COLD | 0.5 | 0 | 3 | compute_hook_score |
| W_REPEAT | 0.5 | 0 | 3 | compute_hook_score |
| W_DIVERSITY_STEP | 2.0 | 0 | 10 | feed_ranked_page slate re-rank (Migration C) |
| W_GLOBAL_ANON | 0.4 | 0 | 3 | feed_ranked_anon_page (M1: namespaced) |
| W_RECENCY_ANON | 0.3 | 0 | 3 | feed_ranked_anon_page |
| W_COLD_ANON | 0.5 | 0 | 3 | feed_ranked_anon_page |

### 1.2 Loader helper — SECURITY DEFINER (C1)

```sql
CREATE FUNCTION public._feed_algo_weights_jsonb() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'W_TOPIC',1.0,'W_CREATOR',0.6,'W_RECENCY',0.3,'W_GLOBAL',0.4,
    'W_EXPLORE',0.8,'W_COLD',0.5,'W_REPEAT',0.5,'W_DIVERSITY_STEP',2.0,
    'W_GLOBAL_ANON',0.4,'W_RECENCY_ANON',0.3,'W_COLD_ANON',0.5
  ) || COALESCE(
    (SELECT jsonb_object_agg(weight_key, weight_value) FROM public.feed_algo_weights),
    '{}'::jsonb);
$$;
REVOKE ALL ON FUNCTION public._feed_algo_weights_jsonb() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._feed_algo_weights_jsonb() TO authenticated, service_role;
```

SECURITY DEFINER (owner postgres) so a direct authenticated `compute_hook_score`
call (PostgREST-exposed, INVOKER fn) can still read weights without a table
grant. EXECUTE granted to authenticated deliberately and the grant is
load-bearing (M-R2-4): `compute_hook_score` runs as the caller, so the helper
must be executable by `authenticated`. Weight values are operational config,
not a secret — intentionally readable; the TABLE stays service-role-only for
writes/forensics. Grant-leak rule check: takes no arguments, reads one
service-role table, no caller-supplied tenant id — no cross-tenant surface.
Hardcoded defaults = fallback; empty table ⇒ today's behavior. Defaults live in
exactly ONE place (this helper).

### 1.3 Scorer wiring — 9-arg design (C1 + M3)

`DROP FUNCTION public.compute_hook_score(uuid,uuid,text,text,int,real,real,text[]);`
then CREATE with appended `p_weights jsonb DEFAULT NULL`:

```sql
v_w jsonb := COALESCE(p_weights, public._feed_algo_weights_jsonb());
-- W_TOPIC constant real := 1.0;  →  v_w_topic real := (v_w->>'W_TOPIC')::real;
```

- Existing 8-arg call sites and tests keep working (9th arg defaults).
- Same migration updates BOTH hot callers to load once per page and pass through:
  - `feed_ranked_page`: CREATE OR REPLACE, body verbatim 0504-05:485 except
    `v_weights jsonb := public._feed_algo_weights_jsonb();` in DECLARE and
    passed as 9th arg at both compute call sites (2 reads → 1 read/page).
  - `feed_ranked_anon_page`: CREATE OR REPLACE (same signature/shape), the three
    constants become `(v_weights->>'W_GLOBAL_ANON')::real` etc.
- `admin_algo_score_explain` is NOT touched: its 8-arg call now resolves to the
  9-arg fn with `p_weights=NULL` ⇒ self-loads LIVE weights via the secdef helper
  ⇒ explainer and feed stay weight-consistent. (Verified: explain RPC is
  SECURITY DEFINER anyway.)
- Re-issue REVOKE/GRANT footer for the new signature:
  `REVOKE … FROM PUBLIC; GRANT EXECUTE … TO authenticated, service_role;`
- Blast radius (S-R2-1/S-R2-2): direct callers = `feed_ranked_page` (×2 sites),
  `admin_algo_score_explain` (8 positional args — resolves cleanly to the 9-arg
  fn, p_weights defaults NULL ⇒ self-loads live weights; NO edit needed), and
  3 test files (`agrees_with_feed`, `s_creator_dynamic_ceiling`,
  `no_log_scored_impressions_function`) — all ≤8-arg calls stay valid; verify
  in full-suite run.

### 1.4 Admin RPCs (pattern: `admin_set_profile_tier` guard + audit)

- `admin_list_feed_algo_weights()` → TABLE(weight_key, weight_value, min_value, max_value, description, updated_at). Admin guard (inline canonical predicate incl. `revoked_at IS NULL`), no audit write (read-only).
- `admin_set_feed_algo_weight(p_key text, p_value real)` → void. Admin guard;
  unknown key ⇒ RAISE P0002; NULL/non-finite or out-of-bounds ⇒ RAISE 22023 with
  bounds in message; UPDATE row (sets updated_by/updated_at); audit row:
  `action='feed_algo_weight_set'`, `target_kind='system'`, **`target_id=NULL`** (M2),
  `before=jsonb{key, value:old}`, `after=jsonb{key, value:new}`.
- Both: SECURITY DEFINER, `SET search_path = public, pg_temp`, footer:
  `REVOKE ALL … FROM PUBLIC, anon; GRANT EXECUTE … TO authenticated;` (guard inside).

### 1.5 Admin UI

- `src/app/admin/algo/weights/page.tsx` (server component; `admin_list_feed_algo_weights` via cookie-bound `supabaseServer()` — NOT supabaseAdmin, auth.uid() must resolve).
- `weights-form.tsx` (client) + `set-weight-action.ts`: `'use server'`,
  `assertAdminFromSession()` FIRST, then RPC (S4); error mapping mirrors
  explain-action.ts (42501→auth_required, 22023→bad_value, P0002→not_found).
- Shared-pipeline warning copy next to `*_ANON` rows ("anon feed only") and the
  core rows ("authenticated feed"). Link from `/admin/algo` page.
- No vitest (basic UI + guarded action; DB rules covered by pgTAP).

---

## 2. Migration B — `20260613000002_hook_global_stats_decay.sql` (Fix 3)

### 2.1 Columns

```sql
ALTER TABLE public.hook_global_stats
  ADD COLUMN impressions_decayed real   NOT NULL DEFAULT 0 CHECK (impressions_decayed >= 0),
  ADD COLUMN full_opens_decayed  real   NOT NULL DEFAULT 0 CHECK (full_opens_decayed  >= 0),
  ADD COLUMN mic_taps_decayed    real   NOT NULL DEFAULT 0 CHECK (mic_taps_decayed    >= 0),
  ADD COLUMN impressions_top3    bigint NOT NULL DEFAULT 0 CHECK (impressions_top3    >= 0),
  ADD COLUMN impressions_rest    bigint NOT NULL DEFAULT 0 CHECK (impressions_rest    >= 0);

UPDATE public.hook_global_stats SET
  impressions_decayed = impressions,
  full_opens_decayed  = full_opens,
  mic_taps_decayed    = mic_taps;   -- one-shot continuity; ADD COLUMN DEFAULT 0 guards re-apply (S6)
```

Raw bigint counters stay untouched forever (analytics truth). Decayed shadows
drive `global_quality`. **`avg_completion_pct` stays all-time raw BY DESIGN**
(M4): it's a content-health diagnostic, not a freshness signal — comment in the
migration + CLEANUP_BACKLOG entry ("decide decayed completion when position-bias
correction lands").

### 2.2 Trigger update (CREATE OR REPLACE `feed_events_raw_rollup`, base = 0504-05 body)

Hook-stats arm — **both arms change (C2)**:
- INSERT VALUES arm: decayed cols = same CASE expressions as raw (`::real`);
  `global_quality` = Laplace **derived from this row's OWN values** (M-R2-1):
  `(1 + <this row's full_opens_decayed> + 3*<this row's mic_taps_decayed>) / (10 + <this row's impressions_decayed>)`
  — impression-first event ⇒ 1/11 ≈ 0.0909; open-first ⇒ 2/10 = 0.2. The
  laplace test asserts only the FINAL value (2/11 after impression+open) — green.
  Never a hardcoded numerator.
- DO UPDATE arm: decayed cols `+ EXCLUDED.*_decayed`; `global_quality` recomputed
  from the updated decayed sums (formula unchanged, inputs decayed).

Slot buckets — **separate unconditional upsert (C3)**, placed AFTER the
weight-gated arm (so for the common impression case the weight arm creates the
row with correct global_quality first). Full column list (M-R2-2): only
`(hook_id, impressions_top3, impressions_rest)` — every other column has a
NOT NULL DEFAULT (counters 0, pcts 0, timestamps now()), all CHECKs satisfied;
bucket DO UPDATE touches ONLY the two bucket columns:

```sql
IF NEW.hook_id IS NOT NULL AND NEW.event_name = 'hook_impression' THEN
  INSERT INTO public.hook_global_stats AS g (hook_id, impressions_top3, impressions_rest)
  VALUES (NEW.hook_id,
          CASE WHEN public._jsonb_int(NEW.payload,'served_rank') BETWEEN 0 AND 2 THEN 1 ELSE 0 END,
          CASE WHEN COALESCE(public._jsonb_int(NEW.payload,'served_rank'), 99) BETWEEN 0 AND 2 THEN 0 ELSE 1 END)
  ON CONFLICT (hook_id) DO UPDATE SET impressions_top3 = g.impressions_top3 + EXCLUDED.impressions_top3,
                                      impressions_rest = g.impressions_rest + EXCLUDED.impressions_rest;
END IF;
```

Counts ALL non-skipped impressions (skipped_reason rows still exit at trigger
top — they are debug rows by contract). Malformed/missing served_rank ⇒ rest.
Buckets are logging-only for future position-bias correction; NOT in scoring.
(Bucket-arm-creates-row-first is only reachable if an impression ever carried
weight ≤ 0 — impossible today (0.02); ordering makes it moot anyway since the
weight arm's DO UPDATE always recomputes global_quality.)

### 2.3 Decay function + cron

```sql
CREATE FUNCTION public.hook_global_stats_decay() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.hook_global_stats SET
    impressions_decayed = CASE WHEN impressions_decayed * 0.97716 < 0.01 THEN 0 ELSE impressions_decayed * 0.97716 END,
    full_opens_decayed  = ... same ...,
    mic_taps_decayed    = ... same ...,
    global_quality      = (1 + <decayed_opens'> + 3*<decayed_taps'>) / (10 + <decayed_impr'>),
    updated_at          = now();
$$;
-- footer: REVOKE from PUBLIC, anon, authenticated; service_role only.
```

- Multiplier written as `pow(0.5, 1.0/30.0)` INLINE in the function body
  (S-R2-5 — never a hand-typed literal): 30-day half-life at daily cadence.
  Decay test asserts the multiplied value to 1e-5.
- **Applies to ALL rows; discretized exponential decay** (M5): counters earned
  within the last day take ≤2.3% early decay — documented approximation,
  acceptable v1; no `last_event_at` gate (gating would freeze decay on hot hooks).
- Dust floor 0.01 → 0; `global_quality` → 0.1 prior on dead hooks; all CHECKs satisfied.
- pg_cron: DO/EXCEPTION-wrapped, unschedule-first,
  `cron.schedule('hook_global_stats_decay_daily', '47 3 * * *', $$SELECT public.hook_global_stats_decay()$$)`.
  Existing cron test untouched (filters by jobname — M6 verified); new sibling test added.

---

## 3. Migration C — `20260613000003_feed_ranked_page_retrieval_diversity.sql` (Fixes 1+2)

One CREATE OR REPLACE of `feed_ranked_page` (signature + RETURNS shape unchanged),
body based verbatim on the Migration-A version (= 0504-05 body + v_weights),
two surgical changes:

### 3.1 Retrieval pool blend (Fix 1)

Replace the single candidates CTE with (C4: FULL alias list, explicit DISTINCT ON
discipline):

```sql
base AS (
  SELECT h.id              AS cand_hook_id,
         h.video_id        AS cand_video_id,
         c.id              AS cand_creator_id,
         c.handle::text    AS cand_creator_handle,
         c.display_name    AS cand_creator_name,
         c.avatar_url      AS cand_creator_avatar,
         v.title           AS cand_video_title,
         h.lesson_number   AS cand_lesson_number,
         h.title           AS cand_hook_title,
         h.caption         AS cand_hook_caption,
         h.transcript      AS cand_hook_transcript,
         h.topic_tags      AS cand_topic_tags,
         h.mux_playback_id AS cand_mux_playback_id,
         h.mux_aspect_ratio AS cand_mux_aspect_ratio,
         h.mux_duration_ms AS cand_mux_duration_ms,
         h.duration_seconds AS cand_duration_seconds,
         h.opening_prompt  AS cand_opening_prompt,
         h.question_seeds  AS cand_question_seeds,
         h.created_at      AS cand_hook_created_at,
         (v.long_form_mux_playback_id IS NOT NULL
          AND v.long_form_published_at IS NOT NULL) AS cand_long_form_available,
         COALESCE(hgs.global_quality, 0)            AS cand_pool_gq
    FROM public.hooks_public h
    JOIN public.videos   v ON v.id = h.video_id
    JOIN public.creators c ON c.id = v.creator_id
    LEFT JOIN public.hook_global_stats hgs ON hgs.hook_id = h.id
   WHERE v.published_at IS NOT NULL
     AND c.published_at IS NOT NULL
     AND c.creator_type = 'human'
     AND h.id <> ALL (v_exclude)
     AND NOT EXISTS (SELECT 1 FROM user_cooldowns uc
                      WHERE uc.hook_id = h.id AND uc.available_after > now())
),
pool_quality AS (SELECT * FROM base ORDER BY cand_pool_gq DESC, cand_hook_created_at DESC, cand_hook_id LIMIT 120),
pool_recent  AS (SELECT * FROM base ORDER BY cand_hook_created_at DESC, cand_hook_id LIMIT 50),
pool_random  AS (SELECT * FROM base
                  ORDER BY hashtextextended(cand_hook_id::text || ':' || v_seed::text, 0), cand_hook_id
                  LIMIT 30),  -- signed hash OK: pure ORDER BY, no modulo (S2)
candidates AS (
  SELECT DISTINCT ON (cand_hook_id) *
    FROM (SELECT * FROM pool_quality UNION ALL
          SELECT * FROM pool_recent  UNION ALL
          SELECT * FROM pool_random) u
   ORDER BY cand_hook_id            -- DISTINCT ON discipline; duplicate rows are value-identical
)
```

- Inert today: catalog ≤ 200 ⇒ pool_quality(120)+pool_recent(50)+pool_random(30)
  over the same base… **membership** = base when |base| ≤ 50? NO — see note:
  union of three caps guarantees |candidates| ≥ min(|base|, 120). For full
  membership equality with the old LIMIT 200 the bound is |base| ≤ 120 (quality
  arm alone covers it). Between 120 and 200 the new pool may differ from the
  old recency-200 in composition — BUT both are supersets of every hook that can
  reach a 10-slot page under score ordering? Not provable in general; accepted
  divergence window (120 < catalog < 200) documented. Today's catalog is <30 ⇒
  fully inert. Property tests assert membership at ≤120 (§4).
- Downstream `scored`/`dual_scored` SELECT `c.*`/`s.*` now carry `cand_pool_gq`;
  `merged` projects explicit column lists ⇒ extra column dropped there;
  `top_exploit`/`top_explore` `SELECT *` carry it harmlessly; both `merged`
  UNION ALL arms project explicit identical lists ⇒ no arity break (C4 traced).
- `pool_random` shares `v_seed` ⇒ `algo_scorer_deterministic_same_cursor` green.

### 3.2 Slate diversity (Fix 2) — full rewired chain (C-R2-1 + C-R2-2)

Diversity runs AFTER explore-hook exclusion, so `creator_seq` partitions only
over hooks that remain exploit candidates. Full chain (live names from 0504-05;
`exploit_ranked` keeps its name so downstream reads stay diff-minimal):

```sql
exploit_ranked AS (              -- UNCHANGED from live body: pure score order
  SELECT ds.*,
         ROW_NUMBER() OVER (ORDER BY (ds.bd_exploit->>'score_total')::real DESC NULLS LAST,
                            ds.cand_hook_created_at DESC, ds.cand_hook_id) AS exploit_rn
    FROM dual_scored ds
),
explore_eligible AS ( ... unchanged ... ),
top_explore      AS ( ... unchanged ... ),
exploit_pool AS (                -- explore winners removed FIRST (C-R2-1)
  SELECT er.* FROM exploit_ranked er
   WHERE NOT EXISTS (SELECT 1 FROM top_explore te2 WHERE te2.cand_hook_id = er.cand_hook_id)
),
exploit_seq AS (
  SELECT ep.*,
         ROW_NUMBER() OVER (PARTITION BY ep.cand_creator_id ORDER BY ep.exploit_rn) AS creator_seq
    FROM exploit_pool ep
),
exploit_diversified AS (
  SELECT eq.*,
         ROW_NUMBER() OVER (ORDER BY eq.exploit_rn + v_div_step * (eq.creator_seq - 1),
                            eq.exploit_rn) AS div_rn
    FROM exploit_seq eq
),
top_exploit AS (                 -- was: filter + ORDER BY exploit_rn LIMIT; now div_rn
  SELECT *, ROW_NUMBER() OVER (ORDER BY div_rn) AS hook_rn
    FROM (SELECT * FROM exploit_diversified ORDER BY div_rn LIMIT v_limit) limited
)
-- exploit_positions + merged: UNCHANGED (join on ep.slot_rn = te.hook_rn)
```

- `v_div_step real := COALESCE((v_weights->>'W_DIVERSITY_STEP')::real, 2.0)`.
- **Gaplessness (C-R2-2):** `div_rn` and `hook_rn` are ROW_NUMBER outputs —
  always 1..N with no gaps regardless of penalty values, so the
  `exploit_positions.slot_rn = top_exploit.hook_rn` join can never misalign and
  `top_exploit` still yields exactly `min(v_limit, |exploit_pool|)` rows.
- Single-creator inertness (now valid for the dual_score test's exact shape):
  within `exploit_pool`, one creator ⇒ `creator_seq` == rank-by-exploit_rn ⇒
  div key = `exploit_rn + step·(rank−1)` strictly monotone in exploit_rn ⇒
  `div_rn == ` old ordering. Explore winners were already removed, so their
  former presence cannot perturb the sequence.
- `W_DIVERSITY_STEP=0` ⇒ div key == exploit_rn ⇒ exact pre-change ordering (kill switch).
- Penalty applies BEFORE `LIMIT v_limit` — at scale diversity can change which
  hooks make the page (intended); inert at N=1 creator or step=0.
- `score_breakdown` gains `{'diversity': {'creator_seq': n, 'exploit_rn': m}}`
  spliced in the **exploit `merged` arm only** (S-R2-3); explore rows carry no
  diversity field by design.

### 3.3 Explicitly NOT changing

Cooldown CTEs, explore-slot seeding/positions, hardened casts, limit clamps,
RETURNS shape, grants, anon function (already weights-wired in A).

---

## 4. Tests (pgTAP, TDD: write → red → implement → green)

| File | Asserts |
|---|---|
| `algo_feed_algo_weights_service_role_only.test.sql` | RLS enabled, zero policies, authenticated/anon lack table SELECT/UPDATE (has_table_privilege) |
| `algo_feed_algo_weights_seeded_defaults.test.sql` | 11 rows; capture seeded values, DELETE all rows, assert `_feed_algo_weights_jsonb()` output == captured values (M-R2-3: expectations DERIVED, never a third hardcoded list) |
| `algo_weights_helper_falls_back_when_table_empty.test.sql` | DELETE rows ⇒ helper returns defaults; compute_hook_score score_total unchanged vs seeded |
| `algo_weights_scorer_reads_live_value.test.sql` | UPDATE W_TOPIC 1.0→2.0 ⇒ breakdown `weighted.'W_TOPIC x S_topic'` doubles |
| `algo_weights_scorer_direct_call_as_authenticated.test.sql` | **C1 guard**: tests.set_authenticated → SELECT compute_hook_score(...) 8-arg → returns finite score, no 42501 |
| `algo_weights_anon_scorer_reads_anon_keys.test.sql` | bump W_GLOBAL_ANON ⇒ anon score moves; bump W_GLOBAL ⇒ anon score does NOT move (M1 namespacing proof). Runs as postgres — fn is service-role-only (S-R2-6) |
| `admin_set_feed_algo_weight_guard_and_audit.test.sql` | non-admin 42501; revoked admin 42501; unknown key P0002; out-of-bounds 22023; NULL value 22023; happy path: row updated + audit row (action, target_kind='system', target_id NULL, before/after key+value) |
| `admin_list_feed_algo_weights_admin_only.test.sql` | non-admin 42501; admin gets 11 rows |
| `algo_hook_global_stats_decay_columns_seeded.test.sql` | post-migration decayed == raw for pre-existing rows |
| `algo_rollup_first_insert_sets_decayed.test.sql` | **C2 guard**: brand-new hook, single full_video_open ⇒ decayed cols == raw cols AND global_quality == 2/11 ≈ 0.1818 (laplace parity on INSERT arm) |
| `algo_rollup_increments_decayed_and_slot_buckets.test.sql` | impression served_rank=1 ⇒ top3+1; =5 ⇒ rest+1; missing/string served_rank ⇒ rest; decayed cols track raw on update arm |
| `algo_rollup_slot_buckets_unconditional.test.sql` | **C3 guard**: impression rows bucket regardless of weight-arm behavior; dead-zone/skipped rows do NOT bucket |
| `algo_hook_global_stats_decay_job.test.sql` | seed counters → run fn → decayed × pow(0.5,1/30) asserted to 1e-5 (S-R2-5), raw untouched, global_quality recomputed, dust <0.01→0; fn not executable by authenticated |
| `algo_decay_cron_job_registered.test.sql` | cron.job has 'hook_global_stats_decay_daily', schedule '47 3 * * *', active |
| `algo_retrieval_pool_includes_old_quality_hook.test.sql` | 230 hooks seeded as 46 videos × 5 hooks under ONE registered creator_topics slug (M-R2-6: respects lesson cap + verify_hook_topic_slugs); one old hook with top global_quality ⇒ appears in page-1 (absent under pure recency-200) |
| `algo_retrieval_pool_membership_complete_under_120.test.sql` | **S5 property**: 60 hooks, no cooldowns, limit 50 ⇒ all 50 served are the top-50 by score; every non-cooled hook reachable (pool == base) |
| `algo_diversity_interleaves_two_creators.test.sql` | creator A top-3 scores, B next-3, step=2 ⇒ exact slot order per penalty math |
| `algo_diversity_noop_single_creator.test.sql` | N=1 creator ⇒ slot order == score order (inertness proof) |
| `algo_diversity_step_zero_disables.test.sql` | W_DIVERSITY_STEP=0 ⇒ slot order == score order with 2 creators (kill switch) |
| `algo_diversity_breakdown_field_present.test.sql` | score_breakdown.diversity.creator_seq present on EXPLOIT rows only; absent on explore rows (S-R2-3) |
| `algo_feed_ranked_page_source_hardened_casts.test.sql` | **C-R2-3 guard**: `pg_get_functiondef(feed_ranked_page)` contains `_jsonb_real`+`_jsonb_int`, does NOT match `payload->>''quartile'')::int` nor `payload->>''completion_pct'')::real` (cast-fidelity across re-creations) |

Then FULL `npm run db:test`. Known-sensitive existing tests + expected outcome:
`algo_scorer_compute_hook_score_agrees_with_feed` (green — breakdown rides the row),
`algo_feed_ranked_page_explore_exploit_dual_score` (green — single-creator; C-R2-1
fix makes the monotonicity proof hold post-explore-exclusion),
`algo_scorer_score_breakdown_shape` (green — presence-checks, new key additive — S-R2-4),
`algo_scorer_deterministic_same_cursor` (green — shared v_seed),
`algo_rollup_global_quality_laplace` (green — C2 fix preserves INSERT-arm math),
`algo_feed_ranked_page_regime_a_quality_order` (read seed data first; if it seeds
multiple creators it may interleave now — if RED, the test is stale BY INTENT:
update WITH comment, never paper over),
`algo_retention_cron_jobs_registered` (green — jobname-filtered).

Any other red ⇒ stale-test vs regression decision BEFORE editing (green ≠ correct).

---

## 5. Rollout / risk

- Order: A (weights + 9-arg scorer + both feed RPCs re-wired) → B (decay) → C (pool + diversity). Alphabetical apply order == dependency order. Each migration leaves the system fully consistent (A re-wires every compute_hook_score caller in the same file as the DROP).
- Rollback = re-apply previous bodies (0503-10 scorer / 0504-05 feed page / 0504-04 anon / 0504-05 trigger).
- Prod data writes: only the decayed-seeding UPDATE (idempotent-safe).
- `NOTIFY pgrst, 'reload schema'` at the end of each migration.
- Docs: ALGO_IMPLEMENTATION_PLAN.md §5.3 weight-source note; CLEANUP_BACKLOG entries: position-bias correction (uses impressions_top3/rest), avg_completion_pct decay decision, 120–200 catalog divergence window note.

## 5b. Performance verification (2026-06-12, before prod)

`scripts/feed_ranked_page_bench.sql` — seeds 100→2000 hooks across 5 creators,
times 25 warm `feed_ranked_page(10)` calls per scale under `SET LOCAL ROLE
authenticated` (so the `hooks_public` security_invoker RLS is in the plan,
matching prod). Fresh regime-A caller ⇒ both exploit + explore scoring passes
run per candidate (per-page worst case). Local Docker-on-Windows:

| catalog | avg ms | p95 ms |
|--------:|-------:|-------:|
|     100 |    9.2 |   10.9 |
|     300 |   14.7 |   15.2 |
|     600 |   20.8 |   22.2 |
|    1000 |   31.6 |   32.1 |
|    2000 |   68.4 |   71.9 |

**Sub-linear** (20× catalog → ~7.5× latency): the candidate pool is capped at
~200 before the 2× `compute_hook_score` scoring, so the only catalog-linear
term is the `hooks_public` RLS `EXISTS`-join over the filtered base. At any
near-term v1 catalog (tens of hooks) this is ~9 ms; 2000 hooks is still <75 ms
p95 on slow local hardware (prod is faster). If the catalog ever reaches many
thousands, the lever is a partial/covering index backing the visibility EXISTS
— a future optimization, not a launch gate. Deterministic at-scale correctness
(full distinct page, gapless slots, page-2 fill) is locked by
`algo_feed_ranked_page_scale_500_hooks.test.sql` in the always-run suite.

## 6. Out of scope (unchanged deferrals)

Learned ranker, collaborative filtering, pgvector retrieval, interleaving
harness, cohort funnel dashboard (separate unit), anon cooldowns.
