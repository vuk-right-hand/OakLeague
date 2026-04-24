-- 0503-10 — scorer + ranked feed RPCs (D3; algo plan §3.2 migration 8,
-- renumbered per D2 7b→8 shift + D2-cleanup migration 9).
--
-- Three functions, one shared scorer:
--   (1) _consecutive_streak_from_tail(uuid[], uuid) — helper for M8 streak penalty
--   (2) compute_hook_score(...)                      — shared (sanity call 7).
--       Called by feed_ranked_page (live) and admin_algo_score_explain (D6).
--       Drift between live + admin scoring is structurally impossible.
--   (3) feed_ranked_page(...)                        — authenticated scorer.
--       Cooldown via on-the-fly CTE (M5, no MV). p_exclude_hook_ids capped
--       at 50 (M4). Slot interleaving with seeded randomness (S4).
--   (4) feed_ranked_anon_page(...)                   — anon lite scorer
--       (NC3 + M11). W_GLOBAL + W_RECENCY + W_COLD_ANON only; no user-state
--       lookups (anon affinity lives in jsonb on anon_feed_sessions).
--       score_breakdown always NULL (no explainer for anon).
--       Service-role only (no `authenticated` grant).

-- ---- Helper: _consecutive_streak_from_tail ----------------------------

CREATE OR REPLACE FUNCTION public._consecutive_streak_from_tail(
  p_arr uuid[],
  p_target uuid
) RETURNS int
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  v_count int := 0;
  v_i     int;
BEGIN
  -- p_arr is ordered most-recent-first (the caller passes recent impressions
  -- sorted by created_at DESC). Walk from index 1 and count the leading run
  -- of entries that match p_target. First non-match breaks.
  IF p_arr IS NULL OR p_target IS NULL THEN RETURN 0; END IF;
  FOR v_i IN 1..cardinality(p_arr) LOOP
    IF p_arr[v_i] = p_target THEN
      v_count := v_count + 1;
    ELSE
      EXIT;
    END IF;
  END LOOP;
  RETURN v_count;
END;$$;

REVOKE EXECUTE ON FUNCTION public._consecutive_streak_from_tail(uuid[], uuid) FROM PUBLIC;

-- ---- compute_hook_score (shared; sanity call 7) -----------------------

CREATE OR REPLACE FUNCTION public.compute_hook_score(
  p_user_id                    uuid,
  p_hook_id                    uuid,
  p_slot_type                  text    DEFAULT 'exploit',
  p_regime                     text    DEFAULT 'C',
  p_consecutive_creator_streak int     DEFAULT 0,
  p_user_topic_max             real    DEFAULT 5.0,
  p_user_creator_max           real    DEFAULT 5.0,
  p_interest_slugs             text[]  DEFAULT '{}'::text[]
) RETURNS jsonb
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
DECLARE
  -- Default scorer weights. Hardcoded for v1; feed_algo_weights table is v1.1.
  W_TOPIC   constant real := 1.0;
  W_CREATOR constant real := 0.6;
  W_RECENCY constant real := 0.3;
  W_GLOBAL  constant real := 0.4;
  W_EXPLORE constant real := 0.8;
  W_COLD    constant real := 0.5;
  W_REPEAT  constant real := 0.5;

  v_hook_topic_tags text[];
  v_hook_creator_id uuid;
  v_hook_published  timestamptz;
  v_hook_created    timestamptz;
  v_global_quality  real;
  v_age_days        real;
  v_raw_topic_sum   real := 0;
  v_top_topic       text;
  v_creator_aff     real := 0;
  v_has_sparse_topic boolean := false;

  v_s_topic   real := 0;
  v_s_creator real := 0;
  v_s_recency real := 0;
  v_s_global  real := 0;
  v_s_explore real := 0;
  v_s_cold    real := 0;
  v_p_repeat  real := 0;
  v_score     real := 0;

  v_topic_max   real;
  v_creator_max real;
