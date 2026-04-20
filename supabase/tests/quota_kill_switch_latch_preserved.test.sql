-- Once latched, a subsequent UPDATE that drops seconds_used must NOT unlatch.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('latch-preserve@test');
BEGIN
  INSERT INTO public.daily_quotas (user_id, quota_date, tier_snapshot, daily_limit_s, seconds_used)
    VALUES (v_uid, current_date, 'free', 1200, 2000);

  UPDATE public.daily_quotas SET seconds_used = 100 WHERE user_id = v_uid;

  RETURN NEXT ok(
    (SELECT kill_switch_fired_at FROM public.daily_quotas WHERE user_id = v_uid) IS NOT NULL,
    'latch preserved across seconds_used downward UPDATE'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
