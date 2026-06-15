-- 0613-01 — feed_algo_weights: live-tunable scorer weights (FEED_PRETRAFFIC_FIXES §1).
--
-- Replaces the hardcoded `constant real` weights in compute_hook_score and
-- feed_ranked_anon_page with a service-role-only table + a SECURITY DEFINER
-- loader helper. Seed values are TODAY'S exact constants, so scores are
-- bit-identical at ship; behavior changes only when an admin touches a knob.
--
-- Five objects:
--   (1) public.feed_algo_weights        — 11 seeded rows, RLS zero-policy
--   (2) public._feed_algo_weights_jsonb — secdef loader; hardcoded defaults
--       are the ONLY fallback copy (drift-guarded by pgTAP seeded-defaults test)
--   (3) compute_hook_score              — DROP 8-arg, CREATE 9-arg
--       (p_weights jsonb DEFAULT NULL). All existing ≤8-arg call sites
--       (admin_algo_score_explain, 3 test files) resolve to the new fn with
--       the default. Weight names stay W_TOPIC/… as plain (non-constant)
--       DECLARE vars so the body is verbatim 0503-10.
--   (4) feed_ranked_page                — verbatim 0504-05 body + one
--       v_weights load per page, passed as 9th arg at both call sites
--   (5) feed_ranked_anon_page           — verbatim 0504-04 body; the three
--       constants now read namespaced *_ANON keys (auth and anon feeds are
--       tuned independently — round-1 audit M1)
-- plus admin_list_feed_algo_weights / admin_set_feed_algo_weight (guarded,
-- audited; pattern: admin_set_profile_tier).
--
-- p_weights contract: pass NULL (self-loads live weights via the secdef
-- helper) or the full output of _feed_algo_weights_jsonb(). A partial jsonb
-- missing W_TOPIC falls back to the helper wholesale — never NULL-weight
-- scoring. Both scorer and helper stay service-role-only (S-D3-1).

-- ── (1) Table ──────────────────────────────────────────────────────────────

CREATE TABLE public.feed_algo_weights (
  weight_key   text PRIMARY KEY,
  weight_value real NOT NULL,
  min_value    real NOT NULL,
  max_value    real NOT NULL,
  description  text NOT NULL,
  updated_by   uuid REFERENCES auth.users(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (weight_value >= min_value AND weight_value <= max_value),
  CHECK (min_value <= max_value)
);

ALTER TABLE public.feed_algo_weights ENABLE ROW LEVEL SECURITY;
-- Zero policies: service-role only. Reads flow through the secdef helper;
-- writes through the audited admin RPC.

REVOKE ALL ON TABLE public.feed_algo_weights FROM PUBLIC, anon, authenticated;
GRANT  ALL ON TABLE public.feed_algo_weights TO service_role;

INSERT INTO public.feed_algo_weights (weight_key, weight_value, min_value, max_value, description) VALUES
  ('W_TOPIC',          1.0, 0.0,  3.0, 'Authenticated scorer: topic-affinity component weight'),
  ('W_CREATOR',        0.6, 0.0,  3.0, 'Authenticated scorer: creator-affinity component weight'),
  ('W_RECENCY',        0.3, 0.0,  3.0, 'Authenticated scorer: recency component weight'),
  ('W_GLOBAL',         0.4, 0.0,  3.0, 'Authenticated scorer: global-quality component weight'),
  ('W_EXPLORE',        0.8, 0.0,  3.0, 'Authenticated scorer: explore-slot bonus weight'),
  ('W_COLD',           0.5, 0.0,  3.0, 'Authenticated scorer: interest-slug cold-start weight'),
  ('W_REPEAT',         0.5, 0.0,  3.0, 'Authenticated scorer: repeat-creator streak penalty weight'),
  ('W_DIVERSITY_STEP', 2.0, 0.0, 10.0, 'feed_ranked_page slate re-rank: ranks a creator''s Nth page hook drops (0 disables)'),
  ('W_GLOBAL_ANON',    0.4, 0.0,  3.0, 'Anon lite scorer: global-quality weight (anon feed ONLY)'),
  ('W_RECENCY_ANON',   0.3, 0.0,  3.0, 'Anon lite scorer: recency weight (anon feed ONLY)'),
  ('W_COLD_ANON',      0.5, 0.0,  3.0, 'Anon lite scorer: session topic-affinity weight (anon feed ONLY)');

-- ── (2) Loader helper ──────────────────────────────────────────────────────
-- SECURITY DEFINER (owner = migration role, RLS-bypassing) so the table read
-- works regardless of who the calling context runs as. Service-role-only like
-- compute_hook_score itself (S-D3-1): every live caller chain starts inside a
-- SECURITY DEFINER feed/admin RPC, so no client-facing grant is needed.

CREATE FUNCTION public._feed_algo_weights_jsonb() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'W_TOPIC',          1.0,
    'W_CREATOR',        0.6,
    'W_RECENCY',        0.3,
    'W_GLOBAL',         0.4,
    'W_EXPLORE',        0.8,
    'W_COLD',           0.5,
    'W_REPEAT',         0.5,
    'W_DIVERSITY_STEP', 2.0,
    'W_GLOBAL_ANON',    0.4,
    'W_RECENCY_ANON',   0.3,
    'W_COLD_ANON',      0.5
  ) || COALESCE(
    (SELECT jsonb_object_agg(weight_key, weight_value)
       FROM public.feed_algo_weights),
    '{}'::jsonb
  );
