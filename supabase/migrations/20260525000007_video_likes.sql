-- 20260525000007 — video likes (COMMENTS_LIKES_PLAN L1)
--
-- One action: a like increments a PUBLIC count (videos.like_count) AND the set
-- of a user's likes is their PRIVATE "Liked" list. WHO liked a video is private
-- (own-read RLS); the public sees only the aggregate count. Video-level.
-- Patterns mirror handshakes/watch_history (count trigger, published re-gate,
-- 1-min rate limit, REVOKE-all-then-grant).

CREATE TABLE public.video_likes (
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  video_id   uuid        NOT NULL REFERENCES public.videos(id)   ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video_id)
);

-- Composite keyset for the "Liked" tab (created_at not unique → tiebreaker, audit M7).
CREATE INDEX video_likes_recent_idx ON public.video_likes (user_id, created_at DESC, video_id);

ALTER TABLE public.videos ADD COLUMN like_count int NOT NULL DEFAULT 0 CHECK (like_count >= 0);

-- Count maintenance. The CHECK >= 0 is a tripwire, not a correctness mechanism.
-- Cascade directions (audit M4): a USER delete cascades their likes → each fires
-- AFTER DELETE → decrements the SURVIVING video. A VIDEO delete cascades its
-- likes too, but the video row is already gone so the UPDATE matches 0 rows (no-op).
CREATE FUNCTION public.videos_like_count_maintain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.videos SET like_count = like_count + 1 WHERE id = NEW.video_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.videos SET like_count = GREATEST(0, like_count - 1) WHERE id = OLD.video_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;$$;

REVOKE ALL ON FUNCTION public.videos_like_count_maintain() FROM public, anon, authenticated;

CREATE TRIGGER videos_like_count_maintain
  AFTER INSERT OR DELETE ON public.video_likes
  FOR EACH ROW EXECUTE FUNCTION public.videos_like_count_maintain();

-- RLS: own-read only (who-liked is private). Public sees only videos.like_count.
ALTER TABLE public.video_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "video_likes own read"
  ON public.video_likes FOR SELECT
  USING (user_id = auth.uid());

GRANT SELECT ON public.video_likes TO authenticated;  -- restrictive default-grant posture (20260420000021)
-- No write policy: writes via RPC only.

-- like_video(video) ---------------------------------------------------------

CREATE FUNCTION public.like_video(p_video_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  -- Video AND its creator must be published (audit C4; videos RLS gates on
  -- videos.published_at only).
  IF NOT EXISTS (
    SELECT 1 FROM public.videos v
      JOIN public.creators c ON c.id = v.creator_id
     WHERE v.id = p_video_id
       AND v.published_at IS NOT NULL
       AND c.published_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'video_not_available' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.rate_limit_hit('video_like', v_uid::text, interval '1 minute', 60) THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.video_likes (user_id, video_id)
  VALUES (v_uid, p_video_id)
  ON CONFLICT (user_id, video_id) DO NOTHING;  -- idempotent; count never double-moves
END;$$;

REVOKE ALL   ON FUNCTION public.like_video(uuid) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.like_video(uuid) TO authenticated;

-- unlike_video(video) -------------------------------------------------------

CREATE FUNCTION public.unlike_video(p_video_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.video_likes WHERE user_id = v_uid AND video_id = p_video_id;  -- idempotent
END;$$;

REVOKE ALL   ON FUNCTION public.unlike_video(uuid) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.unlike_video(uuid) TO authenticated;

-- viewer_liked_state(video) → boolean ---------------------------------------

CREATE FUNCTION public.viewer_liked_state(p_video_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.video_likes vl
      JOIN public.videos   v ON v.id = vl.video_id
      JOIN public.creators c ON c.id = v.creator_id AND c.published_at IS NOT NULL
     WHERE vl.video_id = p_video_id
       AND vl.user_id = auth.uid()
  );
$$;

REVOKE ALL   ON FUNCTION public.viewer_liked_state(uuid) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.viewer_liked_state(uuid) TO authenticated;

-- list_liked_videos(cursor_ts, cursor_id, limit) ----------------------------
-- Own liked videos, re-gated on published creator (takedowns drop out). Each
-- row routes to the canonical /v/[id] (same feed experience: carousel + Ask).

CREATE FUNCTION public.list_liked_videos(
  p_cursor_ts timestamptz DEFAULT NULL,
  p_cursor_id uuid DEFAULT NULL,
  p_limit     int DEFAULT 30
) RETURNS TABLE (
  video_id       uuid,
  title          text,
  thumbnail_url  text,
  creator_handle citext,
  liked_at       timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.id, v.title, v.thumbnail_url, c.handle, vl.created_at
    FROM public.video_likes vl
    JOIN public.videos   v ON v.id = vl.video_id AND v.published_at IS NOT NULL
    JOIN public.creators c ON c.id = v.creator_id AND c.published_at IS NOT NULL
   WHERE vl.user_id = auth.uid()
     AND (p_cursor_ts IS NULL OR (vl.created_at, vl.video_id) < (p_cursor_ts, p_cursor_id))
   ORDER BY vl.created_at DESC, vl.video_id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
$$;

REVOKE ALL   ON FUNCTION public.list_liked_videos(timestamptz, uuid, int) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.list_liked_videos(timestamptz, uuid, int) TO authenticated;
