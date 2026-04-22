-- 0046 — feed_page defense-in-depth (audit C1).
-- The RPC is STABLE (not SECURITY DEFINER) so it inherits caller RLS.
-- A service-role caller would bypass RLS entirely and leak draft videos.
-- The route is now server-anon-bound, but we add explicit WHERE filters
-- here so the RPC is correct regardless of who calls it.
--
-- Filters added:
--   v.published_at IS NOT NULL  -- never return drafts
--   c.published_at IS NOT NULL  -- never return unpublished creators
--   c.creator_type = 'human'    -- v1 only ships human creators
--
-- hooks_public already filters mux_status='ready' AND is_seed_content=false.

CREATE OR REPLACE FUNCTION public.feed_page(
  p_cursor_created_at timestamptz,
  p_cursor_id         uuid,
  p_limit             int DEFAULT 10
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
  hook_created_at   timestamptz
)
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT h.id,
         h.video_id,
         c.id,
         c.handle,
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
         h.created_at
    FROM public.hooks_public h
    JOIN public.videos   v ON v.id = h.video_id
    JOIN public.creators c ON c.id = v.creator_id
   WHERE v.published_at IS NOT NULL
     AND c.published_at IS NOT NULL
     AND c.creator_type = 'human'
     AND (
           p_cursor_created_at IS NULL
           OR (h.created_at, h.id) < (p_cursor_created_at, p_cursor_id)
         )
   ORDER BY h.created_at DESC, h.id DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

REVOKE ALL    ON FUNCTION public.feed_page(timestamptz, uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.feed_page(timestamptz, uuid, int) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