$$;

REVOKE ALL ON FUNCTION public._feed_algo_weights_jsonb() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._feed_algo_weights_jsonb() TO service_role;

-- ── (3) compute_hook_score: 8-arg → 9-arg ──────────────────────────────────
-- DROP (not OR REPLACE): adding a defaulted param is a signature change; an
-- overload would make 8-arg calls ambiguous. Every caller is re-pointed in
-- THIS migration (feed_ranked_page below) or resolves via the default
-- (admin_algo_score_explain 0504-06:652, test files). Body verbatim 0503-10
-- except the DECLARE weight block.

DROP FUNCTION public.compute_hook_score(uuid, uuid, text, text, int, real, real, text[]);

CREATE FUNCTION public.compute_hook_score(
  p_user_id                    uuid,
  p_hook_id                    uuid,
  p_slot_type                  text    DEFAULT 'exploit',
  p_regime                     text    DEFAULT 'C',
  p_consecutive_creator_streak int     DEFAULT 0,
  p_user_topic_max             real    DEFAULT 5.0,
  p_user_creator_max           real    DEFAULT 5.0,
  p_interest_slugs             text[]  DEFAULT '{}'::text[],
  p_weights                    jsonb   DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
DECLARE
  -- Weights: live table via secdef helper, or the precomputed jsonb the feed
  -- RPCs pass per page (audit M3: one table read per page, not 400).
  v_w jsonb := CASE WHEN COALESCE(p_weights, '{}'::jsonb) ? 'W_TOPIC'
                    THEN p_weights
                    ELSE public._feed_algo_weights_jsonb() END;
  W_TOPIC   real := (v_w->>'W_TOPIC')::real;
  W_CREATOR real := (v_w->>'W_CREATOR')::real;
  W_RECENCY real := (v_w->>'W_RECENCY')::real;
  W_GLOBAL  real := (v_w->>'W_GLOBAL')::real;
  W_EXPLORE real := (v_w->>'W_EXPLORE')::real;
  W_COLD    real := (v_w->>'W_COLD')::real;
  W_REPEAT  real := (v_w->>'W_REPEAT')::real;

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

  -- S_creator: dynamic-max (NM2). Clamped to [0, 1].
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

-- S-D3-1 (20260503000011) preserved across the DROP/CREATE: compute_hook_score
-- is service-role-only. An authenticated grant would let clients probe other
-- users' scoring state via guessed hook/user UUID pairs. Only feed_ranked_page
-- (SECURITY DEFINER) and admin RPCs invoke it.
REVOKE EXECUTE ON FUNCTION public.compute_hook_score(uuid, uuid, text, text, int, real, real, text[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.compute_hook_score(uuid, uuid, text, text, int, real, real, text[], jsonb) TO service_role;

-- ── (4) feed_ranked_page: load weights once per page ───────────────────────
-- Body verbatim 0504-05:485 except: v_weights in DECLARE + 9th arg at the two
-- compute_hook_score call sites. Pool/diversity changes land in 0613-03.

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
  v_weights         jsonb := public._feed_algo_weights_jsonb();
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
             s.streak, v_topic_max, v_creator_max, v_interest_slugs, v_weights
           ) AS bd_exploit,
           public.compute_hook_score(
             v_caller, s.cand_hook_id, 'explore', v_regime,
             s.streak, v_topic_max, v_creator_max, v_interest_slugs, v_weights
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

-- ── (5) feed_ranked_anon_page: namespaced *_ANON weights ───────────────────
-- Body verbatim 0504-04; the three `constant real` declarations become plain
-- vars read from the weights jsonb (names preserved so the body is untouched).

CREATE OR REPLACE FUNCTION public.feed_ranked_anon_page(
  p_anon_id          uuid,
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
  v_weights jsonb := public._feed_algo_weights_jsonb();
  W_GLOBAL  real := (v_weights->>'W_GLOBAL_ANON')::real;
  W_RECENCY real := (v_weights->>'W_RECENCY_ANON')::real;
  W_COLD    real := (v_weights->>'W_COLD_ANON')::real;
  v_anon_topic_aff jsonb := '{}'::jsonb;
  v_limit          int   := LEAST(GREATEST(COALESCE(p_limit, 10), 0), 50);
  v_cursor_epoch   bigint := COALESCE(p_cursor_epoch, EXTRACT(EPOCH FROM now())::bigint);
  v_exclude        uuid[];
BEGIN
  v_exclude := ARRAY(
    SELECT x FROM unnest(COALESCE(p_exclude_hook_ids, '{}'::uuid[]))
                  WITH ORDINALITY AS t(x, ord)
    ORDER BY ord
    LIMIT 50
  );

  IF p_anon_id IS NOT NULL THEN
    SELECT COALESCE(topic_affinity, '{}'::jsonb)
      INTO v_anon_topic_aff
      FROM public.anon_feed_sessions WHERE anon_id = p_anon_id;
    IF NOT FOUND THEN
      v_anon_topic_aff := '{}'::jsonb;
    END IF;
  END IF;

  RETURN QUERY
  WITH scored AS (
    SELECT
      h.id                AS r_hook_id,
      h.video_id          AS r_video_id,
      c.id                AS r_creator_id,
      c.handle::text      AS r_creator_handle,
      c.display_name      AS r_creator_name,
      c.avatar_url        AS r_creator_avatar,
      v.title             AS r_video_title,
      h.lesson_number     AS r_lesson_number,
      h.title             AS r_hook_title,
      h.caption           AS r_hook_caption,
      h.transcript        AS r_hook_transcript,
      h.topic_tags        AS r_topic_tags,
      h.mux_playback_id   AS r_mux_playback_id,
      h.mux_aspect_ratio  AS r_mux_aspect_ratio,
      h.mux_duration_ms   AS r_mux_duration_ms,
      h.duration_seconds  AS r_duration_seconds,
      h.opening_prompt    AS r_opening_prompt,
      h.question_seeds    AS r_question_seeds,
      h.created_at        AS r_hook_created_at,
      (v.long_form_mux_playback_id IS NOT NULL
       AND v.long_form_published_at IS NOT NULL)
                          AS r_long_form_available,
      (  W_GLOBAL  * COALESCE(hgs.global_quality, 0)
       + W_RECENCY * (1.0 / (1.0 + ln(1.0 + GREATEST(0.0,
           EXTRACT(EPOCH FROM (now() - COALESCE(h.published_at, h.created_at))) / 86400))))
       + W_COLD    * LEAST(1.0,
           cardinality(ARRAY(
             SELECT t.tag FROM unnest(h.topic_tags) AS t(tag)
              WHERE COALESCE((v_anon_topic_aff->>t.tag)::real, 0) > 0
           ))::real / 3.0
         )
      )::real             AS st
    FROM public.hooks h
    JOIN public.videos   v ON v.id = h.video_id
    JOIN public.creators c ON c.id = v.creator_id
    LEFT JOIN public.hook_global_stats hgs ON hgs.hook_id = h.id
   WHERE h.mux_status     = 'ready'
     AND h.is_seed_content = false
     AND v.published_at   IS NOT NULL
     AND c.published_at   IS NOT NULL
     AND c.creator_type   = 'human'
     AND h.id <> ALL(v_exclude)
   ORDER BY h.created_at DESC
   LIMIT 200
  )
  SELECT
    s.r_hook_id,
    s.r_video_id,
    s.r_creator_id,
    s.r_creator_handle,
    s.r_creator_name,
    s.r_creator_avatar,
    s.r_video_title,
    s.r_lesson_number,
    s.r_hook_title,
    s.r_hook_caption,
    s.r_hook_transcript,
    s.r_topic_tags,
    s.r_mux_playback_id,
    s.r_mux_aspect_ratio,
    s.r_mux_duration_ms,
    s.r_duration_seconds,
    s.r_opening_prompt,
    s.r_question_seeds,
    s.r_hook_created_at,
    s.st,
    NULL::jsonb,
    (ROW_NUMBER() OVER (ORDER BY s.st DESC, s.r_hook_created_at DESC, s.r_hook_id) - 1)::int,
    v_cursor_epoch,
    s.r_long_form_available
  FROM scored s
  ORDER BY s.st DESC, s.r_hook_created_at DESC, s.r_hook_id
  LIMIT v_limit;
END;$$;

REVOKE EXECUTE ON FUNCTION public.feed_ranked_anon_page(uuid, int, bigint, uuid[])
  FROM PUBLIC, anon, authenticated;

-- ── Admin RPCs ──────────────────────────────────────────────────────────────

CREATE FUNCTION public.admin_list_feed_algo_weights()
RETURNS TABLE (
  weight_key   text,
  weight_value real,
  min_value    real,
  max_value    real,
  description  text,
  updated_at   timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_admin_id uuid := auth.uid();
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

  RETURN QUERY
  SELECT w.weight_key, w.weight_value, w.min_value, w.max_value,
         w.description, w.updated_at
    FROM public.feed_algo_weights w
   ORDER BY w.weight_key;
END;$$;

REVOKE ALL    ON FUNCTION public.admin_list_feed_algo_weights() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_feed_algo_weights() TO authenticated;

CREATE FUNCTION public.admin_set_feed_algo_weight(
  p_key   text,
  p_value real
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_old      real;
  v_min      real;
  v_max      real;
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

  SELECT weight_value, min_value, max_value INTO v_old, v_min, v_max
    FROM public.feed_algo_weights
   WHERE weight_key = p_key
   FOR UPDATE;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'weight key not found: %', p_key USING ERRCODE = 'P0002';
  END IF;

  IF p_value IS NULL OR p_value <> p_value /* NaN */
     OR p_value = 'Infinity'::real OR p_value = '-Infinity'::real
     OR p_value < v_min OR p_value > v_max THEN
    RAISE EXCEPTION 'weight value out of bounds for %: must be finite in [%, %]',
      p_key, v_min, v_max USING ERRCODE = '22023';
  END IF;

  UPDATE public.feed_algo_weights
     SET weight_value = p_value,
         updated_by   = v_admin_id,
         updated_at   = now()
   WHERE weight_key = p_key;

  -- target_id is NULL by design: weight keys are text, target_id is uuid
  -- (audit M2). Forensics key on after->>'key'. target_kind 'system' is the
  -- first non-profile/session kind (plain text column, no CHECK).
  INSERT INTO public.admin_audit_log (admin_user_id, action, target_kind, target_id, before, after)
  VALUES (
    v_admin_id,
    'feed_algo_weight_set',
    'system',
    NULL,
    jsonb_build_object('key', p_key, 'value', v_old),
    jsonb_build_object('key', p_key, 'value', p_value)
  );
END;$$;

REVOKE ALL    ON FUNCTION public.admin_set_feed_algo_weight(text, real) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_feed_algo_weight(text, real) TO authenticated;

NOTIFY pgrst, 'reload schema';
