-- Baseline: profile.timezone default 'UTC' means quota_date = UTC::date.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('utc-default@test');
  v_cuid uuid := tests.create_auth_user('cutc@test');
  v_cid uuid;
  v_sid uuid;
  v_quota_date date;
BEGIN
  UPDATE public.profiles SET handle = 'cutc' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'CUTC', 'cutc', 'ready', now())
    RETURNING id INTO v_cid;

  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_uid, v_cid, 'gemini_3_1_flash_live_preview', 'free')
    RETURNING id INTO v_sid;

  SELECT quota_date INTO v_quota_date
    FROM public.daily_quotas WHERE user_id = v_uid;

  RETURN NEXT ok(
    v_quota_date = (now() AT TIME ZONE 'UTC')::date,
    'UTC-default user resets at UTC midnight'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
