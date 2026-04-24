-- 0503-01 — feed event enums + profiles.interest_slugs + feed_regime
-- (algo plan §3.2 migration 1)
--
-- Enums are the schema-level spelling contract for every event-emitting
-- client. The rollup trigger (migration 6), the ingest RPCs (migrations 0
-- and 7a), and the admin surface (migration 9) all parse against these
-- enums; typos fail at INSERT, not in production.

CREATE TYPE feed_event_name AS ENUM (
  'hook_impression',
  'hook_dwell_end',
  'hook_swipe',
  'full_video_open',
  'full_video_quartile',
  'creator_carousel_open',
  'creator_carousel_hook_open',
  'mic_tap'
);

CREATE TYPE swipe_direction        AS ENUM ('up', 'down', 'left', 'right');
CREATE TYPE carousel_open_source   AS ENUM ('avatar', 'chip');
CREATE TYPE full_video_open_source AS ENUM ('swipe', 'carousel_hook', 'creator_profile');
CREATE TYPE mic_tap_outcome        AS ENUM (
  'session_opened',
  'kill_switch_blocked',
  'auth_required',
  'creator_not_ready',
  'unknown_error'
);

-- NM4: memoized cold-start regime per-profile. The rollup trigger promotes
-- users monotonically A → B → C as they cross engagement thresholds.
-- Regime D is transient (candidate exhaustion) and computed at call time.
CREATE TYPE feed_regime AS ENUM ('A', 'B', 'C', 'D');

-- profiles.interest_slugs (structured multi-select, regime-B seed) --------
-- Free-text goals[] / obstacles[] are kept for display only; they do NOT
-- drive the scorer. interest_slugs is the only cold-start signal.
--
-- Intentionally not FK'd to creator_topics(slug): the onboarding set is a
-- point-in-time snapshot. A stale slug becomes a no-op overlap in the
-- scorer (S_cold returns 0 for that tag). creator_topics.slug is already
-- rename/delete-protected by migrations 0012 + 0039.

-- S5: uniqueness helper. Postgres disallows subqueries inline in CHECK,
-- so the DISTINCT cardinality comparison lives behind an IMMUTABLE wrapper
-- (same pattern as _all_text_array_elems_within from migration 0001).
CREATE FUNCTION public._text_array_is_unique(arr text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT arr IS NULL
      OR cardinality(arr) = (SELECT count(*)::int
                               FROM (SELECT DISTINCT unnest(arr)) d);
$$;

REVOKE EXECUTE ON FUNCTION public._text_array_is_unique(text[]) FROM public;
GRANT  EXECUTE ON FUNCTION public._text_array_is_unique(text[]) TO authenticated, service_role;

ALTER TABLE public.profiles
  ADD COLUMN interest_slugs text[] NOT NULL DEFAULT '{}'
  CHECK (
    cardinality(interest_slugs) <= 20
    AND public._all_text_array_elems_within(interest_slugs, 40)
    -- S5: a duplicate slug would double-weight its signal in the S_cold
    -- scorer before the INTERSECT de-dupe at query time — subtle ranking bug.
    AND public._text_array_is_unique(interest_slugs)
  );

COMMENT ON COLUMN public.profiles.interest_slugs IS
  'Structured interest slugs matching creator_topics.slug; intentionally not FK. Cold-start signal only (regime B); not consulted once regime = C.';

-- profiles.feed_regime (NM4) ---------------------------------------------
-- Replaces a COUNT(*) scan over feed_events_raw on every feed call.
-- Default 'A' (anon/fresh). Rollup trigger (migration 6) bumps A→B on first
-- meaningful engagement (v_weight >= 0.6 OR mic_tap session_opened) and
-- A/B→C on C5-qualifying events (dwell completion>=0.8, full_video_open,
-- or mic_tap session_opened). Monotonic; no downgrade.

ALTER TABLE public.profiles
  ADD COLUMN feed_regime feed_regime NOT NULL DEFAULT 'A';

COMMENT ON COLUMN public.profiles.feed_regime IS
  'Memoized scoring regime updated by feed_events_raw_rollup trigger (migration 6); avoids COUNT(*) scan per feed call (NM4). Monotonic A->B->C.';

-- Audit C3 — one-shot backfill for users who already existed before this
-- column was added. The rollup trigger (migration 6, D2) won't retroactively
-- promote them, so without this backfill the admin seed account
-- (vukpjescic@gmail.com) and any rc1 testers would serve cold-start feeds
-- on first post-D2 page load — the opposite of the expected demo behavior.
--
-- Threshold proxy: a user who has accumulated >= 30 seconds of session
-- time has almost certainly opened a full video, pressed the mic, and had
-- a conversation (which is the C5 definition of "meaningful engagement").
-- Safer to over-promote a few idle testers to C than to under-serve active
-- ones. False positives re-settle at next event via the monotonic rollup
-- trigger — no way to downgrade, which is by design.
UPDATE public.profiles p SET feed_regime = 'C'
 WHERE p.feed_regime = 'A'
   AND EXISTS (
     SELECT 1 FROM public.sessions s
      WHERE s.user_id = p.id
        AND COALESCE(s.active_seconds, 0) >= 30
   );
