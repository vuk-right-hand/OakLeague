# OakLeague Feed & Personalization Algorithm — v1 Implementation Plan

**Author:** algo-handoff agent
**Drafted:** 2026-04-23 (rc1 tagged) · **Rev 2:** 2026-04-23 (post-audit) · **Rev 3:** 2026-04-23 (post-audit-2)
**Target:** YC S26 application submission (2026-05-06)
**Status:** awaiting Vuk approval before migrations land

---

## Audit response index

| ID | Finding | Severity | Resolution |
|---|---|---|---|
| C1 | score_breakdown leaks algo to all callers | Critical | §6.1 — stripped in API layer; only admin client receives it |
| C2 | Admin reads unaudited | Critical | §7.2 — admin_audit_log row on every admin_algo_* call |
| C3 | Admin guard missing revoked_at IS NULL | Critical | §7.2 — canonical predicate added to every admin RPC |
| C4 | S_recency uses created_at not published_at | Critical | §5.3 — uses COALESCE(published_at, created_at) |
| C5 | Cold→behavioral transition too shallow | Critical | §4.1 — now requires meaningful engagement depth |
| C6 | Anon visitors get no continuity — deferred | Critical | §4.3 — ships in v1, not deferred |
| C7 | Admin debugger is numbers, not a sentence | Critical | §7.1 + §7.2 — narrative RPC added |
| M1 | mic_tap session_id not ownership-checked | Medium | §3.2 migration 7 — verified against auth.uid() |
| M2 | auth_required SQLSTATE 42501 collides | Medium | §6.2 — 28000 used |
| M3 | NORM_TOPIC = 5.0 arbitrary / fails silently | Medium | §5.3 — dynamic per-user max |
| M4 | exclude-ids cursor unbounded | Medium | §5.2 — hard-capped at 50 client-side + server |
| M5 | Cooldown MV is race+lag trap | Medium | §5.3 — on-the-fly CTE, no MV |
| M6 | Negative affinity stored but clamped to 0 | Medium | §5.3 — negatives used; S_topic is now signed |
| M7 | Session duration not fed back into scoring | Medium | §3.2 migration 7b + §5.3 |
| M8 | P_repeat_creator ambiguous count vs consecutive | Medium | §5.3 — consecutive streak in viewport |
| M9 | Carousel with 1 hook silently dead | Medium | §1.2 — graceful fallback to cross-creator hooks |
| M10 | Catalog exhaustion breaks feed silently | Medium | §4.1 — regime D + progressive cooldown relaxation |
| M11 | Anon first-feed fully un-scored | Medium | §5.4 — lite scorer (W_GLOBAL + W_RECENCY + anon affinity) |
| S1 | Per-IP only rate limit bypassable | Small | §6.2 — per-user rate limit added |
| S2 | raise_append_only() assumed to exist | Small | §3.2 migration 2 — reference to 0020 explicit |
| S3 | Decay test uses pg_sleep | Small | §9 — UPDATE last_event_at specified |
| S4 | Explore slots positions 3,7 are a tell | Small | §5.5 — seeded-PRNG slot picks within windows |
| S5 | Dwell-end timing during carousel ambiguous | Small | §2.2 — fires on sheet-open |
| S6 | No skip affordance for interest_slugs | Small | §4.2 — explicit skip copy specified |

**Design calls sanity-checked:** all 7 from original plan pass. Updates: (a) shared `compute_hook_score()` function called from both live scorer and admin explainer (sanity call 7), (b) `interest_slugs` topic-rename guard documented (sanity call 2), (c) EMA half-life kept as SQL constant not migration (sanity call 3), (d) full_video_quartile 100 weight revisit flagged in §11 open questions (sanity call 4).

**Round 2 audit findings — Rev 3 resolution index:**

| ID | Finding | Severity | Resolution |
|---|---|---|---|
| NC1 | `ingest_feed_events_anon` RPC has no DDL | Critical | §3.2 migration 0 — full DDL added |
| NC2 | `hooks.topic_tags` column not verified before migration 6 uses it | Critical | §3.2 migration 6 — explicit verification note + hooks migration reference |
| NC3 | `feed_ranked_anon_page` missing from migration map | Critical | §3.1 + §3.2 migration 8 — added to map + DDL sketch |
| NC4 | `logScoredImpressions` referenced but undefined | Critical | §6.1 — removed; admin calls `compute_hook_score()` live; no replay table needed |
| NM1 | `rate_limit_hit` RPC not in any migration | Medium | §3.2 migration 7a — DDL added |
| NM2 | `S_creator` hardcoded 5.0 ceiling — loses resolution after 2 sessions | Medium | §5.3 — dynamic `v_user_creator_max` identical to M3 fix for S_topic |
| NM3 | Cooldown CTE correlated subquery missing composite index | Medium | §3.2 migration 2 — `feed_events_raw_user_video_event_idx` added |
| NM4 | `engagement_depth` scan on every feed call with no memoization | Medium | §3.2 migration 1 + migration 6 — `profiles.feed_regime` column; rollup trigger updates it; zero-latency at feed time |
| Clarification | Admin explainer always uses regime C regardless of actual served regime | — | §7.2 — one-line note added |

---

## 0. TL;DR — what we ship and why it feels like v4

OakLeague's feed is the retention engine for the avatar moat. North-Star metric: **`mic_tap_rate` per session** — everything upstream compresses the gap between "user lands" and "user talks to a creator."

**v1 ships:**

- **Full behavioral instrumentation.** Nine event types. Schema permanent; scorer replaceable.
- **Per-user topic + creator affinity.** Live EMA with 14-day half-life. Time-decayed. No pgvector, no ML, no black box. Deterministic, explainable in SQL.
- **Smart multi-signal scorer.** Blends taste, recency (using published_at), global quality, explore/exploit, diversity, and signed negative signals. Every ranking decision produces a full component breakdown.
- **Admin "why this hook?" explainer.** Live scorer + natural-language narrative sentence. The YC demo moment. Same shared `compute_hook_score()` function — no drift.
- **Persistent anon cookie + auth merge.** Every YC reviewer's pre-login swipes become behavioral signal. Ships now, not deferred.
- **Cold start from interest_slugs.** Four regimes: A (anon/fresh), B (interest-seeded), C (behavioral ≥ meaningful engagement), D (catalog exhausted). Regime D progressively relaxes cooldowns so the feed never goes blank.
- **score_breakdown stripped from non-admin API responses.** Only `{hook_id, served_rank, ...feed_page columns}` reaches users. Admin receives the full breakdown.
- **90-day raw retention, live rollup aggregates, pg_cron GC.**
- **Zero new paid-API calls.**
- **Works at N=1 creator and N=1000.**

**Defers with structural justification:**

| Deferred | Why |
|---|---|
| Collaborative filtering | Requires N_creators × N_users scale. Noise at current N. Ships v1.5. |
| Trained ML ranker | Needs 30–60 days labeled data. Heuristic becomes warm-start + fallback. |
| pgvector / semantic embeddings | Topic drawers are the v1 primitive per CLAUDE.md. Explainability > magic at small N. |
| Tier-based algo variants | **Forbidden by architecture.** Tier = minutes/day only. |
| Shadow A/B weight testing | No cohort tooling. Weights stay as SQL constants for v1; `feed_algo_weights` table is v1.1. |

---

## 1. Product model & validation

### 1.1 The loop the algorithm optimizes

```
feed impression → hook dwell → decision (swipe-away | swipe-into-full | creator-tap | mic-tap)
       ↑                                              │
       └────────────────── served-again-later ────────┘
                             (or not, per cooldown policy)
```

**The single question the scorer answers:** of all candidate hooks this user hasn't exhausted, which N are most likely to trigger `swipe-into-full-video` or `mic-tap` in the next 10 seconds?

### 1.2 Validating: "single hook per card + creator-tap carousel"

**Pushback on current implementation.** [`src/app/(feed)/feed-container.tsx`](src/app/(feed)/feed-container.tsx) groups hooks by video (`groupByVideo`) and renders `VideoRow` with 1–5 nested lessons. This conflates two distinct decisions — "do I want *this* hook?" and "do I want *more* from this creator?" — making it impossible to distinguish a rejection swipe from a lesson-advance swipe.

**Adopt single-hook-per-card + creator-tap carousel:**

- One card = one hook = one `hook_swipe` event. TikTok-canonical. Clean attribution.
- Creator avatar in card is tappable → bottom-sheet carousel.
- **Carousel fill order:** (1) if current hook is part of a 5-lesson video, show the other ≤4 lessons first; (2) pad to 4 entries using topic-overlap hooks from other creators (ranked by `S_global`); (3) if filling from other creators, show an "More from @handle coming soon" tile at position 0 to make the cross-creator fill explicit.
- **Sparse-creator edge case (M9).** When creator has only 1 published hook, tapping the avatar must *not* produce a dead region. The sheet always renders ≥1 of: (a) peer creator hooks on the same topic, (b) the "coming soon" tile. A completely empty sheet is never shown. This edge case is guaranteed to apply at launch (N=1 creator × however many hooks) — it cannot be a v1.1 concern.
- Hook pauses on sheet open; resumes on dismiss. `hook_dwell_end` fires at sheet-open (accurate dwell attribution — S5).

**What changes:** flatten `feed-container.tsx` to render `HookCard[]` not `VideoRow[]`. `VideoRow` → `HookCard`. New `CreatorCarouselSheet`. The `feed_page` RPC already returns hook-granular rows — stop client-side grouping.

**What stays:** `feed_page` keyset pagination shape, intersection observer, load-more trigger.

---

## 2. Event taxonomy

One server route → one SECURITY DEFINER RPC → one append-only table. Client never writes directly.

### 2.1 Event table

