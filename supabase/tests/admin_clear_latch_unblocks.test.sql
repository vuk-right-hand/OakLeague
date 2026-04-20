-- R5-S2: admin UPDATE kill_switch_fired_at = NULL unblocks the user.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('admin-unblock@test');
  v_cuid uuid := tests.create_auth_user('creator-au@test');
  v_cid uuid;
  v_sid uuid;
BEGIN
  UPDATE public.profiles SET handle = 'cau' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'CAU', 'cau', 'ready', now())
    RETURNING id INTO v_cid;

  INSERT INTO public.daily_quotas (user_id, quota_date, tier_snapshot, daily_limit_s, seconds_used)
    VALUES (v_uid, (now() AT TIME ZONE 'UTC')::date, 'free', 600, 900);

  UPDATE public.daily_quotas SET kill_switch_fired_at = NULL WHERE user_id = v_uid;

  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_uid, v_cid, 'gemini_3_1_flash_live_preview', 'free')
    RETURNING id INTO v_sid;

  RETURN NEXT ok(v_sid IS NOT NULL, 'new session succeeds after admin clears latch');
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
