-- voice_usage_record_v2: only the slice of a turn BEYOND the free allowance
-- draws the wallet; exactly-once on retry; wallet_spent clamped to wallet_active
-- (Phase-7 invariant); monthly counter written.
-- Growth & Minutes Economy Phase 1 (migration 20260615000002).
BEGIN;
SELECT plan(7);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid  uuid := tests.create_auth_user('rec@test');
  v_uid2 uuid := tests.create_auth_user('rec2@test');
  v_sid  uuid := '11111111-1111-1111-1111-111111111111';
  v_ret  boolean;
  v_spent bigint;
  v_month numeric;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- User 1 has a 600s wallet on top of the 300s daily free allowance.
  PERFORM public.minute_grant_insert(v_uid, 'paid_topup', 600, 'admin', 'topup_1', NULL, NULL);

  -- Turn 1: 200s — fully within the 300s free allowance ⇒ no wallet draw.
  SELECT public.voice_usage_record_v2(v_uid, v_sid, 1, 200, now()) INTO v_ret;
  RETURN NEXT is(v_ret, true, '1: turn 1 recorded (returns true)');
  SELECT wallet_spent_seconds INTO v_spent FROM public.profiles WHERE id = v_uid;
  RETURN NEXT is(v_spent, 0::bigint, '2: turn within free allowance draws no wallet');

  -- Turn 2: 200s — only 100s of free allowance left ⇒ 100s overflow draws wallet.
  PERFORM public.voice_usage_record_v2(v_uid, v_sid, 2, 200, now());
  SELECT wallet_spent_seconds INTO v_spent FROM public.profiles WHERE id = v_uid;
  RETURN NEXT is(v_spent, 100::bigint, '3: only the overflow slice (100s) draws the wallet');

  -- Turn 2 retry (same turn_number) ⇒ idempotent no-op, no double draw.
  SELECT public.voice_usage_record_v2(v_uid, v_sid, 2, 200, now()) INTO v_ret;
  RETURN NEXT is(v_ret, false, '4: duplicate turn returns false (exactly-once)');
  SELECT wallet_spent_seconds INTO v_spent FROM public.profiles WHERE id = v_uid;
  RETURN NEXT is(v_spent, 100::bigint, '5: retry did not double-draw the wallet');

  -- Monthly counter written across both turns (400s).
  SELECT seconds_used INTO v_month FROM public.voice_usage_monthly
    WHERE user_id = v_uid AND period_start = public.monthly_window_start(v_uid);
  RETURN NEXT is(v_month, 400::numeric, '6: monthly counter accumulated 400s');

  -- User 2 has NO wallet: a turn over the free cap must NOT push wallet_spent
  -- above wallet_active (clamped to 0) — preserves the reconcile invariant.
  PERFORM public.voice_usage_record_v2(v_uid2, v_sid, 1, 400, now());
  SELECT wallet_spent_seconds INTO v_spent FROM public.profiles WHERE id = v_uid2;
  RETURN NEXT is(v_spent, 0::bigint, '7: overflow with empty wallet clamps wallet_spent to 0');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
