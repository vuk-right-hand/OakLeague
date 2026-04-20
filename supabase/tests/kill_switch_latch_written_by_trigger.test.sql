-- R4-S1: UPDATE that crosses 150% latches kill_switch_fired_at.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('latch-update@test');
  v_pre  timestamptz;
  v_post timestamptz;
BEGIN
  INSERT INTO public.daily_quotas (user_id, quota_date, tier_snapshot, daily_limit_s, seconds_used)
    VALUES (v_uid, current_date, 'free', 1200, 100);
  SELECT kill_switch_fired_at INTO v_pre FROM public.daily_quotas WHERE user_id = v_uid;
  RETURN NEXT ok(v_pre IS NULL, 'not latched before threshold');

  UPDATE public.daily_quotas SET seconds_used = 2000 WHERE user_id = v_uid;
  SELECT kill_switch_fired_at INTO v_post FROM public.daily_quotas WHERE user_id = v_uid;
  RETURN NEXT ok(v_post IS NOT NULL, 'latched after UPDATE crosses 150%');
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
