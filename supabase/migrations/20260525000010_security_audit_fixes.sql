-- 20260525000010 — security audit fixes for the profile + engagement layer
--
-- Auditor subagent pass on migrations 20260525000001–09 (2026-05-25). Closes two
-- ship-blockers and a set of mediums. See docs/_planning/PROFILE_SYSTEM_PLAN.md
-- and COMMENTS_LIKES_PLAN.md for the full finding log.

-- ── C1 — profiles column-write allowlist ────────────────────────────────────
-- The "profiles own update" RLS policy gates the ROW (id = auth.uid()) but not
-- COLUMNS, and Supabase default-grants table-wide UPDATE to authenticated. So a
-- user could PATCH their own row via PostgREST to forge handshake_count, flip
-- their own tier to 'boardroom' (free voice minutes / COGS — pre-existing hole),
-- or re-roll public_id. RLS alone cannot stop this. Fix: revoke the table-wide
-- UPDATE and grant only the columns a user legitimately edits.
--
-- The allowlist is exactly the set written by the two USER-context call sites
-- (profile-actions.saveProfile → display_name/bio/handle; onboarding.saveOnboarding
-- → goals/obstacles/timezone/onboarded_at). avatar_url and tos_* are written ONLY
-- by service-role routes (bypass grants), so they are deliberately excluded.
-- handshake counters are maintained by the AFTER trigger (runs as owner). tier is
-- admin-only via a SECDEF RPC. ANY future trust-bearing profiles column must be
-- added with a column grant or guard in the same migration — RLS will NOT cover it.
REVOKE UPDATE ON public.profiles FROM authenticated, anon;
GRANT  UPDATE (display_name, bio, handle, goals, obstacles, timezone, onboarded_at)
  ON public.profiles TO authenticated;

-- ── C1 (bio) — block scam links in a non-creator's public bio ────────────────
-- The bio is owner-only editable but public-to-web, so a scammer's own bio is a
-- clickable-text scam billboard. Enforced as a DB trigger (not just the server
-- action) so a direct PostgREST PATCH of bio cannot bypass it. Creators are
-- exempt (verified identity via the application flow — they may link their course).
CREATE FUNCTION public.profiles_bio_link_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.bio IS NOT NULL
     AND public._comment_contains_link(NEW.bio)
     AND NOT EXISTS (SELECT 1 FROM public.creators WHERE user_id = NEW.id) THEN
    RAISE EXCEPTION 'link_not_allowed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;$$;
REVOKE ALL ON FUNCTION public.profiles_bio_link_guard() FROM public, anon, authenticated;

CREATE TRIGGER profiles_bio_link_guard
  BEFORE INSERT OR UPDATE OF bio ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_bio_link_guard();

-- ── C2 — handshake existence oracle on in-review creators ────────────────────
-- _profile_id_for_handle resolved creators.handle with no published gate, so
-- handshake('<in-review-handle>') SUCCEEDED (and bumped a count) even though the
-- public profile 404s — leaking the in-review creator pipeline. Mirror the
-- public_profiles gate exactly: a creator's handle resolves ONLY when published.
-- An unpublished-creator handle now resolves to NULL → handshake/unhandshake/
-- viewer_handshake_state/list_* all behave as "no such handle" (target_not_found).
CREATE OR REPLACE FUNCTION public._profile_id_for_handle(p_handle citext) RETURNS uuid
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT id FROM (
    SELECT p.id,      1 AS pri FROM public.profiles p WHERE p.handle = p_handle
    UNION ALL
    SELECT c.user_id, 2 AS pri FROM public.creators c
     WHERE c.handle = p_handle AND c.published_at IS NOT NULL   -- published creators only (C2)
  ) s ORDER BY pri LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public._profile_id_for_handle(citext) FROM public, anon, authenticated;

-- ── M4 — comment moderation is superadmin-only (+ honor revocation) ──────────
-- Both helpers granted EVERY admin_roles row (incl. the lower-trust 'reviewer')
-- platform-wide hide/delete/pin, AND ignored revoked_at (a revoked admin still
-- moderated). Restrict the admin branch to an ACTIVE superadmin. The video's
-- own creator is unchanged (they always moderate their own video).
CREATE OR REPLACE FUNCTION public._can_moderate_comment(p_comment_id uuid, p_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.admin_roles
                  WHERE user_id = p_uid AND role = 'superadmin' AND revoked_at IS NULL)
      OR EXISTS (
           SELECT 1
             FROM public.video_comments vc
             JOIN public.videos   v ON v.id = vc.video_id
             JOIN public.creators c ON c.id = v.creator_id
            WHERE vc.id = p_comment_id AND c.user_id = p_uid
         );
