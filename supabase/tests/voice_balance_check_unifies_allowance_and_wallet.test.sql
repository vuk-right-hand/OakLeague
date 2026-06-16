-- voice_balance_check: effective_remaining = free allowance + durable wallet;
-- recruiter bonus adds to the DAILY side only; cap_period reports the binding
-- free cap. Growth & Minutes Economy Phase 1 (migration 20260615000002).
BEGIN;
SELECT plan(8);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('bal@test');
  v_b   record;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Fresh free user: daily=300, weekly=900, monthly=NULL, wallet=0.
  SELECT * INTO v_b FROM public.voice_balance_check(v_uid);
  RETURN NEXT is(v_b.effective_remaining, 300, '1: fresh free user effective = daily cap 300 (binds under weekly 900)');
  RETURN NEXT is(v_b.allowance_remaining, 300, '2: allowance_remaining = 300');
  RETURN NEXT is(v_b.wallet_remaining, 0, '3: wallet_remaining = 0 with no grants');
  RETURN NEXT is(v_b.cap_period, 'daily', '4: cap_period = daily (smallest headroom)');

  -- Grant 600s wallet → effective rises by the wallet.
  PERFORM public.minute_grant_insert(v_uid, 'referral_verified', 600, 'referral_token', 'tok_bal', NULL, NULL);
  SELECT * INTO v_b FROM public.voice_balance_check(v_uid);
  RETURN NEXT is(v_b.wallet_remaining, 600, '5: wallet_remaining = 600 after grant');
  RETURN NEXT is(v_b.effective_remaining, 900, '6: effective = allowance 300 + wallet 600');

  -- Recruiter bonus adds to the daily side only → daily_cap_eff = 420.
  UPDATE public.profiles SET recruiter_bonus_daily_seconds = 120 WHERE id = v_uid;
  SELECT * INTO v_b FROM public.voice_balance_check(v_uid);
  RETURN NEXT is(v_b.daily_cap_eff, 420, '7: daily_cap_eff = daily 300 + recruiter 120');
  RETURN NEXT is(v_b.effective_remaining, 1020, '8: effective = allowance 420 + wallet 600');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
