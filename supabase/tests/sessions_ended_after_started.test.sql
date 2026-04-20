-- CHECK (ended_at IS NULL OR ended_at >= started_at)
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('sends@test');
  v_cuid uuid := tests.create_auth_user('cse@test');
  v_cid uuid;
  v_sid uuid;
BEGIN
  UPDATE public.profiles SET handle = 'cse' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'CS', 'cse', 'ready', now())
    RETURNING id INTO v_cid;
  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_uid, v_cid, 'gemini_3_1_flash_live_preview', 'free')
    RETURNING id INTO v_sid;

  RETURN NEXT throws_like(
    format($$ UPDATE public.sessions SET ended_at = now() - interval '1 hour'
              WHERE id = '%s' $$, v_sid),
    '%check%',
    'ended_at < started_at rejected'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
