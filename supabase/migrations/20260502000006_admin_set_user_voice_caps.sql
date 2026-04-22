-- 0502000006 — admin_set_user_voice_caps: per-user minute-dial editing.
--
-- Why this RPC exists:
--   Tier (free/premium/boardroom) is the coarse gate. The actual knob that
--   makes the "tier = minutes/day dial" model real is per-user cap editing —
--   without it, every user sits at defaults and the admin console has no
--   functional control surface for the voice pipeline. See CLAUDE.md
--   "Tier = minutes/day dial" + Days 13-14 handoff §4.
--
-- Invariants:
--   (a) caller is an active admin (admin_roles, revoked_at IS NULL).
--   (b) ranges mirror the CHECK constraints on profiles columns:
--       daily   : int 0–86400                      (hard cap, NOT NULL on col)
--       weekly  : NULL-or-int 0–604800             (NULL disables weekly cap)
--       monthly : NULL-or-int 0–2678400            (NULL = unlimited)
--   (c) writes an admin_audit_log row with full before/after cap triple.
--   (d) does NOT reach into voice_usage_daily / voice_usage_weekly. Caps apply
--       at the next ticket_check call — never mid-session (handoff §4).

CREATE FUNCTION public.admin_set_user_voice_caps(
  p_target_user_id uuid,
  p_daily          int,
  p_weekly         int,
  p_monthly        int
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_admin_id    uuid := auth.uid();
  v_old_daily   int;
  v_old_weekly  int;
  v_old_monthly int;
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

  -- Range guards — distinct errcodes so the API can map each to a clear
  -- user-facing message. DB CHECK would also reject, but the error would be
  -- 23514 with an opaque constraint-name payload.
  IF p_daily IS NULL OR p_daily < 0 OR p_daily > 86400 THEN
    RAISE EXCEPTION 'bad_daily_cap' USING ERRCODE = '22003';
  END IF;
  IF p_weekly IS NOT NULL AND (p_weekly < 0 OR p_weekly > 604800) THEN
    RAISE EXCEPTION 'bad_weekly_cap' USING ERRCODE = '22003';
  END IF;
  IF p_monthly IS NOT NULL AND (p_monthly < 0 OR p_monthly > 2678400) THEN
    RAISE EXCEPTION 'bad_monthly_cap' USING ERRCODE = '22003';
  END IF;

  -- Lock target so before/after read + write are consistent.
  SELECT voice_daily_cap_seconds, voice_weekly_cap_seconds, voice_monthly_cap_seconds
    INTO v_old_daily, v_old_weekly, v_old_monthly
    FROM public.profiles
   WHERE id = p_target_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target user not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.profiles
     SET voice_daily_cap_seconds   = p_daily,
         voice_weekly_cap_seconds  = p_weekly,
         voice_monthly_cap_seconds = p_monthly
   WHERE id = p_target_user_id;

  INSERT INTO public.admin_audit_log (admin_user_id, action, target_kind, target_id, before, after)
  VALUES (
    v_admin_id,
    'voice_caps_set',
    'profile',
    p_target_user_id,
    jsonb_build_object(
      'voice_daily_cap_seconds',   v_old_daily,
      'voice_weekly_cap_seconds',  v_old_weekly,
      'voice_monthly_cap_seconds', v_old_monthly
    ),
    jsonb_build_object(
      'voice_daily_cap_seconds',   p_daily,
      'voice_weekly_cap_seconds',  p_weekly,
      'voice_monthly_cap_seconds', p_monthly
    )
  );
END;$$;

REVOKE ALL    ON FUNCTION public.admin_set_user_voice_caps(uuid, int, int, int) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_set_user_voice_caps(uuid, int, int, int) TO authenticated;

COMMENT ON FUNCTION public.admin_set_user_voice_caps(uuid, int, int, int) IS
  'Admin-only per-user voice-minute cap editor. Writes admin_audit_log. Caps apply at next ticket_check — never mid-session. NULL weekly/monthly disables that cap.';
