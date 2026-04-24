-- 0503-07 — rate_limit_counters + ingest_feed_events (authenticated path)
-- (algo plan §3.2 migration 7a + NM1 + M1/M2/S1)
--
-- Two pieces of write-path infrastructure:
--   (1) rate_limit_counters table + rate_limit_hit RPC — leaky-bucket counter
--       used by the API layer for per-IP and per-user rate limiting (NM1/S1).
--   (2) ingest_feed_events RPC — authenticated batch write into
--       feed_events_raw. Dedupes on (user_id, event_name, idempotency_key),
--       marks dead-zone swipes with skipped_reason, verifies session_id
--       ownership for mic_tap events (M1), raises SQLSTATE 28000 when
--       unauthenticated (M2 — distinct from 42501=forbidden).

-- ---- Rate limit counters (NM1) -----------------------------------------

CREATE TABLE public.rate_limit_counters (
  scope        text         NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 40),
  key          text         NOT NULL CHECK (char_length(key)   BETWEEN 1 AND 128),
  window_start timestamptz  NOT NULL DEFAULT date_trunc('minute', now()),
  hit_count    int          NOT NULL DEFAULT 1 CHECK (hit_count >= 0),
  PRIMARY KEY (scope, key, window_start)
);

CREATE INDEX rate_limit_counters_gc_idx
  ON public.rate_limit_counters (window_start);

ALTER TABLE public.rate_limit_counters ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only. Called exclusively via the rate_limit_hit
-- RPC, which itself is SECURITY DEFINER.

REVOKE ALL ON public.rate_limit_counters FROM PUBLIC, anon, authenticated;

-- Leaky-bucket counter: each call increments the (scope, key, window_start)
-- bucket and returns true iff the bucket is still under p_limit.
--
-- p_window is accepted for API stability but currently fixed to 1-minute
-- buckets (the date_trunc call). Supporting variable windows would require
-- rounding now() to p_window boundaries, which isn't expressible in pure
-- SQL for arbitrary intervals. If we need sub-minute or multi-minute
-- buckets later, extend here.
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

REVOKE EXECUTE ON FUNCTION public.rate_limit_hit(text, text, interval, int)
  FROM PUBLIC, anon, authenticated;
-- Service-role only; called from the API route via supabaseAdmin().

-- ---- ingest_feed_events — authenticated batch write --------------------

CREATE OR REPLACE FUNCTION public.ingest_feed_events(p_events jsonb)
RETURNS TABLE(inserted int, deduped int, dead_zoned int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_caller   uuid := auth.uid();
  v_inserted int := 0;
  v_deduped  int := 0;
  v_dead     int := 0;
  v_evt         jsonb;
  v_event_name  text;
  v_skip_reason text;
  v_session_id  uuid;
BEGIN
  -- M2: distinct SQLSTATE so the API route can map unauthenticated (28000 →
  -- 401) vs forbidden (42501 → 403) without string-matching error messages.
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
    v_event_name  := v_evt->>'event_name';
    v_skip_reason := NULL;
    v_session_id  := NULL;

    -- Dead-zone swipes are stored (for debug) but flagged so the rollup
    -- trigger skips them.
    IF v_event_name = 'hook_swipe'
       AND COALESCE((v_evt->'payload'->>'seconds_to_decision_ms')::int, 9999) < 500 THEN
      v_skip_reason := 'dead_zone_swipe';
      v_dead := v_dead + 1;
    END IF;

    -- M1: verify session_id ownership for mic_tap events. If the session
    -- belongs to a different user, silently null the attribution — the
    -- event itself is still valid, just not tied to that session.
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
        -- Malformed UUID in one of the id fields → drop this one event,
        -- keep processing the rest of the batch.
        CONTINUE;
    END;
  END LOOP;

  RETURN QUERY SELECT v_inserted, v_deduped, v_dead;
END;$$;

REVOKE EXECUTE ON FUNCTION public.ingest_feed_events(jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.ingest_feed_events(jsonb) TO authenticated;
