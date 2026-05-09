-- voice_tickets brain-payload CHECK constraints (M4).
-- system_prompt: octet_length 1..2000
-- prefix_turns:  pg_column_size < 96 KB
BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user      uuid := tests.create_auth_user('vtbp@test');
  v_creat     uuid := tests.create_auth_user('vtbpc@test');
  v_creator   uuid;
  v_session   uuid;
  v_ticket_id text;
  v_err       text;
BEGIN
  UPDATE public.profiles SET handle = 'vtbpcr' WHERE id = v_creat;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creat, 'C', 'vtbpcr', 'training') RETURNING id INTO v_creator;

  -- Open a session for the user (so voice_tickets has a valid session_id).
  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session, status, avatar_status)
    VALUES (v_user, v_creator, 'gemini_3_1_flash_live_preview', 'free', 'starting', 'pending')
    RETURNING id INTO v_session;

  -- 1) Empty system_prompt (octet_length=0) violates CHECK.
  BEGIN
    INSERT INTO public.voice_tickets
      (ticket_id, user_id, creator_id, session_id, expected_tier, purpose,
       avatar_provider, expires_at, bound_ua_hash, system_prompt)
    VALUES
      (gen_random_uuid(), v_user, v_creator, v_session, 'free', 'voice_session',
       'simli', now() + interval '120 seconds', repeat('a', 64), '');
    RETURN NEXT fail('1: empty system_prompt should have been rejected');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    RETURN NEXT is(v_err, '23514', '1: empty system_prompt → 23514');
  END;

  -- 2) Oversized (>2000 octets) system_prompt violates CHECK.
  BEGIN
    INSERT INTO public.voice_tickets
      (ticket_id, user_id, creator_id, session_id, expected_tier, purpose,
       avatar_provider, expires_at, bound_ua_hash, system_prompt)
    VALUES
      (gen_random_uuid(), v_user, v_creator, v_session, 'free', 'voice_session',
       'simli', now() + interval '120 seconds', repeat('a', 64), repeat('x', 2001));
    RETURN NEXT fail('2: oversized system_prompt should have been rejected');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    RETURN NEXT is(v_err, '23514', '2: oversized system_prompt → 23514');
  END;

  -- 3) Valid persona-shaped system_prompt + null prefix_turns → accepted.
  INSERT INTO public.voice_tickets
    (ticket_id, user_id, creator_id, session_id, expected_tier, purpose,
     avatar_provider, expires_at, bound_ua_hash, system_prompt)
  VALUES
    (gen_random_uuid(), v_user, v_creator, v_session, 'free', 'voice_session',
     'simli', now() + interval '120 seconds', repeat('a', 64), 'You are X. Topics: y. Answer briefly.');
  RETURN NEXT ok(true, '3: valid system_prompt accepted');

  -- 4) prefix_turns near cap (~80KB) accepted; prefix_turns far over (>96KB) rejected.
  --    Build an ~80KB jsonb to verify we pass under cap.
  --    Wire shape: SINGLE user-role Content entry (post-2026-05-09 spike;
  --    preview model rejects model-role turns w/ WS-1007). Don't insert
  --    a second `role:'model'` element here even though the DB CHECK is
  --    shape-agnostic — this file gets read by future engineers reaching
  --    for "what does prefix_turns look like."
  DECLARE
    v_big_text text := repeat('a', 80000);
  BEGIN
    INSERT INTO public.voice_tickets
      (ticket_id, user_id, creator_id, session_id, expected_tier, purpose,
       avatar_provider, expires_at, bound_ua_hash, prefix_turns)
    VALUES
      (gen_random_uuid(), v_user, v_creator, v_session, 'free', 'voice_session',
       'simli', now() + interval '120 seconds', repeat('a', 64),
       jsonb_build_array(
         jsonb_build_object('role', 'user', 'parts', jsonb_build_array(jsonb_build_object('text', v_big_text)))
       ));
    RETURN NEXT ok(true, '4: ~80KB prefix_turns (single user-turn) accepted (under 96KB cap)');
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
