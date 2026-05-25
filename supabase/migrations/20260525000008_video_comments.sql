-- 20260525000008 — video comments (COMMENTS_LIKES_PLAN C1)
--
-- Comments on videos only, ONE level of replies, soft-delete, creator/admin
-- moderation (delete/hide/pin), reportable. No comment-likes in v1.
--
-- The count trigger acts on a derived visibility BOOLEAN's transition (audit C1)
-- and the depth guard reads the LIVE parent + rejects hidden/deleted parents
-- (audit C2). All writes via SECURITY DEFINER RPCs; reads via SECDEF list RPCs.

CREATE TABLE public.video_comments (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id   uuid        NOT NULL REFERENCES public.videos(id)         ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES public.profiles(id)       ON DELETE CASCADE,
  parent_id  uuid                 REFERENCES public.video_comments(id) ON DELETE CASCADE,
  body       text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  pinned_at  timestamptz,          -- creator pin (top-level only)
  hidden_at  timestamptz,          -- creator/admin hid it
  hidden_by  uuid                 REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_at timestamptz,          -- soft delete (author/creator/admin)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX video_comments_feed_idx   ON public.video_comments (video_id, created_at DESC, id);
CREATE INDEX video_comments_thread_idx ON public.video_comments (parent_id, created_at, id) WHERE parent_id IS NOT NULL;

ALTER TABLE public.videos ADD COLUMN comment_count int NOT NULL DEFAULT 0 CHECK (comment_count >= 0);

-- Depth guard (audit C2): reads the LIVE parent, trusts nothing from RPC args.
CREATE FUNCTION public.video_comments_depth_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p RECORD;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT parent_id, video_id, deleted_at, hidden_at INTO p
      FROM public.video_comments WHERE id = NEW.parent_id FOR SHARE;  -- lock parent vs concurrent hide/delete
    IF NOT FOUND
       OR p.parent_id  IS NOT NULL          -- no reply-to-reply (one level)
       OR p.video_id  <> NEW.video_id       -- derive parent's video; reject cross-video
       OR p.deleted_at IS NOT NULL          -- cannot reply under a deleted comment
       OR p.hidden_at  IS NOT NULL THEN     -- ...or a hidden one (moderation-evasion)
      RAISE EXCEPTION 'bad_parent' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;$$;

REVOKE ALL ON FUNCTION public.video_comments_depth_guard() FROM public, anon, authenticated;

CREATE TRIGGER video_comments_depth_guard
  BEFORE INSERT ON public.video_comments
  FOR EACH ROW EXECUTE FUNCTION public.video_comments_depth_guard();

-- Count trigger (audit C1): act on the transition of a derived visibility bool.
CREATE FUNCTION public.videos_comment_count_maintain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE was boolean; vis boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.deleted_at IS NULL AND NEW.hidden_at IS NULL THEN
      UPDATE public.videos SET comment_count = comment_count + 1 WHERE id = NEW.video_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    was := (OLD.deleted_at IS NULL AND OLD.hidden_at IS NULL);
    vis := (NEW.deleted_at IS NULL AND NEW.hidden_at IS NULL);
    IF (NOT was) AND vis THEN
      UPDATE public.videos SET comment_count = comment_count + 1 WHERE id = NEW.video_id;
    ELSIF was AND (NOT vis) THEN
      UPDATE public.videos SET comment_count = GREATEST(0, comment_count - 1) WHERE id = NEW.video_id;
    END IF;  -- visible↔visible or hidden↔hidden: no-op (idempotent)
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.deleted_at IS NULL AND OLD.hidden_at IS NULL THEN  -- only if it was still counted
      UPDATE public.videos SET comment_count = GREATEST(0, comment_count - 1) WHERE id = OLD.video_id;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;$$;

REVOKE ALL ON FUNCTION public.videos_comment_count_maintain() FROM public, anon, authenticated;

CREATE TRIGGER videos_comment_count_maintain
  AFTER INSERT OR UPDATE OR DELETE ON public.video_comments
  FOR EACH ROW EXECUTE FUNCTION public.videos_comment_count_maintain();

-- RLS: reads go through SECDEF list RPCs; keep a tight own-read for safety. No
-- client writes (RPC only).
ALTER TABLE public.video_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "video_comments own read"
  ON public.video_comments FOR SELECT
  USING (user_id = auth.uid());

GRANT SELECT ON public.video_comments TO authenticated;

-- comment_reports: service-role/admin only (zero client policies + REVOKE ALL).
CREATE TABLE public.comment_reports (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id  uuid        NOT NULL REFERENCES public.video_comments(id) ON DELETE CASCADE,
  reporter_id uuid        NOT NULL REFERENCES public.profiles(id)       ON DELETE CASCADE,
  reason      text        CHECK (reason IS NULL OR char_length(reason) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX comment_reports_dedupe ON public.comment_reports (comment_id, reporter_id);

ALTER TABLE public.comment_reports ENABLE ROW LEVEL SECURITY;  -- zero policies
REVOKE ALL ON public.comment_reports FROM public, anon, authenticated;

-- ── Helper: is the caller the video's creator, or an admin? ────────────────
CREATE FUNCTION public._can_moderate_comment(p_comment_id uuid, p_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.admin_roles WHERE user_id = p_uid)
      OR EXISTS (
           SELECT 1
             FROM public.video_comments vc
             JOIN public.videos   v ON v.id = vc.video_id
             JOIN public.creators c ON c.id = v.creator_id   -- videos.creator_id → creators.id (two-hop)
            WHERE vc.id = p_comment_id AND c.user_id = p_uid
         );
$$;
REVOKE ALL ON FUNCTION public._can_moderate_comment(uuid, uuid) FROM public, anon, authenticated;

-- post_comment ---------------------------------------------------------------
CREATE FUNCTION public.post_comment(p_video_id uuid, p_body text, p_parent_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id  uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501'; END IF;
  IF p_body IS NULL OR char_length(btrim(p_body)) = 0 OR char_length(p_body) > 2000 THEN
    RAISE EXCEPTION 'bad_body' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.videos v JOIN public.creators c ON c.id = v.creator_id
     WHERE v.id = p_video_id AND v.published_at IS NOT NULL AND c.published_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'video_not_available' USING ERRCODE = 'P0001';
  END IF;
  -- Per-caller + per-video caps (audit M6: blunt brigading of one video).
  IF NOT public.rate_limit_hit('comment_post', v_uid::text, interval '1 minute', 10) THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.rate_limit_hit('comment_video', p_video_id::text, interval '1 minute', 120) THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.video_comments (video_id, user_id, parent_id, body)
  VALUES (p_video_id, v_uid, p_parent_id, btrim(p_body))  -- depth guard trigger validates parent
  RETURNING id INTO v_id;
  RETURN v_id;
END;$$;

REVOKE ALL   ON FUNCTION public.post_comment(uuid, text, uuid) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.post_comment(uuid, text, uuid) TO authenticated;

-- delete_own_comment (author soft-delete; idempotent) -----------------------
CREATE FUNCTION public.delete_own_comment(p_comment_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501'; END IF;
  UPDATE public.video_comments
     SET deleted_at = now()
   WHERE id = p_comment_id AND user_id = v_uid AND deleted_at IS NULL;  -- idempotent: no-op if already deleted
END;$$;

REVOKE ALL   ON FUNCTION public.delete_own_comment(uuid) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.delete_own_comment(uuid) TO authenticated;

-- moderate_comment (creator of the video OR admin) --------------------------
CREATE FUNCTION public.moderate_comment(p_comment_id uuid, p_action text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_top boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501'; END IF;
  IF NOT public._can_moderate_comment(p_comment_id, v_uid) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_action = 'delete' THEN
    UPDATE public.video_comments SET deleted_at = now()
     WHERE id = p_comment_id AND deleted_at IS NULL;
  ELSIF p_action = 'hide' THEN
    UPDATE public.video_comments SET hidden_at = now(), hidden_by = v_uid
     WHERE id = p_comment_id AND hidden_at IS NULL;
  ELSIF p_action = 'unhide' THEN
    UPDATE public.video_comments SET hidden_at = NULL, hidden_by = NULL
     WHERE id = p_comment_id AND hidden_at IS NOT NULL;
  ELSIF p_action = 'pin' THEN
    SELECT parent_id IS NULL INTO v_is_top FROM public.video_comments WHERE id = p_comment_id;
    IF NOT COALESCE(v_is_top, false) THEN RAISE EXCEPTION 'pin_top_level_only' USING ERRCODE = 'P0001'; END IF;
    UPDATE public.video_comments SET pinned_at = now()
     WHERE id = p_comment_id AND pinned_at IS NULL;
  ELSIF p_action = 'unpin' THEN
    UPDATE public.video_comments SET pinned_at = NULL
     WHERE id = p_comment_id AND pinned_at IS NOT NULL;
  ELSE
    RAISE EXCEPTION 'bad_action' USING ERRCODE = 'check_violation';
  END IF;
END;$$;

REVOKE ALL   ON FUNCTION public.moderate_comment(uuid, text) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.moderate_comment(uuid, text) TO authenticated;

-- report_comment (no existence oracle for invisible comments, audit M3) ------
CREATE FUNCTION public.report_comment(p_comment_id uuid, p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501'; END IF;
  IF p_reason IS NOT NULL AND char_length(p_reason) > 500 THEN
    RAISE EXCEPTION 'bad_reason' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.rate_limit_hit('comment_report', v_uid::text, interval '1 minute', 20) THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
  END IF;
  -- Only report a CURRENTLY-VISIBLE comment on a published creator. Otherwise
  -- no-op silently (same shape as not-found) so this isn't an existence oracle.
  IF NOT EXISTS (
    SELECT 1 FROM public.video_comments vc
      JOIN public.videos   v ON v.id = vc.video_id AND v.published_at IS NOT NULL
      JOIN public.creators c ON c.id = v.creator_id AND c.published_at IS NOT NULL
     WHERE vc.id = p_comment_id AND vc.deleted_at IS NULL AND vc.hidden_at IS NULL
  ) THEN
    RETURN;
  END IF;
  INSERT INTO public.comment_reports (comment_id, reporter_id, reason)
  VALUES (p_comment_id, v_uid, p_reason)
  ON CONFLICT (comment_id, reporter_id) DO NOTHING;  -- dedupe
END;$$;

REVOKE ALL   ON FUNCTION public.report_comment(uuid, text) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.report_comment(uuid, text) TO authenticated;

-- ── Read RPCs ──────────────────────────────────────────────────────────────
-- Author identity is the public-handle projection only (COALESCE creators over
-- profiles) — never email/id. A NULL-handle author shows a fallback name and is
-- not linkable. The video's creator / an admin additionally sees HIDDEN (not
-- deleted) comments flagged is_hidden so they can unhide. Pins are returned by
-- list_pinned_comments (separately), so the main stream keyset-paginates cleanly
-- on (created_at, id) without pins folded in (audit M2).

CREATE FUNCTION public._is_video_moderator(p_video_id uuid, p_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT p_uid IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.admin_roles WHERE user_id = p_uid)
    OR EXISTS (SELECT 1 FROM public.videos v JOIN public.creators c ON c.id = v.creator_id
                WHERE v.id = p_video_id AND c.user_id = p_uid)
  );
$$;
REVOKE ALL ON FUNCTION public._is_video_moderator(uuid, uuid) FROM public, anon, authenticated;

CREATE FUNCTION public.list_pinned_comments(p_video_id uuid)
RETURNS TABLE (
  id uuid, body text, author_handle citext, author_name text, author_avatar text,
  created_at timestamptz, is_hidden boolean, reply_count bigint, is_own boolean
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_mod boolean := public._is_video_moderator(p_video_id, auth.uid());
BEGIN
  RETURN QUERY
    SELECT vc.id, vc.body,
           COALESCE(cc.handle, pp.handle),
           COALESCE(cc.display_name, pp.display_name),
           COALESCE(cc.avatar_url, pp.avatar_url),
           vc.created_at,
           (vc.hidden_at IS NOT NULL),
           (SELECT count(*) FROM public.video_comments r
             WHERE r.parent_id = vc.id AND r.deleted_at IS NULL AND r.hidden_at IS NULL),
           (vc.user_id = auth.uid())  -- is_own: client gates the Delete button on this (audit C1)
      FROM public.video_comments vc
      JOIN public.videos   v  ON v.id = vc.video_id AND v.published_at IS NOT NULL
      JOIN public.creators vcr ON vcr.id = v.creator_id AND vcr.published_at IS NOT NULL
      JOIN public.profiles pp ON pp.id = vc.user_id
      LEFT JOIN public.creators cc ON cc.user_id = vc.user_id AND cc.published_at IS NOT NULL
     WHERE vc.video_id = p_video_id
       AND vc.parent_id IS NULL
       AND vc.pinned_at IS NOT NULL
       AND vc.deleted_at IS NULL
       AND (vc.hidden_at IS NULL OR v_mod)
     ORDER BY vc.pinned_at DESC;
END;$$;
REVOKE ALL   ON FUNCTION public.list_pinned_comments(uuid) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.list_pinned_comments(uuid) TO anon, authenticated;

CREATE FUNCTION public.list_video_comments(
  p_video_id uuid, p_cursor_ts timestamptz DEFAULT NULL, p_cursor_id uuid DEFAULT NULL, p_limit int DEFAULT 30
) RETURNS TABLE (
  id uuid, body text, author_handle citext, author_name text, author_avatar text,
  created_at timestamptz, is_hidden boolean, reply_count bigint, is_own boolean
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_mod boolean := public._is_video_moderator(p_video_id, auth.uid());
BEGIN
  RETURN QUERY
    SELECT vc.id, vc.body,
           COALESCE(cc.handle, pp.handle),
           COALESCE(cc.display_name, pp.display_name),
           COALESCE(cc.avatar_url, pp.avatar_url),
           vc.created_at,
           (vc.hidden_at IS NOT NULL),
           (SELECT count(*) FROM public.video_comments r
             WHERE r.parent_id = vc.id AND r.deleted_at IS NULL AND r.hidden_at IS NULL),
           (vc.user_id = auth.uid())  -- is_own (audit C1)
      FROM public.video_comments vc
      JOIN public.videos   v  ON v.id = vc.video_id AND v.published_at IS NOT NULL
      JOIN public.creators vcr ON vcr.id = v.creator_id AND vcr.published_at IS NOT NULL
      JOIN public.profiles pp ON pp.id = vc.user_id
      LEFT JOIN public.creators cc ON cc.user_id = vc.user_id AND cc.published_at IS NOT NULL
     WHERE vc.video_id = p_video_id
       AND vc.parent_id IS NULL
       AND vc.pinned_at IS NULL                              -- pins come from list_pinned_comments
       AND vc.deleted_at IS NULL
       AND (vc.hidden_at IS NULL OR v_mod)
       AND (p_cursor_ts IS NULL OR (vc.created_at, vc.id) < (p_cursor_ts, p_cursor_id))
     ORDER BY vc.created_at DESC, vc.id DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
END;$$;
REVOKE ALL   ON FUNCTION public.list_video_comments(uuid, timestamptz, uuid, int) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.list_video_comments(uuid, timestamptz, uuid, int) TO anon, authenticated;

CREATE FUNCTION public.list_comment_replies(
  p_parent_id uuid, p_cursor_ts timestamptz DEFAULT NULL, p_cursor_id uuid DEFAULT NULL, p_limit int DEFAULT 30
) RETURNS TABLE (
  id uuid, body text, author_handle citext, author_name text, author_avatar text,
  created_at timestamptz, is_hidden boolean, is_own boolean
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_video uuid; v_mod boolean;
BEGIN
  -- Parent's video_id (safe: the main query below re-gates on published; this
  -- lone read only resolves moderator scope).
  SELECT video_id INTO v_video FROM public.video_comments WHERE id = p_parent_id;
  v_mod := public._is_video_moderator(v_video, auth.uid());
  RETURN QUERY
    SELECT vc.id, vc.body,
           COALESCE(cc.handle, pp.handle),
           COALESCE(cc.display_name, pp.display_name),
           COALESCE(cc.avatar_url, pp.avatar_url),
           vc.created_at,
           (vc.hidden_at IS NOT NULL),
           (vc.user_id = auth.uid())  -- is_own (audit C1)
      FROM public.video_comments vc
      JOIN public.videos   v  ON v.id = vc.video_id AND v.published_at IS NOT NULL
      JOIN public.creators vcr ON vcr.id = v.creator_id AND vcr.published_at IS NOT NULL
      JOIN public.profiles pp ON pp.id = vc.user_id
      LEFT JOIN public.creators cc ON cc.user_id = vc.user_id AND cc.published_at IS NOT NULL
     WHERE vc.parent_id = p_parent_id
       AND vc.deleted_at IS NULL
       AND (vc.hidden_at IS NULL OR v_mod)
       AND (p_cursor_ts IS NULL OR (vc.created_at, vc.id) > (p_cursor_ts, p_cursor_id))
     ORDER BY vc.created_at ASC, vc.id ASC   -- replies oldest-first under a parent
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
END;$$;
REVOKE ALL   ON FUNCTION public.list_comment_replies(uuid, timestamptz, uuid, int) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.list_comment_replies(uuid, timestamptz, uuid, int) TO anon, authenticated;

-- admin reports queue reader (so comment_reports isn't write-into-the-void, audit C3)
CREATE FUNCTION public.admin_list_comment_reports(p_limit int DEFAULT 50, p_offset int DEFAULT 0)
RETURNS TABLE (
  report_id uuid, comment_id uuid, video_id uuid, reason text,
  comment_body text, reporter_id uuid, reported_at timestamptz,
  comment_deleted boolean, comment_hidden boolean
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admin_roles WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT cr.id, cr.comment_id, vc.video_id, cr.reason, vc.body, cr.reporter_id, cr.created_at,
           (vc.deleted_at IS NOT NULL), (vc.hidden_at IS NOT NULL)
      FROM public.comment_reports cr
      JOIN public.video_comments vc ON vc.id = cr.comment_id
     ORDER BY cr.created_at DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200) OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;$$;
REVOKE ALL   ON FUNCTION public.admin_list_comment_reports(int, int) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_list_comment_reports(int, int) TO authenticated;  -- body asserts admin
