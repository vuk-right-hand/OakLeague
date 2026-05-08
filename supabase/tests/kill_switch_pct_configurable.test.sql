-- Phase C B4.2: kill-switch threshold honors `app.kill_switch_pct` GUC.
--
-- Default 150 (no GUC set), latch fires at exactly daily_limit_s * 1.5.
-- Override via SET LOCAL to 120, latch now fires at daily_limit_s * 1.2.
-- Out-of-bounds value (e.g., '5' = 5% — typo) falls back to 150.
BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid;
  v_qdate date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  -- Default 150% threshold: 300s cap → latch at 450s.
  v_uid := tests.create_auth_user('killpct-default@test');
  INSERT INTO public.daily_quotas
    (user_id, quota_date, tier_snapshot, daily_limit_s, seconds_used)
  VALUES (v_uid, v_qdate, 'free', 300, 0);
  UPDATE public.daily_quotas SET seconds_used = 449
   WHERE user_id = v_uid AND quota_date = v_qdate;
  RETURN NEXT ok(
    (SELECT kill_switch_fired_at FROM public.daily_quotas
       WHERE user_id = v_uid AND quota_date = v_qdate) IS NULL,
    'default 150%: 449s of 300s cap (149.7%) does NOT latch'
  );
  UPDATE public.daily_quotas SET seconds_used = 450
   WHERE user_id = v_uid AND quota_date = v_qdate;
  RETURN NEXT ok(
    (SELECT kill_switch_fired_at FROM public.daily_quotas
       WHERE user_id = v_uid AND quota_date = v_qdate) IS NOT NULL,
    'default 150%: 450s of 300s cap (150%) latches'
  );

  -- Override to 120%: 300s cap → latch at 360s.
  PERFORM set_config('app.kill_switch_pct', '120', true);
  v_uid := tests.create_auth_user('killpct-120@test');
  INSERT INTO public.daily_quotas
    (user_id, quota_date, tier_snapshot, daily_limit_s, seconds_used)
  VALUES (v_uid, v_qdate, 'free', 300, 0);
  UPDATE public.daily_quotas SET seconds_used = 360
   WHERE user_id = v_uid AND quota_date = v_qdate;
  RETURN NEXT ok(
    (SELECT kill_switch_fired_at FROM public.daily_quotas
       WHERE user_id = v_uid AND quota_date = v_qdate) IS NOT NULL,
    'GUC=120%: 360s of 300s cap (120%) latches earlier than default'
  );

  -- Out-of-bounds (5% — typo) falls back to 150%.
  PERFORM set_config('app.kill_switch_pct', '5', true);
  v_uid := tests.create_auth_user('killpct-oob@test');
  INSERT INTO public.daily_quotas
    (user_id, quota_date, tier_snapshot, daily_limit_s, seconds_used)
  VALUES (v_uid, v_qdate, 'free', 300, 0);
  -- 16s is over 5% of 300 (=15s) but under 150% (=450s). With OOB
  -- fallback to 150%, this should NOT latch.
  UPDATE public.daily_quotas SET seconds_used = 16
   WHERE user_id = v_uid AND quota_date = v_qdate;
  RETURN NEXT ok(
    (SELECT kill_switch_fired_at FROM public.daily_quotas
       WHERE user_id = v_uid AND quota_date = v_qdate) IS NULL,
    'GUC=5% (out of bounds [100,1000]): falls back to 150%, no latch at 16s'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
