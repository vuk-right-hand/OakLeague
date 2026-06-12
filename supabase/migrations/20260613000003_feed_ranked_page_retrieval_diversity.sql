-- 0613-03 — feed_ranked_page: quality-blended retrieval pool + slate
-- diversity (FEED_PRETRAFFIC_FIXES §3).
--
-- TWO changes vs the 0613-01 body (which is verbatim 0504-05 + weights):
--
-- (1) RETRIEVAL POOL (fix 1). The candidates CTE was `ORDER BY h.created_at
--     DESC LIMIT 200` — recency-only retrieval. Past 200 hooks, old
--     high-quality content became permanently unreachable. Now the pool is a
--     blend over the same filtered base:
--        pool_quality : top 120 by global_quality (LEFT JOIN hook_global_stats)
--        pool_recent  : top  50 by created_at
--        pool_random  : 30 seeded-random (hashtextextended over the SAME
--                       v_seed as the explore slots — deterministic per
--                       (user, cursor_epoch), so paging stays stable)
--     UNION ALL → DISTINCT ON (cand_hook_id). Inert while catalog ≤ 120
--     (quality arm alone covers the whole base; the union is the full set);
--     divergence window 120–200 documented in the plan. Downstream CTEs
--     re-order by score, so only pool MEMBERSHIP matters.
--
-- (2) SLATE DIVERSITY (fix 2). Exploit ordering gets a soft same-creator
--     interleave: the Nth hook from one creator inside the slate ordering is
--     demoted by W_DIVERSITY_STEP*(N-1) ranks (live-tunable, 0 disables).
--     Runs AFTER explore-winner exclusion (audit C-R2-1) so creator_seq
--     partitions only over actual exploit candidates. div_rn / hook_rn are
--     ROW_NUMBER outputs — gapless 1..N regardless of penalty values, so the
--     exploit_positions slot join cannot misalign (audit C-R2-2).
--     Single creator: creator_seq == rank-by-exploit_rn ⇒ penalized key is
--     strictly monotone in exploit_rn ⇒ provable no-op. score_breakdown on
--     exploit rows gains {'diversity': {creator_seq, exploit_rn}} (explore
--     rows carry no diversity field by design).
--
-- Everything else — cooldown CTEs (hardened _jsonb_real/_jsonb_int casts),
-- explore-slot seeding, limit clamps, RETURNS shape, grants — is verbatim.
-- Cast fidelity is mechanically guarded by
-- algo_feed_ranked_page_source_hardened_casts.test.sql (audit C-R2-3).

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
  v_div_step        real;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = '28000';
  END IF;

  v_div_step := COALESCE((v_weights->>'W_DIVERSITY_STEP')::real, 2.0);

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
  -- Fix 1: filtered base (all visibility/exclude/cooldown rules — unchanged
  -- from the old candidates CTE) feeding three capped retrieval arms.
  base AS (
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
                                  AS cand_long_form_available,
           COALESCE(hgs.global_quality, 0)
                                  AS cand_pool_gq
      FROM public.hooks_public h
      JOIN public.videos   v ON v.id = h.video_id
      JOIN public.creators c ON c.id = v.creator_id
      LEFT JOIN public.hook_global_stats hgs ON hgs.hook_id = h.id
     WHERE v.published_at IS NOT NULL
       AND c.published_at IS NOT NULL
       AND c.creator_type = 'human'
       AND h.id <> ALL (v_exclude)
       AND NOT EXISTS (
         SELECT 1 FROM user_cooldowns uc
          WHERE uc.hook_id = h.id AND uc.available_after > now()
       )
  ),
  pool_quality AS (
    SELECT * FROM base
     ORDER BY cand_pool_gq DESC, cand_hook_created_at DESC, cand_hook_id
     LIMIT 120
  ),
  pool_recent AS (
    SELECT * FROM base
     ORDER BY cand_hook_created_at DESC, cand_hook_id
     LIMIT 50
  ),
  pool_random AS (
    -- Signed hash is fine: pure ORDER BY, no modulo (audit S-R2-2). Shares
    -- v_seed with the explore slots ⇒ deterministic per (user, cursor_epoch).
    SELECT * FROM base
     ORDER BY hashtextextended(cand_hook_id::text || ':' || v_seed::text, 0),
              cand_hook_id
     LIMIT 30
  ),
  candidates AS (
    -- Duplicate rows across arms are value-identical (same base), so the
    -- DISTINCT ON survivor choice is immaterial; ORDER BY satisfies the
    -- DISTINCT ON leading-expression rule. Downstream re-orders by score.
    SELECT DISTINCT ON (cand_hook_id) *
      FROM (
        SELECT * FROM pool_quality
        UNION ALL
        SELECT * FROM pool_recent
        UNION ALL
        SELECT * FROM pool_random
      ) u
     ORDER BY cand_hook_id
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
  -- Fix 2: diversity re-rank, AFTER explore-winner exclusion (audit C-R2-1).
  exploit_pool AS (
    SELECT er.* FROM exploit_ranked er
     WHERE NOT EXISTS (
       SELECT 1 FROM top_explore te2
        WHERE te2.cand_hook_id = er.cand_hook_id
     )
  ),
  exploit_seq AS (
    SELECT ep.*,
           ROW_NUMBER() OVER (PARTITION BY ep.cand_creator_id
                              ORDER BY ep.exploit_rn) AS creator_seq
      FROM exploit_pool ep
  ),
  exploit_diversified AS (
    SELECT eq.*,
           ROW_NUMBER() OVER (
             ORDER BY eq.exploit_rn + v_div_step * (eq.creator_seq - 1),
                      eq.exploit_rn
           ) AS div_rn
      FROM exploit_seq eq
  ),
  top_exploit AS (
    SELECT *,
           ROW_NUMBER() OVER (ORDER BY div_rn) AS hook_rn
      FROM (
        SELECT * FROM exploit_diversified
         ORDER BY div_rn
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
      -- Exploit rows carry the diversity trace for the admin explainer
      -- (explore rows below carry none — S-R2-3).
      jsonb_set(te.bd_exploit, '{diversity}',
                jsonb_build_object('creator_seq', te.creator_seq,
                                   'exploit_rn',  te.exploit_rn)) AS bd,
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
