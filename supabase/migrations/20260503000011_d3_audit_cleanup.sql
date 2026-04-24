-- 0503-11 — D3 audit cleanup
-- Findings addressed:
--   H-D3-1  explore/exploit slots were labels, not scores — dual-score each candidate
--   M-D3-1  feed_ranked_anon_page missing p_exclude_hook_ids
--   M-D3-2  anon page duplicated scoring expression in SELECT + ORDER BY
--   M-D3-3  _consecutive_streak_from_tail called twice per candidate
--   M-D3-5  users with interest_slugs but no events stay at regime A
--   M-D3-6  candidates LIMIT 200 had no ORDER BY (arbitrary pool at scale)
--   S-D3-1  compute_hook_score granted to authenticated (should be service_role only)

-- ── S-D3-1 ───────────────────────────────────────────────────────────────────
-- compute_hook_score must not be callable by authenticated clients directly;
-- only feed_ranked_page (SECURITY DEFINER) and admin RPCs (service_role) should
-- invoke it. An authenticated caller could probe other users' scoring state via
-- guessed hook/user UUID combinations.
REVOKE EXECUTE ON FUNCTION public.compute_hook_score(
  uuid, uuid, text, text, int, real, real, text[]
) FROM authenticated;

-- ── M-D3-5 ───────────────────────────────────────────────────────────────────
-- Promote feed_regime A→B when interest_slugs is set at onboarding. The rollup
-- trigger (migration 6) already promotes A→B on first feed event, but onboarding
-- sets interest_slugs before any event exists, leaving those users at regime A
-- and losing their cold-start intent signals.
CREATE OR REPLACE FUNCTION public._promote_regime_on_interests()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.feed_regime = 'A'
     AND cardinality(COALESCE(NEW.interest_slugs, '{}'::text[])) > 0
     AND (
       TG_OP = 'INSERT'
       OR cardinality(COALESCE(OLD.interest_slugs, '{}'::text[])) = 0
       OR OLD.interest_slugs IS NULL
     ) THEN
    NEW.feed_regime := 'B';
  END IF;
  RETURN NEW;
END;$$;

DROP TRIGGER IF EXISTS promote_regime_on_interests ON public.profiles;
CREATE TRIGGER promote_regime_on_interests
  BEFORE INSERT OR UPDATE OF interest_slugs ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public._promote_regime_on_interests();

