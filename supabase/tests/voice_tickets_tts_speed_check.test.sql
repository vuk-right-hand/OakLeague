-- voice_tickets.tts_speed: NULL allowed (legacy), [0.6, 1.5] accepted,
-- out-of-range rejected with 23514.
--
-- Pre-commit audit M2 fix: voice_tickets.session_id has a FK to sessions.
-- We must create a real sessions row first or the FK fires 23503 before
-- the tts_speed CHECK is reached. Pattern lifted from
-- voice_tickets_brain_payload_check.test.sql.
BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user      uuid := tests.create_auth_user('vts-u@test');
  v_creat     uuid := tests.create_auth_user('vts-c@test');
  v_creator   uuid;
  v_session   uuid;
  v_err       text;
BEGIN
  UPDATE public.profiles SET handle = 'vtscr' WHERE id = v_creat;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creat, 'VTS C', 'vtscr', 'training') RETURNING id INTO v_creator;

  -- Open a real session row so voice_tickets.session_id FK is satisfied.
  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session, status, avatar_status)
    VALUES (v_user, v_creator, 'gemini_3_1_flash_live_preview', 'free', 'starting', 'pending')
    RETURNING id INTO v_session;

  -- 1) NULL tts_speed accepted (legacy ticket path).
  INSERT INTO public.voice_tickets
    (ticket_id, user_id, creator_id, session_id, expected_tier, purpose,
     avatar_provider, expires_at, bound_ua_hash, tts_speed)
  VALUES
    (gen_random_uuid(), v_user, v_creator, v_session, 'free', 'voice_session',
     'simli', now() + interval '120 seconds', repeat('a', 64), NULL);
  RETURN NEXT ok(true, '1: NULL tts_speed accepted');

  -- 2) tts_speed=1.0 accepted.
  INSERT INTO public.voice_tickets
    (ticket_id, user_id, creator_id, session_id, expected_tier, purpose,
     avatar_provider, expires_at, bound_ua_hash, tts_speed)
  VALUES
    (gen_random_uuid(), v_user, v_creator, v_session, 'free', 'voice_session',
     'simli', now() + interval '120 seconds', repeat('b', 64), 1.0);
  RETURN NEXT ok(true, '2: tts_speed=1.0 accepted');

  -- 3) tts_speed=0.5 (below 0.6 floor) rejected.
  BEGIN
    INSERT INTO public.voice_tickets
      (ticket_id, user_id, creator_id, session_id, expected_tier, purpose,
       avatar_provider, expires_at, bound_ua_hash, tts_speed)
    VALUES
      (gen_random_uuid(), v_user, v_creator, v_session, 'free', 'voice_session',
       'simli', now() + interval '120 seconds', repeat('c', 64), 0.5);
    RETURN NEXT fail('3: tts_speed=0.5 should have raised 23514');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    RETURN NEXT is(v_err, '23514', '3: tts_speed=0.5 → 23514');
  END;

  -- 4) tts_speed=2.0 (above 1.5 ceiling) rejected.
  BEGIN
    INSERT INTO public.voice_tickets
      (ticket_id, user_id, creator_id, session_id, expected_tier, purpose,
       avatar_provider, expires_at, bound_ua_hash, tts_speed)
    VALUES
      (gen_random_uuid(), v_user, v_creator, v_session, 'free', 'voice_session',
       'simli', now() + interval '120 seconds', repeat('d', 64), 2.0);
    RETURN NEXT fail('4: tts_speed=2.0 should have raised 23514');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    RETURN NEXT is(v_err, '23514', '4: tts_speed=2.0 → 23514');
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
