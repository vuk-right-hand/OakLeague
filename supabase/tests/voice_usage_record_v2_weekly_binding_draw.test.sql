-- voice_usage_record_v2: when the WEEKLY cap (not daily) is the binding free cap,
-- the wallet draws exactly the slice beyond the remaining weekly allowance, and the
-- gate (voice_balance_check) agrees on the free-pool size (M1 — the gate and meter
-- must never disagree, incl. on a non-daily-binding pool).
-- Growth & Minutes Economy Phase 1 (migration 20260615000002).
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid   uuid := tests.create_auth_user('recwk@test');
  v_sid   uuid := '22222222-2222-2222-2222-222222222222';
  v_b     record;
  v_spent bigint;
BEGIN
  UPDATE public.profiles SET timezone = 'UTC' WHERE id = v_uid;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- 600s wallet; pre-load 850s used THIS WEEK (daily still 0). Weekly cap 900 ⇒
  -- only 50s of free pool left, even though daily has 300 headroom.
  PERFORM public.minute_grant_insert(v_uid, 'paid_topup', 600, 'admin', 'wk_topup', NULL, NULL);
  INSERT INTO public.voice_usage_weekly (user_id, iso_week_mon, seconds_used)
    VALUES (v_uid, date_trunc('week', (now() AT TIME ZONE 'UTC')::date)::date, 850);

  -- Gate agrees the free pool is 50 (weekly binds under daily).
  SELECT * INTO v_b FROM public.voice_balance_check(v_uid);
  RETURN NEXT is(v_b.allowance_remaining, 50, '1: gate sees 50s free (weekly binds under daily 300)');

  -- A 200s turn: 50s free + 150s overflow → wallet draws exactly 150s.
  PERFORM public.voice_usage_record_v2(v_uid, v_sid, 1, 200, now());
  SELECT wallet_spent_seconds INTO v_spent FROM public.profiles WHERE id = v_uid;
  RETURN NEXT is(v_spent, 150::bigint, '2: weekly-binding overflow draws exactly 150s from the wallet');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
