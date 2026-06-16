-- Phase 4 referral engine: minute_grant_insert v2 caps + the unified atomic
-- credit RPC (recording_referral_credit_first_session_v2). Migration 20260615000005.
-- Covers: happy-path credit + both grants + recruiter bump; idempotency;
-- self-referral block; sock-puppet no-bump; share_tap dedup + 2/day cap;
-- lifetime cap; velocity cap.
BEGIN;
SELECT plan(20);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_ref  uuid := tests.create_auth_user('ref@test');   -- referrer / token minter
  v_new  uuid := tests.create_auth_user('new@test');   -- converts on token1
  v_new2 uuid := tests.create_auth_user('new2@test');  -- sock-puppet on token2
  v_life uuid := tests.create_auth_user('life@test');  -- lifetime-cap subject
  v_vel  uuid := tests.create_auth_user('vel@test');   -- velocity-cap subject
  v_r    record;
  v_g    record;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Mint token1 with the minter's fp/ip.
  RETURN NEXT ok(public.recording_referral_mint(v_ref, NULL, NULL, 'th1', 'fp_ref', '1.2.3'),
    '1: token1 minted');

  -- ── Happy path: credit + referrer grant + welcome + recruiter bump ───────
  SELECT * INTO v_r FROM public.recording_referral_credit_first_session_v2(
    'th1', v_new, 'fp_new', '9.9.9');  -- distinct fp/ip from the minter
  RETURN NEXT is(v_r.credited,         true, '2: credited');
  RETURN NEXT is(v_r.referrer_granted, true, '3: referrer referral_verified granted');
  RETURN NEXT is(v_r.welcome_granted,  true, '4: new-user welcome granted');
  RETURN NEXT is(v_r.recruiter_bumped, true, '5: recruiter bumped');
  RETURN NEXT is((SELECT recruiter_bonus_daily_seconds FROM public.profiles WHERE id = v_ref),
    60, '6: recruiter bonus = +60');
  RETURN NEXT is((SELECT wallet_active_seconds FROM public.profiles WHERE id = v_ref),
    900::bigint, '7: referrer wallet += 900');
  RETURN NEXT is((SELECT wallet_active_seconds FROM public.profiles WHERE id = v_new),
    900::bigint, '8: new-user wallet += 900');

  -- ── Idempotent: re-crediting the same token+user is a no-op ──────────────
  SELECT * INTO v_r FROM public.recording_referral_credit_first_session_v2('th1', v_new, 'fp_new', '9.9.9');
  RETURN NEXT is(v_r.credited, false, '9: re-credit no-op');
  RETURN NEXT is((SELECT wallet_active_seconds FROM public.profiles WHERE id = v_ref),
    900::bigint, '10: referrer wallet unchanged on re-credit (dedup)');

  -- ── Self-referral: minter signs up under own token → nothing ─────────────
  PERFORM public.recording_referral_mint(v_ref, NULL, NULL, 'th2', 'fp_ref', '1.2.3');
  SELECT * INTO v_r FROM public.recording_referral_credit_first_session_v2('th2', v_ref, 'fp_ref', '1.2.3');
  RETURN NEXT is(v_r.reason,   'self_referral', '11: self-referral blocked');
  RETURN NEXT is(v_r.credited, false,           '12: self-referral not credited');

  -- ── Sock-puppet: new user fp matches the MINTER fp → credit + grants but
  --    NO recruiter bump (R2-M4). Uses token2 (minter fp_ref); v_new2 fp = fp_ref.
  SELECT * INTO v_r FROM public.recording_referral_credit_first_session_v2('th2', v_new2, 'fp_ref', '5.5.5');
  RETURN NEXT is(v_r.credited,         true,  '13: sock-puppet still credits the conversion');
  RETURN NEXT is(v_r.recruiter_bumped, false, '14: sock-puppet skips the recruiter bump');
  RETURN NEXT is((SELECT recruiter_bonus_daily_seconds FROM public.profiles WHERE id = v_ref),
    60, '15: recruiter bonus NOT raised by the sock-puppet');

  -- ── share_tap dedup on token + 2/day cap ────────────────────────────────
  PERFORM public.minute_grant_insert(v_new2,'share_tap',60,'share_token','st1',NULL,NULL,18000,10,2);
  SELECT * INTO v_g FROM public.minute_grant_insert(v_new2,'share_tap',60,'share_token','st1',NULL,NULL,18000,10,2);
  RETURN NEXT is(v_g.reason, 'duplicate', '16: share_tap dedup on token (no slot burned)');
  PERFORM public.minute_grant_insert(v_new2,'share_tap',60,'share_token','st2',NULL,NULL,18000,10,2);
  SELECT * INTO v_g FROM public.minute_grant_insert(v_new2,'share_tap',60,'share_token','st3',NULL,NULL,18000,10,2);
  RETURN NEXT is(v_g.reason, 'share_tap_daily_cap', '17: 3rd share_tap/day capped');

  -- ── Lifetime cap: Σ(referral_verified+share_tap) ≥ cap rejects more ──────
  -- cap=100: grant 60 (Σ→60), grant 60 (Σ→120), 3rd sees Σ_before=120 ≥ 100 → reject.
  PERFORM public.minute_grant_insert(v_life,'share_tap',60,'share_token','L1',NULL,NULL,100,10,9);
  PERFORM public.minute_grant_insert(v_life,'referral_verified',60,'referral_token','L2',NULL,NULL,100,10,9);
  SELECT * INTO v_g FROM public.minute_grant_insert(v_life,'referral_verified',60,'referral_token','L3',NULL,NULL,100,10,9);
  RETURN NEXT is(v_g.reason, 'lifetime_cap', '18: lifetime cap rejects past Σ ≥ cap');

  -- ── Velocity cap: > N referral_verified / 24h rejects ───────────────────
  PERFORM public.minute_grant_insert(v_vel,'referral_verified',60,'referral_token','V1',NULL,NULL,999999,2,9);
  PERFORM public.minute_grant_insert(v_vel,'referral_verified',60,'referral_token','V2',NULL,NULL,999999,2,9);
  SELECT * INTO v_g FROM public.minute_grant_insert(v_vel,'referral_verified',60,'referral_token','V3',NULL,NULL,999999,2,9);
  RETURN NEXT is(v_g.reason, 'velocity_cap', '19: velocity cap rejects the 3rd in 24h');
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.minute_grants WHERE user_id = v_vel AND grant_type = 'referral_verified'),
    2, '20: exactly 2 referral_verified landed before the velocity cap');
END;
$fn$;
SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
