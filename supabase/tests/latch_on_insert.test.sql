-- R5-S1: latch fires on INSERT, not only UPDATE.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('latch-insert@test');
  v_latched timestamptz;
BEGIN
  INSERT INTO public.daily_quotas (user_id, quota_date, tier_snapshot, daily_limit_s, seconds_used)
    VALUES (v_uid, current_date, 'free', 1200, 2000);
  SELECT kill_switch_fired_at INTO v_latched
    FROM public.daily_quotas WHERE user_id = v_uid;
  RETURN NEXT ok(v_latched IS NOT NULL, 'latch set on INSERT when seconds_used crosses 150%');
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
