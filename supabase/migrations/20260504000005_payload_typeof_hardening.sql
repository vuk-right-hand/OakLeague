-- 0504-05 — payload type-guard hardening across the live algo path.
--
-- Round-3 audit C-NEW1: a single malformed jsonb payload (buggy client build,
-- shape revision drift, attacker probing the SECURITY DEFINER ingest paths)
-- crashes any function that does naked (payload->>'X')::int / ::real. The
-- crash cascades — one bad event in a 50-event batch raises
-- invalid_text_representation and rolls back the whole INSERT; the cooldown
-- CTE in feed_ranked_page errors out for any user whose history touches the
-- bad row. The inspector tool would render cleanly while the user's feed
-- itself errors out — forensically backwards.
--
-- Pattern: introduce two IMMUTABLE helpers that return NULL on missing or
-- non-numeric values; refactor every cast site in the live algo path to call
-- them. Comparisons against NULL evaluate to NULL → row excluded by WHERE /
-- CASE branch → no SQLSTATE crash.
--
--   _jsonb_int(p jsonb, p_key text)  → int  | NULL
--   _jsonb_real(p jsonb, p_key text) → real | NULL
--
-- Function bodies below are verbatim copies of the latest CREATE OR REPLACE
-- for each function (per the migration log) with cast sites swapped. The
-- side-by-side diff against the prior migration is the audit trail.
--
-- Sources (live versions, by alphabetical migration order):
--   compute_event_weight       — 20260503000017_d5_h1_swipe_up_neutral.sql
--   feed_events_raw_rollup     — 20260503000009_d2_audit_cleanup.sql
--   ingest_feed_events         — 20260503000009_d2_audit_cleanup.sql
--   ingest_feed_events_anon    — 20260503000015_d4_anon_ingest_rate_limit.sql
--   feed_ranked_page           — 20260504000003_feed_ranked_page_video_level_cooldown.sql
--
-- Sites refactored (audit C-NEW1):
--   compute_event_weight                — 4 sites (completion_pct, seconds_to_decision_ms, quartile)
--   feed_events_raw_rollup              — 2 sites (completion_pct, dwell_ms)
--   ingest_feed_events                  — 1 site (seconds_to_decision_ms)   [round-3 critical 3]
--   ingest_feed_events_anon             — 3 sites (seconds_to_decision_ms,   [round-3 critical 3]
--                                                  topic blob real,
--                                                  creator blob real)
--   feed_ranked_page cooldown CTE       — 5 sites (completion_pct ×2, quartile ×3)

-- ─────────────────────────────────────────────────────────────────────────
-- Helpers
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._jsonb_int(p jsonb, p_key text)
RETURNS int
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(p->p_key) = 'number'
              THEN (p->>p_key)::int END;
$$;

CREATE OR REPLACE FUNCTION public._jsonb_real(p jsonb, p_key text)
RETURNS real
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(p->p_key) = 'number'
              THEN (p->>p_key)::real END;
$$;