$$;
REVOKE ALL ON FUNCTION public._can_moderate_comment(uuid, uuid) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public._is_video_moderator(p_video_id uuid, p_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT p_uid IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.admin_roles
             WHERE user_id = p_uid AND role = 'superadmin' AND revoked_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.videos v JOIN public.creators c ON c.id = v.creator_id
                WHERE v.id = p_video_id AND c.user_id = p_uid)
  );
$$;
REVOKE ALL ON FUNCTION public._is_video_moderator(uuid, uuid) FROM public, anon, authenticated;

-- ── M3 — list_comment_replies must not derive moderator scope from a draft ───
-- v_video was read from an UNGATED video_comments row, so v_mod could be computed
-- for a comment on an unpublished video. Resolve v_video only through a published
-- video (else NULL → _is_video_moderator returns false). Body otherwise identical
-- to 20260525000008.
CREATE OR REPLACE FUNCTION public.list_comment_replies(
  p_parent_id uuid, p_cursor_ts timestamptz DEFAULT NULL, p_cursor_id uuid DEFAULT NULL, p_limit int DEFAULT 30
) RETURNS TABLE (
  id uuid, body text, author_handle citext, author_name text, author_avatar text,
  created_at timestamptz, is_hidden boolean, is_own boolean
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_video uuid; v_mod boolean;
BEGIN
  -- Published-gated parent→video resolution (M3): a draft parent yields NULL.
  SELECT v.id INTO v_video
    FROM public.video_comments vc
    JOIN public.videos   v ON v.id = vc.video_id AND v.published_at IS NOT NULL
    JOIN public.creators c ON c.id = v.creator_id AND c.published_at IS NOT NULL
   WHERE vc.id = p_parent_id;
  v_mod := public._is_video_moderator(v_video, auth.uid());
  RETURN QUERY
    SELECT vc.id, vc.body,
           COALESCE(cc.handle, pp.handle),
           COALESCE(cc.display_name, pp.display_name),
           COALESCE(cc.avatar_url, pp.avatar_url),
           vc.created_at,
           (vc.hidden_at IS NOT NULL),
           (vc.user_id = auth.uid())
      FROM public.video_comments vc
      JOIN public.videos   v  ON v.id = vc.video_id AND v.published_at IS NOT NULL
      JOIN public.creators vcr ON vcr.id = v.creator_id AND vcr.published_at IS NOT NULL
      JOIN public.profiles pp ON pp.id = vc.user_id
      LEFT JOIN public.creators cc ON cc.user_id = vc.user_id AND cc.published_at IS NOT NULL
     WHERE vc.parent_id = p_parent_id
       AND vc.deleted_at IS NULL
       AND (vc.hidden_at IS NULL OR v_mod)
       AND (p_cursor_ts IS NULL OR (vc.created_at, vc.id) > (p_cursor_ts, p_cursor_id))
     ORDER BY vc.created_at ASC, vc.id ASC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
END;$$;
REVOKE ALL   ON FUNCTION public.list_comment_replies(uuid, timestamptz, uuid, int) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.list_comment_replies(uuid, timestamptz, uuid, int) TO anon, authenticated;

-- ── M2 — report_comment per-target cap (coordinated false-report flood) ──────
-- Body otherwise identical to 20260525000008; adds a per-comment-target cap
-- alongside the existing per-reporter cap so a coordinated group can't flood the
-- admin queue against one creator's legitimate comment.
CREATE OR REPLACE FUNCTION public.report_comment(p_comment_id uuid, p_reason text DEFAULT NULL) RETURNS void
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
  IF NOT public.rate_limit_hit('comment_report_target', p_comment_id::text, interval '1 minute', 50) THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';   -- per-comment flood cap (M2)
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.video_comments vc
      JOIN public.videos   v ON v.id = vc.video_id AND v.published_at IS NOT NULL
      JOIN public.creators c ON c.id = v.creator_id AND c.published_at IS NOT NULL
     WHERE vc.id = p_comment_id AND vc.deleted_at IS NULL AND vc.hidden_at IS NULL
  ) THEN
    RETURN;  -- no existence oracle for invisible comments
  END IF;
  INSERT INTO public.comment_reports (comment_id, reporter_id, reason)
  VALUES (p_comment_id, v_uid, p_reason)
  ON CONFLICT (comment_id, reporter_id) DO NOTHING;
