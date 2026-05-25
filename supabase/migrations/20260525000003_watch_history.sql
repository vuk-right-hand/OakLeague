-- 20260525000003 — watch_history (private)
-- PROFILE_SYSTEM_PLAN U1 / §3.4.
--
-- Records a real watch (first long-form quartile, written by record_watch).
-- Private: own-read only, never in any public surface. Reads + writes re-gate
-- on creators.published_at so a since-taken-down creator's videos drop out of
-- history (videos RLS alone gates on videos.published_at only — audit C3).

CREATE TABLE public.watch_history (
  user_id         uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  video_id        uuid        NOT NULL REFERENCES public.videos(id)   ON DELETE CASCADE,
  first_viewed_at timestamptz NOT NULL DEFAULT now(),
  last_viewed_at  timestamptz NOT NULL DEFAULT now(),
  view_count      int         NOT NULL DEFAULT 1 CHECK (view_count >= 1),
  PRIMARY KEY (user_id, video_id)
);

CREATE INDEX watch_history_recent_idx ON public.watch_history (user_id, last_viewed_at DESC);

ALTER TABLE public.watch_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "watch_history own read"
  ON public.watch_history FOR SELECT
  USING (user_id = auth.uid());

GRANT SELECT ON public.watch_history TO authenticated;
-- No write policy: writes via record_watch / clear_watch_history RPCs only.

-- record_watch(video) -------------------------------------------------------

CREATE FUNCTION public.record_watch(p_video_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  -- Video AND its creator must be published at write time (audit C3/M6).
  IF NOT EXISTS (
    SELECT 1
      FROM public.videos v
      JOIN public.creators c ON c.id = v.creator_id
     WHERE v.id = p_video_id
       AND v.published_at IS NOT NULL
       AND c.published_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'video_not_available' USING ERRCODE = 'P0001';
  END IF;
  -- Light cap on distinct writes/min to stop scripted inflation (audit M6).
  IF NOT public.rate_limit_hit('watch_write', v_uid::text, interval '1 minute', 120) THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.watch_history (user_id, video_id)
  VALUES (v_uid, p_video_id)
  ON CONFLICT (user_id, video_id)
  DO UPDATE SET last_viewed_at = now(),
               view_count     = public.watch_history.view_count + 1;
END;$$;

REVOKE ALL   ON FUNCTION public.record_watch(uuid) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.record_watch(uuid) TO authenticated;

-- clear_watch_history() -----------------------------------------------------

CREATE FUNCTION public.clear_watch_history() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.watch_history WHERE user_id = v_uid;
END;$$;

REVOKE ALL   ON FUNCTION public.clear_watch_history() FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.clear_watch_history() TO authenticated;

-- list_watch_history(cursor, limit) -----------------------------------------
-- Own history, re-gated on creators.published_at so takedowns drop out.

CREATE FUNCTION public.list_watch_history(
  p_cursor timestamptz DEFAULT NULL,
  p_limit  int DEFAULT 30
) RETURNS TABLE (
  video_id       uuid,
  title          text,
  thumbnail_url  text,
  creator_handle citext,
  last_viewed_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.id, v.title, v.thumbnail_url, c.handle, w.last_viewed_at
    FROM public.watch_history w
    JOIN public.videos   v ON v.id = w.video_id AND v.published_at IS NOT NULL
    JOIN public.creators c ON c.id = v.creator_id AND c.published_at IS NOT NULL
   WHERE w.user_id = auth.uid()
     AND (p_cursor IS NULL OR w.last_viewed_at < p_cursor)
   ORDER BY w.last_viewed_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
$$;

REVOKE ALL   ON FUNCTION public.list_watch_history(timestamptz, int) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.list_watch_history(timestamptz, int) TO authenticated;