REVOKE ALL    ON FUNCTION public._jsonb_int(jsonb, text)  FROM public;
REVOKE ALL    ON FUNCTION public._jsonb_real(jsonb, text) FROM public;
GRANT EXECUTE ON FUNCTION public._jsonb_int(jsonb, text)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._jsonb_real(jsonb, text) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- compute_event_weight  (was 0503-17)
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.compute_event_weight(
  p_event_name text,
  p_payload    jsonb
) RETURNS real
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT (CASE p_event_name
    WHEN 'hook_impression' THEN 0.02
    WHEN 'hook_dwell_end'  THEN
      LEAST(1.0, GREATEST(-0.3, COALESCE(public._jsonb_real(p_payload, 'completion_pct'), 0)))
    WHEN 'hook_swipe' THEN
      CASE (p_payload->>'direction')
        WHEN 'right' THEN 0.5
        WHEN 'left'  THEN 0.0
        WHEN 'up'    THEN 0.0
        ELSE CASE WHEN COALESCE(public._jsonb_int(p_payload,  'seconds_to_decision_ms'), 9999) < 2000
                       AND COALESCE(public._jsonb_real(p_payload, 'completion_pct'), 0) < 0.2
                  THEN -0.3 ELSE -0.05 END
      END
    WHEN 'full_video_open' THEN 0.6
    WHEN 'full_video_quartile' THEN
      CASE COALESCE(public._jsonb_int(p_payload, 'quartile'), 0)
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

-- ─────────────────────────────────────────────────────────────────────────
-- feed_events_raw_rollup  (was 0503-09)
-- ─────────────────────────────────────────────────────────────────────────

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
  v_completion_pct := LEAST(1.0, GREATEST(0.0,
    COALESCE(public._jsonb_real(NEW.payload, 'completion_pct'), 0)
  ));

  IF v_hook_topic_tags IS NOT NULL THEN
    FOREACH v_tag IN ARRAY v_hook_topic_tags LOOP
      INSERT INTO public.user_topic_affinity AS t
        (user_id, topic_slug, impressions, dwell_ms_total, completions, full_opens,
         carousel_opens, mic_taps, negatives, affinity_score, last_event_at, updated_at)
      VALUES (
        NEW.user_id, v_tag,
        CASE WHEN NEW.event_name = 'hook_impression' THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_name = 'hook_dwell_end'
             THEN COALESCE(public._jsonb_int(NEW.payload, 'dwell_ms'), 0) ELSE 0 END,
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

  IF NEW.hook_id IS NOT NULL AND v_weight > 0 THEN
    INSERT INTO public.hook_global_stats AS g
      (hook_id, impressions, full_opens, mic_taps, avg_completion_pct,
       global_quality, last_event_at, updated_at, dwell_ends)
    VALUES (
      NEW.hook_id,
      CASE WHEN NEW.event_name = 'hook_impression' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'full_video_open' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'mic_tap'
            AND NEW.payload->>'mic_tap_outcome' = 'session_opened'
           THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'hook_dwell_end' THEN v_completion_pct ELSE 0 END,
      0, NEW.created_at, NEW.created_at,
      CASE WHEN NEW.event_name = 'hook_dwell_end' THEN 1 ELSE 0 END
    )
    ON CONFLICT (hook_id) DO UPDATE SET
      impressions = g.impressions + EXCLUDED.impressions,
      full_opens  = g.full_opens  + EXCLUDED.full_opens,
      mic_taps    = g.mic_taps    + EXCLUDED.mic_taps,
      dwell_ends  = g.dwell_ends  + EXCLUDED.dwell_ends,
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

-- ─────────────────────────────────────────────────────────────────────────
-- ingest_feed_events  (was 0503-09)
-- ─────────────────────────────────────────────────────────────────────────

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

  IF jsonb_typeof(p_events) <> 'array' THEN
    RAISE EXCEPTION 'p_events must be a jsonb array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_events) > 50 THEN
    RAISE EXCEPTION 'batch too large (max 50)' USING ERRCODE = '22023';
  END IF;

  IF NOT public.rate_limit_hit('feed_events_user', v_caller::text,
                                '1 minute', PER_USER_LIMIT_PER_MIN) THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = '54000';
  END IF;

  FOR v_evt IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    v_event_name  := v_evt->>'event_name';
    v_skip_reason := NULL;
    v_session_id  := NULL;

    -- Hardened (round-3 critical 3): non-numeric seconds_to_decision_ms no
    -- longer crashes the entire 50-event batch.
    IF v_event_name = 'hook_swipe'
       AND COALESCE(public._jsonb_int(v_evt->'payload', 'seconds_to_decision_ms'), 9999) < 500 THEN
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

-- ─────────────────────────────────────────────────────────────────────────
-- ingest_feed_events_anon  (was 0503-15)
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ingest_feed_events_anon(
  p_anon_id uuid,
  p_events  jsonb
) RETURNS TABLE(inserted int, deduped int, dead_zoned int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  BLOB_SOFT_CAP constant int := 3500;
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

  IF NOT public.rate_limit_hit('feed_events_anon', p_anon_id::text,
                                '1 minute', PER_ANON_LIMIT_PER_MIN) THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = '54000';
  END IF;

  v_new_topic_aff   := v_anon.topic_affinity;
  v_new_creator_aff := v_anon.creator_affinity;

  FOR v_evt IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    v_event_name := v_evt->>'event_name';

    -- Hardened (round-3 critical 3).
    IF v_event_name = 'hook_swipe'
       AND COALESCE(public._jsonb_int(v_evt->'payload', 'seconds_to_decision_ms'), 0) < 500 THEN
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
        -- Hardened: server-managed blob, but the helper costs nothing and
        -- shields against future schema-rev surprises.
        v_old_score := COALESCE(public._jsonb_real(v_new_topic_aff, v_tag), 0);
        v_new_score := GREATEST(-0.5, LEAST(5.0, v_old_score + v_weight));
        IF (v_new_topic_aff ? v_tag)
           OR octet_length(v_new_topic_aff::text) < BLOB_SOFT_CAP THEN
          v_new_topic_aff := jsonb_set(v_new_topic_aff, ARRAY[v_tag], to_jsonb(v_new_score));
        END IF;
      END LOOP;
    END IF;

    v_creator_id := COALESCE(v_hook_creator_id::text, v_evt->>'creator_id');
    IF v_creator_id IS NOT NULL THEN
      v_old_score := COALESCE(public._jsonb_real(v_new_creator_aff, v_creator_id), 0);
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

-- ─────────────────────────────────────────────────────────────────────────
-- feed_ranked_page  (was 0504-03)
--
-- The cooldown CTE casts (completion_pct ×2, quartile ×3) are the only sites
-- changed; the rest of the function body is verbatim. CREATE OR REPLACE is
-- sufficient — RETURNS TABLE shape unchanged.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.feed_ranked_page(
  p_limit            int    DEFAULT 10,
  p_cursor_epoch     bigint DEFAULT NULL,
  p_exclude_hook_ids uuid[] DEFAULT '{}'::uuid[]
) RETURNS TABLE (
  hook_id             uuid,
  video_id            uuid,
  creator_id          uuid,
  creator_handle      text,
  creator_name        text,
  creator_avatar      text,
  video_title         text,
  lesson_number       int,
  hook_title          text,
  hook_caption        text,
  hook_transcript     text,
  topic_tags          text[],
  mux_playback_id     text,
  mux_aspect_ratio    text,
  mux_duration_ms     integer,
  duration_seconds    integer,
  opening_prompt      text,
  question_seeds      jsonb,
  hook_created_at     timestamptz,
  score_total         real,
  score_breakdown     jsonb,
  served_rank         int,
  cursor_epoch        bigint,
  long_form_available bool
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_caller          uuid := auth.uid();
  v_limit           int  := LEAST(GREATEST(COALESCE(p_limit, 10), 0), 50);
  v_cursor_epoch    bigint := COALESCE(p_cursor_epoch, EXTRACT(EPOCH FROM now())::bigint);
  v_exclude         uuid[];
  v_topic_max       real := 5.0;
  v_creator_max     real := 5.0;
  v_interest_slugs  text[] := '{}'::text[];
  v_regime          text := 'A';
  v_last_creators   uuid[] := '{}'::uuid[];
  v_seed            bigint;
  v_explore_slot_1  int;
  v_explore_slot_2  int;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = '28000';
  END IF;

  v_exclude := ARRAY(
    SELECT x FROM unnest(COALESCE(p_exclude_hook_ids, '{}'::uuid[]))
                  WITH ORDINALITY AS t(x, ord)
    ORDER BY ord
    LIMIT 50
  );

  SELECT GREATEST(5.0, COALESCE(MAX(affinity_score), 5.0))
    INTO v_topic_max
    FROM public.user_topic_affinity WHERE user_id = v_caller;

  SELECT GREATEST(5.0, COALESCE(MAX(affinity_score), 5.0))
    INTO v_creator_max
    FROM public.user_creator_affinity WHERE user_id = v_caller;

  SELECT COALESCE(p.interest_slugs, '{}'::text[]),
         COALESCE(p.feed_regime::text, 'A')
    INTO v_interest_slugs, v_regime
    FROM public.profiles p WHERE p.id = v_caller;

  SELECT COALESCE(array_agg(creator_id ORDER BY created_at DESC), '{}'::uuid[])
    INTO v_last_creators
    FROM (
      SELECT creator_id, created_at
        FROM public.feed_events_raw
       WHERE user_id     = v_caller
         AND event_name  = 'hook_impression'
         AND creator_id IS NOT NULL
         AND created_at  > now() - interval '10 minutes'
       ORDER BY created_at DESC
       LIMIT 20
    ) recent;

  v_seed := abs(hashtextextended(v_caller::text || ':' || v_cursor_epoch::text, 0));
  v_explore_slot_1 := 2 + ((v_seed      ) % 3)::int;
  v_explore_slot_2 := 6 + ((v_seed / 3  ) % 3)::int;

  RETURN QUERY
  WITH user_cooldowns_raw AS (
    SELECT f.hook_id, MAX(CASE
             WHEN f.event_name = 'mic_tap'
                  AND f.payload->>'mic_tap_outcome' = 'session_opened'
                  AND f.session_id IS NOT NULL
                  THEN f.created_at + interval '30 days'
             -- Hardened: non-numeric completion_pct → NULL → CASE arm fails → row excluded.
             WHEN f.event_name = 'hook_dwell_end'
                  AND public._jsonb_real(f.payload, 'completion_pct') >= 0.8
                  THEN f.created_at + interval '3 days'
             WHEN f.event_name = 'hook_dwell_end'
                  AND public._jsonb_real(f.payload, 'completion_pct') < 0.8
                  THEN f.created_at + interval '7 days'
           END) AS available_after
      FROM public.feed_events_raw f
     WHERE f.user_id     = v_caller
       AND f.hook_id    IS NOT NULL
       AND f.event_name IN ('mic_tap','hook_dwell_end')
       AND f.created_at  > now() - interval '30 days'
       AND f.skipped_reason IS NULL
     GROUP BY f.hook_id

    UNION ALL

    SELECT h.id AS hook_id, vc.available_after
      FROM (
        SELECT f.video_id,
               MAX(CASE
                 -- Hardened (×3): non-numeric quartile → NULL → CASE arm fails.
                 WHEN f.event_name = 'full_video_quartile'
                      AND public._jsonb_int(f.payload, 'quartile') = 100
                      THEN f.created_at + interval '14 days'
                 WHEN f.event_name = 'full_video_quartile'
                      AND public._jsonb_int(f.payload, 'quartile') >= 50
                      THEN f.created_at + interval '7 days'
                 WHEN f.event_name = 'full_video_open'
                      AND NOT EXISTS (
                        SELECT 1 FROM public.feed_events_raw q2
                         WHERE q2.user_id    = v_caller
                           AND q2.video_id   = f.video_id
                           AND q2.event_name = 'full_video_quartile'
                           AND public._jsonb_int(q2.payload, 'quartile') >= 50
                           AND q2.created_at > f.created_at
                           AND q2.created_at < f.created_at + interval '60 seconds'
                      ) THEN f.created_at + interval '24 hours'
               END) AS available_after
          FROM public.feed_events_raw f
         WHERE f.user_id     = v_caller
           AND f.video_id   IS NOT NULL
           AND f.event_name IN ('full_video_open','full_video_quartile')
           AND f.created_at  > now() - interval '30 days'
           AND f.skipped_reason IS NULL
         GROUP BY f.video_id
      ) vc
      JOIN public.hooks h ON h.video_id = vc.video_id
     WHERE vc.available_after IS NOT NULL
  ),
  user_cooldowns AS (
    SELECT hook_id, MAX(available_after) AS available_after
      FROM user_cooldowns_raw
     GROUP BY hook_id
  ),
  candidates AS (
    SELECT h.id                  AS cand_hook_id,
           h.video_id             AS cand_video_id,
           c.id                   AS cand_creator_id,
           c.handle::text         AS cand_creator_handle,
           c.display_name         AS cand_creator_name,
           c.avatar_url           AS cand_creator_avatar,
           v.title                AS cand_video_title,
           h.lesson_number        AS cand_lesson_number,
           h.title                AS cand_hook_title,
           h.caption              AS cand_hook_caption,
           h.transcript           AS cand_hook_transcript,
           h.topic_tags           AS cand_topic_tags,
           h.mux_playback_id      AS cand_mux_playback_id,
           h.mux_aspect_ratio     AS cand_mux_aspect_ratio,
           h.mux_duration_ms      AS cand_mux_duration_ms,
           h.duration_seconds     AS cand_duration_seconds,
           h.opening_prompt       AS cand_opening_prompt,
           h.question_seeds       AS cand_question_seeds,
           h.created_at           AS cand_hook_created_at,
           (v.long_form_mux_playback_id IS NOT NULL
            AND v.long_form_published_at IS NOT NULL)
                                  AS cand_long_form_available
      FROM public.hooks_public h
      JOIN public.videos   v ON v.id = h.video_id
      JOIN public.creators c ON c.id = v.creator_id
     WHERE v.published_at IS NOT NULL
       AND c.published_at IS NOT NULL
       AND c.creator_type = 'human'
       AND h.id <> ALL (v_exclude)
       AND NOT EXISTS (
         SELECT 1 FROM user_cooldowns uc
          WHERE uc.hook_id = h.id AND uc.available_after > now()
       )
     ORDER BY h.created_at DESC
     LIMIT 200
  ),
  scored AS (
    SELECT c.*,
           public._consecutive_streak_from_tail(v_last_creators, c.cand_creator_id) AS streak
      FROM candidates c
  ),
  dual_scored AS MATERIALIZED (
    SELECT s.*,
           public.compute_hook_score(
             v_caller, s.cand_hook_id, 'exploit', v_regime,
             s.streak, v_topic_max, v_creator_max, v_interest_slugs
           ) AS bd_exploit,
           public.compute_hook_score(
             v_caller, s.cand_hook_id, 'explore', v_regime,
             s.streak, v_topic_max, v_creator_max, v_interest_slugs
           ) AS bd_explore
      FROM scored s
  ),
  exploit_ranked AS (
    SELECT ds.*,
           ROW_NUMBER() OVER (
             ORDER BY (ds.bd_exploit->>'score_total')::real DESC NULLS LAST,
                      ds.cand_hook_created_at DESC,
                      ds.cand_hook_id
           ) AS exploit_rn
      FROM dual_scored ds
  ),
  explore_eligible AS (
    SELECT ds.*,
           ROW_NUMBER() OVER (
             ORDER BY (ds.bd_explore->>'score_total')::real DESC NULLS LAST,
                      ds.cand_hook_created_at DESC,
                      ds.cand_hook_id
           ) AS explore_rn
      FROM dual_scored ds
     WHERE (ds.bd_explore->'components'->>'S_explore')::real > 0
  ),
  top_explore AS (
    SELECT * FROM explore_eligible
     WHERE explore_rn <= 2
       AND CASE explore_rn
             WHEN 1 THEN v_explore_slot_1 < v_limit
             WHEN 2 THEN v_explore_slot_2 < v_limit
           END
  ),
  top_exploit AS (
    SELECT *,
           ROW_NUMBER() OVER (ORDER BY exploit_rn) AS hook_rn
      FROM (
        SELECT er.* FROM exploit_ranked er
         WHERE NOT EXISTS (
           SELECT 1 FROM top_explore te2
            WHERE te2.cand_hook_id = er.cand_hook_id
         )
         ORDER BY exploit_rn
         LIMIT v_limit
      ) limited
  ),
  exploit_positions AS (
    SELECT gs AS pos, ROW_NUMBER() OVER (ORDER BY gs) AS slot_rn
      FROM generate_series(0, v_limit - 1) AS gs
     WHERE (gs <> v_explore_slot_1
            OR NOT EXISTS (SELECT 1 FROM top_explore WHERE explore_rn = 1))
       AND (gs <> v_explore_slot_2
            OR NOT EXISTS (SELECT 1 FROM top_explore WHERE explore_rn = 2))
  ),
  merged AS (
    SELECT
      te.cand_hook_id,      te.cand_video_id,     te.cand_creator_id,
      te.cand_creator_handle, te.cand_creator_name, te.cand_creator_avatar,
      te.cand_video_title,  te.cand_lesson_number,
      te.cand_hook_title,   te.cand_hook_caption,  te.cand_hook_transcript,
      te.cand_topic_tags,   te.cand_mux_playback_id, te.cand_mux_aspect_ratio,
      te.cand_mux_duration_ms, te.cand_duration_seconds,
      te.cand_opening_prompt, te.cand_question_seeds, te.cand_hook_created_at,
      te.cand_long_form_available,
      ep.pos           AS slot_idx,
      te.bd_exploit    AS bd,
      'exploit'::text  AS slot_type
    FROM top_exploit te
    JOIN exploit_positions ep ON ep.slot_rn = te.hook_rn
    UNION ALL
    SELECT
      x.cand_hook_id,       x.cand_video_id,      x.cand_creator_id,
      x.cand_creator_handle, x.cand_creator_name,  x.cand_creator_avatar,
      x.cand_video_title,   x.cand_lesson_number,
      x.cand_hook_title,    x.cand_hook_caption,   x.cand_hook_transcript,
      x.cand_topic_tags,    x.cand_mux_playback_id, x.cand_mux_aspect_ratio,
      x.cand_mux_duration_ms, x.cand_duration_seconds,
      x.cand_opening_prompt, x.cand_question_seeds, x.cand_hook_created_at,
      x.cand_long_form_available,
      CASE x.explore_rn WHEN 1 THEN v_explore_slot_1 ELSE v_explore_slot_2 END AS slot_idx,
      x.bd_explore     AS bd,
      'explore'::text  AS slot_type
    FROM top_explore x
  )
  SELECT
    m.cand_hook_id,
    m.cand_video_id,
    m.cand_creator_id,
    m.cand_creator_handle,
    m.cand_creator_name,
    m.cand_creator_avatar,
    m.cand_video_title,
    m.cand_lesson_number,
    m.cand_hook_title,
    m.cand_hook_caption,
    m.cand_hook_transcript,
    m.cand_topic_tags,
    m.cand_mux_playback_id,
    m.cand_mux_aspect_ratio,
    m.cand_mux_duration_ms,
    m.cand_duration_seconds,
    m.cand_opening_prompt,
    m.cand_question_seeds,
    m.cand_hook_created_at,
    (m.bd->>'score_total')::real,
    jsonb_set(
      jsonb_set(m.bd, '{slot_type}',   to_jsonb(m.slot_type)),
      '{served_rank}',                  to_jsonb(m.slot_idx)
    ),
    m.slot_idx,
    v_cursor_epoch,
    m.cand_long_form_available
  FROM merged m
  ORDER BY m.slot_idx;
END;$$;

REVOKE EXECUTE ON FUNCTION public.feed_ranked_page(int, bigint, uuid[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.feed_ranked_page(int, bigint, uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
