-- 0504-04 — feed_ranked_anon_page returns-shape extension (long-form viewer
-- plan §1.4). Single change vs 0503-14: append long_form_available bool to
-- RETURNS TABLE and project (v.long_form_mux_playback_id IS NOT NULL AND
-- v.long_form_published_at IS NOT NULL) from the joined videos v.
--
-- Anon ranking has no cooldown CTE today; we do NOT add one for long-form.
-- The anon-side feed pill renders on the same long_form_available signal as
-- auth — the cooldown logic stays anon-blind. If anon long-form cooldowns
-- become desirable later, that's a separate algo project.

DROP FUNCTION IF EXISTS public.feed_ranked_anon_page(uuid, int, bigint, uuid[]);

CREATE FUNCTION public.feed_ranked_anon_page(
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
  W_GLOBAL  constant real := 0.4;
  W_RECENCY constant real := 0.3;
  W_COLD    constant real := 0.5;
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

NOTIFY pgrst, 'reload schema';
