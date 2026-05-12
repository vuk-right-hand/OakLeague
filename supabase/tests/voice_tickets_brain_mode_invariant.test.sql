-- pgvector RAG plan M6 — voice_tickets_brain_mode_prefix_chk invariant.
--
-- vector mode + non-null prefix_turns → CHECK violation (23514).
-- vector mode + null prefix_turns → OK.
-- drawer mode + null prefix_turns → OK.
-- drawer mode + non-null prefix_turns → OK (legacy path).

BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user     uuid := tests.create_auth_user('brain-mode-inv@test');
  v_creator  uuid;
  v_session  uuid;
  v_ticket   uuid;
  v_app      uuid;
BEGIN
  -- Build the minimal chain: profile (handle_new_user trigger does it),
  -- creator_application, creator, session.
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle)
  VALUES (gen_random_uuid(), v_user, 'approved', 'Test Creator', 'brainmodeinv1')
  RETURNING id INTO v_app;

  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, brain_mode)
  VALUES (gen_random_uuid(), v_user, v_app, 'Test Creator', 'brainmodeinv1', 'ready', 'vector')
  RETURNING id INTO v_creator;

  -- session needs a model + tier; use the existing session_open RPC's
  -- bypass by INSERTing directly as service_role.
  INSERT INTO public.sessions (id, user_id, creator_id, model_used, tier_at_session, status)
  VALUES (gen_random_uuid(), v_user, v_creator, 'gemini_3_1_flash_live_preview', 'free', 'starting')
  RETURNING id INTO v_session;

  -- 1: vector + prefix_turns array → must fail.
  BEGIN
    INSERT INTO public.voice_tickets
      (user_id, bound_ua_hash, creator_id, session_id, expected_tier, avatar_provider, expires_at, brain_mode, prefix_turns)
    VALUES (v_user, repeat('a', 64), v_creator, v_session, 'free', 'simli', now() + interval '2 minutes', 'vector',
            '[{"role":"user","parts":[{"text":"x"}]}]'::jsonb);
    RETURN NEXT fail('1: vector + prefix_turns array should have CHECK-violated');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('1: vector + non-null prefix_turns → CHECK violation');
  END;

  -- 2: vector + null prefix_turns → OK.
  INSERT INTO public.voice_tickets
    (user_id, bound_ua_hash, creator_id, session_id, expected_tier, avatar_provider, expires_at, brain_mode, prefix_turns)
  VALUES (v_user, repeat('b', 64), v_creator, v_session, 'free', 'simli', now() + interval '2 minutes', 'vector', NULL)
  RETURNING ticket_id INTO v_ticket;
  RETURN NEXT pass('2: vector + null prefix_turns → OK');
  DELETE FROM public.voice_tickets WHERE ticket_id = v_ticket;

  -- 3: drawer + non-null prefix_turns → OK.
  INSERT INTO public.voice_tickets
    (user_id, bound_ua_hash, creator_id, session_id, expected_tier, avatar_provider, expires_at, brain_mode, prefix_turns)
  VALUES (v_user, repeat('c', 64), v_creator, v_session, 'free', 'simli', now() + interval '2 minutes', 'drawer',
          '[{"role":"user","parts":[{"text":"x"}]}]'::jsonb)
  RETURNING ticket_id INTO v_ticket;
  RETURN NEXT pass('3: drawer + non-null prefix_turns → OK');
  DELETE FROM public.voice_tickets WHERE ticket_id = v_ticket;

  -- 4: drawer + null prefix_turns → OK.
  INSERT INTO public.voice_tickets
    (user_id, bound_ua_hash, creator_id, session_id, expected_tier, avatar_provider, expires_at, brain_mode, prefix_turns)
  VALUES (v_user, repeat('d', 64), v_creator, v_session, 'free', 'simli', now() + interval '2 minutes', 'drawer', NULL)
  RETURNING ticket_id INTO v_ticket;
  RETURN NEXT pass('4: drawer + null prefix_turns → OK');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
