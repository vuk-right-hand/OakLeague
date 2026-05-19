-- DECOUPLED_BRAIN_PLAN P1-2 — voice_tickets_decoupled_requires_vector_chk.
--
-- decoupled=true  + brain_mode='vector' (prefix NULL) → OK (valid decoupled ticket).
-- decoupled=true  + brain_mode='drawer'               → CHECK violation (23514).
-- decoupled=false + brain_mode='drawer'               → OK (legacy default).
-- decoupled=false + brain_mode='vector' (prefix NULL) → OK (legacy vector, decoupled off).
--
-- Mirrors voice_tickets_brain_mode_invariant.test.sql. Vector rows keep
-- prefix_turns NULL so the pre-existing voice_tickets_brain_mode_prefix_chk
-- never confounds the decoupled assertion.

BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user     uuid := tests.create_auth_user('decoupled-inv@test');
  v_creator  uuid;
  v_session  uuid;
  v_ticket   uuid;
  v_app      uuid;
BEGIN
  -- topics + proof are NOT NULL since 20260420000010 (the older
  -- voice_tickets_brain_mode_invariant reference omits them and is
  -- itself stale); current-correct pattern = admin_compare_and_promote_v2.
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
  VALUES (gen_random_uuid(), v_user, 'approved', 'Test Creator', 'decoupledinv1',
          '[]'::jsonb, '{}'::jsonb)
  RETURNING id INTO v_app;

  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, brain_mode)
  VALUES (gen_random_uuid(), v_user, v_app, 'Test Creator', 'decoupledinv1', 'ready', 'vector')
  RETURNING id INTO v_creator;

  INSERT INTO public.sessions (id, user_id, creator_id, model_used, tier_at_session, status)
  VALUES (gen_random_uuid(), v_user, v_creator, 'gemini_3_1_flash_live_preview', 'free', 'starting')
  RETURNING id INTO v_session;

  -- 1: decoupled=true + vector (prefix NULL) → OK.
  INSERT INTO public.voice_tickets
    (user_id, bound_ua_hash, creator_id, session_id, expected_tier, avatar_provider, expires_at, brain_mode, prefix_turns, decoupled, tts_provider)
  VALUES (v_user, repeat('a', 64), v_creator, v_session, 'free', 'simli', now() + interval '2 minutes', 'vector', NULL, true, 'cartesia')
  RETURNING ticket_id INTO v_ticket;
  RETURN NEXT pass('1: decoupled=true + vector → OK');
  DELETE FROM public.voice_tickets WHERE ticket_id = v_ticket;

  -- 2: decoupled=true + drawer → must fail.
  BEGIN
    INSERT INTO public.voice_tickets
      (user_id, bound_ua_hash, creator_id, session_id, expected_tier, avatar_provider, expires_at, brain_mode, prefix_turns, decoupled, tts_provider)
    VALUES (v_user, repeat('b', 64), v_creator, v_session, 'free', 'simli', now() + interval '2 minutes', 'drawer', NULL, true, 'cartesia');
    RETURN NEXT fail('2: decoupled=true + drawer should have CHECK-violated');
  EXCEPTION WHEN check_violation THEN
    RETURN NEXT pass('2: decoupled=true + drawer → CHECK violation');
  END;

  -- 3: decoupled=false + drawer → OK (legacy default).
  INSERT INTO public.voice_tickets
    (user_id, bound_ua_hash, creator_id, session_id, expected_tier, avatar_provider, expires_at, brain_mode, prefix_turns, decoupled, tts_provider)
  VALUES (v_user, repeat('c', 64), v_creator, v_session, 'free', 'simli', now() + interval '2 minutes', 'drawer', NULL, false, 'cartesia')
  RETURNING ticket_id INTO v_ticket;
  RETURN NEXT pass('3: decoupled=false + drawer → OK');
  DELETE FROM public.voice_tickets WHERE ticket_id = v_ticket;

  -- 4: decoupled=false + vector (prefix NULL) → OK (legacy vector).
  INSERT INTO public.voice_tickets
    (user_id, bound_ua_hash, creator_id, session_id, expected_tier, avatar_provider, expires_at, brain_mode, prefix_turns, decoupled, tts_provider)
  VALUES (v_user, repeat('d', 64), v_creator, v_session, 'free', 'simli', now() + interval '2 minutes', 'vector', NULL, false, 'cartesia')
  RETURNING ticket_id INTO v_ticket;
  RETURN NEXT pass('4: decoupled=false + vector → OK');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