-- ── H-D3-1 + M-D3-3 + M-D3-6: rewrite feed_ranked_page ────────────────────
--
-- Three bugs fixed in one rewrite:
--
--   M-D3-3: _consecutive_streak_from_tail was called twice per candidate (once
--   as a named column, once as an argument). Now computed once in `scored` CTE
--   and referenced by name in `dual_scored`.
--
--   H-D3-1: all candidates were scored as 'exploit'; explore slots were
--   post-hoc labels with S_explore=0 everywhere. Now each candidate is scored
--   twice (bd_exploit + bd_explore). Explore slots are filled from the pool of
--   candidates with S_explore > 0, ranked by their explore score. Exploit slots
--   are filled from the remaining candidates ranked by exploit score. If fewer
--   than 2 explore-eligible candidates exist those positions fall back to
--   exploit.
--
--   M-D3-6: candidates LIMIT 200 now has ORDER BY h.created_at DESC so the
--   pool is the most-recent 200 hooks, not an arbitrary heap-order slice.

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

  v_exclude := ARRAY(
    SELECT x FROM unnest(COALESCE(p_exclude_hook_ids, '{}'::uuid[])) AS x LIMIT 50
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

  -- Deterministic explore-slot positions seeded by (user, cursor_epoch).
  v_seed := abs(hashtextextended(v_caller::text || ':' || v_cursor_epoch::text, 0));
  v_explore_slot_1 := 2 + ((v_seed      ) % 3)::int;   -- {2, 3, 4}
  v_explore_slot_2 := 6 + ((v_seed / 3  ) % 3)::int;   -- {6, 7, 8}

  RETURN QUERY
  WITH user_cooldowns AS (
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
    -- M-D3-6: ORDER BY before LIMIT keeps the pool deterministic at scale.
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
     ORDER BY h.created_at DESC
     LIMIT 200
  ),
  scored AS (
    -- M-D3-3: streak computed once here, referenced by name in dual_scored.
    SELECT c.*,
           public._consecutive_streak_from_tail(v_last_creators, c.cand_creator_id) AS streak
      FROM candidates c
  ),
  dual_scored AS (
    -- H-D3-1: score each candidate as both 'exploit' and 'explore' so that
    -- S_explore is non-zero for eligible hooks when they land in explore slots.
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
    -- Only hooks where scoring as 'explore' yields S_explore > 0. Hooks that
    -- saturate at explore quality=0 (no global signal) never fill explore slots.
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
    -- Take up to 2 explore picks, only for slot positions within the page.
    SELECT * FROM explore_eligible
     WHERE explore_rn <= 2
       AND CASE explore_rn
             WHEN 1 THEN v_explore_slot_1 < v_limit
             WHEN 2 THEN v_explore_slot_2 < v_limit
           END
  ),
  top_exploit AS (
    -- Exploit pool: exclude hooks already claimed by top_explore, take top
    -- v_limit, then number them 1-based for position assignment.
    SELECT *,
           ROW_NUMBER() OVER (ORDER BY exploit_rn) AS hook_rn
      FROM (
        SELECT * FROM exploit_ranked
         WHERE cand_hook_id NOT IN (SELECT cand_hook_id FROM top_explore)
         ORDER BY exploit_rn
         LIMIT v_limit
      ) limited
  ),
  exploit_positions AS (
    -- Available slot indices (0-based) for exploit hooks. A slot is reserved
    -- only if the corresponding top_explore entry actually exists.
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
    v_cursor_epoch
  FROM merged m
  ORDER BY m.slot_idx;
END;$$;

REVOKE EXECUTE ON FUNCTION public.feed_ranked_page(int, bigint, uuid[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.feed_ranked_page(int, bigint, uuid[]) TO authenticated;

-- ── M-D3-1 + M-D3-2: rewrite feed_ranked_anon_page ──────────────────────────
--
--   M-D3-1: new p_exclude_hook_ids parameter (capped at 50, same as auth feed).
--   M-D3-2: scoring expression was duplicated verbatim in both the SELECT list
--   (as `st`) and the ORDER BY clause. Now computed once in a CTE; the outer
--   query reads `st` for both score_total and ROW_NUMBER ordering.
--
-- The old 3-arg signature (uuid, int, bigint) must be explicitly dropped before
-- creating the new 4-arg one; CREATE OR REPLACE only replaces an exact match.
DROP FUNCTION IF EXISTS public.feed_ranked_anon_page(uuid, int, bigint);

CREATE OR REPLACE FUNCTION public.feed_ranked_anon_page(
  p_anon_id          uuid,
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
  W_GLOBAL  constant real := 0.4;
  W_RECENCY constant real := 0.3;
  W_COLD    constant real := 0.5;
  v_anon_topic_aff jsonb := '{}'::jsonb;
  v_limit          int   := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_cursor_epoch   bigint := COALESCE(p_cursor_epoch, EXTRACT(EPOCH FROM now())::bigint);
  v_exclude        uuid[];
BEGIN
  v_exclude := ARRAY(
    SELECT x FROM unnest(COALESCE(p_exclude_hook_ids, '{}'::uuid[])) AS x LIMIT 50
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
    -- M-D3-2: compute st once; ORDER BY reads the alias.
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
    v_cursor_epoch
  FROM scored s
  ORDER BY s.st DESC, s.r_hook_created_at DESC, s.r_hook_id
  LIMIT v_limit;
END;$$;

REVOKE EXECUTE ON FUNCTION public.feed_ranked_anon_page(uuid, int, bigint, uuid[])
  FROM PUBLIC, anon, authenticated;
-- Service-role only; called from /api/feed (anon branch) via supabaseAdmin().