BEGIN
  -- Guard against unbounded division in normalization.
  v_topic_max   := GREATEST(5.0, COALESCE(p_user_topic_max,   5.0));
  v_creator_max := GREATEST(5.0, COALESCE(p_user_creator_max, 5.0));

  -- Load hook shape + global quality in one shot.
  SELECT h.topic_tags, v.creator_id,
         h.published_at, h.created_at,
         COALESCE(hgs.global_quality, 0)
    INTO v_hook_topic_tags, v_hook_creator_id,
         v_hook_published, v_hook_created, v_global_quality
    FROM public.hooks h
    JOIN public.videos v ON v.id = h.video_id
    LEFT JOIN public.hook_global_stats hgs ON hgs.hook_id = h.id
   WHERE h.id = p_hook_id;

  IF v_hook_topic_tags IS NULL THEN
    RETURN jsonb_build_object('error', 'hook_not_found', 'hook_id', p_hook_id);
  END IF;

  -- S_topic: signed, dynamic-max normalization (M3 + M6).
  -- Sum affinity across the hook's topics (missing = 0), normalize by tag
  -- count, clamp to [-0.5, 1.0], then divide by max to get [−0.1, 1.0]-ish.
  SELECT COALESCE(SUM(uta.affinity_score), 0),
         (ARRAY_AGG(uta.topic_slug ORDER BY uta.affinity_score DESC NULLS LAST))[1]
    INTO v_raw_topic_sum, v_top_topic
    FROM unnest(v_hook_topic_tags) AS t(tag)
    LEFT JOIN public.user_topic_affinity uta
      ON uta.user_id = p_user_id AND uta.topic_slug = t.tag;

  IF v_top_topic IS NULL AND cardinality(v_hook_topic_tags) > 0 THEN
    v_top_topic := v_hook_topic_tags[1];
  END IF;

  v_s_topic := GREATEST(-0.5, LEAST(1.0,
    v_raw_topic_sum / GREATEST(1.0, cardinality(v_hook_topic_tags)::real)
  )) / v_topic_max;

  -- S_creator: dynamic-max (NM2). Clamped to [0, 1] — negative creator
  -- affinity is rare and not penalized here (the scorer penalizes the
  -- topic side; creator side is "how much you like", not "how much you
  -- dislike").
  SELECT COALESCE(uca.affinity_score, 0) INTO v_creator_aff
    FROM public.user_creator_affinity uca
   WHERE uca.user_id = p_user_id AND uca.creator_id = v_hook_creator_id;
  v_s_creator := LEAST(1.0, GREATEST(0.0, COALESCE(v_creator_aff, 0) / v_creator_max));

  -- S_recency (C4: published_at if available, else created_at).
  v_age_days := EXTRACT(EPOCH FROM (now() - COALESCE(v_hook_published, v_hook_created))) / 86400;
  v_s_recency := 1.0 / (1.0 + ln(1.0 + GREATEST(0.0, v_age_days)));

  -- S_global.
  v_s_global := v_global_quality;

  -- S_explore: only fires on 'explore' slots AND only if at least one of the
  -- hook's topics is "sparse" (< 3 impressions for this user).
  IF p_slot_type = 'explore' THEN
    SELECT EXISTS (
      SELECT 1
        FROM unnest(v_hook_topic_tags) AS t(tag)
        LEFT JOIN public.user_topic_affinity uta
          ON uta.user_id = p_user_id AND uta.topic_slug = t.tag
       WHERE uta.impressions IS NULL OR uta.impressions < 3
    ) INTO v_has_sparse_topic;
    IF v_has_sparse_topic THEN
      v_s_explore := v_s_global;
    END IF;
  END IF;

  -- S_cold: normalized overlap between hook topics and interest_slugs.
  IF cardinality(COALESCE(p_interest_slugs, '{}'::text[])) > 0 THEN
    v_s_cold := LEAST(1.0,
      cardinality(ARRAY(
        SELECT UNNEST(v_hook_topic_tags)
        INTERSECT
        SELECT UNNEST(p_interest_slugs)
      ))::real / 3.0
    );
  END IF;

  -- P_repeat_creator (M8): consecutive run of same-creator trailing impressions.
  v_p_repeat := CASE
    WHEN COALESCE(p_consecutive_creator_streak, 0) <= 1 THEN 0.0
    WHEN p_consecutive_creator_streak = 2                THEN 0.2
    ELSE 0.8
  END;

  -- Combine.
  v_score := W_TOPIC   * v_s_topic
           + W_CREATOR * v_s_creator
           + W_RECENCY * v_s_recency
           + W_GLOBAL  * v_s_global
           + W_EXPLORE * v_s_explore
           + W_COLD    * v_s_cold
           - W_REPEAT  * v_p_repeat;

  RETURN jsonb_build_object(
    'regime',     p_regime,
    'slot_type',  p_slot_type,
    'top_topic',  v_top_topic,
    'age_days',   round(v_age_days::numeric, 2),
    'components', jsonb_build_object(
      'S_topic',   round(v_s_topic::numeric,   4),
      'S_creator', round(v_s_creator::numeric, 4),
      'S_recency', round(v_s_recency::numeric, 4),
      'S_global',  round(v_s_global::numeric,  4),
      'S_explore', round(v_s_explore::numeric, 4),
      'S_cold',    round(v_s_cold::numeric,    4)
    ),
    'weighted', jsonb_build_object(
      'W_TOPIC x S_topic',     round((W_TOPIC   * v_s_topic  )::numeric, 4),
      'W_CREATOR x S_creator', round((W_CREATOR * v_s_creator)::numeric, 4),
      'W_RECENCY x S_recency', round((W_RECENCY * v_s_recency)::numeric, 4),
      'W_GLOBAL x S_global',   round((W_GLOBAL  * v_s_global )::numeric, 4),
      'W_EXPLORE x S_explore', round((W_EXPLORE * v_s_explore)::numeric, 4),
      'W_COLD x S_cold',       round((W_COLD    * v_s_cold   )::numeric, 4),
      '- W_REPEAT x P_repeat', round((-W_REPEAT * v_p_repeat )::numeric, 4)
    ),
    'score_total', round(v_score::numeric, 4),
    'p_consecutive_creator_streak', p_consecutive_creator_streak
  );
END;$$;

REVOKE EXECUTE ON FUNCTION public.compute_hook_score(uuid, uuid, text, text, int, real, real, text[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.compute_hook_score(uuid, uuid, text, text, int, real, real, text[]) TO authenticated, service_role;

-- ---- feed_ranked_page (authenticated) ---------------------------------

CREATE OR REPLACE FUNCTION public.feed_ranked_page(
  p_limit            int    DEFAULT 10,
  p_cursor_epoch     bigint DEFAULT NULL,
  p_exclude_hook_ids uuid[] DEFAULT '{}'::uuid[]
) RETURNS TABLE (
  hook_id           uuid,
  video_id          uuid,
  creator_id        uuid,
  creator_handle    text,
  creator_name      text,
  creator_avatar    text,
  video_title       text,
  lesson_number     int,
  hook_title        text,
  hook_caption      text,
  hook_transcript   text,
  topic_tags        text[],
  mux_playback_id   text,
  mux_aspect_ratio  text,
  mux_duration_ms   integer,
  duration_seconds  integer,
  opening_prompt    text,
  question_seeds    jsonb,
  hook_created_at   timestamptz,
  score_total       real,
  score_breakdown   jsonb,
  served_rank       int,
  cursor_epoch      bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_caller          uuid := auth.uid();
  v_limit           int  := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
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

  -- M4: cap p_exclude_hook_ids at 50 to bound URL / jsonb payload size.
  v_exclude := ARRAY(
    SELECT x FROM unnest(COALESCE(p_exclude_hook_ids, '{}'::uuid[])) AS x LIMIT 50
  );

  -- Pre-compute once per call: dynamic ceilings (M3 + NM2), regime, interests.
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

  -- Trailing impressions (last 10 min, max 20) to compute M8 consecutive
  -- same-creator streak per candidate.
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

  -- S4: deterministic explore-slot positions, seeded by (user, cursor_epoch).
  v_seed := abs(hashtextextended(v_caller::text || ':' || v_cursor_epoch::text, 0));
  v_explore_slot_1 := 2 + ((v_seed      ) % 3)::int;   -- {2, 3, 4}
  v_explore_slot_2 := 6 + ((v_seed / 3  ) % 3)::int;   -- {6, 7, 8}

  RETURN QUERY
  WITH user_cooldowns AS (
    -- M5: on-the-fly cooldown per-hook. No MV.
    -- Composite index feed_events_raw_user_video_event_idx (NM3) supports the
    -- correlated NOT EXISTS on (user_id, video_id, event_name).
    SELECT f.hook_id,
           MAX(CASE
             WHEN f.event_name = 'mic_tap'
                  AND f.payload->>'mic_tap_outcome' = 'session_opened'
                  THEN f.created_at + interval '30 days'
             WHEN f.event_name = 'full_video_quartile'
                  AND (f.payload->>'quartile')::int = 100
                  THEN f.created_at + interval '14 days'
             WHEN f.event_name = 'full_video_quartile'
                  AND (f.payload->>'quartile')::int >= 50
                  THEN f.created_at + interval '7 days'
             WHEN f.event_name = 'full_video_open'
                  AND NOT EXISTS (
                    SELECT 1 FROM public.feed_events_raw q2
                     WHERE q2.user_id    = v_caller
                       AND q2.video_id   = f.video_id
                       AND q2.event_name = 'full_video_quartile'
                       AND q2.created_at > f.created_at
                       AND q2.created_at < f.created_at + interval '60 seconds'
                  ) THEN f.created_at + interval '24 hours'
             WHEN f.event_name = 'hook_dwell_end'
                  AND (f.payload->>'completion_pct')::real >= 0.8
                  THEN f.created_at + interval '3 days'
             WHEN f.event_name = 'hook_dwell_end'
                  AND (f.payload->>'completion_pct')::real < 0.8
                  THEN f.created_at + interval '7 days'
           END) AS available_after
      FROM public.feed_events_raw f
     WHERE f.user_id     = v_caller
       AND f.hook_id    IS NOT NULL
       AND f.created_at  > now() - interval '30 days'
       AND f.skipped_reason IS NULL
     GROUP BY f.hook_id
  ),
  candidates AS (
    -- Pool cap at 200 candidates. More than enough headroom for top-10.
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
           h.created_at           AS cand_hook_created_at
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
     LIMIT 200
  ),
  scored AS (
    -- Score each candidate via the shared function. Slot type is 'exploit'
    -- for the initial scoring; explore slots are reassigned after rank.
    SELECT c.*,
           public._consecutive_streak_from_tail(v_last_creators, c.cand_creator_id) AS streak,
           public.compute_hook_score(
             v_caller,
             c.cand_hook_id,
             'exploit',
             v_regime,
             public._consecutive_streak_from_tail(v_last_creators, c.cand_creator_id),
             v_topic_max,
             v_creator_max,
             v_interest_slugs
           ) AS bd
      FROM candidates c
  ),
  ranked AS (
    SELECT s.*,
           ((s.bd->>'score_total')::real) AS s_total,
           ROW_NUMBER() OVER (ORDER BY (s.bd->>'score_total')::real DESC NULLS LAST,
                                       s.cand_hook_created_at DESC,
                                       s.cand_hook_id) AS rn
      FROM scored s
  ),
  -- Mark slots 0-indexed for explore assignment. Matches plan §5.5: slots
  -- 0,1,5,9 always exploit; explore slot 1 in {2,3,4}; explore slot 2 in {6,7,8}.
  sliced AS (
    SELECT r.*,
           ((r.rn - 1)::int) AS slot_idx,
           CASE WHEN ((r.rn - 1)::int) IN (v_explore_slot_1, v_explore_slot_2)
                THEN 'explore' ELSE 'exploit' END AS slot_type
      FROM ranked r
     WHERE r.rn <= v_limit
  )
  SELECT
    sl.cand_hook_id,
    sl.cand_video_id,
    sl.cand_creator_id,
    sl.cand_creator_handle,
    sl.cand_creator_name,
    sl.cand_creator_avatar,
    sl.cand_video_title,
    sl.cand_lesson_number,
    sl.cand_hook_title,
    sl.cand_hook_caption,
    sl.cand_hook_transcript,
    sl.cand_topic_tags,
    sl.cand_mux_playback_id,
    sl.cand_mux_aspect_ratio,
    sl.cand_mux_duration_ms,
    sl.cand_duration_seconds,
    sl.cand_opening_prompt,
    sl.cand_question_seeds,
    sl.cand_hook_created_at,
    sl.s_total,
    -- Splice slot_type + served_rank into the breakdown so the admin
    -- explainer sees exactly what was served.
    jsonb_set(
      jsonb_set(sl.bd, '{slot_type}',   to_jsonb(sl.slot_type)),
      '{served_rank}',                   to_jsonb(sl.slot_idx)
    ) AS bd_out,
    sl.slot_idx,
    v_cursor_epoch
  FROM sliced sl
  ORDER BY sl.rn;
END;$$;

REVOKE EXECUTE ON FUNCTION public.feed_ranked_page(int, bigint, uuid[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.feed_ranked_page(int, bigint, uuid[]) TO authenticated;

-- ---- feed_ranked_anon_page (NC3) --------------------------------------

CREATE OR REPLACE FUNCTION public.feed_ranked_anon_page(
  p_anon_id      uuid,
  p_limit        int    DEFAULT 10,
  p_cursor_epoch bigint DEFAULT NULL
) RETURNS TABLE (
  hook_id           uuid,
  video_id          uuid,
  creator_id        uuid,
  creator_handle    text,
  creator_name      text,
  creator_avatar    text,
  video_title       text,
  lesson_number     int,
  hook_title        text,
  hook_caption      text,
  hook_transcript   text,
  topic_tags        text[],
  mux_playback_id   text,
  mux_aspect_ratio  text,
  mux_duration_ms   integer,
  duration_seconds  integer,
  opening_prompt    text,
  question_seeds    jsonb,
  hook_created_at   timestamptz,
  score_total       real,
  score_breakdown   jsonb,
  served_rank       int,
  cursor_epoch      bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  W_GLOBAL  constant real := 0.4;
  W_RECENCY constant real := 0.3;
  W_COLD    constant real := 0.5;
  v_anon_topic_aff jsonb := '{}'::jsonb;
  v_limit          int := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_cursor_epoch   bigint := COALESCE(p_cursor_epoch, EXTRACT(EPOCH FROM now())::bigint);
BEGIN
  -- Unknown anon_id → fall back to quality-ordered without affinity (M11).
  -- Not an error: the cookie may have expired or never been minted server-side.
  IF p_anon_id IS NOT NULL THEN
    SELECT COALESCE(topic_affinity, '{}'::jsonb)
      INTO v_anon_topic_aff
      FROM public.anon_feed_sessions WHERE anon_id = p_anon_id;
    IF NOT FOUND THEN
      v_anon_topic_aff := '{}'::jsonb;
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    h.id,
    h.video_id,
    c.id,
    c.handle::text,
    c.display_name,
    c.avatar_url,
    v.title,
    h.lesson_number,
    h.title,
    h.caption,
    h.transcript,
    h.topic_tags,
    h.mux_playback_id,
    h.mux_aspect_ratio,
    h.mux_duration_ms,
    h.duration_seconds,
    h.opening_prompt,
    h.question_seeds,
    h.created_at,
    (  W_GLOBAL  * COALESCE(hgs.global_quality, 0)
     + W_RECENCY * (1.0 / (1.0 + ln(1.0 + GREATEST(0.0,
         EXTRACT(EPOCH FROM (now() - COALESCE(h.published_at, h.created_at))) / 86400))))
     + W_COLD    * LEAST(1.0,
         cardinality(ARRAY(
           SELECT t.tag
             FROM unnest(h.topic_tags) AS t(tag)
            WHERE COALESCE((v_anon_topic_aff->>t.tag)::real, 0) > 0
         ))::real / 3.0
       )
    )::real AS st,
    NULL::jsonb AS bd,
    (ROW_NUMBER() OVER (ORDER BY
      (  W_GLOBAL  * COALESCE(hgs.global_quality, 0)
       + W_RECENCY * (1.0 / (1.0 + ln(1.0 + GREATEST(0.0,
           EXTRACT(EPOCH FROM (now() - COALESCE(h.published_at, h.created_at))) / 86400))))
       + W_COLD    * LEAST(1.0,
           cardinality(ARRAY(
             SELECT t.tag
               FROM unnest(h.topic_tags) AS t(tag)
              WHERE COALESCE((v_anon_topic_aff->>t.tag)::real, 0) > 0
           ))::real / 3.0
         )
      ) DESC,
      h.created_at DESC,
      h.id
    ) - 1)::int AS sr,
    v_cursor_epoch
  -- hooks_public view doesn't expose published_at; use the base table with
  -- the same visibility filters the view applies (mux_status='ready',
  -- not seed content). Recency formula needs published_at for C4.
  FROM public.hooks h
  JOIN public.videos   v ON v.id = h.video_id
  JOIN public.creators c ON c.id = v.creator_id
  LEFT JOIN public.hook_global_stats hgs ON hgs.hook_id = h.id
  WHERE h.mux_status = 'ready'
    AND h.is_seed_content = false
    AND v.published_at IS NOT NULL
    AND c.published_at IS NOT NULL
    AND c.creator_type = 'human'
  ORDER BY st DESC, h.created_at DESC, h.id
  LIMIT v_limit;
END;$$;

REVOKE EXECUTE ON FUNCTION public.feed_ranked_anon_page(uuid, int, bigint)
  FROM PUBLIC, anon, authenticated;
-- Service-role only; called from /api/feed (anon branch) via supabaseAdmin().
