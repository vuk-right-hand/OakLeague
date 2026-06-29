-- voice_check_quota_v2: returns voice_check_quota's System-A fuse fields PLUS the
-- unified balance (remaining_seconds = the SAME number the open gate uses, via
-- voice_balance_check — no drift, R1-M2/R4-C4). The proxy OWNS the exhaustion
-- decision (S2 — no authoritative boolean returned); we assert the raw signal it
-- consumes (remaining_seconds) and the C4 had_wallet flag that drives buy-vs-wait.
-- Growth & Minutes Economy Phase 2 (migration 20260615000004).
BEGIN;
SELECT plan(7);

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

  -- 1) Fresh free user: remaining = 300 (daily cap binds), no wallet.
  SELECT * INTO v_r FROM public.voice_check_quota_v2(v_sid);
  RETURN NEXT is(v_r.remaining_seconds, 300, '1: effective remaining = 300');
  RETURN NEXT is(v_r.had_wallet, false, '2: fresh user has no wallet');

  -- 2) Burn the daily free allowance → exhausted (remaining<=0), cap_period = daily,
  -- still no wallet (so the upsell tells them to WAIT, not buy — C4).
  INSERT INTO public.voice_usage_daily (user_id, day, seconds_used)
    VALUES (v_uid, (now() AT TIME ZONE 'UTC')::date, 300);
  SELECT * INTO v_r FROM public.voice_check_quota_v2(v_sid);
  RETURN NEXT ok(v_r.remaining_seconds <= 0, '3: exhausted after burning the daily allowance');
  RETURN NEXT is(v_r.cap_period, 'daily', '4: cap_period = daily');
  RETURN NEXT is(v_r.had_wallet, false, '5: pure free user still has no wallet when exhausted');

  -- 3) A wallet grant rescues (remaining > 0 again) AND flips had_wallet → true, so
  -- a later exhaustion would lead the overlay with "buy" not "wait" (C4).
  PERFORM public.minute_grant_insert(v_uid, 'paid_topup', 600, 'admin', 'vcq_topup', NULL, NULL);
  SELECT * INTO v_r FROM public.voice_check_quota_v2(v_sid);
  RETURN NEXT ok(v_r.remaining_seconds > 0, '6: wallet grant un-exhausts (effective>0)');
  RETURN NEXT is(v_r.had_wallet, true, '7: had_wallet flips true after the grant');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
