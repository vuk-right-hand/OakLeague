-- Same-day tier flip updates daily_quotas.daily_limit_s / tier_snapshot via
-- the next session-open upsert (when not latched).
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('flip@test');
  v_cuid uuid := tests.create_auth_user('cflip@test');
  v_cid uuid;
BEGIN
  UPDATE public.profiles SET handle = 'cflip' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'CF', 'cflip', 'ready', now())
    RETURNING id INTO v_cid;

  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_uid, v_cid, 'gemini_3_1_flash_live_preview', 'free');

  RETURN NEXT is(
    (SELECT daily_limit_s FROM public.daily_quotas WHERE user_id = v_uid),
    600,
    'initial free-tier limit = 600s'
  );

  UPDATE public.profiles SET tier = 'premium' WHERE id = v_uid;
  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_uid, v_cid, 'gemini_pro_audio_v2', 'premium');

  RETURN NEXT is(
    (SELECT daily_limit_s FROM public.daily_quotas WHERE user_id = v_uid),
    3600,
    'premium upsert raises daily_limit_s to 3600s'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
