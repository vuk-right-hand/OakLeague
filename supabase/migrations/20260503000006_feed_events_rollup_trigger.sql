-- 0503-06 — feed_events_raw rollup trigger (algo plan §3.2 migration 6)
--
-- AFTER INSERT on feed_events_raw → updates three rollup tables:
--   (1) user_topic_affinity  — per-(user, topic_slug) signed EMA, 14d half-life
--   (2) user_creator_affinity — per-(user, creator_id), same formula
--   (3) hook_global_stats     — Laplace-smoothed quality, positive events only
--
-- And promotes profiles.feed_regime monotonically A→B→C so the scorer (D3)
-- can read regime from a single indexed column instead of COUNT-scanning
-- feed_events_raw per page load (NM4).
--
-- Weight table is sourced from public.compute_event_weight (migration 0).
-- The anon ingest path (ingest_feed_events_anon) and this authenticated
-- rollup both call the same function — drift between them is structurally
-- impossible (C1).

CREATE OR REPLACE FUNCTION public.feed_events_raw_rollup()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  HALF_LIFE_DAYS constant real := 14.0;
  -- Scalars (not a record) so the NULL-hook branch doesn't trip
  -- "record not yet assigned" when the event has no hook_id.
  v_hook_topic_tags text[];
  v_hook_creator_id uuid;
  v_creator_id uuid;
  v_tag    text;
  v_weight real;
  v_is_c5  boolean;
  v_completion_pct real;
