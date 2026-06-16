-- voice_check_quota_v2: returns voice_check_quota's System-A fuse fields PLUS the
-- unified balance. tier_exhausted = effective_remaining <= 0 (the SAME number the
-- open gate uses, via voice_balance_check — no drift, R1-M2/R4-C4).
-- Growth & Minutes Economy Phase 2 (migration 20260615000004).
BEGIN;
SELECT plan(5);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid  uuid := tests.create_auth_user('vcq@test');
  v_cuid uuid := tests.create_auth_user('vcqc@test');
  v_cid  uuid;
  v_sid  uuid;
  v_r    record;
BEGIN
  UPDATE public.profiles SET timezone = 'UTC' WHERE id = v_uid;
  UPDATE public.profiles SET handle = 'vcqc' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'VC', 'vcqc', 'ready', now()) RETURNING id INTO v_cid;
  -- A session is needed so the RPC can resolve session → user (the trigger also
  -- creates today's daily_quotas row).
  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_uid, v_cid, 'gemini_3_1_flash_live_preview', 'free') RETURNING id INTO v_sid;

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- 1) Fresh free user: not exhausted, effective = 300 (daily cap binds).
  SELECT * INTO v_r FROM public.voice_check_quota_v2(v_sid);
  RETURN NEXT is(v_r.tier_exhausted, false, '1: fresh user not exhausted');
  RETURN NEXT is(v_r.remaining_seconds, 300, '2: effective remaining = 300');

  -- 2) Burn the daily free allowance → exhausted, cap_period = daily.
  INSERT INTO public.voice_usage_daily (user_id, day, seconds_used)
    VALUES (v_uid, (now() AT TIME ZONE 'UTC')::date, 300);
  SELECT * INTO v_r FROM public.voice_check_quota_v2(v_sid);
  RETURN NEXT is(v_r.tier_exhausted, true, '3: exhausted after burning the daily allowance');
  RETURN NEXT is(v_r.cap_period, 'daily', '4: cap_period = daily');

  -- 3) A wallet grant rescues (effective > 0 again) — same as the open gate.
  PERFORM public.minute_grant_insert(v_uid, 'paid_topup', 600, 'admin', 'vcq_topup', NULL, NULL);
  SELECT * INTO v_r FROM public.voice_check_quota_v2(v_sid);
  RETURN NEXT is(v_r.tier_exhausted, false, '5: wallet grant un-exhausts (effective>0)');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
