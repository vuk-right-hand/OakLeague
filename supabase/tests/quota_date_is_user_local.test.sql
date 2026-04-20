-- R6-C2 / R6-C3: daily_quotas.quota_date is user-local, not UTC.
-- An LA user opening a session at 07:00 UTC is at 23:00 PST the PREVIOUS
-- local day. The quota row must key on the PST date, not UTC.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid   uuid;
  v_cid   uuid;
  v_creator_user uuid;
  v_sid   uuid;
  v_quota_date date;
BEGIN
  v_uid := tests.create_auth_user('la-user@test');
  UPDATE public.profiles SET timezone = 'America/Los_Angeles' WHERE id = v_uid;

  v_creator_user := tests.create_auth_user('creator-quota@test');
  UPDATE public.profiles SET handle = 'cquota' WHERE id = v_creator_user;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_user, 'CQ', 'cquota', 'ready', now())
    RETURNING id INTO v_cid;

  PERFORM set_config('timezone', 'UTC', true);
  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_uid, v_cid, 'gemini_3_1_flash_live_preview', 'free')
    RETURNING id INTO v_sid;

  SELECT quota_date INTO v_quota_date
    FROM public.daily_quotas WHERE user_id = v_uid;

  RETURN NEXT ok(
    v_quota_date = (now() AT TIME ZONE 'America/Los_Angeles')::date,
    'quota_date equals the user-local (PST) calendar date'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