BEGIN
  -- Skip dead-zone / skipped rows (they're kept in the raw table for debug,
  -- not propagated to affinity).
  IF NEW.skipped_reason IS NOT NULL THEN RETURN NULL; END IF;

  -- Resolve hook fields into scalars.
  v_hook_topic_tags := NULL;
  v_hook_creator_id := NULL;
  IF NEW.hook_id IS NOT NULL THEN
    SELECT h.topic_tags, v.creator_id
      INTO v_hook_topic_tags, v_hook_creator_id
      FROM public.hooks h
      JOIN public.videos v ON v.id = h.video_id
     WHERE h.id = NEW.hook_id;
  END IF;

  -- C1: single source of truth for event → weight mapping.
  v_weight := public.compute_event_weight(NEW.event_name::text, NEW.payload);

  v_completion_pct := COALESCE((NEW.payload->>'completion_pct')::real, 0);

  -- ---- Per-topic affinity upsert (signed EMA) ----
  IF v_hook_topic_tags IS NOT NULL THEN
    FOREACH v_tag IN ARRAY v_hook_topic_tags LOOP
      INSERT INTO public.user_topic_affinity AS t
        (user_id, topic_slug, impressions, dwell_ms_total, completions, full_opens,
         carousel_opens, mic_taps, negatives, affinity_score, last_event_at, updated_at)
      VALUES (
        NEW.user_id, v_tag,
        CASE WHEN NEW.event_name = 'hook_impression' THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_name = 'hook_dwell_end'
             THEN COALESCE((NEW.payload->>'dwell_ms')::int, 0) ELSE 0 END,
        CASE WHEN NEW.event_name = 'hook_dwell_end' AND v_completion_pct >= 0.8
             THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_name = 'full_video_open' THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_name = 'creator_carousel_open' THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_name = 'mic_tap'
              AND NEW.payload->>'mic_tap_outcome' = 'session_opened' THEN 1 ELSE 0 END,
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
        -- Signed EMA with HALF_LIFE_DAYS half-life. Score can go negative;
        -- scorer clamps at read time (M6).
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

  -- ---- Per-creator affinity upsert (same signed EMA) ----
  v_creator_id := COALESCE(v_hook_creator_id, NEW.creator_id);
  IF v_creator_id IS NOT NULL THEN
    INSERT INTO public.user_creator_affinity AS t
      (user_id, creator_id, impressions, full_opens, carousel_opens, mic_taps,
       negatives, affinity_score, last_event_at, updated_at, total_session_seconds)
    VALUES (
      NEW.user_id, v_creator_id,
      CASE WHEN NEW.event_name = 'hook_impression' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'full_video_open' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'creator_carousel_open' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'mic_tap'
            AND NEW.payload->>'mic_tap_outcome' = 'session_opened' THEN 1 ELSE 0 END,
      CASE WHEN v_weight < 0 THEN 1 ELSE 0 END,
      v_weight, NEW.created_at, NEW.created_at, 0
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

  -- ---- Global hook stats (positive events only) ----
  -- Laplace-smoothed open-through-rate with 3× mic-tap bonus:
  --   quality = (1 + full_opens + 3*mic_taps) / (10 + impressions)
  -- Prior of 0.1 prevents brand-new hooks from jumping to 100% quality after
  -- their first positive event.
  IF NEW.hook_id IS NOT NULL AND v_weight > 0 THEN
    INSERT INTO public.hook_global_stats AS g
      (hook_id, impressions, full_opens, mic_taps, avg_completion_pct,
       global_quality, last_event_at, updated_at)
    VALUES (
      NEW.hook_id,
      CASE WHEN NEW.event_name = 'hook_impression' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'full_video_open' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'mic_tap'
            AND NEW.payload->>'mic_tap_outcome' = 'session_opened' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'hook_dwell_end' THEN v_completion_pct ELSE 0 END,
      0, NEW.created_at, NEW.created_at
    )
    ON CONFLICT (hook_id) DO UPDATE SET
      impressions        = g.impressions + EXCLUDED.impressions,
      full_opens         = g.full_opens  + EXCLUDED.full_opens,
      mic_taps           = g.mic_taps    + EXCLUDED.mic_taps,
      avg_completion_pct = CASE
        WHEN NEW.event_name = 'hook_dwell_end'
        THEN ((g.avg_completion_pct * GREATEST(g.impressions, 1))
              + v_completion_pct)
             / (GREATEST(g.impressions, 1) + 1)
        ELSE g.avg_completion_pct
      END,
      global_quality = (1 + (g.full_opens + EXCLUDED.full_opens)
                           + 3 * (g.mic_taps + EXCLUDED.mic_taps))::real
                       / (10 + (g.impressions + EXCLUDED.impressions))::real,
      last_event_at  = NEW.created_at,
      updated_at     = NEW.created_at;
  END IF;

  -- ---- NM4: monotonic feed_regime promotion A→B→C ----
  -- B-gate: any event with v_weight >= 0.6 (full_video_open, dwell>=0.6, etc.)
  --          OR a mic_tap that actually opened a session.
  -- C-gate: stricter subset per §4.1 C5 — completion>=0.8 dwell OR full_video_open
  --          OR mic_tap session_opened. Does NOT include full_video_quartile=100
  --          by design (quartile=100 is passive completion; C reserves the jump
  --          for active engagement with a specific hook).
  IF v_weight >= 0.6
     OR (NEW.event_name = 'mic_tap'
         AND NEW.payload->>'mic_tap_outcome' = 'session_opened') THEN
    -- A → B (cheap no-op when already >= B due to WHERE clause).
    UPDATE public.profiles SET feed_regime = 'B'
     WHERE id = NEW.user_id AND feed_regime = 'A';

    v_is_c5 :=
         (NEW.event_name = 'hook_dwell_end' AND v_completion_pct >= 0.8)
      OR NEW.event_name = 'full_video_open'
      OR (NEW.event_name = 'mic_tap'
          AND NEW.payload->>'mic_tap_outcome' = 'session_opened');

    IF v_is_c5 THEN
      UPDATE public.profiles SET feed_regime = 'C'
       WHERE id = NEW.user_id AND feed_regime IN ('A', 'B');
    END IF;
  END IF;

  RETURN NULL;
END;$$;

REVOKE EXECUTE ON FUNCTION public.feed_events_raw_rollup() FROM PUBLIC;
-- No grants needed — trigger fires as the inserting role, no direct call path.

CREATE TRIGGER feed_events_raw_rollup
  AFTER INSERT ON public.feed_events_raw
  FOR EACH ROW EXECUTE FUNCTION public.feed_events_raw_rollup();