END;$$;
REVOKE ALL   ON FUNCTION public.report_comment(uuid, text) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.report_comment(uuid, text) TO authenticated;

-- ── M5 — handle_available: authenticated-only + rate-limited ─────────────────
-- Was anon-callable and unthrottled → full handle-namespace enumeration oracle.
-- The only caller is the authenticated saveProfile pre-check, so revoke anon and
-- add a per-caller cap (returns false when exceeded — the unique index remains
-- the real guard, so a throttled UX check never lets a dupe through).
CREATE OR REPLACE FUNCTION public.handle_available(p_handle citext)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;  -- authenticated-only; no anon enumeration
  IF NOT public.rate_limit_hit('handle_check', v_uid::text, interval '1 minute', 30) THEN
    RETURN false;  -- throttled → "unavailable"; the unique index is the real guard
  END IF;
  RETURN
    p_handle IS NOT NULL
    AND char_length(p_handle) BETWEEN 3 AND 30
    AND p_handle ~ '^[a-z0-9_]+$'
    AND NOT EXISTS (SELECT 1 FROM public.handles_registry WHERE handle = lower(p_handle))
    AND NOT EXISTS (SELECT 1 FROM public.reserved_handles WHERE handle = lower(p_handle));
END;$$;
REVOKE ALL   ON FUNCTION public.handle_available(citext) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.handle_available(citext) TO authenticated;

-- ── M1 + M7 — comment_reports: handle (not raw uuid) + resolve lifecycle ─────
ALTER TABLE public.comment_reports
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- M1: project the reporter's PUBLIC handle, never the raw auth uuid, even to
-- admins. M7: default to UNRESOLVED so the queue is actionable and bounded.
-- Signature changes (drop reporter_id, add reporter_handle + resolved flag), so
-- DROP first (CREATE OR REPLACE cannot alter the result column set).
DROP FUNCTION IF EXISTS public.admin_list_comment_reports(int, int);
CREATE FUNCTION public.admin_list_comment_reports(
  p_include_resolved boolean DEFAULT false, p_limit int DEFAULT 50, p_offset int DEFAULT 0
) RETURNS TABLE (
  report_id uuid, comment_id uuid, video_id uuid, reason text,
  comment_body text, reporter_handle citext, reported_at timestamptz,
  comment_deleted boolean, comment_hidden boolean, resolved boolean
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Any ACTIVE admin (superadmin or reviewer) may triage the queue.
  IF NOT EXISTS (SELECT 1 FROM public.admin_roles WHERE user_id = auth.uid() AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT cr.id, cr.comment_id, vc.video_id, cr.reason, vc.body,
           COALESCE(cc.handle, pp.handle),       -- reporter PUBLIC handle, not raw uuid (M1)
           cr.created_at,
           (vc.deleted_at IS NOT NULL), (vc.hidden_at IS NOT NULL),
           (cr.resolved_at IS NOT NULL)
      FROM public.comment_reports cr
      JOIN public.video_comments vc ON vc.id = cr.comment_id
      JOIN public.profiles pp ON pp.id = cr.reporter_id
      LEFT JOIN public.creators cc ON cc.user_id = cr.reporter_id AND cc.published_at IS NOT NULL
     WHERE (p_include_resolved OR cr.resolved_at IS NULL)
     ORDER BY cr.created_at DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200) OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;$$;
REVOKE ALL   ON FUNCTION public.admin_list_comment_reports(boolean, int, int) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_list_comment_reports(boolean, int, int) TO authenticated;  -- body asserts admin

-- M7: close the lifecycle — mark a report (or all reports on a comment) resolved.
CREATE FUNCTION public.admin_resolve_comment_report(p_comment_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admin_roles WHERE user_id = v_uid AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  UPDATE public.comment_reports
     SET resolved_at = now(), resolved_by = v_uid
   WHERE comment_id = p_comment_id AND resolved_at IS NULL;  -- idempotent
END;$$;
REVOKE ALL   ON FUNCTION public.admin_resolve_comment_report(uuid) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_resolve_comment_report(uuid) TO authenticated;

-- ── Small — tighten the trigger fn that should never be client-callable ──────
REVOKE ALL ON FUNCTION public.handshakes_maintain_counts() FROM public, anon, authenticated;
