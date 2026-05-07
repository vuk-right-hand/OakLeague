-- 20260509000007 — session_close: fix `column reference "session_id" is ambiguous`
--
-- Latent bug since 20260502000002. The function declares
--   RETURNS TABLE (session_id uuid, active_seconds int, end_reason text)
-- which creates an implicit OUT variable named `session_id`. The body's
--   UPDATE public.session_pauses SET resumed_at = now()
--    WHERE session_id = p_session_id AND resumed_at IS NULL;
-- references `session_id` unqualified, so Postgres can't tell whether it
-- means the OUT variable or session_pauses.session_id and raises 42702
-- ('column reference "session_id" is ambiguous') at execution.
--
-- Why it surfaced now (Phase 0.5, HeyGen wire-up): the HeyGen flow
-- generates several pause/resume cycles during a session (audio buffer
-- pauses), so the WHERE evaluates against actual rows and the ambiguity
-- check fires on every close. Pre-HeyGen sessions often closed without
-- an open pause row, so the planner never tripped. Client-side close
-- catch (`catch { /* reaper catches orphans */ }`) swallowed the 500
-- — sessions still ended via the 60s reaper, but for HeyGen that 60s
-- window was billed at ~1 credit/min. 7 credits evaporated in a few
-- test runs as a result.
--
-- Fix: re-create with `#variable_conflict use_column` directive — the
-- project convention used by 12 other RPCs (search migrations for the
-- directive). Function body otherwise unchanged from the original.

CREATE OR REPLACE FUNCTION public.session_close(
  p_session_id uuid,
  p_end_reason text
) RETURNS TABLE (
  session_id     uuid,
  active_seconds int,
  end_reason     text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_caller      uuid;
  v_row         public.sessions%ROWTYPE;
  v_tz          text;
  v_qdate       date;
  v_limit_s     int;
  v_elapsed     int;
  v_active      int;
  v_is_service  boolean;
BEGIN
  v_caller := auth.uid();
  v_is_service := COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role';

  IF p_end_reason IS NULL OR char_length(p_end_reason) = 0 OR char_length(p_end_reason) > 200 THEN
    RAISE EXCEPTION 'bad_end_reason' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_dead' USING ERRCODE = 'P0006';
  END IF;

  IF NOT v_is_service AND v_row.user_id <> v_caller THEN
    RAISE EXCEPTION 'not_owner' USING ERRCODE = '42501';
  END IF;

  IF v_row.ended_at IS NOT NULL THEN
    RETURN QUERY SELECT v_row.id, v_row.active_seconds, v_row.end_reason;
    RETURN;
  END IF;

  SELECT p.timezone INTO v_tz FROM public.profiles p WHERE p.id = v_row.user_id;
  v_qdate := (v_row.started_at AT TIME ZONE v_tz)::date;

  v_limit_s := CASE v_row.tier_at_session
    WHEN 'free'      THEN 600
    WHEN 'premium'   THEN 3600
    WHEN 'boardroom' THEN 14400
  END;

  v_elapsed := GREATEST(EXTRACT(EPOCH FROM (now() - v_row.started_at))::int - v_row.paused_seconds_total, 0);
  v_active  := LEAST(v_elapsed, v_limit_s);

  UPDATE public.sessions
     SET ended_at       = now(),
         status         = 'ended',
         end_reason     = p_end_reason,
         active_seconds = v_active
   WHERE id = p_session_id;

  UPDATE public.session_pauses
     SET resumed_at = now()
   WHERE session_id = p_session_id AND resumed_at IS NULL;

  INSERT INTO public.daily_quotas (user_id, quota_date, tier_snapshot, daily_limit_s, seconds_used)
  VALUES (v_row.user_id, v_qdate, v_row.tier_at_session, v_limit_s, v_active)
  ON CONFLICT (user_id, quota_date)
  DO UPDATE SET
    seconds_used = public.daily_quotas.seconds_used + EXCLUDED.seconds_used;

  RETURN QUERY SELECT p_session_id, v_active, p_end_reason;
END;$$;
