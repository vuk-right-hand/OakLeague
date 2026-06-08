-- FISH_AUDIO_PHASE_1 §6 — creators.tts_provider accepts 'fish'.
--
-- M1 (20260608100001) widens the enum from (cartesia, hume) to
-- (cartesia, hume, fish). This test exercises:
--   1. Direct INSERT with tts_provider='fish' succeeds.
--   2. creator_set_tts_provider(id, 'fish') succeeds when no active session.
--   3. creator_set_tts_provider(id, 'fish') raises 55006 when active session.
--
-- The RPC signature already takes public.tts_provider, so widening the enum
-- means no RPC changes were required (HUME_TTS_PLAN's RPC just gained a new
-- valid value automatically).

BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user      uuid := tests.create_auth_user('fishcreator@test');
  v_app       uuid;
  v_creator   uuid;
  v_session   uuid;
  v_provider  public.tts_provider;
BEGIN
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
  VALUES (gen_random_uuid(), v_user, 'approved', 'Fish Creator', 'fishcreator2', '[]'::jsonb, '{}'::jsonb)
  RETURNING id INTO v_app;

  -- 1: direct INSERT with tts_provider='fish'.
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, brain_mode, tts_provider)
  VALUES (gen_random_uuid(), v_user, v_app, 'Fish Creator', 'fishcreator2', 'ready', 'vector', 'fish')
  RETURNING id INTO v_creator;
  SELECT tts_provider INTO v_provider FROM public.creators WHERE id = v_creator;
  RETURN NEXT ok(v_provider = 'fish', '1: INSERT creator with tts_provider=fish → column reads fish');

  -- Reset for RPC test: clear back to NULL so the RPC writes something new.
  UPDATE public.creators SET tts_provider = NULL WHERE id = v_creator;

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- 2: RPC accepts 'fish' when no active session.
  PERFORM public.creator_set_tts_provider(v_creator, 'fish'::public.tts_provider);
  SELECT tts_provider INTO v_provider FROM public.creators WHERE id = v_creator;
  RETURN NEXT ok(v_provider = 'fish', '2: creator_set_tts_provider(fish) with no active sessions → succeeds');

  -- 3: RPC accepts NULL (back to "inherit env" — audit S6). Lock-in
  -- semantics: a creator currently routed to fish can be reset to NULL
  -- so they fall back to the proxy's env-default provider. This is the
  -- reverse-flip an admin would use to roll a creator OFF fish without
  -- forcing a specific cartesia/hume re-route.
  PERFORM public.creator_set_tts_provider(v_creator, NULL::public.tts_provider);
  SELECT tts_provider INTO v_provider FROM public.creators WHERE id = v_creator;
  RETURN NEXT ok(v_provider IS NULL, '3: creator_set_tts_provider(NULL) resets to inherit-env (NULL)');

  -- Restore fish so the active-session test exercises a real flip-blocker.
  PERFORM public.creator_set_tts_provider(v_creator, 'fish'::public.tts_provider);

  -- 4: RPC blocks 'cartesia' flip when an active session exists.
  -- The session insert and the RPC call execute in the same outer
  -- BEGIN; … ROLLBACK; (pgTAP block), so the RPC's active-session COUNT
  -- reads through the current-tx snapshot and sees this insert — that
  -- is what makes test 4 fire 55006 instead of succeeding (round 2 M5).
  INSERT INTO public.sessions (id, user_id, creator_id, model_used, tier_at_session, status)
  VALUES (gen_random_uuid(), v_user, v_creator, 'gemini_3_1_flash_live_preview', 'free', 'starting')
  RETURNING id INTO v_session;

  BEGIN
    PERFORM public.creator_set_tts_provider(v_creator, 'cartesia'::public.tts_provider);
    RETURN NEXT fail('4: flip with active session should have raised 55006');
  EXCEPTION
    WHEN SQLSTATE '55006' THEN RETURN NEXT pass('4: creator_set_tts_provider with active session → 55006');
    WHEN OTHERS THEN RETURN NEXT fail('4: expected 55006, got ' || SQLSTATE || ' ' || SQLERRM);
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
