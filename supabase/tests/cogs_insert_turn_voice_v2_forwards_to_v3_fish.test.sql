-- FISH_AUDIO_PHASE_1 §6 — v2 forwards to v3 (Fish-aware).
--
-- v2 keeps its byte-identical signature post-M3 but its body becomes
-- PERFORM v3(...). This test verifies that:
--   1. Calling v2 with fish args writes the same 4 legs that v3 would write
--      directly (transparent forward).
--   2. Calling v2 with cartesia args still works (no regression).
--
-- The brain-leg RPC is unrelated and not exercised here.

BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user_f    uuid := tests.create_auth_user('v2fwd-fish@test');
  v_user_c    uuid := tests.create_auth_user('v2fwd-cart@test');
  v_creator   uuid;
  v_session_f uuid;
  v_session_c uuid;
  v_app       uuid;
  v_rows      int;
BEGIN
  -- One shared creator; separate user per session because the
  -- sessions_one_active_per_user partial unique index forbids two active
  -- sessions for the same user (regardless of creator).
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
  VALUES (gen_random_uuid(), v_user_f, 'approved', 'V2Fwd Creator', 'v2fwd1', '[]'::jsonb, '{}'::jsonb)
  RETURNING id INTO v_app;

  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, brain_mode)
  VALUES (gen_random_uuid(), v_user_f, v_app, 'V2Fwd Creator', 'v2fwd1', 'ready', 'vector')
  RETURNING id INTO v_creator;

  INSERT INTO public.sessions (id, user_id, creator_id, model_used, tier_at_session, status, tts_provider_at_session)
  VALUES (gen_random_uuid(), v_user_f, v_creator, 'gemini_3_1_flash_live_preview', 'free', 'starting', 'fish')
  RETURNING id INTO v_session_f;

  INSERT INTO public.sessions (id, user_id, creator_id, model_used, tier_at_session, status, tts_provider_at_session)
  VALUES (gen_random_uuid(), v_user_c, v_creator, 'gemini_3_1_flash_live_preview', 'free', 'starting', 'cartesia')
  RETURNING id INTO v_session_c;

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- 1: v2 with fish args lands the 4 legs.
  PERFORM public.cogs_insert_turn_voice_v2(
    v_user_f, v_session_f, 1,
    1.0::numeric, 0.0001::numeric,
    100::int, 0.0001::numeric,
    'fish'::public.cogs_service,
    'fish'::public.tts_provider,
    200::int, 0.003::numeric, 6.0::numeric,
    'production'::text,
    '{}'::jsonb
  );
  SELECT count(*) INTO v_rows
    FROM public.cogs_log
   WHERE session_id = v_session_f AND turn_number = 1;
  RETURN NEXT ok(
    v_rows = 4
      AND EXISTS (SELECT 1 FROM public.cogs_log
                    WHERE session_id = v_session_f AND turn_number = 1
                      AND service = 'fish' AND operation = 'voice_tts_characters'),
    '1: v2(fish) forwards to v3 → 4 rows with service=fish on TTS legs'
  );

  -- 2: v2 with cartesia args (regression — pre-existing pipeline).
  PERFORM public.cogs_insert_turn_voice_v2(
    v_user_c, v_session_c, 1,
    1.0::numeric, 0.0001::numeric,
    100::int, 0.0001::numeric,
    'cartesia'::public.cogs_service,
    'cartesia'::public.tts_provider,
    200::int, 0.005::numeric, 6.0::numeric,
    'production'::text,
    '{}'::jsonb
  );
  SELECT count(*) INTO v_rows
    FROM public.cogs_log
   WHERE session_id = v_session_c AND turn_number = 1;
  RETURN NEXT ok(
    v_rows = 4
      AND EXISTS (SELECT 1 FROM public.cogs_log
                    WHERE session_id = v_session_c AND turn_number = 1
                      AND service = 'cartesia' AND operation = 'voice_tts_characters'),
    '2: v2(cartesia) still works → no regression in pre-existing path'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
