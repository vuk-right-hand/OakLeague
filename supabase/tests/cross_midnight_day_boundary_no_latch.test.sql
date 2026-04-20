-- R4-M1: session starts 23:55 day N, day-N quota fresh (no latch). Turn at
-- 00:03 day N+1 passes — keys on session start day, latch not set.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('cross-nolatch@test');
  v_cuid uuid := tests.create_auth_user('creator-cnl@test');
  v_cid uuid;
  v_sid uuid;
  v_tid uuid;
BEGIN
  UPDATE public.profiles SET timezone = 'UTC' WHERE id = v_uid;
  UPDATE public.profiles SET handle = 'ccnl' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'CCNL', 'ccnl', 'ready', now())
    RETURNING id INTO v_cid;

  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session, started_at)
    VALUES (v_uid, v_cid, 'gemini_3_1_flash_live_preview', 'free',
            (now() - interval '7 minutes'))
    RETURNING id INTO v_sid;

  INSERT INTO public.session_turns (session_id, turn_number, role, transcript)
    VALUES (v_sid, 1, 'user', 'hi')
    RETURNING id INTO v_tid;

  RETURN NEXT ok(v_tid IS NOT NULL, 'turn lands when no latch on session-start day');
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
