# ADMIN_ALGO_INSPECTOR

D6 — `/admin/algo/<userId>` "Why this hook?" debugger. Plan v5 — final pre-implementation, after 3 audit rounds.

**YC demo moment:** open admin page → pick a hook from the user's feed → click Explain → narrative + component breakdown. Duration: < 90 seconds.

**Status:** ready to implement. v3 audit closed C1-C5 + M1/M2/M4/M5/M6 from v2. v4 audit (round 3) found three production-blockers and a handful of mediums; v5 closes them all. The regime-split fabricated in v3 is removed entirely — v1 scorer is regime-agnostic and the explainer must reflect that, not speculate about what the scorer "should" do.

---

## 0. Files

**New (apply order = filename order):**
- `supabase/migrations/20260504000005_payload_typeof_hardening.sql` (helpers + refactor)
- `supabase/migrations/20260504000006_admin_algo_inspect_rpcs.sql` (admin RPCs; depends on helpers above)
- `src/app/admin/algo/page.tsx`
- `src/app/admin/algo/[userId]/page.tsx`
- `src/app/admin/algo/[userId]/loading.tsx`
- `src/app/admin/algo/[userId]/explain-form.tsx`
- `src/app/admin/algo/[userId]/explain-action.ts`
- `supabase/tests/admin_algo_*.test.sql` (~32 files; §4)
- `supabase/tests/payload_hardening_*.test.sql` (5 files; §4)

**Edited:**
- `src/app/admin/layout.tsx` — add "Algo" nav link
- `docs/ALGO_IMPLEMENTATION_PLAN.md` §1049-1106 — patch fictional `metadata` → real audit shape; "Ranked #N" → "Shown in slot #N"; drop the speculated regime-split narrative; drop the standalone `admin_algo_score_explain_narrative` RPC

---

## 1. Migration `20260504000006_admin_algo_inspect_rpcs.sql`

> **Filename ordering note:** in earlier plan drafts, this migration was numbered
> `0504-05` and the hardening sibling was `0504-06`. Supabase applies migrations
> in alphabetical order, but admin RPCs reference `_jsonb_real` / `_jsonb_int`
> helpers introduced in the hardening migration. The numbers were swapped during
> implementation so the dependency chain matches alphabetical apply order:
> `0504-05_payload_typeof_hardening` (helpers + refactor) →
> `0504-06_admin_algo_inspect_rpcs`.

### 1.1 Canonical admin guard (inlined every public RPC)

Match `admin_set_profile_tier` style — no extracted helper, RAISE 42501:

```sql
DECLARE v_admin_id uuid := auth.uid();
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_roles
     WHERE user_id = v_admin_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'admin not authorized' USING ERRCODE = '42501';
  END IF;
```

### 1.2 RPC #1 — `admin_algo_log_inspector_view(p_user_id uuid, p_session_correlation_id uuid) returns void`

The **only** audit-writer for the read-only fan-out. RPC-side debounce: skip insert if a row exists for `(admin_user_id, target_id, action)` in the last 5 seconds.

```sql
-- After admin guard:
IF p_session_correlation_id IS NULL THEN
  RAISE EXCEPTION 'session_correlation_id required' USING ERRCODE = '22023';
END IF;

IF EXISTS (
  SELECT 1 FROM public.admin_audit_log
   WHERE admin_user_id = v_admin_id
     AND target_kind   = 'profile'
     AND target_id     = p_user_id
     AND action IN ('algo_profile_viewed', 'algo_profile_viewed_self')
     AND created_at    > now() - interval '5 seconds'
) THEN
  RETURN;
END IF;

v_action := CASE WHEN v_admin_id = p_user_id
                 THEN 'algo_profile_viewed_self'
                 ELSE 'algo_profile_viewed' END;

INSERT INTO public.admin_audit_log
  (admin_user_id, action, target_kind, target_id, before, after)
VALUES (
  v_admin_id, v_action, 'profile', p_user_id, NULL,
  jsonb_build_object(
    'rpc',                    'admin_algo_log_inspector_view',
    'session_correlation_id', p_session_correlation_id,
    'ts',                     now()
  )
);
```

`p_session_correlation_id` is required and reused by the explain RPC for the same page render — multi-event admin sessions group by `after->>'session_correlation_id'`.

### 1.3 RPC #2 — `admin_algo_user_summary(p_user_id uuid) returns jsonb`

No audit write. Admin guard only.

```jsonc
{
  "profile": { "id", "handle", "display_name", "tier", "timezone",
               "created_at", "interest_slugs", "feed_regime",
               "goals", "obstacles" },
  "engagement_depth": int,
  "events_30d": { "total": int, "by_event": { ... } },
  "user_topic_max": real,
  "user_creator_max": real
}
```

