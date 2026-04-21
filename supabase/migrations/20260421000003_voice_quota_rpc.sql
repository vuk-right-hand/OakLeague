-- 0042 — voice quota RPCs (check + accumulate)
--
-- Post-Spike-A audit fix: kill-switch was defined in migration 0019 but never
-- called from the voice proxy. Voicer path wires ran without quota enforcement
-- and without incrementing daily_quotas.seconds_used — meaning the latch
-- trigger never saw the 150% crossing.
--
-- Two RPCs, both SECURITY DEFINER, both keyed on the session's start-day in
-- USER-LOCAL time (matches session_turns_guard and sessions_enforce):
--
--   voice_check_quota(p_session_id)       — fast SELECT, proxy calls at turn_start
--   voice_accumulate_seconds(..., p_secs) — UPSERT, proxy calls at turn_end
--
-- Both derive the target quota_date from sessions.started_at + profiles.timezone
-- so a session that crosses midnight keeps charging to the day it opened on.

CREATE FUNCTION public.voice_check_quota(p_session_id uuid)
RETURNS TABLE (
  seconds_used          int,
  daily_limit_s         int,
  kill_switch_fired_at  timestamptz,
  over_150_pct          boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user_id    uuid;
  v_started_at timestamptz;
  v_tz         text;
  v_qdate      date;
  v_row        record;
BEGIN
  SELECT s.user_id, s.started_at, p.timezone
    INTO v_user_id, v_started_at, v_tz
    FROM public.sessions s
    JOIN public.profiles p ON p.id = s.user_id
   WHERE s.id = p_session_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'session % not found', p_session_id USING ERRCODE = '23503';
  END IF;

  v_qdate := (v_started_at AT TIME ZONE v_tz)::date;

  SELECT q.seconds_used, q.daily_limit_s, q.kill_switch_fired_at
    INTO v_row
    FROM public.daily_quotas q
   WHERE q.user_id = v_user_id AND q.quota_date = v_qdate;

  -- If no row exists yet (shouldn't happen post-session-insert trigger, but
  -- defensive), return a "not over" sentinel so the first turn proceeds.
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, 0, NULL::timestamptz, false;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    v_row.seconds_used,
    v_row.daily_limit_s,
    v_row.kill_switch_fired_at,
    (v_row.seconds_used >= (v_row.daily_limit_s * 3) / 2);
END;$$;

-- Supabase auto-grants EXECUTE to {public, anon, authenticated, service_role}
-- on every new function. REVOKE from public alone leaves anon+authenticated
-- grants intact — any logged-in user could call this SECURITY DEFINER and
-- latch a victim's quota. Strip all non-service roles; service_role keeps
-- its explicit grant and the Fly proxy continues to call normally.
REVOKE EXECUTE ON FUNCTION public.voice_check_quota(uuid) FROM public, anon, authenticated;

-- voice_accumulate_seconds: idempotency is the caller's problem (the proxy
-- calls once per turn_end). Negative / huge values are rejected.

CREATE FUNCTION public.voice_accumulate_seconds(
  p_session_id uuid,
  p_seconds    numeric
) RETURNS TABLE (
  seconds_used          int,
  daily_limit_s         int,
  kill_switch_fired_at  timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user_id    uuid;
  v_started_at timestamptz;
  v_tz         text;
  v_qdate      date;
  v_row        record;
BEGIN
  IF p_seconds < 0 OR p_seconds > 3600 THEN
    RAISE EXCEPTION 'seconds out of range [0,3600]' USING ERRCODE = '22003';
  END IF;

  SELECT s.user_id, s.started_at, p.timezone
    INTO v_user_id, v_started_at, v_tz
    FROM public.sessions s
    JOIN public.profiles p ON p.id = s.user_id
   WHERE s.id = p_session_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'session % not found', p_session_id USING ERRCODE = '23503';
  END IF;

  v_qdate := (v_started_at AT TIME ZONE v_tz)::date;

  -- UPDATE (latch trigger fires on seconds_used crossing 150%). If no row
  -- exists yet we raise P0002 — sessions_enforce_tier_and_kill_switch (0017)
  -- upserts daily_quotas at session-insert time, so a missing row means
  -- either an admin wiped the row or the trigger regressed. The Fly proxy
  -- must treat this as a fatal quota-state inconsistency (close WS with
  -- code 4006) rather than swallow — silent swallow would grant free turns
  -- until the row is recreated.
  UPDATE public.daily_quotas q
     SET seconds_used = q.seconds_used + CEIL(p_seconds)::int
   WHERE q.user_id = v_user_id AND q.quota_date = v_qdate
  RETURNING q.seconds_used, q.daily_limit_s, q.kill_switch_fired_at
    INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no daily_quotas row for user=% date=% (session insert trigger should have created it)',
      v_user_id, v_qdate USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY SELECT v_row.seconds_used, v_row.daily_limit_s, v_row.kill_switch_fired_at;
END;$$;

-- Same Supabase default-grant concern as voice_check_quota above: strip anon +
-- authenticated so a logged-in user cannot burn a victim's quota by calling
-- this SECURITY DEFINER directly. service_role retains its explicit grant.
REVOKE EXECUTE ON FUNCTION public.voice_accumulate_seconds(uuid, numeric) FROM public, anon, authenticated;
