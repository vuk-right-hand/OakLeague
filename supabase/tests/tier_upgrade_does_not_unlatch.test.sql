-- R5-S2: tier upgrade does not clear the latch. New session still fails.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('tier-upgrade@test');
  v_cuid uuid := tests.create_auth_user('creator-tu@test');
  v_cid uuid;
BEGIN
  UPDATE public.profiles SET handle = 'ctu' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'CTU', 'ctu', 'ready', now())
    RETURNING id INTO v_cid;

  INSERT INTO public.daily_quotas (user_id, quota_date, tier_snapshot, daily_limit_s, seconds_used)
    VALUES (v_uid, (now() AT TIME ZONE 'UTC')::date, 'free', 600, 900);

  UPDATE public.profiles SET tier = 'premium' WHERE id = v_uid;

  RETURN NEXT throws_like(
    format($$ INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
              VALUES ('%s', '%s', 'gemini_3_1_flash_live_preview', 'premium') $$,
           v_uid, v_cid),
    '%kill_switch%',
    'new session blocked despite tier upgrade'
  );

  RETURN NEXT ok(
    (SELECT kill_switch_fired_at FROM public.daily_quotas WHERE user_id = v_uid) IS NOT NULL,
    'latch still set after tier upgrade'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
