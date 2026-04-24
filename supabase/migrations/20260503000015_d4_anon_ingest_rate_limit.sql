-- 0503-15 — D4 audit H1: per-anon_id rate limit inside ingest_feed_events_anon
--
-- The route-layer per-IP cap (600/min) is insufficient protection on shared
-- carrier-grade NAT or campus WiFi where dozens of anons share one IP. Worse,
-- a known oak_anon_id can be flooded from distributed IPs to bloat its
-- topic_affinity / creator_affinity jsonb blobs against the 4096-byte hard
-- CHECK — a targeted DoS on a single anon session.
--
-- Fix: replicate the authenticated RPC's in-RPC rate limit (migration 0503-09
-- H1). 300 events/min per anon_id. SQLSTATE 54000 surfaces to the route
-- handler and maps to HTTP 429.
--
-- Rate-limit bucket is evaluated AFTER the anon_session_not_found check but
-- BEFORE the array-shape validation so malformed payloads (HTTP 400) don't
-- burn the quota — an attacker using a stolen anon_id can't exhaust the
-- minute bucket at zero write-cost with garbage batches.

CREATE OR REPLACE FUNCTION public.ingest_feed_events_anon(
  p_anon_id uuid,
  p_events  jsonb
) RETURNS TABLE(inserted int, deduped int, dead_zoned int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  BLOB_SOFT_CAP constant int := 3500;  -- M2 guard; hard CHECK at 4096.
  PER_ANON_LIMIT_PER_MIN constant int := 300;
  v_anon record;
  v_evt  jsonb;
  v_event_name text;
  v_hook_topic_tags text[];
  v_hook_creator_id uuid;
  v_tag  text;
  v_weight real;
  v_creator_id text;
  v_inserted int := 0;
  v_deduped  int := 0;
  v_dead     int := 0;
  v_new_topic_aff   jsonb;
  v_new_creator_aff jsonb;
  v_old_score real;
  v_new_score real;
BEGIN
  SELECT topic_affinity, creator_affinity
    INTO v_anon
    FROM public.anon_feed_sessions
   WHERE anon_id = p_anon_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'anon_session_not_found' USING ERRCODE = '28000';
  END IF;

  IF jsonb_typeof(p_events) <> 'array' THEN
    RAISE EXCEPTION 'p_events must be a jsonb array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_events) > 50 THEN
    RAISE EXCEPTION 'batch too large (max 50)' USING ERRCODE = '22023';
  END IF;

  -- H1: per-anon rate limit. Fires AFTER shape validation so malformed
  -- batches don't consume bucket. 54000 (program_limit_exceeded) → 429.
  IF NOT public.rate_limit_hit('feed_events_anon', p_anon_id::text,
                                '1 minute', PER_ANON_LIMIT_PER_MIN) THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = '54000';
  END IF;

  v_new_topic_aff   := v_anon.topic_affinity;
  v_new_creator_aff := v_anon.creator_affinity;

  FOR v_evt IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    v_event_name := v_evt->>'event_name';

    IF v_event_name = 'hook_swipe'
       AND COALESCE((v_evt->'payload'->>'seconds_to_decision_ms')::int, 0) < 500 THEN
      v_dead := v_dead + 1;
      CONTINUE;
    END IF;

    v_hook_topic_tags := NULL;
    v_hook_creator_id := NULL;
    IF (v_evt->>'hook_id') IS NOT NULL THEN
      BEGIN
        SELECT h.topic_tags, v.creator_id
          INTO v_hook_topic_tags, v_hook_creator_id
          FROM public.hooks h
          JOIN public.videos v ON v.id = h.video_id
         WHERE h.id = (v_evt->>'hook_id')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        v_hook_topic_tags := NULL;
        v_hook_creator_id := NULL;
      END;
    END IF;

    v_weight := public.compute_event_weight(v_event_name, v_evt->'payload');

    IF v_hook_topic_tags IS NOT NULL THEN
      FOREACH v_tag IN ARRAY v_hook_topic_tags LOOP
        v_old_score := COALESCE((v_new_topic_aff->>v_tag)::real, 0);
        v_new_score := GREATEST(-0.5, LEAST(5.0, v_old_score + v_weight));
        IF (v_new_topic_aff ? v_tag)
           OR octet_length(v_new_topic_aff::text) < BLOB_SOFT_CAP THEN
          v_new_topic_aff := jsonb_set(v_new_topic_aff, ARRAY[v_tag], to_jsonb(v_new_score));
        END IF;
      END LOOP;
    END IF;

    v_creator_id := COALESCE(v_hook_creator_id::text, v_evt->>'creator_id');
    IF v_creator_id IS NOT NULL THEN
      v_old_score := COALESCE((v_new_creator_aff->>v_creator_id)::real, 0);
      v_new_score := GREATEST(-0.5, LEAST(5.0, v_old_score + v_weight));
      IF (v_new_creator_aff ? v_creator_id)
         OR octet_length(v_new_creator_aff::text) < BLOB_SOFT_CAP THEN
        v_new_creator_aff := jsonb_set(v_new_creator_aff, ARRAY[v_creator_id], to_jsonb(v_new_score));
      END IF;
    END IF;

    v_inserted := v_inserted + 1;
  END LOOP;

  UPDATE public.anon_feed_sessions SET
    topic_affinity   = v_new_topic_aff,
    creator_affinity = v_new_creator_aff,
    event_count      = event_count + v_inserted,
    last_active_at   = now()
  WHERE anon_id = p_anon_id;

  RETURN QUERY SELECT v_inserted, v_deduped, v_dead;
END;$$;

REVOKE EXECUTE ON FUNCTION public.ingest_feed_events_anon(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
