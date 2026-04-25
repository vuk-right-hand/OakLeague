-- 0503-17 — D5 audit H1: vertical 'up' swipe is neutral, not dead-zone.
--
-- Pre-fix compute_event_weight:
--   WHEN 'right' THEN 0.5
--   WHEN 'left'  THEN 0.0
--   ELSE  -- catches 'up' AND 'down'
--     CASE WHEN seconds_to_decision_ms < 2000
--               AND completion_pct < 0.2 THEN -0.3 ELSE -0.05 END
--
-- The asymmetry was wrong: horizontal-back ('left') was treated as a
-- neutral re-engagement (0.0), but vertical-back ('up') fell into the
-- generic ELSE branch and got penalized identically to 'down' (next-video
-- gesture). Users scrolling back UP to find a video they wanted to rewatch
-- got punished as if they hated the previous one.
--
-- Fix: 'up' gets the same neutral 0.0 as 'left'. Only 'down' (intentional
-- next-video) falls through to the dead-zone classifier — and now D5 M1
-- has wired completion_pct into the vertical swipe payload, so the
-- < 0.2 branch finally gets honest input instead of a default-0.

CREATE OR REPLACE FUNCTION public.compute_event_weight(
  p_event_name text,
  p_payload    jsonb
) RETURNS real
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT (CASE p_event_name
    WHEN 'hook_impression' THEN 0.02
    WHEN 'hook_dwell_end'  THEN
      LEAST(1.0, GREATEST(-0.3, COALESCE((p_payload->>'completion_pct')::real, 0)))
    WHEN 'hook_swipe' THEN
      CASE (p_payload->>'direction')
        WHEN 'right' THEN 0.5
        WHEN 'left'  THEN 0.0
        WHEN 'up'    THEN 0.0
        ELSE CASE WHEN COALESCE((p_payload->>'seconds_to_decision_ms')::int, 9999) < 2000
                       AND COALESCE((p_payload->>'completion_pct')::real, 0) < 0.2
                  THEN -0.3 ELSE -0.05 END
      END
    WHEN 'full_video_open' THEN 0.6
    WHEN 'full_video_quartile' THEN
      CASE COALESCE((p_payload->>'quartile')::int, 0)
        WHEN 25  THEN 0.2
        WHEN 50  THEN 0.4
        WHEN 75  THEN 0.6
        WHEN 100 THEN 1.0
        ELSE 0
      END
    WHEN 'creator_carousel_open'      THEN 0.4
    WHEN 'creator_carousel_hook_open' THEN 0.5
    WHEN 'mic_tap' THEN
      CASE (p_payload->>'mic_tap_outcome')
        WHEN 'session_opened' THEN 2.0
        ELSE 0.3
      END
    ELSE 0
  END)::real;
$$;

REVOKE EXECUTE ON FUNCTION public.compute_event_weight(text, jsonb) FROM PUBLIC, anon, authenticated;
