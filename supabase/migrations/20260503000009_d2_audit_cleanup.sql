-- 0503-09 — D2 audit cleanup (H1 + M1 + M2 + M4 + M5 + round-5 fixes)
--
-- Rewrites 4 functions and adds 1 column. No modifications to shipped
-- migrations 6/7/8 — everything here uses ALTER / CREATE OR REPLACE so
-- environments that applied D2 before this cleanup upgrade cleanly.
--
-- H1 — ingest_feed_events auto-exposes at /rest/v1/rpc/ via PostgREST since
--      it's granted to authenticated. The planned /api/events/feed-batch
--      route (D4) will rate-limit at the HTTP layer, but that limit is
--      bypassable by direct PostgREST calls. Move the per-user limit INSIDE
--      the RPC as the structural backstop. Route-layer per-IP limit stays
--      as first line of defense when the route ships.
-- M1 — hook_global_stats.avg_completion_pct divided by g.impressions instead
--      of by dwell_end count. First dwell_end on a hook with 50 impressions
--      would compute 0.8/51 ≈ 0.016 instead of 0.8. Visible in admin
--      score_breakdown; fix before the admin surface ships (D6).
-- M1-clamp (round-5) — v_completion_pct now clamped to [0, 1]. A malformed
--      client payload with completion_pct > 1 would otherwise produce an
--      avg_completion_pct > 1, trip the BETWEEN 0 AND 1 CHECK on
--      hook_global_stats, and abort the entire 50-event batch in the
--      ingest RPC (exception handler catches only unique_violation).
-- M2 — sessions_creator_affinity_on_close guards on OLD.status, which can
--      regress (admin rollback, buggy write) and re-fire. OLD.ended_at is
--      monotonic-forward and the stronger invariant.
-- M4 — Decay anchor used now() instead of NEW.ended_at; inconsistent with
--      the rollup trigger's "use the row's own event-clock field, not
--      now()" convention (rollup uses NEW.created_at, session-close uses
--      NEW.ended_at).
-- M4-order (round-5) — ingest_feed_events now validates payload shape and
--      batch size BEFORE the rate-limit counter increments. Malformed
--      requests no longer consume the victim's quota.
-- M5 — rate_limit_hit accepted p_window but silently ignored it. Next
--      caller passing '5 minutes' gets 1-minute buckets and trips 5x too
--      fast. Raise on any value other than '1 minute' until true variable-
--      window support lands.
-- Round-5 H1 backfill — dwell_ends NOT NULL DEFAULT 0 on an existing table
--      means any hooks with pre-fix avg_completion_pct > 0 get their
--      history discarded on the next dwell_end ((avg * 0 + new) / 1 = new).
--      Reset those rows to avg=0 so the first post-upgrade dwell_end seeds
--      cleanly. Lossy for historical avg, but the pre-fix avg was divided
--      by impressions — i.e., wrong anyway. Better to start clean.

-- ---- M1: add dwell_ends column ----------------------------------------

ALTER TABLE public.hook_global_stats
  ADD COLUMN dwell_ends bigint NOT NULL DEFAULT 0 CHECK (dwell_ends >= 0);

COMMENT ON COLUMN public.hook_global_stats.dwell_ends IS
  'Count of hook_dwell_end events seen for this hook. Denominator for avg_completion_pct running mean (M1 fix).';

-- Round-5 H1 backfill: reset stale avg_completion_pct on rows that already
-- existed before the dwell_ends column landed. With dwell_ends=0 and a
-- pre-fix avg > 0, the first dwell_end would execute (avg * 0 + new) / 1
-- = new — silently discarding the historical value. Reset to 0 so the
-- first post-upgrade dwell seeds the running mean correctly.
UPDATE public.hook_global_stats
   SET avg_completion_pct = 0
 WHERE dwell_ends = 0
   AND avg_completion_pct > 0;

-- ---- M1: rollup trigger with dwell_ends counter + corrected avg formula

CREATE OR REPLACE FUNCTION public.feed_events_raw_rollup()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  HALF_LIFE_DAYS constant real := 14.0;
  v_hook_topic_tags text[];
  v_hook_creator_id uuid;
  v_creator_id uuid;
  v_tag    text;
  v_weight real;
  v_is_c5  boolean;
  v_completion_pct real;