`engagement_depth` — formula matches `ALGO_IMPLEMENTATION_PLAN.md` §1144-1158 exactly:

```sql
SELECT COUNT(*) FROM public.feed_events_raw
 WHERE user_id = p_user_id
   AND skipped_reason IS NULL
   AND (
     (event_name = 'hook_dwell_end'
      AND public._jsonb_real(payload, 'completion_pct') >= 0.8)
     OR event_name = 'full_video_open'
     OR (event_name = 'mic_tap'
         AND payload->>'mic_tap_outcome' = 'session_opened')
   )
```

`_jsonb_real` is the IMMUTABLE helper introduced in `0504-06` (§2). Returns NULL for non-numeric / missing keys; the `>= 0.8` comparison evaluates to NULL → row excluded. No SQLSTATE crash on malformed payload.

`user_topic_max` / `user_creator_max`:
```sql
GREATEST(5.0, COALESCE(MAX(affinity_score), 5.0))::real
```

### 1.4 RPC #3 — `admin_algo_top_topics(p_user_id, p_limit default 5)`

```sql
RETURNS TABLE (topic_slug text, affinity_score real, impressions int, mic_taps int,
               full_opens int, completions int, negatives int,
               last_event_at timestamptz, sign text)
v_limit := GREATEST(1, LEAST(50, p_limit));
sign    := CASE WHEN affinity_score > 0 THEN 'positive'
                WHEN affinity_score < 0 THEN 'negative'
                ELSE 'neutral' END;
affinity_score := round(affinity_score::numeric, 4)::real;  -- float-noise scrub
ORDER BY affinity_score DESC NULLS LAST LIMIT v_limit;
```

### 1.5 RPC #4 — `admin_algo_top_creators(p_user_id, p_limit default 5)`

```sql
RETURNS TABLE (creator_id uuid, handle text, display_name text,
               affinity_score real, impressions int, full_opens int,
               mic_taps int, total_session_seconds int, last_event_at timestamptz)

JOIN public.creators c ON c.id = uca.creator_id
WHERE c.creator_type = 'human'
  AND c.published_at IS NOT NULL
```

(C1 from round 1: `creators.deleted_at` does not exist; use `published_at IS NOT NULL` instead. Round-3 audit small: `v.published_at` symmetry — `creators` is the right table here, no `videos` join needed.)

`v_limit` clamped 1..50 same way.

### 1.6 RPC #5 — `admin_algo_funnel_7d(p_user_id) returns jsonb`

```jsonc
{
  "window_days": 7,
  "impressions": n, "dwell_ge_80": n, "full_video_open": n,
  "mic_tap": n, "session_opened": n,
  "rates": {
    "impression_to_dwell80": 0.xx | null,
    "dwell80_to_full_open":  0.xx | null,
    "full_open_to_mic_tap":  0.xx | null,
    "mic_tap_to_session":    0.xx | null,
    "impression_to_session": 0.xx | null
  }
}
```

Each step counts distinct `(user_id, hook_id)` pairs except `session_opened` which counts events with `payload->>'mic_tap_outcome'='session_opened'`. Dwell filter uses `_jsonb_real(payload, 'completion_pct') >= 0.8`. `NULLIF(denom, 0)` on every rate. Rates rounded to 4 decimals.

7d (not 30d): the `payload->'completion_pct'` extract is unindexed; 7d window keeps the scan cheap. v1.1 can add a partial expression index and widen the window when data volume justifies it.

### 1.7 RPC #6 — `admin_algo_recent_events(p_user_id, p_limit default 50)`

```sql
RETURNS TABLE (id bigint, created_at timestamptz, event_name feed_event_name,
               hook_id uuid, video_id uuid, creator_id uuid, session_id uuid,
               payload_safe jsonb, skipped_reason text)
ORDER BY created_at DESC LIMIT v_limit;
v_limit := GREATEST(1, LEAST(200, p_limit));
```

`payload_safe` is a whitelist projection. Numeric keys via `->` (preserves jsonb number type); string keys via `->>`. Type guards via `jsonb_typeof = 'number'` so a malformed-but-stored payload doesn't poison the result row:

```sql
jsonb_strip_nulls(jsonb_build_object(
  'completion_pct',
    CASE WHEN jsonb_typeof(payload->'completion_pct') = 'number'
         THEN payload->'completion_pct' END,
  'quartile',
    CASE WHEN jsonb_typeof(payload->'quartile') = 'number'
         THEN payload->'quartile' END,
  'served_rank',
    CASE WHEN jsonb_typeof(payload->'served_rank') = 'number'
         THEN payload->'served_rank' END,
  'lesson_number',
    CASE WHEN jsonb_typeof(payload->'lesson_number') = 'number'
         THEN payload->'lesson_number' END,
  'seconds_to_decision_ms',
    CASE WHEN jsonb_typeof(payload->'seconds_to_decision_ms') = 'number'
         THEN payload->'seconds_to_decision_ms' END,
  'mic_tap_outcome', payload->>'mic_tap_outcome',
  'direction',       payload->>'direction',
  'source',          payload->>'source'
)) AS payload_safe
```

`seconds_to_decision_ms` verified emitted by [feed-container.tsx:120](../../src/app/(feed)/feed-container.tsx#L120) and [video-row.tsx:50](../../src/app/(feed)/video-row.tsx#L50) — keep in whitelist.

### 1.8 RPC #7 — `admin_algo_score_explain(p_user_id uuid, p_hook_id uuid, p_session_correlation_id uuid) returns jsonb`

The headline RPC. **Single path. No regime branching** — round-3 audit C1 confirmed the v1 scorer is regime-agnostic. `p_regime` in [`compute_hook_score`](../../supabase/migrations/20260503000010_feed_ranked_page_rpc.sql#L51) is parameter-only and echoed into the return jsonb at line 187, never branched on. Speculating about regime-specific narratives in v3/v4 was a fabrication; v5 always computes.

#### 1.8.1 Audit row pattern

**Single audit row, INSERT after compute completes.** Matches `admin_set_profile_tier` style ([20260502000004:115](../../supabase/migrations/20260502000004_admin_audit_and_tier_flip.sql#L115)). Append-only contract honored. `RAISE 'hook_not_found'` on bad hook rolls back the function — no audit fingerprint for unknown-hook probes. This is the codebase's established pattern for failed admin actions; if forensic visibility into probes becomes a future requirement, a separate access-log table with autonomous-transaction writes (dblink) is the right v2 home.

#### 1.8.2 Slot field

Single field: `display_slot_one_indexed` (= `served_slot_zero_persisted + 1`, NULL if no impression). The 0-indexed raw value is dropped from the envelope per round-3 audit medium (cognitive overhead > zero-cost). The conversion is documented in the function header and the `notes.served_slot_meaning` field.

#### 1.8.3 Streak reconstruction (M-NEW4)

Match `feed_ranked_page` exactly — `array_agg ORDER BY` inside a `LIMIT 20` subquery (not bare `ARRAY(SELECT ...)` — order is undefined across planners):

```sql
SELECT v.creator_id INTO v_hook_creator_id
  FROM public.hooks h JOIN public.videos v ON v.id = h.video_id
 WHERE h.id = p_hook_id;

IF v_hook_creator_id IS NULL THEN
  RAISE EXCEPTION 'hook_not_found' USING ERRCODE = 'P0002';
END IF;

SELECT COALESCE(array_agg(creator_id ORDER BY created_at DESC), '{}'::uuid[])
  INTO v_last_creators
  FROM (
    SELECT creator_id, created_at
      FROM public.feed_events_raw
     WHERE user_id     = p_user_id
       AND event_name  = 'hook_impression'
       AND creator_id IS NOT NULL
       AND created_at  > now() - interval '10 minutes'
     ORDER BY created_at DESC
     LIMIT 20
  ) recent;

v_streak := public._consecutive_streak_from_tail(v_last_creators, v_hook_creator_id);
```

#### 1.8.4 Body

```sql
-- After admin guard:
IF p_session_correlation_id IS NULL THEN
  RAISE EXCEPTION 'session_correlation_id required' USING ERRCODE = '22023';
END IF;

-- Most recent impression (slot + timestamp).
SELECT (payload->>'served_rank')::int, created_at
  INTO v_served_slot_zero, v_served_at
  FROM public.feed_events_raw
 WHERE user_id = p_user_id AND hook_id = p_hook_id
   AND event_name = 'hook_impression'
   AND jsonb_typeof(payload->'served_rank') = 'number'
 ORDER BY created_at DESC LIMIT 1;

-- Hook + creator (RAISE if hook missing — codebase pattern).
SELECT v.creator_id INTO v_hook_creator_id
  FROM public.hooks h JOIN public.videos v ON v.id = h.video_id
 WHERE h.id = p_hook_id;
IF v_hook_creator_id IS NULL THEN
  RAISE EXCEPTION 'hook_not_found' USING ERRCODE = 'P0002';
END IF;

-- Streak (matches feed_ranked_page array_agg ORDER BY pattern; round-3 medium).
SELECT COALESCE(array_agg(creator_id ORDER BY created_at DESC), '{}'::uuid[])
  INTO v_last_creators
  FROM ( SELECT creator_id, created_at FROM public.feed_events_raw
          WHERE user_id = p_user_id AND event_name = 'hook_impression'
            AND creator_id IS NOT NULL AND created_at > now() - interval '10 minutes'
          ORDER BY created_at DESC LIMIT 20 ) recent;
v_streak := public._consecutive_streak_from_tail(v_last_creators, v_hook_creator_id);

-- Dynamic maxes match scorer.
SELECT GREATEST(5.0, COALESCE(MAX(affinity_score), 5.0))::real
  INTO v_user_topic_max FROM public.user_topic_affinity   WHERE user_id = p_user_id;
SELECT GREATEST(5.0, COALESCE(MAX(affinity_score), 5.0))::real
  INTO v_user_creator_max FROM public.user_creator_affinity WHERE user_id = p_user_id;

SELECT interest_slugs, feed_regime::text INTO v_interest_slugs, v_regime_current
  FROM public.profiles WHERE id = p_user_id;

-- Compute (regime echoed only; scorer is regime-agnostic in v1).
SELECT public.compute_hook_score(
  p_user_id, p_hook_id, 'exploit', 'C',
  v_streak,
  v_user_topic_max, v_user_creator_max,
  v_interest_slugs
) INTO v_breakdown;

-- compute_hook_score returns {error: ...} for some shapes; treat as not-found.
IF v_breakdown ? 'error' THEN
  RAISE EXCEPTION 'hook_not_found' USING ERRCODE = 'P0002';
END IF;

v_narrative := public._admin_algo_narrative_from_breakdown(
                 v_breakdown, v_served_slot_zero, v_streak, v_regime_current);

v_action := CASE WHEN v_admin_id = p_user_id
                 THEN 'algo_score_explained_self'
                 ELSE 'algo_score_explained' END;

INSERT INTO public.admin_audit_log
  (admin_user_id, action, target_kind, target_id, before, after)
VALUES (
  v_admin_id, v_action, 'profile', p_user_id, NULL,
  jsonb_build_object(
    'rpc',                    'admin_algo_score_explain',
    'hook_id',                p_hook_id,
    'session_correlation_id', p_session_correlation_id,
    'ts',                     now()
  )
);

RETURN jsonb_build_object(
  'breakdown',                  v_breakdown,
  'narrative',                  v_narrative,
  'display_slot_one_indexed',
    CASE WHEN v_served_slot_zero IS NULL THEN NULL ELSE v_served_slot_zero + 1 END,
  'served_at_last_impression',  v_served_at,
  'reconstructed_creator_streak', v_streak,
  'regime_label',               v_regime_current,
  'notes', jsonb_build_object(
    'scorer_regime_agnostic_v1',
      'profiles.feed_regime is a label only; v1 scorer is regime-agnostic. '
      'When v2 introduces regime-specific scoring, this explainer extends.',
    'streak_window',
      'last 20 impressions in past 10 minutes',
    'served_slot_meaning',
      'display_slot_one_indexed = persisted slot_idx + 1; 1 = top of feed page'
  )
);
```

### 1.9 Private helper `_admin_algo_narrative_from_breakdown(p_breakdown jsonb, p_served_slot_zero int, p_streak int, p_regime_label text) returns text`

```sql
LANGUAGE sql IMMUTABLE      -- pure jsonb→text formatting; no DB reads
```
- Service-role only grant (revoked from public, anon, authenticated).
- Lead clause:
  - `p_served_slot_zero IS NULL` → `'Hook not yet served to this user — '`
  - else → `format('Shown in slot #%s — ', (p_served_slot_zero + 1)::text)`
- Topic / creator / recency clauses: copied from `ALGO_IMPLEMENTATION_PLAN.md` §1083-1103.
- Empty-state: if `S_topic ≤ 0.05 AND S_creator ≤ 0.05` → "score driven by global quality + recency only — no affinity history yet."
- Streak penalty: if `p_streak >= 2` → append `format(' Repeat-creator penalty applied (streak %s).', p_streak)`.
- Regime tail: if `p_regime_label IN ('A','B')` → append `format(' (Profile regime: %s — informational; v1 scorer treats all regimes identically.)', p_regime_label)`.

### 1.10 Grants & search_path

Every public RPC:
```sql
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
REVOKE ALL    ON FUNCTION public.admin_algo_<name>(...) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_algo_<name>(...) TO authenticated;
```
Helper: `REVOKE ALL ... FROM public, anon, authenticated` — service_role only (executed via SECURITY DEFINER ownership).

---

## 2. Migration `20260504000005_payload_typeof_hardening.sql`

> Lower-numbered than §1 because it introduces helpers that §1 depends on.
> See the filename-ordering note in §1.

Closes the wider naked-cast attack surface across live algo paths. A single malformed payload (buggy client, future shape rev, attacker probing `ingest_feed_events`) currently can:
- crash the rollup trigger → cascading 50-event batch INSERT failure
- crash `feed_ranked_page` cooldown CTE → the inspector tool would render cleanly while the user's feed itself errors out

### 2.1 Two IMMUTABLE jsonb-cast helpers (refactor approach, not copy-paste)

Round-3 audit medium: "copy bodies verbatim is a maintenance bomb." Introduce two helpers; refactor cast sites to call them.

```sql
CREATE OR REPLACE FUNCTION public._jsonb_int(p jsonb, p_key text) RETURNS int
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(p->p_key) = 'number'
              THEN (p->>p_key)::int END;
$$;

CREATE OR REPLACE FUNCTION public._jsonb_real(p jsonb, p_key text) RETURNS real
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(p->p_key) = 'number'
              THEN (p->>p_key)::real END;
$$;

REVOKE ALL ON FUNCTION public._jsonb_int(jsonb, text)  FROM public;
REVOKE ALL ON FUNCTION public._jsonb_real(jsonb, text) FROM public;
GRANT EXECUTE ON FUNCTION public._jsonb_int(jsonb, text)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._jsonb_real(jsonb, text) TO authenticated, service_role;
```

Both return `NULL` on missing key OR non-number JSON value. Comparisons against NULL (e.g., `_jsonb_real(p, 'completion_pct') >= 0.8`) evaluate to NULL → row excluded by WHERE/CASE. No SQLSTATE crash.

### 2.2 Sites refactored

Each affected function is `CREATE OR REPLACE`d in this migration with the cast sites swapped to helper calls. Function bodies otherwise untouched.

| File | Lines | Field | Helper |
|---|---|---|---|
| `20260503000006_feed_events_rollup_trigger.sql` | 50 | `completion_pct` | `_jsonb_real` |
| `20260503000007_ingest_feed_events_rpc.sql` | **103** | `seconds_to_decision_ms` | `_jsonb_int` |
| `20260503000015_d4_anon_ingest_rate_limit.sql` | **72** | `seconds_to_decision_ms` | `_jsonb_int` |
| `20260504000003_feed_ranked_page_video_level_cooldown.sql` | 142, 145 | `completion_pct` | `_jsonb_real` |
| `20260504000003_feed_ranked_page_video_level_cooldown.sql` | 167, 170, 181 | `quartile` | `_jsonb_int` |

The two **bold** entries (`0007:103`, `0015:72`) are the round-3 critical 3 additions — both are inside `ingest_feed_events` and `ingest_feed_events_anon` SECURITY DEFINER bodies and a single bad value crashes the entire 50-event batch.

`0015:85` is `(v_evt->>'hook_id')::uuid` — already inside `EXCEPTION WHEN invalid_text_representation` block; not in scope. `0015:96, 0015:107` are reads from `anon_feed_sessions` (service-role-managed table); lower risk surface but still hardened in the same pass for consistency.

The other audit-cited lines (`d2_audit_cleanup:93`, `anon_feed_identity:60/66/71`, `d5_h1_swipe_up_neutral:29/36/41`) are verified and hardened in the same migration.

### 2.3 Migration header documents

```sql
-- Hardens every naked (payload->>'X')::cast across the live algo path so a
-- single malformed payload cannot crash the rollup trigger, the cooldown CTE,
-- or the SECURITY DEFINER ingest RPCs.
--
-- Pattern: replace (p->>'k')::int   with public._jsonb_int(p, 'k')
--                  (p->>'k')::real  with public._jsonb_real(p, 'k')
-- Helpers return NULL on non-numeric / missing values; comparisons against
-- NULL evaluate to NULL → row excluded. No SQLSTATE crash.
--
-- Function bodies are otherwise verbatim copies of the latest CREATE OR
-- REPLACE for each function. Side-by-side diff is the audit trail.
```

---

## 3. Admin UI

### 3.1 `src/app/admin/algo/page.tsx`

User search. Mirrors `src/app/admin/users/page.tsx` shape (sanitized search, link-out to `/admin/algo/<id>`).

### 3.2 `src/app/admin/algo/[userId]/page.tsx` (server component)

```tsx
import { randomUUID } from 'crypto';
export const dynamic = 'force-dynamic';

const sessionCorrelationId = randomUUID();   // multi-event session group key

const sb = await supabaseServer();
const [, summary, topics, creators, funnel, events] = await Promise.all([
  sb.rpc('admin_algo_log_inspector_view',
         { p_user_id, p_session_correlation_id: sessionCorrelationId }),
  sb.rpc('admin_algo_user_summary',  { p_user_id }),
  sb.rpc('admin_algo_top_topics',    { p_user_id, p_limit: 5 }),
  sb.rpc('admin_algo_top_creators',  { p_user_id, p_limit: 5 }),
  sb.rpc('admin_algo_funnel_7d',     { p_user_id }),
  sb.rpc('admin_algo_recent_events', { p_user_id, p_limit: 50 }),
]);

return <ExplainForm
  pUserId={p_user_id}
  sessionCorrelationId={sessionCorrelationId}
  summary={summary.data}
  topics={topics.data}
  creators={creators.data}
  funnel={funnel.data}
  events={events.data}
/>;
```

Layout matches `ALGO_IMPLEMENTATION_PLAN.md` §7.1 ASCII diagram: header, top topics + creators (2 cols), 7-day funnel bar, "Why this hook?" form, recent events table.

### 3.3 `src/app/admin/algo/[userId]/loading.tsx`

Bare skeleton matching the page layout.

### 3.4 `src/app/admin/algo/[userId]/explain-form.tsx`

```ts
'use server';

import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseServer } from '@/lib/supabase/server';

const HOOK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function explainHook(
  pUserId: string, pHookId: string, pSessionCorrelationId: string,
) {
  try { await assertAdminFromSession(); }
  catch (e) {
    if (e instanceof AuthGuardError) return { error: 'auth_required' };
    throw e;
  }

  if (!HOOK_ID_RE.test(pHookId)) {
    return { error: 'bad_hook_id', message: 'Invalid hook ID format. Expected UUID.' };
  }

  // CRITICAL: cookie-bound supabaseServer(), NOT supabaseAdmin().
  // supabaseAdmin() → auth.uid() returns NULL → admin guard fails 42501.
  const sb = await supabaseServer();
  const { data, error } = await sb.rpc('admin_algo_score_explain', {
    p_user_id:                pUserId,
    p_hook_id:                pHookId,
    p_session_correlation_id: pSessionCorrelationId,
  });

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') return { error: 'auth_required' };
    if (code === '22P02') return { error: 'bad_hook_id', message: 'Invalid hook ID format.' };
    if (code === 'P0002') return { error: 'not_found',   message: 'Hook not found in catalog.' };
    return { error: 'internal' };
  }
  return { data };
}
```

Render rules:
- Slot displayed as `display_slot_one_indexed` (1-indexed) everywhere.
- Streak badge if `reconstructed_creator_streak >= 2`.
- Regime label rendered as a neutral pill ("Profile regime: A · scorer is regime-agnostic in v1") — informational, not a warning.
- No "breakdown skipped" UI branch — single path always renders the table.

### 3.5 Admin nav

Add `<a href="/admin/algo">Algo</a>` to `src/app/admin/layout.tsx`.

---

## 4. pgTAP tests

All tests use `tests.create_auth_user`, `tests.set_authenticated`, `tests.reset_role` (pattern: `admin_set_user_voice_caps.test.sql`).

### 4.1 RPC behavior — admin guards & audit (8 files)

| File | Asserts |
|---|---|
| `admin_algo_rpcs_deny_non_admin.test.sql` | All 7 RPCs → 42501 for non-admin authenticated |
| `admin_algo_rpcs_deny_revoked_admin.test.sql` | revoked_at = now() → 42501 (C3 of original spec) |
| `admin_algo_rpcs_deny_anon.test.sql` | `SET ROLE anon` → 42501 / no-grant |
| `admin_algo_log_inspector_view_writes_one_audit_row.test.sql` | Single row, action='algo_profile_viewed', after has session_correlation_id |
| `admin_algo_log_inspector_view_self_uses_self_action.test.sql` | p_user_id == admin_id → action='algo_profile_viewed_self' |
| `admin_algo_log_inspector_view_debounce_blocks_second_call_within_5s.test.sql` | (renamed from "concurrency") two calls within 5s → 1 audit row, not 2 |
| `admin_algo_log_inspector_view_debounce_window_releases.test.sql` | After 6s → next call writes a new row |
| `admin_algo_log_inspector_view_rejects_null_correlation_id.test.sql` | NULL correlation_id → 22023 |

### 4.2 Read RPCs — no audit, no crash, correct shape (10 files)

| File | Asserts |
|---|---|
| `admin_algo_read_rpcs_do_not_audit.test.sql` | All 5 read RPCs write 0 audit rows; only `log_inspector_view` does |
| `admin_algo_user_summary_engagement_depth_matches_c5.test.sql` | One of each qualifying + skipped event; depth matches §1144-1158 |
| `admin_algo_user_summary_handles_zero_affinity.test.sql` | Fresh user → topic_max=5.0, no errors |
| `admin_algo_top_topics_returns_signed_rows.test.sql` | Negative affinity → sign='negative' |
| `admin_algo_top_topics_clamps_limit.test.sql` | p_limit=10000 → 50; p_limit=-1 → 1 |
| `admin_algo_top_creators_filters_human_only.test.sql` | brand-type creator excluded |
| `admin_algo_top_creators_filters_unpublished.test.sql` | `published_at IS NULL` creator excluded |
| `admin_algo_funnel_7d_distinct_hook_counts.test.sql` | 2 impressions same hook → impressions=1 |
| `admin_algo_funnel_7d_handles_malformed_completion_pct.test.sql` | Payload with string completion_pct → no crash, dwell_ge_80=0 |
| `admin_algo_funnel_7d_window_excludes_8d_old.test.sql` | 8d-old event excluded |

### 4.3 Recent events — payload redaction & types (3 files)

| File | Asserts |
|---|---|
| `admin_algo_recent_events_clamps_limit.test.sql` | p_limit=10000 → 200; p_limit=-5 → 1 |
| `admin_algo_recent_events_redacts_payload.test.sql` | Non-whitelisted key absent from payload_safe |
| `admin_algo_recent_events_preserves_numeric_types.test.sql` | completion_pct in payload_safe is jsonb number, not string |

### 4.4 score_explain — single-path correctness (12 files)

| File | Asserts |
|---|---|
| `admin_algo_score_explain_returns_breakdown_and_narrative.test.sql` | regime=C user; envelope keys present; finite score_total |
| `admin_algo_score_explain_works_for_regime_a.test.sql` | (round-3 critical 1) regime=A user → SAME breakdown as regime=C user with identical affinity; no skip |
| `admin_algo_score_explain_works_for_regime_b.test.sql` | regime=B user → same; narrative includes regime-label note |
| `admin_algo_score_explain_uses_target_user_affinity.test.sql` | Admin A inspects target B; B's affinity drives S_topic, not A's |
| `admin_algo_score_explain_uses_dynamic_maxes.test.sql` | topic_max=8.0 used, not 5.0 |
| `admin_algo_score_explain_self_uses_self_action.test.sql` | p_user_id == admin → action='algo_score_explained_self' |
| `admin_algo_score_explain_one_audit_row.test.sql` | Single call → 1 audit row |
| `admin_algo_score_explain_slot_one_indexed.test.sql` | served_rank=0 in payload → narrative says "slot #1"; envelope has display_slot_one_indexed=1 |
| `admin_algo_score_explain_no_zero_indexed_field.test.sql` | Envelope does NOT contain `served_slot_zero_indexed` (round-3 medium: kill the dual-field) |
| `admin_algo_score_explain_unknown_hook_raises_p0002.test.sql` | Bad hook_id → SQLSTATE P0002 (matches `admin_set_profile_tier` style) |
| `admin_algo_score_explain_session_correlation_id_persisted.test.sql` | Audit row's `after->>'session_correlation_id'` matches input |
| `admin_algo_score_explain_rejects_null_correlation_id.test.sql` | NULL → 22023 |

### 4.5 Streak reconstruction (3 files)

| File | Asserts |
|---|---|
| `admin_algo_score_explain_streak_reconstructed.test.sql` | Seed 3 consecutive same-creator impressions in last 10 min → `reconstructed_creator_streak >= 2`; breakdown's `- W_REPEAT × P_repeat` term reflects penalty |
| `admin_algo_score_explain_streak_zero_for_new_user.test.sql` | No prior impressions → `reconstructed_creator_streak=0` |
| `admin_algo_score_explain_streak_resets_on_different_creator.test.sql` | Interleaved different creator → streak ≤ 1 |

### 4.6 Hardening migration (5 files)

| File | Asserts |
|---|---|
| `payload_hardening_jsonb_int_helper_returns_null_for_string.test.sql` | `_jsonb_int(jsonb, text)` on string value → NULL, not crash |
| `payload_hardening_jsonb_real_helper_returns_null_for_string.test.sql` | `_jsonb_real(jsonb, text)` on string value → NULL, not crash |
| `payload_hardening_cooldown_cte_handles_string_completion_pct.test.sql` | feed_ranked_page with malformed event in user's history → no SQLSTATE error |
| `payload_hardening_rollup_trigger_handles_string_completion_pct.test.sql` | Direct service-role INSERT with malformed payload → trigger does not raise |
| `payload_hardening_ingest_feed_events_handles_string_seconds.test.sql` | (round-3 critical 3) ingest_feed_events with hook_swipe payload `seconds_to_decision_ms: "500"` → 50-event batch does not crash; that single event's dead-zone check evaluates to NULL → not flagged |

### 4.7 Function-owner check (1 file)

| File | Asserts |
|---|---|
| `admin_algo_functions_owned_by_rls_bypassing_role.test.sql` | For every `admin_algo_*` function and `_admin_algo_narrative_from_breakdown`: `prosecdef = true AND proowner::regrole NOT IN ('authenticated', 'anon')`. Round-3 small: environment-portable check; replaces the manual `pg_proc.proowner` deploy-checklist step from v4 |

**Total: ~32 files admin_algo + 5 files payload_hardening = ~37 tests.** No cuts.

---

## 5. Pre-deploy verification

The function-owner check (§4.7) replaces the manual deploy-step from v4. Greenlight = all tests pass.

If the production deploy uses a different role than staging, re-verify before merge:
```sql
SELECT proname, prosecdef, proowner::regrole::text AS owner
  FROM pg_proc
 WHERE proname LIKE 'admin_algo_%' OR proname = '_admin_algo_narrative_from_breakdown';
```
Expected: every row has `prosecdef = true` and `owner` is a role with implicit RLS bypass (typically `postgres` or `supabase_admin`).

---

## 6. Out of scope (explicit, with rationale)

| Deferred | Rationale |
|---|---|
| 30-day funnel window | 7d adequate for YC narrative; partial expression index in v1.1 with data-volume justification |
| Persisting `regime` / `slot_type` into impression payload | Client + ingest schema change; explainer surfaces regime as informational only |
| Audit fingerprint for hook-not-found probes | Codebase precedent (`admin_set_profile_tier`, `admin_force_close_session`) is RAISE-without-audit on failure. Autonomous-transaction audit (dblink) is a v2 access-log table, not a D6 widening |
| Materialized views / caching | Admin volume is single-digit calls per demo |
| Page-level event-stream pagination beyond last 50 | Cursor pagination is v1.1 |
| Hardening pass on non-algo migrations | Round 2/3 audits scoped C-NEW1 to feed/algo paths; auth/voice paths use different jsonb shapes and aren't part of feed event ingest |
| Regime-specific narrative branching | v1 scorer is regime-agnostic ([compute_hook_score:51,187](../../supabase/migrations/20260503000010_feed_ranked_page_rpc.sql#L51) — `p_regime` is parameter+echo, never branched). When v2 introduces regime-specific scoring, the explainer extends |

---

## 7. Audit trail through versions

| Version | Verdict | Resolved in next | Outstanding at merge |
|---|---|---|---|
| v1 | C1 audit_log shape, C2 served_rank semantics, C3 target-vs-admin uid, C4 slot_idx semantics, C5 regime-not-recoverable; M1-M7 | v2 |  |
| v2 | C1 creators.deleted_at, C2 audit-log spam, C3 regime-narrative misleading, C4 slot off-by-one, C5 redundant RPC #7 | v3 |  |
| v3 | C-NEW1 hardening scope (rollup trigger + cooldown CTE), M-NEW1 regime narrative split, M-NEW2 stub caveat, M-NEW3 debounce, M-NEW4 streak reconstruction | v4 |  |
| v4 | C-1 regime-split FABRICATED (not in scorer), C-2 audit-fingerprint claim false (PL/pgSQL transaction semantics), C-3 hardening missed ingest paths; M streak ordering, soft-error-vs-RAISE inconsistency, dual-slot cognitive overhead | v5 |  |
| **v5** | **ready to implement** | — | none |

---

## 8. Build sequencing

1. Write `0504-06_payload_typeof_hardening.sql` first (helpers exist before RPCs that use them).
2. Run §4.6 + §4.7 tests — green.
3. Write `0504-05_admin_algo_inspect_rpcs.sql`.
4. Run §4.1-4.5 + §4.7 tests — green.
5. Write the 4 `src/app/admin/algo/**` files + `loading.tsx` + nav link.
6. Patch `docs/ALGO_IMPLEMENTATION_PLAN.md` §1049-1106 in the same commit (so the spec stops misleading future contributors).
7. Manual smoke on staging: navigate `/admin/algo/<vukpjescic_user_id>`, click Explain on a known hook, verify narrative + breakdown + slot value + streak field.
8. Merge to main → Vercel production deploy.