| event_name | Trigger | Client payload | Retention | Write path | Notes |
|---|---|---|---|---|---|
| `hook_impression` | HookCard enters viewport ≥300ms, tab active (IntersectionObserver @ 0.9) | `{hook_id, served_rank, served_at_ms, viewport_enter_ms, idempotency_key}` | Raw 90d → rollup ∞ | batch queue → `POST /api/events/feed-batch` → `ingest_feed_events` RPC | `served_score_json` stripped before client response (C1); stored server-side at ingest |
| `hook_dwell_end` | Sheet opens OR card pauses > 2s OR swipe begins (S5) | `{hook_id, dwell_ms, watched_ms, completion_pct, audio_muted, idempotency_key}` | Raw 90d → rollup ∞ | same | completion_pct = watched_ms / duration_ms |
| `hook_swipe` | User swipes or taps advance | `{hook_id, direction: 'up'\|'down'\|'right'\|'left', seconds_to_decision_ms, completion_pct, idempotency_key}` | Raw 90d → rollup ∞ | same | <500ms dead-zone enforced server-side; dead-zone rows inserted with skipped_reason='dead_zone_swipe' |
| `full_video_open` | Swipe-right OR carousel tap opens full video | `{hook_id, video_id, source: 'swipe'\|'carousel_hook'\|'creator_profile', idempotency_key}` | Raw 90d → rollup ∞ | same | |
| `full_video_quartile` | MuxPlayer timeupdate crosses 25/50/75/100% for first time | `{video_id, quartile: 25\|50\|75\|100, watched_ms_in_view, view_id, idempotency_key}` | Raw 90d → rollup ∞ | same | Max 4 rows per (user, video, view_id) |
| `creator_carousel_open` | User taps creator avatar or lessons-chip | `{hook_id, creator_id, source: 'avatar'\|'chip', idempotency_key}` | Raw 90d → rollup ∞ | same | Drill-down intent; strong positive even without further action |
| `creator_carousel_hook_open` | User taps a hook inside carousel sheet | `{parent_hook_id, opened_hook_id, carousel_position, idempotency_key}` | Raw 90d → rollup ∞ | same | carousel_position 0–3 |
| `mic_tap` | User taps mic button mid-full-video | `{hook_id, video_id, creator_id, mic_tap_outcome, session_id_if_opened?, idempotency_key}` | Raw ∞ (north-star) | same | mic_tap_outcome enum: session_opened \| kill_switch_blocked \| auth_required \| creator_not_ready \| unknown_error. Server verifies session_id_if_opened belongs to auth.uid() (M1). |
| `session_close` | sessions.status → ended/errored | — | ∞ (it's the sessions row) | existing session_close RPC | No new row. Admin reads sessions.active_seconds + end_reason. |

### 2.2 Notes

**Idempotency keys.** Every event carries a client-minted UUID. Server dedupes on `(user_id, event_name, idempotency_key)`. Stops network-retry double-counting and strict-mode duplicate mounts.

**Dead-zone.** `hook_swipe` with `seconds_to_decision_ms < 500` → row inserted with `skipped_reason='dead_zone_swipe'`, rollup trigger skips it. Kept for debug.

**Negative signals are committed (M6).** Strong negatives are written with negative EMA weight and *used* by the scorer — S_topic is signed, not clamped. See §5.3 for the signed formula.

**`hook_dwell_end` fires on carousel-open (S5).** When the user taps the creator avatar and the sheet opens, the current hook pauses. Fire `hook_dwell_end` at that moment (accurate dwell = time from card becoming active to sheet-open). When the sheet dismisses, a new `hook_impression` fires for the same hook if they resume watching. Do NOT fire a second `hook_dwell_end` when the card later exits viewport — use the idempotency_key to prevent that double-fire.

---

## 3. Schema sketch — migrations

### 3.1 Migration map

| # | Filename | Purpose |
|---|---|---|
| 0 | `20260503000000_anon_feed_identity.sql` | Anon cookie state + auth-merge RPC (C6) |
| 1 | `20260503000001_algo_enums_and_interest_slugs.sql` | Feed event enums + `profiles.interest_slugs` |
| 2 | `20260503000002_feed_events_raw.sql` | Append-only raw event table; references raise_append_only() from 0020 |
| 3 | `20260503000003_user_topic_affinity.sql` | Per-user topic affinity rollup |
| 4 | `20260503000004_user_creator_affinity.sql` | Per-user creator affinity rollup |
| 5 | `20260503000005_hook_global_stats.sql` | Global quality counters |
| 6 | `20260503000006_feed_events_rollup_trigger.sql` | Raw-event → rollup trigger (signed EMA, M6) |
| 7a | `20260503000007_ingest_feed_events_rpc.sql` | Authenticated batch-ingest SECURITY DEFINER |
| 7b | `20260503000007b_session_close_affinity_trigger.sql` | sessions AFTER UPDATE → creator affinity boost by session duration (M7) |
| 8 | `20260503000008_feed_ranked_page_rpc.sql` | Scored feed + shared `compute_hook_score()` + `feed_ranked_anon_page` (NC3) |
| 9 | `20260503000009_admin_algo_inspect_rpcs.sql` | Admin RPCs with audit log + narrative (C2, C3, C7) |
| 10 | `20260503000010_feed_events_retention_pgcron.sql` | 90-day GC |

### 3.2 Key DDL

> Conventions follow existing codebase: REVOKE then GRANT, RLS enabled on every table, INSERT ON CONFLICT for atomic rollup upserts.

---

**Migration 0 — anon feed identity (C6)**

Persistent anon cookie (`oak_anon_id`, httpOnly, sameSite=lax, 1-year) minted server-side on the first event write from an unauthenticated visitor. State is stored as jsonb blobs to keep the schema minimal — we don't need full normalized rows for ephemeral anon state.

```sql
CREATE TABLE public.anon_feed_sessions (
  anon_id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_active_at    timestamptz NOT NULL DEFAULT now(),
  event_count       int         NOT NULL DEFAULT 0,
  -- Compact EMA blobs: { "cold_outreach": 1.2, "build_in_public": 0.8 }
  topic_affinity    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  creator_affinity  jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX anon_feed_sessions_last_active_idx
  ON public.anon_feed_sessions (last_active_at);

ALTER TABLE public.anon_feed_sessions ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only (anon callers never read/write directly).

-- Merge RPC: called from auth callback (server-side) on signup/login.
-- Blends anon affinity EMA into the real user's rollup tables.
CREATE OR REPLACE FUNCTION public.merge_anon_feed_state(
  p_anon_id uuid,
  p_user_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_anon record;
  v_key text;
  v_val real;
BEGIN
  SELECT * INTO v_anon FROM public.anon_feed_sessions WHERE anon_id = p_anon_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Blend topic affinity.
  FOR v_key, v_val IN SELECT key, value::real FROM jsonb_each_text(v_anon.topic_affinity) LOOP
    INSERT INTO public.user_topic_affinity
      (user_id, topic_slug, affinity_score, last_event_at, updated_at)
    VALUES (p_user_id, v_key, v_val, now(), now())
    ON CONFLICT (user_id, topic_slug) DO UPDATE
      SET affinity_score = (user_topic_affinity.affinity_score + EXCLUDED.affinity_score) / 2,
          updated_at     = now();
  END LOOP;

  -- Blend creator affinity.
  FOR v_key, v_val IN SELECT key, value::real FROM jsonb_each_text(v_anon.creator_affinity) LOOP
    INSERT INTO public.user_creator_affinity
      (user_id, creator_id, affinity_score, last_event_at, updated_at)
    VALUES (p_user_id, v_key::uuid, v_val, now(), now())
    ON CONFLICT (user_id, creator_id) DO UPDATE
      SET affinity_score = (user_creator_affinity.affinity_score + EXCLUDED.affinity_score) / 2,
          updated_at     = now();
  END LOOP;

  DELETE FROM public.anon_feed_sessions WHERE anon_id = p_anon_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.merge_anon_feed_state(uuid,uuid) FROM public;
-- Called from server-side auth callback only; no grant to anon/authenticated.

-- NC1: ingest RPC for unauthenticated visitors. Called from /api/events/feed-batch
-- when auth.uid() IS NULL. Validated by anon_id existence, not JWT.
-- Applies the same EMA weights as the authenticated trigger, but directly
-- to the jsonb blobs in anon_feed_sessions rather than normalized rollup tables.
CREATE OR REPLACE FUNCTION public.ingest_feed_events_anon(
  p_anon_id uuid,
  p_events  jsonb
) RETURNS TABLE(inserted int, deduped int, dead_zoned int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  HALF_LIFE_DAYS constant real := 14.0;
  v_anon record;
  v_evt  jsonb;
  v_event_name text;
  v_hook record;
  v_tag  text;
  v_weight real;
  v_skip_reason text;
  v_inserted int := 0; v_deduped int := 0; v_dead int := 0;
  v_new_topic_aff  jsonb;
  v_new_creator_aff jsonb;
BEGIN
  -- Validate anon session exists (acts as auth — no JWT available).
  SELECT * INTO v_anon FROM public.anon_feed_sessions WHERE anon_id = p_anon_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'anon_session_not_found' USING ERRCODE = '28000';
  END IF;

  IF jsonb_typeof(p_events) <> 'array' THEN
    RAISE EXCEPTION 'p_events must be a jsonb array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_events) > 50 THEN
    RAISE EXCEPTION 'batch too large (max 50)' USING ERRCODE = '22023';
  END IF;

  v_new_topic_aff   := v_anon.topic_affinity;
  v_new_creator_aff := v_anon.creator_affinity;

  FOR v_evt IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    v_event_name  := v_evt->>'event_name';
    v_skip_reason := NULL;

    IF v_event_name = 'hook_swipe'
       AND ((v_evt->'payload'->>'seconds_to_decision_ms')::int < 500) THEN
      v_skip_reason := 'dead_zone_swipe';
      v_dead := v_dead + 1;
      CONTINUE;
    END IF;

    -- Dedupe by (anon_id, event_name, idempotency_key) in the jsonb blob
    -- is impractical; instead we rely on client-side idempotency_key generation
    -- and accept at-most-once semantics for anon (no normalized dedup table).

    -- Resolve topic_tags + creator_id from hooks (same logic as rollup trigger).
    v_hook := NULL;
    IF (v_evt->>'hook_id') IS NOT NULL THEN
      SELECT h.topic_tags, v.creator_id INTO v_hook
        FROM public.hooks h JOIN public.videos v ON v.id = h.video_id
       WHERE h.id = (v_evt->>'hook_id')::uuid;
    END IF;

    -- Event weight (mirrors feed_events_raw_rollup weights exactly).
    v_weight := CASE v_event_name
      WHEN 'hook_impression'            THEN 0.02
      WHEN 'hook_dwell_end'             THEN
        LEAST(1.0, GREATEST(-0.3, COALESCE((v_evt->'payload'->>'completion_pct')::real, 0)))
      WHEN 'hook_swipe'                 THEN
        CASE (v_evt->'payload'->>'direction')
          WHEN 'right' THEN 0.5
          WHEN 'left'  THEN 0.0
          ELSE CASE WHEN (v_evt->'payload'->>'seconds_to_decision_ms')::int < 2000
                         AND COALESCE((v_evt->'payload'->>'completion_pct')::real, 0) < 0.2
                    THEN -0.3 ELSE -0.05 END
        END
      WHEN 'full_video_open'            THEN 0.6
      WHEN 'full_video_quartile'        THEN
        CASE (v_evt->'payload'->>'quartile')::int
          WHEN 25 THEN 0.2  WHEN 50 THEN 0.4
          WHEN 75 THEN 0.6  WHEN 100 THEN 1.0  ELSE 0
        END
      WHEN 'creator_carousel_open'      THEN 0.4
      WHEN 'creator_carousel_hook_open' THEN 0.5
      WHEN 'mic_tap'                    THEN
        CASE (v_evt->'payload'->>'mic_tap_outcome')
          WHEN 'session_opened' THEN 2.0 ELSE 0.3 END
      ELSE 0
    END;

    -- Apply EMA to topic affinity jsonb blobs.
    IF v_hook.topic_tags IS NOT NULL THEN
      FOREACH v_tag IN ARRAY v_hook.topic_tags LOOP
        DECLARE
          v_old_score real := COALESCE((v_new_topic_aff->>v_tag)::real, 0);
          -- No per-key last_event_at stored in blob; use a 1-event approximation
          -- (no time decay for anon — they session-hop, decay is less meaningful).
          v_new_score real := GREATEST(-0.5, LEAST(5.0, v_old_score + v_weight));
        BEGIN
          v_new_topic_aff := jsonb_set(v_new_topic_aff, ARRAY[v_tag], to_jsonb(v_new_score));
        END;
      END LOOP;
    END IF;

    -- Apply EMA to creator affinity jsonb blob.
    DECLARE v_creator_id text := COALESCE(v_hook.creator_id::text, v_evt->>'creator_id');
    BEGIN
      IF v_creator_id IS NOT NULL THEN
        DECLARE
          v_old_score real := COALESCE((v_new_creator_aff->>v_creator_id)::real, 0);
          v_new_score real := GREATEST(-0.5, LEAST(5.0, v_old_score + v_weight));
        BEGIN
          v_new_creator_aff := jsonb_set(v_new_creator_aff, ARRAY[v_creator_id], to_jsonb(v_new_score));
        END;
      END IF;
    END;

    v_inserted := v_inserted + 1;
  END LOOP;

  -- Persist updated blobs + increment event_count.
  UPDATE public.anon_feed_sessions SET
    topic_affinity   = v_new_topic_aff,
    creator_affinity = v_new_creator_aff,
    event_count      = event_count + v_inserted,
    last_active_at   = now()
  WHERE anon_id = p_anon_id;

  RETURN QUERY SELECT v_inserted, v_deduped, v_dead;
END;$$;

REVOKE EXECUTE ON FUNCTION public.ingest_feed_events_anon(uuid, jsonb) FROM public;
-- Called via service-role only from /api/events/feed-batch (anon path).
-- No grant to authenticated or anon roles.
```

**Anon GC** — a pg_cron job deletes `anon_feed_sessions` inactive for > 30 days (added to migration 10).

---

**Migration 1 — enums + interest_slugs**

```sql
CREATE TYPE feed_event_name AS ENUM (
  'hook_impression', 'hook_dwell_end', 'hook_swipe',
  'full_video_open', 'full_video_quartile',
  'creator_carousel_open', 'creator_carousel_hook_open',
  'mic_tap'
);
CREATE TYPE swipe_direction        AS ENUM ('up','down','left','right');
CREATE TYPE carousel_open_source   AS ENUM ('avatar','chip');
CREATE TYPE full_video_open_source AS ENUM ('swipe','carousel_hook','creator_profile');
CREATE TYPE mic_tap_outcome        AS ENUM (
  'session_opened','kill_switch_blocked','auth_required',
  'creator_not_ready','unknown_error'
);

-- Structured interest multi-select. Free-text goals[]/obstacles[] stay for
-- display only and do NOT drive the scorer.
ALTER TABLE public.profiles
  ADD COLUMN interest_slugs text[] NOT NULL DEFAULT '{}'
  CHECK (
    cardinality(interest_slugs) <= 20
    AND public._all_text_array_elems_within(interest_slugs, 40)
  );

-- NOTE on rename safety: creator_topics.slug is immutable once referenced
-- (migrations 0039 orphan-guard + 0012 prevent_orphan_slugs cover rename AND
-- delete). A stale interest_slug becomes a no-op overlap at feed time — the
-- scorer just gets 0 for that tag. Not FK'd intentionally; the onboarding set
-- is a point-in-time snapshot. No additional guard needed.
COMMENT ON COLUMN public.profiles.interest_slugs IS
  'Structured interest slugs matching creator_topics.slug; intentionally not FK.';

-- NM4: memoized regime so the feed call reads a single column instead of
-- running a COUNT(*) over feed_events_raw on every page load.
-- Maintained by the rollup trigger (migration 6) and NOT by feed_ranked_page.
-- Valid values mirror the cold-start regime enum: 'A' | 'B' | 'C' | 'D'.
-- Default 'A' (anon/fresh). Transitions are one-way A→B→C (D is transient, computed at call time).
CREATE TYPE feed_regime AS ENUM ('A', 'B', 'C', 'D');

ALTER TABLE public.profiles
  ADD COLUMN feed_regime feed_regime NOT NULL DEFAULT 'A';

COMMENT ON COLUMN public.profiles.feed_regime IS
  'Memoized scoring regime updated by rollup trigger; avoids COUNT(*) scan on every feed call (NM4).';
```

---

**Migration 2 — raw event table**

`raise_append_only()` is already defined in migration 0020 (`cogs_log`). We reuse it here without redefining (S2).

```sql
CREATE TABLE public.feed_events_raw (
  id              bigserial       PRIMARY KEY,
  created_at      timestamptz     NOT NULL DEFAULT now(),
  user_id         uuid            NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  event_name      feed_event_name NOT NULL,
  hook_id         uuid            REFERENCES public.hooks(id)    ON DELETE SET NULL,
  video_id        uuid            REFERENCES public.videos(id)   ON DELETE SET NULL,
  creator_id      uuid            REFERENCES public.creators(id) ON DELETE SET NULL,
  session_id      uuid            REFERENCES public.sessions(id) ON DELETE SET NULL,
  idempotency_key uuid            NOT NULL,
  payload         jsonb           NOT NULL CHECK (octet_length(payload::text) <= 4096),
  skipped_reason  text            CHECK (skipped_reason IS NULL OR char_length(skipped_reason) <= 64),
  UNIQUE (user_id, event_name, idempotency_key)
);

CREATE INDEX feed_events_raw_user_time_idx  ON public.feed_events_raw (user_id, created_at DESC);
CREATE INDEX feed_events_raw_user_hook_idx  ON public.feed_events_raw (user_id, hook_id)
  WHERE hook_id IS NOT NULL;
CREATE INDEX feed_events_raw_created_at_idx ON public.feed_events_raw (created_at);
-- NM3: the cooldown CTE full_video_open branch does a correlated NOT EXISTS join on
-- (user_id, video_id, event_name). Without this index that's a full-range scan
-- per feed_ranked_page call (user_time_idx covers user+created_at, not video_id).
CREATE INDEX feed_events_raw_user_video_event_idx
  ON public.feed_events_raw (user_id, video_id, event_name)
  WHERE video_id IS NOT NULL;

-- Reuse raise_append_only() from migration 0020 (cogs_log).
CREATE TRIGGER feed_events_raw_no_update
  BEFORE UPDATE ON public.feed_events_raw
  FOR EACH ROW EXECUTE FUNCTION public.raise_append_only();
CREATE TRIGGER feed_events_raw_no_truncate
  BEFORE TRUNCATE ON public.feed_events_raw
  FOR EACH STATEMENT EXECUTE FUNCTION public.raise_append_only();
-- DELETE allowed: retention job + CASCADE from profiles.

ALTER TABLE public.feed_events_raw ENABLE ROW LEVEL SECURITY;
CREATE POLICY "feed_events_raw own read"
  ON public.feed_events_raw FOR SELECT USING (user_id = auth.uid());
-- Writes: SECURITY DEFINER RPC only. No INSERT policy.
```

---

**Migrations 3–5** (user_topic_affinity, user_creator_affinity, hook_global_stats — unchanged from original plan). See §5 for the `affinity_score` sign discussion.

---

**Migration 6 — rollup trigger (signed EMA + negative signals committed)**

Key change from draft: `affinity_score` is signed. Negative-weight events (fast-dismiss swipes) drive the score below 0. The scorer's `S_topic` component respects the sign (§5.3). The EMA half-life constant (14 days) lives at the top of this function as a SQL comment + named constant — not a migration column — so it can be tuned by changing one line (sanity call 3).

**NC2 — `hooks.topic_tags` verified.** Migration `20260420000016_hooks.sql` explicitly creates `topic_tags text[]` on the `hooks` table with a GIN index. The rollup trigger query `SELECT h.topic_tags, v.creator_id FROM hooks h JOIN videos v ...` is safe. Note: CLAUDE.md mentions `topic_tags[]` on `sample_content` (knowledge drawers) — that's a separate column on a separate table. Hooks have their own `topic_tags[]` populated at publish time from the video's topic assignment. Both columns coexist; they are not the same.

**NM4 — `profiles.feed_regime` update.** The rollup trigger also updates `profiles.feed_regime` when the user crosses engagement thresholds — avoiding a `COUNT(*)` scan per feed call. Regime transitions are one-way (A→B→C); D is transient and computed at call time from candidate count.

```sql
CREATE OR REPLACE FUNCTION public.feed_events_raw_rollup()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  -- Tunable constants. Change here only.
  HALF_LIFE_DAYS constant real := 14.0;
  v_hook record;
  v_tag  text;
  v_weight real := 0;
BEGIN
  IF NEW.skipped_reason IS NOT NULL THEN RETURN NULL; END IF;

  -- Resolve hook's topic tags + creator_id once.
  IF NEW.hook_id IS NOT NULL THEN
    SELECT h.topic_tags, v.creator_id INTO v_hook
      FROM public.hooks h JOIN public.videos v ON v.id = h.video_id
     WHERE h.id = NEW.hook_id;
  END IF;

  -- Weight per event type (negative = dislike signal; kept and used by scorer).
  v_weight := CASE NEW.event_name
    WHEN 'hook_impression'            THEN 0.02
    WHEN 'hook_dwell_end'             THEN
      LEAST(1.0, GREATEST(-0.3, COALESCE((NEW.payload->>'completion_pct')::real, 0)))
    WHEN 'hook_swipe'                 THEN
      CASE (NEW.payload->>'direction')
        WHEN 'right' THEN 0.5
        WHEN 'left'  THEN 0.0
        ELSE -- up/down (dismiss)
          CASE WHEN (NEW.payload->>'seconds_to_decision_ms')::int < 2000
                AND COALESCE((NEW.payload->>'completion_pct')::real, 0) < 0.2
               THEN -0.3   -- strong negative
               ELSE -0.05  -- weak negative
          END
      END
    WHEN 'full_video_open'            THEN 0.6
    WHEN 'full_video_quartile'        THEN
      CASE (NEW.payload->>'quartile')::int
        WHEN 25 THEN 0.2  WHEN 50 THEN 0.4
        WHEN 75 THEN 0.6  WHEN 100 THEN 1.0  ELSE 0
      END
    WHEN 'creator_carousel_open'      THEN 0.4
    WHEN 'creator_carousel_hook_open' THEN 0.5
    WHEN 'mic_tap'                    THEN
      CASE (NEW.payload->>'mic_tap_outcome')
        WHEN 'session_opened' THEN 2.0
        ELSE 0.3
      END
    ELSE 0
  END;

  -- Per-topic affinity upsert.
  IF v_hook.topic_tags IS NOT NULL THEN
    FOREACH v_tag IN ARRAY v_hook.topic_tags LOOP
      INSERT INTO public.user_topic_affinity AS t
        (user_id, topic_slug, impressions, dwell_ms_total, completions, full_opens,
         carousel_opens, mic_taps, negatives, affinity_score, last_event_at, updated_at)
      VALUES (
        NEW.user_id, v_tag,
        CASE WHEN NEW.event_name='hook_impression' THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_name='hook_dwell_end'
             THEN COALESCE((NEW.payload->>'dwell_ms')::int, 0) ELSE 0 END,
        CASE WHEN NEW.event_name='hook_dwell_end'
              AND COALESCE((NEW.payload->>'completion_pct')::real,0) >= 0.8
             THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_name='full_video_open' THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_name='creator_carousel_open' THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_name='mic_tap'
              AND NEW.payload->>'mic_tap_outcome'='session_opened' THEN 1 ELSE 0 END,
        CASE WHEN v_weight < 0 THEN 1 ELSE 0 END,
        v_weight, NEW.created_at, NEW.created_at
      )
      ON CONFLICT (user_id, topic_slug) DO UPDATE SET
        impressions    = t.impressions    + EXCLUDED.impressions,
        dwell_ms_total = t.dwell_ms_total + EXCLUDED.dwell_ms_total,
        completions    = t.completions    + EXCLUDED.completions,
        full_opens     = t.full_opens     + EXCLUDED.full_opens,
        carousel_opens = t.carousel_opens + EXCLUDED.carousel_opens,
        mic_taps       = t.mic_taps       + EXCLUDED.mic_taps,
        negatives      = t.negatives      + EXCLUDED.negatives,
        -- Signed EMA with HALF_LIFE_DAYS half-life. Score can go negative.
        affinity_score = (
          t.affinity_score
            * pow(0.5, EXTRACT(EPOCH FROM (NEW.created_at - t.last_event_at))
                       / (HALF_LIFE_DAYS * 86400))
          + v_weight
        ),
        last_event_at  = NEW.created_at,
        updated_at     = NEW.created_at;
    END LOOP;
  END IF;

  -- Per-creator affinity upsert (same signed EMA).
  DECLARE v_creator_id uuid := COALESCE(v_hook.creator_id, NEW.creator_id);
  BEGIN
    IF v_creator_id IS NOT NULL THEN
      INSERT INTO public.user_creator_affinity AS t
        (user_id, creator_id, impressions, full_opens, carousel_opens, mic_taps,
         negatives, affinity_score, last_event_at, updated_at)
      VALUES (
        NEW.user_id, v_creator_id,
        CASE WHEN NEW.event_name='hook_impression' THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_name='full_video_open' THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_name='creator_carousel_open' THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_name='mic_tap'
              AND NEW.payload->>'mic_tap_outcome'='session_opened' THEN 1 ELSE 0 END,
        CASE WHEN v_weight < 0 THEN 1 ELSE 0 END,
        v_weight, NEW.created_at, NEW.created_at
      )
      ON CONFLICT (user_id, creator_id) DO UPDATE SET
        impressions    = t.impressions    + EXCLUDED.impressions,
        full_opens     = t.full_opens     + EXCLUDED.full_opens,
        carousel_opens = t.carousel_opens + EXCLUDED.carousel_opens,
        mic_taps       = t.mic_taps       + EXCLUDED.mic_taps,
        negatives      = t.negatives      + EXCLUDED.negatives,
        affinity_score = (
          t.affinity_score
            * pow(0.5, EXTRACT(EPOCH FROM (NEW.created_at - t.last_event_at))
                       / (HALF_LIFE_DAYS * 86400))
          + v_weight
        ),
        last_event_at  = NEW.created_at,
        updated_at     = NEW.created_at;
    END IF;
  END;

  -- Global hook stats (positive events only).
  IF NEW.hook_id IS NOT NULL AND v_weight > 0 THEN
    INSERT INTO public.hook_global_stats AS g
      (hook_id, impressions, full_opens, mic_taps, avg_completion_pct, global_quality,
       last_event_at, updated_at)
    VALUES (
      NEW.hook_id,
      CASE WHEN NEW.event_name='hook_impression' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name='full_video_open' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name='mic_tap'
            AND NEW.payload->>'mic_tap_outcome'='session_opened' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name='hook_dwell_end'
           THEN COALESCE((NEW.payload->>'completion_pct')::real, 0) ELSE 0 END,
      0, NEW.created_at, NEW.created_at
    )
    ON CONFLICT (hook_id) DO UPDATE SET
      impressions        = g.impressions + EXCLUDED.impressions,
      full_opens         = g.full_opens  + EXCLUDED.full_opens,
      mic_taps           = g.mic_taps    + EXCLUDED.mic_taps,
      avg_completion_pct = CASE
        WHEN NEW.event_name='hook_dwell_end'
        THEN ((g.avg_completion_pct * GREATEST(g.impressions,1))
              + COALESCE((NEW.payload->>'completion_pct')::real,0))
             / (GREATEST(g.impressions,1) + 1)
        ELSE g.avg_completion_pct END,
      -- Laplace-smoothed open-through-rate with 3× mic-tap bonus.
      global_quality = (1 + (g.full_opens + EXCLUDED.full_opens)
                           + 3 * (g.mic_taps + EXCLUDED.mic_taps))::real
                       / (10 + (g.impressions + EXCLUDED.impressions))::real,
      last_event_at  = NEW.created_at,
      updated_at     = NEW.created_at;
  END IF;

  -- NM4: update memoized feed_regime on profiles so feed calls don't re-scan.
  -- Only check if current event is meaningful (could push the user to regime C).
  IF v_weight >= 0.6 OR (NEW.event_name = 'mic_tap'
     AND NEW.payload->>'mic_tap_outcome' = 'session_opened') THEN
    -- Regime B → check if already at B or higher; if still A, bump to B.
    IF EXISTS (
      SELECT 1 FROM public.profiles
       WHERE id = NEW.user_id AND feed_regime = 'A'
    ) THEN
      UPDATE public.profiles SET feed_regime = 'B' WHERE id = NEW.user_id;
    END IF;
    -- Regime C check: one meaningful engagement event (C5 definition).
    IF EXISTS (
      SELECT 1 FROM public.profiles
       WHERE id = NEW.user_id AND feed_regime IN ('A','B')
    ) THEN
      -- Meaningful = completion>=0.8 dwell, full_video_open, or mic_tap session_opened.
      IF (NEW.event_name = 'hook_dwell_end'
          AND COALESCE((NEW.payload->>'completion_pct')::real,0) >= 0.8)
         OR NEW.event_name = 'full_video_open'
         OR (NEW.event_name = 'mic_tap'
             AND NEW.payload->>'mic_tap_outcome' = 'session_opened')
      THEN
        UPDATE public.profiles SET feed_regime = 'C' WHERE id = NEW.user_id;
      END IF;
    END IF;
  END IF;

  RETURN NULL;
END;$$;

REVOKE EXECUTE ON FUNCTION public.feed_events_raw_rollup() FROM public;

CREATE TRIGGER feed_events_raw_rollup
  AFTER INSERT ON public.feed_events_raw
  FOR EACH ROW EXECUTE FUNCTION public.feed_events_raw_rollup();
```

---

**Migration 7b — session-close affinity boost (M7)**

The biggest behavioral signal after mic_tap is session duration. A 10-minute conversation is categorically different from a 10-second mic-tap that closed immediately. This trigger fires when `sessions.status` transitions to a terminal state and boosts `user_creator_affinity.affinity_score` proportional to active_seconds. The mic_tap event (weight 2.0) records the *intent*; this trigger records the *depth*.

```sql
CREATE OR REPLACE FUNCTION public.sessions_creator_affinity_on_close()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  HALF_LIFE_DAYS constant real := 14.0;
  MAX_BOOST_SECONDS constant int := 600; -- 10 min → 1.0 boost; linear below
  v_duration_boost real;
BEGIN
  -- Only fire on terminal transitions with meaningful conversation.
  IF NEW.status NOT IN ('ended', 'errored') THEN RETURN NULL; END IF;
  IF OLD.status IN ('ended', 'errored') THEN RETURN NULL; END IF;
  IF COALESCE(NEW.active_seconds, 0) < 30 THEN RETURN NULL; END IF;

  v_duration_boost :=
    LEAST(NEW.active_seconds, MAX_BOOST_SECONDS)::real / MAX_BOOST_SECONDS::real * 1.5;
  -- 1.5 = max boost for a 10-min session; proportional below that.
  -- Rationale: a 10-min session should contribute ~1.5 additional affinity, on
  -- top of the 2.0 already written by the mic_tap event, totaling ~3.5 —
  -- significantly above any passive-scroll activity.

  INSERT INTO public.user_creator_affinity AS t
    (user_id, creator_id, affinity_score, last_event_at, updated_at,
     total_session_seconds, impressions, full_opens, carousel_opens, mic_taps, negatives)
  VALUES (
    NEW.user_id, NEW.creator_id,
    v_duration_boost, now(), now(),
    COALESCE(NEW.active_seconds, 0), 0, 0, 0, 0, 0
  )
  ON CONFLICT (user_id, creator_id) DO UPDATE SET
    total_session_seconds = t.total_session_seconds + EXCLUDED.total_session_seconds,
    affinity_score = (
      t.affinity_score
        * pow(0.5, EXTRACT(EPOCH FROM (now() - t.last_event_at))
                   / (HALF_LIFE_DAYS * 86400))
      + v_duration_boost
    ),
    last_event_at = now(),
    updated_at    = now();
  RETURN NULL;
END;$$;

REVOKE EXECUTE ON FUNCTION public.sessions_creator_affinity_on_close() FROM public;

CREATE TRIGGER sessions_creator_affinity_on_close
  AFTER UPDATE OF status ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.sessions_creator_affinity_on_close();
```

---

**Migration 7a — rate_limit_hit RPC + ingest_feed_events RPC**

**NM1 — `rate_limit_hit` DDL.** This RPC is referenced in §6.2 but was not in any prior migration. It lives in migration 7a alongside the ingest RPC (both are feed-write-path infrastructure). Uses a dedicated `rate_limit_counters` table — a leaky-bucket counter keyed by `(scope, key)`.

```sql
CREATE TABLE public.rate_limit_counters (
  scope       text        NOT NULL,
  key         text        NOT NULL,
  window_start timestamptz NOT NULL DEFAULT date_trunc('minute', now()),
  hit_count   int         NOT NULL DEFAULT 1,
  PRIMARY KEY (scope, key, window_start)
);
CREATE INDEX rate_limit_counters_gc_idx ON public.rate_limit_counters (window_start);
ALTER TABLE public.rate_limit_counters ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only.

-- Returns false if limit exceeded, true if under limit.
CREATE OR REPLACE FUNCTION public.rate_limit_hit(
  p_scope  text,
  p_key    text,
  p_window interval DEFAULT '1 minute',
  p_limit  int      DEFAULT 600
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_window_start timestamptz := date_trunc('minute', now());
  v_count int;
BEGIN
  INSERT INTO public.rate_limit_counters (scope, key, window_start, hit_count)
  VALUES (p_scope, p_key, v_window_start, 1)
  ON CONFLICT (scope, key, window_start) DO UPDATE
    SET hit_count = rate_limit_counters.hit_count + 1
  RETURNING hit_count INTO v_count;
  RETURN v_count <= p_limit;
END;$$;

REVOKE EXECUTE ON FUNCTION public.rate_limit_hit(text,text,interval,int) FROM public;
-- Granted to no role — called via service-role admin client only.
```

A pg_cron job purges `rate_limit_counters` rows older than 5 minutes (added to migration 10).

---

Changes from draft for `ingest_feed_events`:
- M1: If `event_name='mic_tap'` and `session_id_if_opened` is provided, verify it belongs to `auth.uid()` before inserting. Null it out silently if not (not a hard reject — the mic_tap itself is valid; only the attribution is wrong).
- M2: Auth-required error uses SQLSTATE `28000` (`invalid_authorization_specification`), not `42501` which maps to `forbidden` in the existing error envelope.
- S1: Per-user rate limit added alongside per-IP.

```sql
CREATE OR REPLACE FUNCTION public.ingest_feed_events(p_events jsonb)
RETURNS TABLE(inserted int, deduped int, dead_zoned int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_inserted int := 0; v_deduped int := 0; v_dead int := 0;
  v_evt jsonb;
  v_skip_reason text;
  v_session_id uuid;
BEGIN
  -- M2: distinct SQLSTATE so client can distinguish "sign in" vs "forbidden".
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = '28000';
  END IF;
  IF jsonb_typeof(p_events) <> 'array' THEN
    RAISE EXCEPTION 'p_events must be a jsonb array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_events) > 50 THEN
    RAISE EXCEPTION 'batch too large (max 50)' USING ERRCODE = '22023';
  END IF;

  FOR v_evt IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    v_skip_reason := NULL;
    v_session_id  := NULL;

    IF (v_evt->>'event_name') = 'hook_swipe'
       AND ((v_evt->'payload'->>'seconds_to_decision_ms')::int < 500) THEN
      v_skip_reason := 'dead_zone_swipe';
      v_dead := v_dead + 1;
    END IF;

    -- M1: Verify session_id ownership for mic_tap events.
    IF (v_evt->>'event_name') = 'mic_tap'
       AND (v_evt->>'session_id_if_opened') IS NOT NULL THEN
      SELECT id INTO v_session_id FROM public.sessions
       WHERE id = (v_evt->>'session_id_if_opened')::uuid
         AND user_id = v_caller
       LIMIT 1;
      -- If no match, null it out (attribution wrong but event is valid).
    ELSE
      v_session_id := NULLIF(v_evt->>'session_id', '')::uuid;
    END IF;

    BEGIN
      INSERT INTO public.feed_events_raw
        (user_id, event_name, hook_id, video_id, creator_id, session_id,
         idempotency_key, payload, skipped_reason)
      VALUES (
        v_caller,
        (v_evt->>'event_name')::feed_event_name,
        NULLIF(v_evt->>'hook_id','')::uuid,
        NULLIF(v_evt->>'video_id','')::uuid,
        NULLIF(v_evt->>'creator_id','')::uuid,
        v_session_id,
        (v_evt->>'idempotency_key')::uuid,
        v_evt->'payload',
        v_skip_reason
      );
      IF v_skip_reason IS NULL THEN v_inserted := v_inserted + 1; END IF;
    EXCEPTION WHEN unique_violation THEN
      v_deduped := v_deduped + 1;
    END;
  END LOOP;

  RETURN QUERY SELECT v_inserted, v_deduped, v_dead;
END;$$;

REVOKE EXECUTE ON FUNCTION public.ingest_feed_events(jsonb) FROM public;
GRANT  EXECUTE ON FUNCTION public.ingest_feed_events(jsonb) TO authenticated;
```

---

**Migration 8 — shared scorer + feed_ranked_page**

The most significant structural change: **a single `compute_hook_score(p_user_id, p_hook_id)` function** contains all scoring logic. Both `feed_ranked_page` (live feed) and `admin_algo_score_explain` (admin debugger) call this one function. No divergence possible (sanity call 7).

**C4 — recency uses `COALESCE(h.published_at, h.created_at)`**, not `h.created_at` alone. Backfilled or re-ingested content has a `created_at` that reflects ingest time, not editorial publish intent. Using `published_at` (which the creator controls via the publishing flow) as the freshness anchor is correct.

**M3 — dynamic NORM_TOPIC.** Instead of hardcoded 5.0: `GREATEST(5.0, MAX(affinity_score) OVER (PARTITION BY user_id))` computed as a subquery from `user_topic_affinity` for the caller. Ensures the normalization ceiling scales with the user's actual affinity range. Doesn't affect cold users (max = 0 → GREATEST(5.0, 0) = 5.0).

**M4 — exclude-ids cap.** The `p_exclude_hook_ids` parameter is capped at 50 on the client before sending. The RPC also truncates `ARRAY(SELECT unnest(p_exclude_hook_ids) LIMIT 50)` on entry. Beyond 50 exclusions, the cooldown materialized filter in the CTE handles deduplication anyway.

**M5 — on-the-fly cooldown CTE.** No materialized view. Cooldown check is a CTE inside `feed_ranked_page` that scans `feed_events_raw` for the past 30 days (max cooldown) per user, using the `user_time_idx` index:

```sql
WITH user_cooldowns AS (
  SELECT hook_id,
         MAX(CASE
           WHEN event_name='mic_tap'
                AND payload->>'mic_tap_outcome'='session_opened'
                THEN created_at + interval '30 days'
           WHEN event_name='full_video_quartile'
                AND (payload->>'quartile')::int = 100
                THEN created_at + interval '14 days'
           WHEN event_name='full_video_quartile'
                AND (payload->>'quartile')::int >= 50
                THEN created_at + interval '7 days'
           WHEN event_name='full_video_open'
                AND NOT EXISTS (
                  SELECT 1 FROM public.feed_events_raw q2
                   WHERE q2.user_id = p_user_id
                     AND q2.video_id = feed_events_raw.video_id
                     AND q2.event_name = 'full_video_quartile'
                     AND q2.created_at > feed_events_raw.created_at
                     AND q2.created_at < feed_events_raw.created_at + interval '60 seconds'
                ) THEN created_at + interval '24 hours'
           WHEN event_name='hook_dwell_end'
                AND (payload->>'completion_pct')::real >= 0.8
                THEN created_at + interval '3 days'
           WHEN event_name='hook_dwell_end'
                AND (payload->>'completion_pct')::real < 0.8
                THEN created_at + interval '7 days'
         END) AS available_after
    FROM public.feed_events_raw
   WHERE user_id = p_user_id
     AND hook_id IS NOT NULL
     AND created_at > now() - interval '30 days'
   GROUP BY hook_id
  HAVING MAX(...) > now()
)
```

Then the main query adds `AND NOT EXISTS (SELECT 1 FROM user_cooldowns c WHERE c.hook_id = h.id)`.

**M8 — P_repeat_creator uses consecutive streak, not count-in-window.** The penalty applies to hooks from the same creator as the most recently served impression, not to any creator seen in the last 10 min. Implementation: in the scored candidates CTE, look at the most recent N=20 impressions from `feed_events_raw` (last 10 min), count the leading consecutive run of `creator_id = h.creator_id` from the end of that sequence. Penalty:

```
streak 0 or 1 → P_repeat_creator = 0.0
streak 2       → P_repeat_creator = 0.2
streak >= 3    → P_repeat_creator = 0.8
```

**M6 — S_topic is signed.** The formula now uses the raw affinity_score (which can be negative), clamped at the low end to -0.5 (so one bad session can't permanently crater a topic):

```sql
S_topic = CLAMP(
  SUM(uta.affinity_score) / GREATEST(1.0, cardinality(h.topic_tags)),
  -0.5,
  1.0
) / GREATEST(5.0, v_user_topic_max)
```

Where `v_user_topic_max` is `MAX(affinity_score) FROM user_topic_affinity WHERE user_id = p_user_id` (M3 dynamic normalization).

**S4 — Explore slot randomization.** Explore slots are not fixed at positions 3 and 7. Instead, within a 10-card page: pick 2 positions randomly from `{2,3,4}` and `{6,7,8}` respectively, seeded by `hashtext(p_user_id::text || p_cursor_epoch::text)`. Same seed = same positions for the same page request (reproducible for debug). Different page = different positions.

**NM2 — dynamic `S_creator` ceiling.** `S_creator` now uses the same dynamic normalization pattern as `S_topic` (M3). A user who has two 10-min sessions with a creator accumulates ~7.0 creator affinity (2.0 mic_tap + 1.5 session boost × 2), which exceeds the hardcoded 5.0 ceiling and loses resolution at 1.0 for all further sessions. Fix:

```sql
-- Computed once per feed_ranked_page call alongside v_user_topic_max.
SELECT GREATEST(5.0, COALESCE(MAX(affinity_score), 5.0))
  INTO v_user_creator_max
  FROM public.user_creator_affinity
 WHERE user_id = p_user_id;

-- S_creator formula (replaces hardcoded /5.0):
LEAST(1.0, GREATEST(0, COALESCE(uca.affinity_score, 0) / v_user_creator_max))
```

`compute_hook_score()` accepts `p_user_creator_max real DEFAULT 5.0` as a new parameter alongside the existing `p_user_topic_max`.

**NC3 — `feed_ranked_anon_page` DDL.** The anon feed path needs its own RPC because:
- No `auth.uid()` available; identity comes from `p_anon_id`.
- Grant semantics differ: `authenticated` role should NOT have EXECUTE (it calls `feed_ranked_page`); only the service-role API route calls this.
- Returns the same column set as `feed_ranked_page` except `score_breakdown` is always NULL (nothing to explain for anon — M11).

```sql
CREATE OR REPLACE FUNCTION public.feed_ranked_anon_page(
  p_anon_id      uuid,
  p_limit        int    DEFAULT 10,
  p_cursor_epoch bigint DEFAULT NULL
) RETURNS TABLE (
  hook_id         uuid,
  -- same feed columns as feed_ranked_page --
  score_total     real,
  score_breakdown jsonb,   -- always NULL for anon (no user state to explain)
  served_rank     int,
  cursor_epoch    bigint
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_anon record;
BEGIN
  -- Validate anon session.
  SELECT topic_affinity, creator_affinity INTO v_anon
    FROM public.anon_feed_sessions
   WHERE anon_id = p_anon_id;
  IF NOT FOUND THEN
    -- Unknown or expired anon_id — return quality-ordered feed with no affinity.
    v_anon.topic_affinity   := '{}'::jsonb;
    v_anon.creator_affinity := '{}'::jsonb;
  END IF;

  -- Lite scorer: W_GLOBAL × S_global + W_RECENCY × S_recency + W_COLD × S_cold_anon.
  -- W_TOPIC, W_CREATOR, W_REPEAT, W_EXPLORE all 0 (no normalized user state).
  -- S_cold_anon uses v_anon.topic_affinity jsonb blob for overlap with h.topic_tags.
  RETURN QUERY
    SELECT
      h.id                                   AS hook_id,
      -- ... standard feed columns from hooks_public view join ...
      (  0.4 * COALESCE(hgs.global_quality, 0)
       + 0.3 * (1.0 / (1.0 + LN(1 + EXTRACT(EPOCH FROM (now() - COALESCE(h.published_at, h.created_at))) / 86400)))
       + 0.5 * LEAST(1.0, COALESCE((v_anon.topic_affinity->>t.slug)::real, 0) / 2.0)
      )::real                                AS score_total,
      NULL::jsonb                            AS score_breakdown,
      ROW_NUMBER() OVER (ORDER BY score_total DESC)::int AS served_rank,
      EXTRACT(EPOCH FROM now())::bigint      AS cursor_epoch
    FROM public.hooks h
    JOIN public.videos v   ON v.id = h.video_id
    JOIN public.creators c ON c.id = v.creator_id
    LEFT JOIN public.hook_global_stats hgs ON hgs.hook_id = h.id
    LEFT JOIN LATERAL (
      SELECT tag AS slug FROM unnest(h.topic_tags) AS t(tag)
      ORDER BY COALESCE((v_anon.topic_affinity->>tag)::real, 0) DESC
      LIMIT 1
    ) t ON TRUE
    WHERE h.published_at IS NOT NULL
      AND v.published_at IS NOT NULL
      AND c.published_at IS NOT NULL
      AND c.creator_type = 'human'
    ORDER BY score_total DESC
    LIMIT p_limit;
END;$$;

REVOKE EXECUTE ON FUNCTION public.feed_ranked_anon_page(uuid, int, bigint) FROM public;
-- Service-role only. The anon feed route (/api/feed) calls this via supabaseAdmin().
-- No grant to anon or authenticated roles.
```

---

**Migration 9 — admin RPCs (C2, C3, C7)**

Admin guard canonical predicate (C3) — used in every admin_algo_* function:

```sql
-- Template. p_caller := auth.uid() checked against admin_roles.
IF NOT EXISTS (
  SELECT 1 FROM public.admin_roles
   WHERE user_id = auth.uid()
     AND revoked_at IS NULL    -- C3: revoked admins denied
) THEN
  RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
END IF;
```

Audit log on every call (C2) — written before returning results:

```sql
INSERT INTO public.admin_audit_log
  (admin_user_id, action, target_id, metadata)
VALUES (
  auth.uid(), 'algo_profile_viewed', p_user_id,
  jsonb_build_object('rpc', 'admin_algo_user_summary', 'ts', now())
);
```

`admin_audit_log` table already exists from migration `20260502000004_admin_audit_and_tier_flip.sql`.

**Natural-language narrative RPC (C7):**

```sql
CREATE OR REPLACE FUNCTION public.admin_algo_score_explain_narrative(
  p_user_id uuid, p_hook_id uuid
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_breakdown jsonb;
  v_top_topic text;
  v_s_topic real;
  v_s_creator real;
  v_s_recency real;
  v_age_days real;
  v_narrative text;
BEGIN
  -- Admin guard (C3 predicate — see canonical template above).
  ...

  -- Audit log (C2).
  INSERT INTO public.admin_audit_log (admin_user_id, action, target_id, metadata)
  VALUES (auth.uid(), 'algo_score_explain', p_user_id,
          jsonb_build_object('hook_id', p_hook_id));

  -- Get breakdown from the shared scorer function.
  SELECT public.compute_hook_score(p_user_id, p_hook_id) INTO v_breakdown;

  v_top_topic  := v_breakdown->>'top_topic';
  v_s_topic    := (v_breakdown->'components'->>'S_topic')::real;
  v_s_creator  := (v_breakdown->'components'->>'S_creator')::real;
  v_s_recency  := (v_breakdown->'components'->>'S_recency')::real;
  v_age_days   := (v_breakdown->>'age_days')::real;

  -- Template a 1–2 sentence plain-English explanation.
  v_narrative := format(
    'Ranked #%s — %s%s%s',
    v_breakdown->>'served_rank',
    -- Topic signal sentence.
    CASE
      WHEN v_s_topic > 0.5 THEN
        format('strong match on your top topic "%s" (affinity %.2f)', v_top_topic, v_s_topic)
      WHEN v_s_topic > 0.1 THEN
        format('moderate match on "%s"', v_top_topic)
      WHEN v_s_topic < 0 THEN
        format('you''ve dismissed "%s" content before — served as exploration', v_top_topic)
      ELSE 'new topic you haven''t seen yet — served to expand your taste'
    END,
    -- Creator signal addition.
    CASE
      WHEN v_s_creator > 0.3 THEN format(', creator you''ve engaged with (affinity %.2f)', v_s_creator)
      WHEN v_s_creator < -0.1 THEN ', creator you tend to skip'
      ELSE ''
    END,
    -- Recency note.
    CASE
      WHEN v_age_days < 2   THEN '. Just published.'
      WHEN v_s_recency < 0.3 THEN format('. Recency score reduced (%s days old).', ROUND(v_age_days))
      ELSE '.'
    END
  );

  RETURN v_narrative;
END;$$;
```

The admin UI renders this sentence in a styled callout above the component breakdown table. No extra network call — the same `admin_algo_score_explain` response returns both `breakdown` and `narrative` in one envelope.

---

## 4. Cold-start rule

### 4.1 Four regimes

```
A. Anon, no history:
   → lite scorer (W_GLOBAL × S_global + W_RECENCY × S_recency, no user state).
   → Gives reviewer a quality-ordered feed from the first swipe, not raw chronological (M11).
   → Swipes logged to anon_feed_sessions; anon affinity accumulates.

B. Anon with history (event_count >= 3) OR authenticated with interest_slugs, profiles.feed_regime='B':
   → lite scorer + W_COLD × S_cold (interest_slugs or anon affinity).
   → 80/20 exploit/explore.

C. Authenticated, profiles.feed_regime='C' (meaningful engagement — NM4):
   → full scorer (§5). interest_slugs becomes a tiebreaker only.
   → Regime check reads profiles.feed_regime (a single indexed column), not a COUNT(*) scan.
   → Regime is written by the rollup trigger (migration 6) when the user crosses the C5 threshold.

D. Exhausted (candidate count after cooldowns < 5):
   → regime D: progressive cooldown relaxation.
   → Step 1: drop impression-only cooldowns (hooks with only a hook_impression event,
              no dwell-end or negative swipe).
   → Step 2: drop dwell-based cooldowns (completion < 0.8).
   → Step 3: relax to minimum "never re-serve" set: mic_tap 30d + full_100 14d hard floor.
   → score_breakdown.regime = 'D' so admin can see when users are cycling.
```

**Meaningful engagement depth (C5).** Regime C triggers on:

```sql
engagement_depth >= 1
WHERE engagement_depth = (
  SELECT COUNT(*) FROM public.feed_events_raw
   WHERE user_id = p_user_id
     AND skipped_reason IS NULL
     AND (
       (event_name = 'hook_dwell_end'
        AND (payload->>'completion_pct')::real >= 0.8)
       OR event_name = 'full_video_open'
       OR (event_name = 'mic_tap'
           AND payload->>'mic_tap_outcome' = 'session_opened')
     )
)
```

One completed hook, one full-video open, or one mic-tap. That is "meaningful." Doom-scrolling three pages doesn't qualify.

### 4.2 Interest_slugs onboarding

- **Vocabulary:** `SELECT DISTINCT slug FROM creator_topics WHERE EXISTS (SELECT 1 FROM creators c WHERE c.id=creator_id AND c.published_at IS NOT NULL)`. At N=1 creator = 5 chips.
- **Onboarding placement (open question #2):** post-signup dedicated screen is recommended. See §11.
- **Skip copy (S6):** UI must show explicit skip option: *"Pick a few topics or dive in — we'll learn from what you watch."* Not a dark pattern. `interest_slugs = '{}'` is a valid state; regime A handles it.
- **Min/max:** UI enforces 1–5 for best UX (more meaningful signal); DB cap is 20 for future slack. Skip bypasses the min.

### 4.3 Anon cookie + auth merge (C6)

This is not deferred. Every YC reviewer who opens the app in Incognito will swipe before signing up. Those swipes are behavioral data; throwing them away means session 1 post-signup feels cold.

**Cookie:** `oak_anon_id` (UUID), httpOnly, sameSite=lax, 1-year expiry. Minted server-side in the feed-batch route when `auth.uid() IS NULL` — the same route that handles authenticated events. On mint, create a row in `anon_feed_sessions`.

**Ingest path for anon:** `/api/events/feed-batch` checks auth.uid() first; if null, reads `oak_anon_id` cookie. If the anon cookie is present and the UUID exists in `anon_feed_sessions`, calls `ingest_feed_events_anon(p_anon_id, p_events)` (separate SECURITY DEFINER RPC — no auth.uid(), validated via cookie). If no anon cookie, mints one and creates the `anon_feed_sessions` row, sets the cookie on the response.

**Anon affinity updates:** `ingest_feed_events_anon` applies the same EMA weights to the jsonb blobs in `anon_feed_sessions.topic_affinity` and `creator_affinity`. No normalized per-event rows — just the scalar summary. Fast and cheap.

**Auth merge:** called from `src/app/auth/callback/route.ts` after successful login/signup. Reads `oak_anon_id` cookie, calls `merge_anon_feed_state(anon_id, new_user_id)` server-side. Clears the anon cookie on the response.

**Regime for anon:** same A/B/C/D structure. Anon has no `interest_slugs`; falls through regime A → B as their `anon_feed_sessions.event_count` accumulates. The lite scorer reads their `topic_affinity` jsonb blob once it's non-empty.

---

## 5. The scoring function v1

### 5.1 Architecture decision: shared scorer function

Both the live feed and the admin debugger call **one function**:

```sql
-- Returns the component breakdown for a single (user, hook) pair.
-- Called by: (1) feed_ranked_page in a LATERAL scan over candidates
--            (2) admin_algo_score_explain for the "why this hook?" UI
-- No drift between them is possible.
CREATE OR REPLACE FUNCTION public.compute_hook_score(
  p_user_id uuid,
  p_hook_id uuid,
  p_slot_type text DEFAULT 'exploit',       -- 'exploit' | 'explore'
  p_regime    text DEFAULT 'C',             -- 'A' | 'B' | 'C' | 'D'
  p_consecutive_creator_streak int DEFAULT 0,
  p_user_topic_max real DEFAULT 5.0,        -- dynamic normalization ceiling (M3)
  p_interest_slugs text[] DEFAULT '{}'      -- for regime B/C cold bonus
) RETURNS jsonb ...
```

### 5.2 Scorer signature (feed_ranked_page)

```sql
CREATE OR REPLACE FUNCTION public.feed_ranked_page(
  p_limit            int DEFAULT 10,
  p_cursor_epoch     bigint DEFAULT NULL,
  p_exclude_hook_ids uuid[] DEFAULT '{}'::uuid[]   -- capped at 50 (M4)
) RETURNS TABLE (
  hook_id         uuid,
  ...same columns as feed_page...,
  score_total     real,
  score_breakdown jsonb,    -- stripped from non-admin API response in route layer (C1)
  served_rank     int,
  cursor_epoch    bigint
) ...
```

### 5.3 Scoring formula (signed, full)

```
score(u, h) = W_TOPIC    × S_topic(u, h)         -- signed [-0.5, 1.0] (M6)
            + W_CREATOR  × S_creator(u, h)        -- [0, 1.0]
            + W_RECENCY  × S_recency(h)            -- C4: uses published_at
            + W_GLOBAL   × S_global(h)
            + W_EXPLORE  × S_explore(u, h)        -- non-zero on explore slots only
            + W_COLD     × S_cold(u, h)            -- non-zero in regimes A/B
            - W_REPEAT   × P_repeat_creator(consecutive streak, M8)
```

**No P_recently_seen in the formula.** Seen hooks are excluded via the on-the-fly cooldown CTE (M5) — a hard filter, not a soft penalty. Hybrid soft-then-hard is confusing to debug.

**Default weights:**

```
W_TOPIC = 1.0  W_CREATOR = 0.6  W_RECENCY = 0.3  W_GLOBAL = 0.4
W_EXPLORE = 0.8  W_COLD = 0.5  W_REPEAT = 0.5
```

**S_topic (signed, M6 + M3):**

```sql
S_topic = GREATEST(-0.5, LEAST(1.0,
  COALESCE(
    SUM(uta.affinity_score) / GREATEST(1.0, cardinality(h.topic_tags)),
    0
  )
)) / GREATEST(5.0, p_user_topic_max)
```

`p_user_topic_max` is computed once per `feed_ranked_page` call:
```sql
SELECT GREATEST(5.0, COALESCE(MAX(affinity_score), 5.0))
  INTO v_user_topic_max
  FROM public.user_topic_affinity
 WHERE user_id = p_user_id;
```

**S_creator (NM2 — dynamic ceiling, same pattern as M3):**
```sql
-- v_user_creator_max computed once per feed_ranked_page call:
SELECT GREATEST(5.0, COALESCE(MAX(affinity_score), 5.0))
  INTO v_user_creator_max
  FROM public.user_creator_affinity
 WHERE user_id = p_user_id;

-- S_creator formula:
LEAST(1.0, GREATEST(0, COALESCE(uca.affinity_score, 0) / v_user_creator_max))
```

Rationale: 2 sessions with the same creator accumulates ~7.0 affinity (2.0 mic_tap + 1.5 session boost × 2). With the hardcoded 5.0 ceiling, the creator score saturates at 1.0 and loses ranking resolution permanently. Dynamic max scales with the user's actual engagement range. `compute_hook_score()` accepts `p_user_creator_max real DEFAULT 5.0` as a new parameter.

**S_recency (C4 — published_at):**
```sql
1.0 / (1.0 + LN(1 + EXTRACT(EPOCH FROM (now() - COALESCE(h.published_at, h.created_at))) / 86400))
```

**S_global:**
```sql
COALESCE(hgs.global_quality, 0)   -- Laplace-smoothed open-through-rate
```

**S_explore:**
```sql
CASE WHEN p_slot_type = 'explore'
      AND EXISTS (
        SELECT 1 FROM unnest(h.topic_tags) t
        LEFT JOIN user_topic_affinity uta
          ON uta.user_id = p_user_id AND uta.topic_slug = t
        WHERE uta.impressions IS NULL OR uta.impressions < 3
      )
     THEN S_global
     ELSE 0
END
```

**S_cold:**
```sql
LEAST(1.0,
  cardinality(
    ARRAY(SELECT UNNEST(h.topic_tags) INTERSECT SELECT UNNEST(p_interest_slugs))
  )::real / 3.0
)
```

**P_repeat_creator (consecutive streak, M8):**

The scorer is passed `p_consecutive_creator_streak` — computed in `feed_ranked_page` before calling `compute_hook_score` by scanning the trailing impressions in the user's recent event stream. "Consecutive" = how many of the last N impressions before this candidate were from the same creator, counting from the tail of the ordered list and stopping at the first different creator.

```
streak = 0 or 1 → P_repeat_creator = 0.0
streak = 2      → P_repeat_creator = 0.2
streak >= 3     → P_repeat_creator = 0.8
```

### 5.4 Lite scorer for anon (M11)

When `auth.uid() IS NULL` (or no feed_events_raw signal), the route calls `feed_ranked_anon_page` — same RPC skeleton but only activates W_GLOBAL, W_RECENCY, and W_COLD (from anon_topic_affinity jsonb). W_TOPIC, W_CREATOR, W_REPEAT, W_EXPLORE are 0 (no user state). Returns the same column set. No `score_breakdown` returned (nothing to explain for anon).

Result: a quality-ordered feed from the first visit — "here are the best hooks in descending quality" rather than raw `created_at DESC`. Feels intelligent without requiring any account.

### 5.5 Explore/exploit interleaving (S4 — randomized slots)

Slot assignment for a 10-card page:

- 8 exploit slots, 2 explore slots.
- Explore slot 1: a randomly-selected position within `{2, 3, 4}` (early-feed exploration).
- Explore slot 2: a randomly-selected position within `{6, 7, 8}` (mid-feed exploration).
- Positions `{0, 1, 5, 9}` are always exploit — don't put exploration at #1 (kills first impression) or #10 (users rarely get there).
- Random selections seeded by `hashtext(p_user_id::text || p_cursor_epoch::text)`. Deterministic per (user, page); different across pages.

### 5.6 score_breakdown shape (for admin; stripped from user API, C1)

```json
{
  "regime": "C",
  "top_topic": "cold_outreach",
  "age_days": 7.2,
  "components": {
    "S_topic": 0.72, "S_creator": 0.41, "S_recency": 0.34,
    "S_global": 0.55, "S_explore": 0.0, "S_cold": 0.0
  },
  "weighted": {
    "W_TOPIC × S_topic":     0.720,
    "W_CREATOR × S_creator": 0.246,
    "W_RECENCY × S_recency": 0.102,
    "W_GLOBAL × S_global":   0.220,
    "W_EXPLORE × S_explore": 0.000,
    "W_COLD × S_cold":       0.000,
    "- W_REPEAT × P_repeat": 0.000
  },
  "score_total": 1.288,
  "served_rank": 3,
  "slot_type": "exploit"
}
```

---

## 6. Write-path architecture

### 6.1 C1 — score_breakdown stripped from non-admin responses

`/api/feed/route.ts` calls `feed_ranked_page` on the service-role client, **then strips `score_breakdown` and `score_total` before returning to the browser**. Only `hook_id`, feed columns, and `served_rank` reach the user. The full breakdown is written to the server-side impression log for the admin surface, not transmitted over the wire.

```typescript
// src/app/api/feed/route.ts (addition)
const { data: rawRows } = await sbAdmin.rpc('feed_ranked_page', { ... });

// C1: strip algo side-channel before sending to browser.
const publicRows = (rawRows ?? []).map(({ score_breakdown, score_total, ...rest }) => rest);

// NC4: logScoredImpressions is NOT needed and NOT defined.
// The admin score_explain surface calls compute_hook_score() live via the
// admin_algo_score_explain RPC — there is no replay table. The hook_impression
// event written by the client batch already records what was served (served_rank
// in the payload). score_breakdown is never persisted to a separate table.

return NextResponse.json({ items: publicRows, nextCursor: ... });
```

The admin `score_explain` path fetches directly via service-role (never through `/api/feed`) and gets the full breakdown.

### 6.2 Server route `/api/events/feed-batch`

Changes: M2 SQLSTATE handling, S1 per-user rate limit.

```typescript
export async function POST(req: Request) {
  const sb = await supabaseServer();
  const admin = supabaseAdmin();

  // M2: map SQLSTATE 28000 → 401, not 403.
  // (42501 from ingest RPC means forbidden, not unauthenticated.)

  const ip = getClientIp(req);
  const { data: user } = await sb.auth.getUser();

  // S1 + NM1: per-user rate limit + per-IP rate limit. Either triggers 429.
  // rate_limit_hit is defined in migration 7a (20260503000007_ingest_feed_events_rpc.sql).
  const [ipAllowed, userAllowed] = await Promise.all([
    admin.rpc('rate_limit_hit', { p_scope:'feed_events', p_key: ip,
                                   p_window:'1 minute', p_limit: 1200 }),
    user?.user?.id
      ? admin.rpc('rate_limit_hit', { p_scope:'feed_events_user',
                                       p_key: user.user.id,
                                       p_window:'1 minute', p_limit: 600 })
      : Promise.resolve({ data: true }),
  ]);
  if (ipAllowed.data === false || userAllowed.data === false) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  if (!user?.user) {
    // Anon path: mint or read oak_anon_id cookie, call ingest_feed_events_anon.
    return handleAnonBatch(req, admin);
  }

  const body = await req.json();
  const { data, error } = await sb.rpc('ingest_feed_events', { p_events: body.events });
  if (error) {
    // M2: translate SQLSTATE 28000 to 401 for client auth flow.
    const status = error.code === '28000' ? 401 : 500;
    return NextResponse.json({ error: error.code }, { status });
  }
  return NextResponse.json({ ok: true, ...data?.[0] });
}
```

### 6.3 Client queue

File: `src/lib/feed-events/queue.ts`. Same flush-on-swipe, 2s timer, sendBeacon + fetch keepalive fallback as original plan. M4 client-side cap: queue splice is `queue.splice(0, 50)`. Additionally, **exclude_hook_ids** list in the feed state is truncated to last 50 before being passed to `feed_ranked_page` (prevents unbounded URL growth).

---

## 7. Admin observability — `/admin/algo/<user_id>`

### 7.1 Page layout

```
┌─────────────────────────────────────────────────────────────────┐
│  User @vukpjescic · tier=free · tz=Europe/Belgrade             │
│  Onboarded 2026-04-12 · interest_slugs: [cold_outreach, ...]  │
│  Regime C · 30d events: 412 · engagement_depth: 38            │
├─────────────────────────────────────────────────────────────────┤
│  TOP 5 TOPICS                │  TOP 5 CREATORS                 │
│  cold_outreach  +2.41        │  @vukpjescic      +4.12         │
│  build_in_public +1.89       │  @melanie_perkins +1.23         │
│  raising_seed   +1.55        │                                  │
│  saas_pricing   -0.32 ◀ neg  │                                  │
├─────────────────────────────────────────────────────────────────┤
│  EXPLOIT / EXPLORE (last 7d)                                    │
│  ████████████████░░░░░  exploit 82% / explore 18%              │
├─────────────────────────────────────────────────────────────────┤
│  FUNNEL (last 30d)                                              │
│  impressions 2140 → dwell>2s 1405 → full_open 312 →            │
│  quartile_50 186 → mic_tap 34  (mic_tap_rate = 1.59%)          │
├─────────────────────────────────────────────────────────────────┤
│  "WHY THIS HOOK?" DEBUGGER                                      │
│  [ hook_id _________________________ ] [ Explain ]             │
│                                                                 │
│  ╔══════════════════════════════════════════════════════════╗  │
│  ║ Ranked #3 — strong match on your top topic               ║  │
│  ║ "cold_outreach" (affinity 0.72), creator you've engaged  ║  │
│  ║ with recently (0.41). Content is 7 days old.             ║  │
│  ╚══════════════════════════════════════════════════════════╝  │
│                                                                 │
│  Component breakdown:                                           │
│  S_topic   0.72 × W_TOPIC 1.0  = 0.720                        │
│  S_creator 0.41 × W_CREATOR 0.6= 0.246                        │
│  ...                                                            │
├─────────────────────────────────────────────────────────────────┤
│  LAST 50 FEED EVENTS                                            │
│  [event stream table]                                           │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 Backing RPCs — C2 audit log + C3 revoked_at IS NULL

Every admin_algo_* RPC:
1. Checks `admin_roles WHERE user_id = auth.uid() AND revoked_at IS NULL` (C3). Fails with `42501` if not found.
2. Inserts an `admin_audit_log` row with `action='algo_profile_viewed'`, `target_id=p_user_id`, `metadata={rpc, ts}` (C2).
3. Returns results.

RPCs:
- `admin_algo_user_summary(p_user_id)` — profile + regime + event counts
- `admin_algo_top_topics(p_user_id, limit=5)` — includes sign on affinity_score
- `admin_algo_top_creators(p_user_id, limit=5)`
- `admin_algo_funnel_30d(p_user_id)` — impression → mic_tap funnel
- `admin_algo_recent_events(p_user_id, limit=50)` — event stream
- `admin_algo_score_explain(p_user_id, p_hook_id)` → calls `compute_hook_score()` and `admin_algo_score_explain_narrative()` in one response
- Note: `admin_algo_score_explain` and `feed_ranked_page` both call `compute_hook_score()` — same function, no divergence.
- **Regime clarification (Round 2 audit):** the explainer always passes `p_regime='C'` to `compute_hook_score()` for consistency and readability. If the user is actually in regime B (just onboarded), the narrative reflects full-scorer weights — not what was actually served. A one-line note is rendered in the admin UI: *"Score shown uses regime C weights. Actual served score at impression time may have used regime A or B."* This is acceptable for a debugger; correctness > perfect fidelity.

---

## 8. Cost model

| Metric | 10 DAU | 100 DAU | 1 000 DAU |
|---|---|---|---|
| Sessions/day (×1.5) | 15 | 150 | 1 500 |
| Events/day (~120/session) | 1 800 | 18k | 180k |
| Raw bytes/day | 630 KB | 6.3 MB | 63 MB |
| Raw bytes / 90d | 57 MB | 567 MB | 5.7 GB |
| Anon sessions rows | ~2× DAU/d | — | — |
| Rollup rows total | ~500 | ~5k | ~50k |
| COGS delta | **$0** | **$0** | **$0** |

**Hot-path latency:**
- Feed render → event enqueued: <1ms (in-memory push)
- Scorer call p95: <100ms at 1k DAU (indexed candidate scan + top-K sort)
- Event batch flush RTT (background): <150ms p95 (amortized over 10-event batches)
- Admin score_explain: <50ms (single-row compute via shared function)

At 10k DAU, daily partitioning on `feed_events_raw` by `created_at` becomes urgent. Tag it as the schema evolution trigger.

---

## 9. pgTAP test plan

Target: **35+ new tests**, green alongside existing 40 before merge. Run with `supabase test db`.

### 9.1 RLS

- `feed_events_raw_user_a_cannot_read_user_b` — cross-user SELECT denied
- `user_topic_affinity_own_read_only` — cross-user SELECT denied
- `user_creator_affinity_own_read_only` — same
- `hook_global_stats_service_role_only` — no anon/auth policies
- `anon_feed_sessions_service_role_only` — zero policies

### 9.2 Ingest RPC

- `ingest_feed_events_rejects_unauthenticated` — `28000` SQLSTATE (not `42501`, M2)
- `ingest_feed_events_dedupes_by_idempotency_key`
- `ingest_feed_events_dead_zone_swipe_skipped_reason_set`
- `ingest_feed_events_batch_size_cap_51_events_rejected`
- `ingest_feed_events_mic_tap_session_id_verified` — session belonging to other user → session_id nulled, row still inserted (M1)
- `ingest_feed_events_per_user_rate_limit` — 601 events/min from same user triggers 429 (S1)

### 9.3 Rollup trigger

- `rollup_updates_topic_affinity_on_impression`
- `rollup_decay_formula_14d_half_life` — seed event at t0; UPDATE `last_event_at = now() - interval '14 days'` (NOT pg_sleep, S3); insert second event; assert `affinity_score ≈ 0.5 × old + new_weight` to 4 decimal places
- `rollup_mic_tap_biggest_weight`
- `rollup_negative_swipe_drives_score_below_zero` — fast-dismiss, assert affinity_score < 0 (M6)
- `rollup_dead_zone_does_not_update_affinity`
- `rollup_global_quality_laplace_smoothing`
- `rollup_session_close_boosts_creator_affinity_proportional` — AFTER UPDATE sessions.status='ended' with active_seconds=300 → creator affinity += ~0.75 (M7)
- `rollup_session_close_under_30s_ignored` — active_seconds=20 → no boost (M7)

### 9.4 Scorer

- `scorer_deterministic_same_cursor_epoch`
- `scorer_cold_start_regime_A_chronological` — no anon state → quality-ordered via global_quality
- `scorer_cold_start_regime_B_interest_slugs_wins_tiebreak`
- `scorer_regime_C_behavior_dominates` — 5 engagement events beats interest_slugs rank
- `scorer_regime_D_relaxes_cooldowns_when_exhausted` — seed all hooks with strong cooldowns; assert regime D returns results with progressively relaxed policy (M10)
- `scorer_negative_topic_penalizes_rank` — topic with affinity=-0.3 ranks below neutral topics (M6)
- `scorer_seen_policy_mic_tap_excluded_30d` — via cooldown CTE (M5), not MV
- `scorer_cooldown_cte_no_mv_used` — confirm `pg_matviews` does not contain a `user_hook_cooldowns` entry
- `scorer_repeat_creator_consecutive_streak_penalty` — fill last N impressions with same creator; assert P_repeat_creator = 0.8 (M8)
- `scorer_repeat_creator_penalty_resets_on_different_creator` — interleave different creator; streak resets to 0
- `scorer_score_breakdown_has_all_components`
- `scorer_compute_hook_score_and_feed_ranked_page_agree` — call both with same args; assert `score_total` differs by < 1e-4 (sanity call 7)

### 9.5 Admin RPCs

- `admin_algo_rpcs_deny_non_admin` — every admin_algo_* returns `42501` for non-admin
- `admin_algo_rpcs_deny_revoked_admin` — revoked_at = now() → still denied (C3)
- `admin_algo_rpcs_write_audit_log` — call any admin_algo_* RPC; assert admin_audit_log row written (C2)
- `admin_algo_score_explain_narrative_returns_string` — non-empty, contains hook rank (C7)

### 9.6 Anon identity

- `anon_feed_sessions_service_role_only`
- `merge_anon_feed_state_blends_ema_into_user_affinity` — seed anon state; call merge; assert user_topic_affinity populated with blend (C6)
- `merge_anon_feed_state_deletes_anon_row_after_merge`
- `merge_anon_feed_state_noop_when_anon_id_not_found`

### 9.7 Retention

- `retention_sweep_deletes_90d_rows`
- `retention_sweep_preserves_mic_taps_forever`
- `retention_sweep_preserves_rollup_tables`
- `anon_gc_deletes_30d_inactive` (from migration 10)

### 9.8 Round 2 findings coverage

- `ingest_feed_events_anon_updates_topic_affinity_blob` — seed anon session; call RPC with hook_impression; assert topic_affinity key present and correct weight (NC1)
- `ingest_feed_events_anon_rejects_unknown_anon_id` — SQLSTATE 28000 when anon_id not in table (NC1)
- `ingest_feed_events_anon_negative_swipe_drives_score_below_zero` — fast-dismiss swipe; assert topic_affinity value < 0 (NC1 + M6 parity)
- `ingest_feed_events_anon_caps_batch_at_50` — 51 events → SQLSTATE 22023 (NC1)
- `hooks_table_has_topic_tags_column` — `SELECT topic_tags FROM hooks LIMIT 1` does not throw (NC2 verification; simple schema assertion)
- `feed_ranked_anon_page_returns_quality_ordered_results` — no anon state → hooks ordered by global_quality desc (NC3)
- `feed_ranked_anon_page_uses_anon_affinity_for_cold_boost` — seed anon topic blob; assert matching-topic hook ranks above equal-quality non-matching hook (NC3 + M11)
- `feed_ranked_anon_page_unknown_anon_id_falls_back_gracefully` — non-existent anon_id → returns global quality order, no error (NC3)
- `feed_ranked_anon_page_grant_service_role_only` — authenticated role does not have EXECUTE on feed_ranked_anon_page (NC3)
- `api_feed_route_no_log_scored_impressions_function_exists` — assert no function named `log_scored_impressions` (NC4 tombstone; TypeScript compile test equivalent)
- `rate_limit_hit_returns_false_when_limit_exceeded` — call 601 times on same (scope, key); assert 601st returns false (NM1)
- `rate_limit_hit_resets_on_new_window` — call 600 times, advance window_start by 2 min, call 1 more time; assert true (NM1)
- `scorer_s_creator_dynamic_ceiling_preserves_resolution` — seed creator affinity = 7.0 (post-2-session accumulation); assert S_creator < 1.0 with dynamic ceil vs 1.0 with hardcoded 5.0 (NM2)
- `cooldown_cte_correlated_subquery_uses_composite_index` — `EXPLAIN` of feed_ranked_page call; assert plan references `feed_events_raw_user_video_event_idx` (NM3)
- `profiles_feed_regime_updates_to_b_on_first_engagement` — insert full_video_open event; assert profiles.feed_regime = 'B' (NM4)
- `profiles_feed_regime_updates_to_c_on_meaningful_engagement` — insert hook_dwell_end with completion_pct=0.9; assert profiles.feed_regime = 'C' (NM4 + C5)
- `profiles_feed_regime_not_downgraded` — set regime='C'; insert hook_impression (weight 0.02); assert regime stays 'C' (NM4 monotonicity)

---

## 10. Explicit deferrals (structural, not deadline)

| Deferred | Structural reason |
|---|---|
| Collaborative filtering | Sparse matrix at launch. Noise < signal. Ships v1.5. |
| Trained ML ranker | Zero labeled data until 30–60 days post-launch. Heuristic becomes warm-start. |
| pgvector / semantic embeddings | Topic drawers per CLAUDE.md. Explainability > magic at small N. Additional signal in v2. |
| Tier-based algo variants | **Forbidden by architecture (CLAUDE.md).** |
| Shadow A/B weight testing | No cohort tooling. Hardcoded weights; `feed_algo_weights` table is v1.1. |
| Per-creator cap enforcement beyond P_repeat | MMR re-ranking is overkill at N=1 creator. Revisit at N > 50 with user complaints. |
| Negative feedback UI ("Not interested") | Button + copy + education = 2-day scope. The swipe signal covers it. Post-YC. |
| Anon events in `feed_events_raw` | Anon state stays in `anon_feed_sessions` jsonb blobs (no normalized rows). Upgrades to full rows in v1.1 if we want per-event anon history. |

---

## 11. Open questions for Vuk

1. **Single-hook-per-card vs grouped-by-video.** Recommend flatten. Confirm the `feed-container.tsx` rebuild is in scope. ~2h client change.

2. **Interest_slugs onboarding placement.** Recommended: dedicated post-signup screen ("Pick up to 5 topics"), before first feed render. Alternative: embed in welcome-overlay. Impacts cold-start quality vs friction. Product call needed.

3. **Interest_slugs vocabulary.** At N=1 creator = 5 chips from creator_topics. After N=5 creators = potentially 25 chips. Cap the UI at top-20 by `global_quality` impressions? Curate a seed vocabulary independent of creator count?

4. **Mic-tap cooldown: 30 days.** Re-serves the same hook 30 days later. Feels right for "I want to have this conversation again after a month." Confirm.

5. **Weight tuning mechanism.** Hardcoded SQL constants (ship this). Optional: `/admin/algo/weights` editor (~3h extra) for live tuning during demo prep. Recommend YES for a YC demo knob.

6. **Creator carousel at N=1 hook.** Plan: cross-creator topic-overlap hooks fill the sheet + "More from @handle coming soon" tile. Confirm this UX over "disable tap" (which creates a dead zone and confuses first users).

7. **PostHog double-write.** Feed events land in Postgres (scorer input) and optionally PostHog (product analytics). Recommend: nightly batch ETL from `feed_events_raw` → PostHog via pg_cron + PostHog Batch API. Zero incremental cost, ~10 min lag acceptable for analytics. Confirm.

8. **`full_video_quartile=100` weight 1.0 vs mic_tap 2.0.** A 20-min completion is arguably deeper than a 10s mic-tap that closed. The auditor flagged this (sanity call 4). Current split: 2× completed videos ≈ 1 mic-tap in affinity points. Tune post-launch when we see actual completion:mic-tap ratios. Fine for now; note for v1.1 tuning.

9. **Anon cookie + iOS Safari ITP.** Safari's Intelligent Tracking Prevention can nuke httpOnly first-party cookies after 7 days of no interaction. `oak_anon_id` is first-party and set on direct navigation — should survive ITP. But users who come via link + don't return for a week will lose continuity. Acceptable for v1.

10. ~~Anon continuity deferred~~ — **resolved.** Ships in v1. See §4.3.

---

## 12. Rollout plan

Prereq: **Tier 1 test debt (V1_POLISH_ROADMAP.md) must be 40/40 green** before any algo migration lands.

| Day | Work | Deliverable |
|---|---|---|
| D1 | Migrations 0–5 + pgTAP §9.1, §9.6 | Schema live: anon state, event tables, affinity rollups |
| D2 | Migrations 6–7b + pgTAP §9.2–9.3 | Rollup trigger green; signed EMA; session-close boost wired |
| D3 | Migration 8 + pgTAP §9.4 | Scorer live; `compute_hook_score` shared; `feed_ranked_page` active for authenticated users |
| D4 | Client queue + `/api/events/feed-batch` (auth + anon paths) + flatten `FeedContainer` to `HookCard[]` | Events flowing in dev; anon cookie minting; single-hook-per-card feed |
| D5 | `CreatorCarouselSheet` (with sparse fallback, M9) + all client event hooks (impression, dwell, swipe, carousel, mic_tap) | First fully-instrumented session on staging |
| D6 | Migration 9 + pgTAP §9.5 + `/admin/algo/<userId>` page (narrative + table) | Admin surface live on staging |
| D7 | Migration 10 (retention + anon GC) + pgTAP §9.7 + interest_slugs onboarding screen | Feature-complete on staging |
| D8 | End-to-end on Pixel 7 Pro + iPhone 11; score_breakdown strip verified; admin demo rehearsal | rc2 tag, merge to main |

**If D5–D6 slip:** ship client instrumentation + scorer but keep score_breakdown logging as a separate async write that doesn't block the feed. The admin surface can launch 24h later — it reads from already-populated tables.

**YC demo script:** open `/admin/algo/<reviewer_user_id>` → pick any hook from the feed → click Explain → show narrative sentence + component table + confirm "this is why the feed is different for you vs me." Duration: < 90 seconds.

---

## 13. Appendix A — event payload schemas

```jsonc
// hook_impression — score persisted server-side only (C1)
{ "served_rank": 3, "served_at_ms": 1714567890000, "viewport_enter_ms": 320 }
// served_score_json sent by client but stripped before DB insert of user-facing response

// hook_dwell_end
{ "dwell_ms": 4200, "watched_ms": 3800, "completion_pct": 0.83, "audio_muted": false }

// hook_swipe
{ "direction": "right", "seconds_to_decision_ms": 2400, "completion_pct": 0.83 }

// full_video_open
{ "source": "swipe" }

// full_video_quartile
{ "quartile": 50, "watched_ms_in_view": 180000, "view_id": "v_..." }

// creator_carousel_open
{ "source": "avatar" }

// creator_carousel_hook_open
{ "carousel_position": 2 }

// mic_tap
{ "mic_tap_outcome": "session_opened", "session_id_if_opened": "sess_..." }
```

---

## 14. Appendix B — file index

**New files**
- `supabase/migrations/20260503000000_anon_feed_identity.sql`
- `supabase/migrations/20260503000001_algo_enums_and_interest_slugs.sql`
- `supabase/migrations/20260503000002_feed_events_raw.sql`
- `supabase/migrations/20260503000003_user_topic_affinity.sql`
- `supabase/migrations/20260503000004_user_creator_affinity.sql`
- `supabase/migrations/20260503000005_hook_global_stats.sql`
- `supabase/migrations/20260503000006_feed_events_rollup_trigger.sql`
- `supabase/migrations/20260503000007_ingest_feed_events_rpc.sql`
- `supabase/migrations/20260503000007b_session_close_affinity_trigger.sql`
- `supabase/migrations/20260503000008_feed_ranked_page_rpc.sql`
- `supabase/migrations/20260503000009_admin_algo_inspect_rpcs.sql`
- `supabase/migrations/20260503000010_feed_events_retention_pgcron.sql`
- `supabase/tests/algo/*.test.sql` (52+ files — includes §9.8 Round 2 coverage)
- `src/lib/feed-events/queue.ts`
- `src/lib/feed-events/types.ts`
- `src/app/api/events/feed-batch/route.ts`
- `src/app/admin/algo/page.tsx`
- `src/app/admin/algo/[userId]/page.tsx`
- `src/app/(feed)/hook-card.tsx`
- `src/app/(feed)/creator-carousel-sheet.tsx`

**Edited files**
- `src/app/(feed)/feed-container.tsx` — remove groupByVideo; render HookCard[]
- `src/app/(feed)/feed-types.ts` — drop VideoGroup; add scored hook fields
- `src/app/api/feed/route.ts` — call feed_ranked_page for auth users; strip score_breakdown (C1); keep feed_page for anon (overridden by lite scorer)
- `src/app/auth/callback/route.ts` — call merge_anon_feed_state + clear oak_anon_id cookie (C6)
- `src/app/page.tsx` — initial scored fetch
- `docs/V1_POLISH_ROADMAP.md` — tick algo-instrumentation block

---

*Rev 3 incorporates all findings from both audit rounds (C1–C7, M1–M11, S1–S6, NC1–NC4, NM1–NM4 + regime explainer clarification). Read §0, §5, §10, §11 first. Sections 0–7 contain the decisions; 8–12 are the engineering detail.*