BEGIN
  IF NEW.skipped_reason IS NOT NULL THEN RETURN NULL; END IF;

  v_hook_topic_tags := NULL;
  v_hook_creator_id := NULL;
  IF NEW.hook_id IS NOT NULL THEN
    SELECT h.topic_tags, v.creator_id
      INTO v_hook_topic_tags, v_hook_creator_id
      FROM public.hooks h
      JOIN public.videos v ON v.id = h.video_id
     WHERE h.id = NEW.hook_id;
  END IF;

  v_weight := public.compute_event_weight(NEW.event_name::text, NEW.payload);
  -- M1-clamp (round-5): a malformed client payload with completion_pct > 1
  -- would push avg_completion_pct above the BETWEEN 0 AND 1 CHECK and
  -- abort the whole ingest batch. Clamp defensively.
  v_completion_pct := LEAST(1.0, GREATEST(0.0,
    COALESCE((NEW.payload->>'completion_pct')::real, 0)
  ));

  -- Per-topic affinity (unchanged from migration 6).
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

  -- Per-creator affinity (unchanged).
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

  -- ---- M1 fix: hook_global_stats with dwell_ends denominator ----
  IF NEW.hook_id IS NOT NULL AND v_weight > 0 THEN
    INSERT INTO public.hook_global_stats AS g
      (hook_id, impressions, full_opens, mic_taps, avg_completion_pct,
       global_quality, last_event_at, updated_at, dwell_ends)
    VALUES (
      NEW.hook_id,
      /* impressions        */ CASE WHEN NEW.event_name = 'hook_impression' THEN 1 ELSE 0 END,
      /* full_opens         */ CASE WHEN NEW.event_name = 'full_video_open' THEN 1 ELSE 0 END,
      /* mic_taps           */ CASE WHEN NEW.event_name = 'mic_tap'
                                     AND NEW.payload->>'mic_tap_outcome' = 'session_opened'
                                    THEN 1 ELSE 0 END,
      -- First event case: if it's a dwell_end, seed the average with this
      -- completion; else 0 (running mean starts empty).
      /* avg_completion_pct */ CASE WHEN NEW.event_name = 'hook_dwell_end' THEN v_completion_pct ELSE 0 END,
      /* global_quality     */ 0,
      /* last_event_at      */ NEW.created_at,
      /* updated_at         */ NEW.created_at,
      /* dwell_ends         */ CASE WHEN NEW.event_name = 'hook_dwell_end' THEN 1 ELSE 0 END
    )
    ON CONFLICT (hook_id) DO UPDATE SET
      impressions = g.impressions + EXCLUDED.impressions,
      full_opens  = g.full_opens  + EXCLUDED.full_opens,
      mic_taps    = g.mic_taps    + EXCLUDED.mic_taps,
      dwell_ends  = g.dwell_ends  + EXCLUDED.dwell_ends,
      -- M1 fix: running mean of dwell_end completions, divided by dwell_end
      -- count. Non-dwell events pass through unchanged.
      avg_completion_pct = CASE
        WHEN NEW.event_name = 'hook_dwell_end'
        THEN ((g.avg_completion_pct * g.dwell_ends) + v_completion_pct)
             / (g.dwell_ends + 1)
        ELSE g.avg_completion_pct
      END,
      global_quality = (1 + (g.full_opens + EXCLUDED.full_opens)
                           + 3 * (g.mic_taps + EXCLUDED.mic_taps))::real
                       / (10 + (g.impressions + EXCLUDED.impressions))::real,
      last_event_at  = NEW.created_at,
      updated_at     = NEW.created_at;
  END IF;

  -- feed_regime promotion (unchanged from migration 6).
  IF v_weight >= 0.6
     OR (NEW.event_name = 'mic_tap'
         AND NEW.payload->>'mic_tap_outcome' = 'session_opened') THEN
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

-- ---- H1: ingest_feed_events with in-RPC rate limit --------------------

