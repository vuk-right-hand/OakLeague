-- Mid-session kill-switch: turn lands, later turn raises when seconds_used
-- accumulator crosses 150%.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('mid-ks@test');
  v_cuid uuid := tests.create_auth_user('creator-mks@test');
  v_cid uuid;
  v_sid uuid;
  v_tid uuid;
BEGIN
  UPDATE public.profiles SET handle = 'cmks' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'CMKS', 'cmks', 'ready', now())
    RETURNING id INTO v_cid;

  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_uid, v_cid, 'gemini_3_1_flash_live_preview', 'free')
    RETURNING id INTO v_sid;

  INSERT INTO public.session_turns (session_id, turn_number, role)
    VALUES (v_sid, 1, 'user') RETURNING id INTO v_tid;
  RETURN NEXT ok(v_tid IS NOT NULL, 'turn 1 accepted');

  UPDATE public.daily_quotas SET seconds_used = 2000 WHERE user_id = v_uid;

  RETURN NEXT throws_like(
    format($$ INSERT INTO public.session_turns (session_id, turn_number, role)
              VALUES ('%s', 2, 'assistant') $$, v_sid),
    '%kill_switch%',
    'turn 2 raises after mid-session latch'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
