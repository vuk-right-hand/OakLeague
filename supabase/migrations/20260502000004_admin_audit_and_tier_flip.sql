-- 0502000004 — admin_audit_log + admin_set_profile_tier + admin_force_close_session.
-- Day 14 AM, Migration 4. Plan refs: C3-R1, M4-R1, M5-R1, C2-R2, R3-C6, R3-S6, R3-S10.
--
-- Design notes:
--  * `admin_audit_log` is append-only — service-role inserts only, RLS denies
--    all client access. Size caps on before/after jsonb match sessions.metadata.
--  * `admin_set_profile_tier` enforces all four admin tier-flip invariants:
--      (a) caller is an active admin (admin_roles, revoked_at IS NULL)
--      (b) target has no active session (P0004 — has_active_session)
--      (c) downgrades blocked the rest of the user-local day if the user has
--          any logged seconds (P0003 — downgrade_blocked_until_tomorrow, R2-C2)
--      (d) no DELETE of daily_quotas — we preserve seconds_used and re-apply
--          the new tier's daily_limit_s; the latch trigger re-checks.
--  * `admin_force_close_session` is SEPARATE from user self-close (R2-C3) so
--    the two guards never collapse. Both RPCs audit.

-- ── admin_audit_log ────────────────────────────────────────────────────────

CREATE TABLE public.admin_audit_log (
  id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id  uuid         NOT NULL REFERENCES public.admin_roles(user_id) ON DELETE RESTRICT,
  action         text         NOT NULL,
  target_kind    text         NOT NULL,
  target_id      uuid,
  before         jsonb        CHECK (before IS NULL OR octet_length(before::text) <= 4096),
  after          jsonb        CHECK (after  IS NULL OR octet_length(after::text)  <= 4096),
  created_at     timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX admin_audit_log_created_idx      ON public.admin_audit_log (created_at DESC);
CREATE INDEX admin_audit_log_target_idx       ON public.admin_audit_log (target_kind, target_id);
CREATE INDEX admin_audit_log_admin_time_idx   ON public.admin_audit_log (admin_user_id, created_at DESC);

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
-- Zero policies: service-role only, via SECURITY DEFINER RPCs.

-- ── admin_set_profile_tier ────────────────────────────────────────────────

CREATE FUNCTION public.admin_set_profile_tier(
  p_target_user_id uuid,
  p_new_tier       profile_tier
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_admin_id     uuid := auth.uid();
  v_old_tier     profile_tier;
  v_tz           text;
  v_qdate        date;
  v_seconds_used int;
  v_new_limit_s  int;
  v_has_active   boolean;
  v_tier_rank    int;
  v_new_rank     int;
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

  -- Lock target row so seconds_used / tier read + write are consistent.
  SELECT tier, timezone INTO v_old_tier, v_tz
    FROM public.profiles
   WHERE id = p_target_user_id
   FOR UPDATE;
  IF v_old_tier IS NULL THEN
    RAISE EXCEPTION 'target user not found' USING ERRCODE = 'P0002';
  END IF;

  -- Active session gate (P0004). Must close first.
  SELECT EXISTS (
    SELECT 1 FROM public.sessions
     WHERE user_id = p_target_user_id AND ended_at IS NULL
  ) INTO v_has_active;
  IF v_has_active THEN
    RAISE EXCEPTION 'has_active_session' USING ERRCODE = 'P0004';
  END IF;

  -- Downgrade-block: if new tier rank < old rank AND there's logged time
  -- today (user-local), block until tomorrow (P0003).
  v_tier_rank := CASE v_old_tier WHEN 'free' THEN 1 WHEN 'premium' THEN 2 WHEN 'boardroom' THEN 3 END;
  v_new_rank  := CASE p_new_tier  WHEN 'free' THEN 1 WHEN 'premium' THEN 2 WHEN 'boardroom' THEN 3 END;

  v_qdate := (now() AT TIME ZONE v_tz)::date;

  IF v_new_rank < v_tier_rank THEN
    SELECT seconds_used INTO v_seconds_used
      FROM public.daily_quotas
     WHERE user_id = p_target_user_id AND quota_date = v_qdate;
    IF v_seconds_used IS NOT NULL AND v_seconds_used > 0 THEN
      RAISE EXCEPTION 'downgrade_blocked_until_tomorrow' USING ERRCODE = 'P0003';
    END IF;
  END IF;

  -- Apply tier.
  UPDATE public.profiles SET tier = p_new_tier WHERE id = p_target_user_id;

  -- Re-apply daily_limit_s on today's quota row if it exists. Preserve
  -- seconds_used (R2-C2). The latch trigger re-checks on UPDATE.
  v_new_limit_s := CASE p_new_tier
    WHEN 'free'      THEN 600
    WHEN 'premium'   THEN 3600
    WHEN 'boardroom' THEN 14400
  END;

  UPDATE public.daily_quotas
     SET tier_snapshot = p_new_tier,
         daily_limit_s = v_new_limit_s
   WHERE user_id = p_target_user_id AND quota_date = v_qdate;

  -- Audit.
  INSERT INTO public.admin_audit_log (admin_user_id, action, target_kind, target_id, before, after)
  VALUES (
    v_admin_id,
    'tier_flip',
    'profile',
    p_target_user_id,
    jsonb_build_object('tier', v_old_tier),
    jsonb_build_object('tier', p_new_tier)
  );
END;$$;

REVOKE ALL    ON FUNCTION public.admin_set_profile_tier(uuid, profile_tier) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_set_profile_tier(uuid, profile_tier) TO authenticated;

-- ── admin_force_close_session ────────────────────────────────────────────

CREATE FUNCTION public.admin_force_close_session(
  p_session_id uuid,
  p_reason     text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_admin_id   uuid := auth.uid();
  v_target_uid uuid;
  v_started_at timestamptz;
  v_ended_at   timestamptz;
  v_reason     text;
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

  -- The prefix is 19 chars; sessions.end_reason is CHECK <= 200. Cap input
  -- at 180 so the stored value always fits.
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 OR length(p_reason) > 180 THEN
    RAISE EXCEPTION 'bad_reason' USING ERRCODE = '22023';
  END IF;

  v_reason := 'admin_force_close: ' || p_reason;

  SELECT user_id, started_at, ended_at INTO v_target_uid, v_started_at, v_ended_at
    FROM public.sessions
   WHERE id = p_session_id
   FOR UPDATE;
  IF v_target_uid IS NULL THEN
    RAISE EXCEPTION 'session not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_ended_at IS NOT NULL THEN
    -- Idempotent: already closed. Still write audit row so admin intent is
    -- recorded, but do not touch the session.
    INSERT INTO public.admin_audit_log (admin_user_id, action, target_kind, target_id, before, after)
    VALUES (
      v_admin_id,
      'force_close_noop',
      'session',
      p_session_id,
      jsonb_build_object('ended_at', v_ended_at),
      jsonb_build_object('reason', v_reason)
    );
    RETURN;
  END IF;

  UPDATE public.sessions
     SET ended_at   = now(),
         status     = 'ended',
         end_reason = v_reason
   WHERE id = p_session_id;

  INSERT INTO public.admin_audit_log (admin_user_id, action, target_kind, target_id, before, after)
  VALUES (
    v_admin_id,
    'force_close',
    'session',
    p_session_id,
    jsonb_build_object('user_id', v_target_uid, 'started_at', v_started_at),
    jsonb_build_object('reason', v_reason, 'ended_at', now())
  );
END;$$;

REVOKE ALL    ON FUNCTION public.admin_force_close_session(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_force_close_session(uuid, text) TO authenticated;