CREATE OR REPLACE FUNCTION public.ingest_feed_events(p_events jsonb)
RETURNS TABLE(inserted int, deduped int, dead_zoned int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  PER_USER_LIMIT_PER_MIN constant int := 600;
  v_caller   uuid := auth.uid();
  v_inserted int := 0;
  v_deduped  int := 0;
  v_dead     int := 0;
  v_evt         jsonb;
  v_event_name  text;
  v_skip_reason text;
  v_session_id  uuid;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = '28000';
  END IF;

  -- M4-order (round-5): payload shape + batch size checked BEFORE the
  -- rate-limit increment. Malformed requests should raise 22023 (400) and
  -- NOT burn the user's minute quota — otherwise an attacker could use a
  -- victim's session to spam malformed batches and exhaust the quota at
  -- zero DB-write cost.
  IF jsonb_typeof(p_events) <> 'array' THEN
    RAISE EXCEPTION 'p_events must be a jsonb array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_events) > 50 THEN
    RAISE EXCEPTION 'batch too large (max 50)' USING ERRCODE = '22023';
  END IF;

  -- H1: in-RPC per-user rate limit, survives PostgREST /rest/v1/rpc direct
  -- calls that bypass the (planned D4) Next.js route. SQLSTATE 54000
  -- (program_limit_exceeded) maps to HTTP 429 at the API layer.
  IF NOT public.rate_limit_hit('feed_events_user', v_caller::text,
                                '1 minute', PER_USER_LIMIT_PER_MIN) THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = '54000';
  END IF;

  FOR v_evt IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    v_event_name  := v_evt->>'event_name';
    v_skip_reason := NULL;
    v_session_id  := NULL;

    IF v_event_name = 'hook_swipe'
       AND COALESCE((v_evt->'payload'->>'seconds_to_decision_ms')::int, 9999) < 500 THEN
      v_skip_reason := 'dead_zone_swipe';
      v_dead := v_dead + 1;
    END IF;

    IF v_event_name = 'mic_tap'
       AND (v_evt->>'session_id_if_opened') IS NOT NULL THEN
      BEGIN
        SELECT id INTO v_session_id
          FROM public.sessions
         WHERE id = (v_evt->>'session_id_if_opened')::uuid
           AND user_id = v_caller
         LIMIT 1;
      EXCEPTION WHEN invalid_text_representation THEN
        v_session_id := NULL;
      END;
    ELSE
      BEGIN
        v_session_id := NULLIF(v_evt->>'session_id', '')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        v_session_id := NULL;
      END;
    END IF;

    BEGIN
      INSERT INTO public.feed_events_raw
        (user_id, event_name, hook_id, video_id, creator_id, session_id,
         idempotency_key, payload, skipped_reason)
      VALUES (
        v_caller,
        v_event_name::feed_event_name,
        NULLIF(v_evt->>'hook_id', '')::uuid,
        NULLIF(v_evt->>'video_id', '')::uuid,
        NULLIF(v_evt->>'creator_id', '')::uuid,
        v_session_id,
        (v_evt->>'idempotency_key')::uuid,
        COALESCE(v_evt->'payload', '{}'::jsonb),
        v_skip_reason
      );
      IF v_skip_reason IS NULL THEN
        v_inserted := v_inserted + 1;
      END IF;
    EXCEPTION
      WHEN unique_violation THEN
        v_deduped := v_deduped + 1;
      WHEN invalid_text_representation THEN
        CONTINUE;
    END;
  END LOOP;

  RETURN QUERY SELECT v_inserted, v_deduped, v_dead;
END;$$;

-- ---- M2 + M4: session-close trigger ------------------------------------

CREATE OR REPLACE FUNCTION public.sessions_creator_affinity_on_close()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  HALF_LIFE_DAYS    constant real := 14.0;
  MAX_BOOST_SECONDS constant int  := 600;
  MAX_BOOST         constant real := 1.5;
  v_duration_boost real;
  v_decay_anchor   timestamptz;
BEGIN
  IF NEW.status NOT IN ('ended', 'errored') THEN RETURN NULL; END IF;
  -- M2: OLD.ended_at is monotonic-forward in this codebase (once set on
  -- first terminal transition, it doesn't revert). Stronger invariant than
  -- OLD.status, which a rollback/admin path could regress.
  IF OLD.ended_at IS NOT NULL THEN RETURN NULL; END IF;
  IF COALESCE(NEW.active_seconds, 0) < 30 THEN RETURN NULL; END IF;
  IF NEW.creator_id IS NULL THEN RETURN NULL; END IF;

  v_duration_boost :=
    LEAST(NEW.active_seconds, MAX_BOOST_SECONDS)::real
      / MAX_BOOST_SECONDS::real
      * MAX_BOOST;

  -- M4: anchor decay on when the session actually ended, not when the
  -- trigger fires. Follows the convention of using the row's own event-
  -- clock field — the rollup trigger uses NEW.created_at (feed_events_raw
  -- insert time); this trigger uses NEW.ended_at (session close time).
  v_decay_anchor := COALESCE(NEW.ended_at, now());

  INSERT INTO public.user_creator_affinity AS t
    (user_id, creator_id, affinity_score, last_event_at, updated_at,
     total_session_seconds, impressions, full_opens, carousel_opens, mic_taps, negatives)
  VALUES (
    NEW.user_id, NEW.creator_id,
    v_duration_boost, v_decay_anchor, v_decay_anchor,
    NEW.active_seconds, 0, 0, 0, 0, 0
  )
  ON CONFLICT (user_id, creator_id) DO UPDATE SET
    total_session_seconds = t.total_session_seconds + EXCLUDED.total_session_seconds,
    affinity_score = (
      t.affinity_score
        * pow(0.5, EXTRACT(EPOCH FROM (v_decay_anchor - t.last_event_at))
                   / (HALF_LIFE_DAYS * 86400))
      + EXCLUDED.affinity_score
    ),
    last_event_at = v_decay_anchor,
    updated_at    = v_decay_anchor;

  RETURN NULL;
END;$$;

-- ---- M5: rate_limit_hit enforces only '1 minute' ----------------------

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
  -- M5: bucket granularity is 1 minute. Silently accepting other windows
  -- caused a landmine (limit trips 5x too fast for a '5 minutes' caller).
  -- Reject anything else until true variable-window support lands.
  IF p_window <> interval '1 minute' THEN
    RAISE EXCEPTION 'rate_limit_hit supports only ''1 minute'' windows (got %)', p_window
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.rate_limit_counters (scope, key, window_start, hit_count)
  VALUES (p_scope, p_key, v_window_start, 1)
  ON CONFLICT (scope, key, window_start) DO UPDATE
    SET hit_count = rate_limit_counters.hit_count + 1
  RETURNING hit_count INTO v_count;
  RETURN v_count <= p_limit;
END;$$;
