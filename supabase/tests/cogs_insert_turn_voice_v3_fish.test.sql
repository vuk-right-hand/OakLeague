-- FISH_AUDIO_PHASE_1 §6 — cogs_insert_turn_voice_v3 with fish provider.
--
-- Covers the v3 RPC's fish-specific behavior + invariant guards inherited
-- from v2:
--   1. v3 happy path: 4 cogs_log legs land with service='fish' on legs 3+4,
--      service='gemini' on legs 1+2; metadata.tts_provider='fish' on all four.
--   2. p_tts_service / p_tts_provider mismatch → 22023.
--   3. p_tts_service NOT IN ('cartesia','hume','fish') → 22023.
--      NOTE (M3 audit M4): this check is structurally unreachable today —
--      every valid (service, provider) pair where service is in cogs_service
--      but provider is in tts_provider necessarily satisfies the
--      service↔provider mismatch check FIRST. The whitelist remains in
--      place as defense-in-depth against a future enum widening on either
--      side. Test asserts only the 22023 errcode, accepting that the
--      mismatch-check is what fires here.
--   4. p_tts_provider disagrees with sessions.tts_provider_at_session → 22023.
--   5. invalid environment → 22023.
--   6. tts_characters over 100000 cap → 22003.
--   7. idempotency: same (session, turn) re-call → still 4 rows.
--   8. NULL sessions.tts_provider_at_session → 22023 (M3 audit M6 fix —
--      closes the v2 "= cartesia by construction" escape hatch that no
--      longer holds post-Hume / post-Fish).

BEGIN;
SELECT plan(8);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user        uuid := tests.create_auth_user('fishvoice@test');
  v_user_null   uuid := tests.create_auth_user('fishnull@test');
  v_creator     uuid;
  v_session     uuid;
  v_session_null uuid;
  v_app         uuid;
  v_rows        int;
  v_meta        jsonb;
BEGIN
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
  VALUES (gen_random_uuid(), v_user, 'approved', 'Fish Creator', 'fishcreator1', '[]'::jsonb, '{}'::jsonb)
  RETURNING id INTO v_app;

  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, brain_mode, tts_provider)
  VALUES (gen_random_uuid(), v_user, v_app, 'Fish Creator', 'fishcreator1', 'ready', 'vector', 'fish')
  RETURNING id INTO v_creator;

  INSERT INTO public.sessions (id, user_id, creator_id, model_used, tier_at_session, status, tts_provider_at_session)
  VALUES (gen_random_uuid(), v_user, v_creator, 'gemini_3_1_flash_live_preview', 'free', 'starting', 'fish')
  RETURNING id INTO v_session;

  -- Simulate the proxy's service-role JWT (the guard checks the CLAIM, not the DB role).
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- 1: happy path with fish.
  PERFORM public.cogs_insert_turn_voice_v3(
    v_user, v_session, 1,
    1.5::numeric, 0.0001::numeric,            -- leg 1: gemini audio-in seconds + cost
    900::int, 0.0008::numeric,                 -- leg 2: gemini audio-out tokens + cost
    'fish'::public.cogs_service,
    'fish'::public.tts_provider,
    200::int, 0.003::numeric, 6.5::numeric,    -- legs 3+4: tts chars/cost/audio_seconds
    'production'::text,
    '{}'::jsonb
  );
  SELECT count(*) INTO v_rows
    FROM public.cogs_log
   WHERE session_id = v_session AND turn_number = 1;
  RETURN NEXT ok(
    v_rows = 4
      AND EXISTS (SELECT 1 FROM public.cogs_log
                    WHERE session_id = v_session AND turn_number = 1
                      AND service = 'fish' AND operation = 'voice_tts_characters')
      AND EXISTS (SELECT 1 FROM public.cogs_log
                    WHERE session_id = v_session AND turn_number = 1
                      AND service = 'fish' AND operation = 'voice_tts_audio_seconds')
      AND EXISTS (SELECT 1 FROM public.cogs_log
                    WHERE session_id = v_session AND turn_number = 1
                      AND service = 'gemini' AND operation = 'voice_audio_input_seconds')
      AND EXISTS (SELECT 1 FROM public.cogs_log
                    WHERE session_id = v_session AND turn_number = 1
                      AND service = 'gemini' AND operation = 'voice_audio_out_tokens')
      AND (SELECT bool_and((metadata ->> 'tts_provider') = 'fish')
             FROM public.cogs_log WHERE session_id = v_session AND turn_number = 1),
    '1: v3+fish → 4 rows (2 gemini + 2 fish), metadata.tts_provider=fish on all'
  );

  -- 2: p_tts_service vs p_tts_provider mismatch.
  BEGIN
    PERFORM public.cogs_insert_turn_voice_v3(
      v_user, v_session, 2,
      1::numeric, 0.0001::numeric,
      100::int, 0.0001::numeric,
      'fish'::public.cogs_service,
      'cartesia'::public.tts_provider,
      100::int, 0.001::numeric, 2::numeric,
      'production'::text,
      '{}'::jsonb
    );
    RETURN NEXT fail('2: mismatched service/provider should have raised 22023');
  EXCEPTION
    WHEN SQLSTATE '22023' THEN RETURN NEXT pass('2: service/provider mismatch → 22023');
    WHEN OTHERS THEN RETURN NEXT fail('2: expected 22023, got ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- 3: p_tts_service not in the allowed set ('gemini' is in the cogs_service
  -- enum but not in the cartesia|hume|fish whitelist).
  BEGIN
    PERFORM public.cogs_insert_turn_voice_v3(
      v_user, v_session, 3,
      1::numeric, 0.0001::numeric,
      100::int, 0.0001::numeric,
      'gemini'::public.cogs_service,
      'fish'::public.tts_provider,    -- service vs provider also mismatches; checked SECOND in v3
      100::int, 0.001::numeric, 2::numeric,
      'production'::text,
      '{}'::jsonb
    );
    RETURN NEXT fail('3: gemini service should have raised 22023');
  EXCEPTION
    WHEN SQLSTATE '22023' THEN RETURN NEXT pass('3: service NOT IN whitelist → 22023');
    WHEN OTHERS THEN RETURN NEXT fail('3: expected 22023, got ' || SQLSTATE);
  END;

  -- 4: p_tts_provider disagrees with sessions snapshot (session is 'fish'; call says 'hume').
  BEGIN
    PERFORM public.cogs_insert_turn_voice_v3(
      v_user, v_session, 4,
      1::numeric, 0.0001::numeric,
      100::int, 0.0001::numeric,
      'hume'::public.cogs_service,
      'hume'::public.tts_provider,
      100::int, 0.001::numeric, 2::numeric,
      'production'::text,
      '{}'::jsonb
    );
    RETURN NEXT fail('4: provider mismatch with session snapshot should have raised 22023');
  EXCEPTION
    WHEN SQLSTATE '22023' THEN RETURN NEXT pass('4: provider disagrees with sessions.tts_provider_at_session → 22023');
    WHEN OTHERS THEN RETURN NEXT fail('4: expected 22023, got ' || SQLSTATE);
  END;

  -- 5: invalid environment.
  BEGIN
    PERFORM public.cogs_insert_turn_voice_v3(
      v_user, v_session, 5,
      1::numeric, 0.0001::numeric,
      100::int, 0.0001::numeric,
      'fish'::public.cogs_service,
      'fish'::public.tts_provider,
      100::int, 0.001::numeric, 2::numeric,
      'staging'::text,
      '{}'::jsonb
    );
    RETURN NEXT fail('5: env=staging should have raised 22023');
  EXCEPTION
    WHEN SQLSTATE '22023' THEN RETURN NEXT pass('5: invalid environment → 22023');
    WHEN OTHERS THEN RETURN NEXT fail('5: expected 22023, got ' || SQLSTATE);
  END;

  -- 6: tts_characters over 100000.
  BEGIN
    PERFORM public.cogs_insert_turn_voice_v3(
      v_user, v_session, 6,
      1::numeric, 0.0001::numeric,
      100::int, 0.0001::numeric,
      'fish'::public.cogs_service,
      'fish'::public.tts_provider,
      150000::int, 0.001::numeric, 2::numeric,
      'production'::text,
      '{}'::jsonb
    );
    RETURN NEXT fail('6: tts_characters=150000 should have raised 22003');
  EXCEPTION
    WHEN SQLSTATE '22003' THEN RETURN NEXT pass('6: tts_characters > 100000 cap → 22003');
    WHEN OTHERS THEN RETURN NEXT fail('6: expected 22003, got ' || SQLSTATE);
  END;

  -- 7: idempotency — same (session, turn) → still exactly 4 rows.
  PERFORM public.cogs_insert_turn_voice_v3(
    v_user, v_session, 1,
    99::numeric, 9::numeric,    -- bigger numbers; should NOT land
    9999::int, 9::numeric,
    'fish'::public.cogs_service,
    'fish'::public.tts_provider,
    9999::int, 9::numeric, 99::numeric,
    'production'::text,
    '{}'::jsonb
  );
  SELECT count(*) INTO v_rows
    FROM public.cogs_log
   WHERE session_id = v_session AND turn_number = 1;
  RETURN NEXT ok(v_rows = 4, '7: idempotent — same (session,turn) re-call → still 4 rows, no double-bill');

  -- 8: NULL tts_provider_at_session → 22023 (M3 audit M6).
  -- v2 used to skip the snapshot check if the column was NULL ("= cartesia
  -- by construction"). v3 closes this — a session without a snapshot
  -- cannot bill voice cogs at all. Prevents the silent cross-provider
  -- double-bill the M5+M6 audit findings flagged.
  -- v_user_null is a SEPARATE user from v_user so sessions_one_active_per_user
  -- doesn't reject this insert (round 2 S4 — explicit note).
  BEGIN
    INSERT INTO public.sessions (id, user_id, creator_id, model_used, tier_at_session, status, tts_provider_at_session)
    VALUES (gen_random_uuid(), v_user_null, v_creator, 'gemini_3_1_flash_live_preview', 'free', 'starting', NULL)
    RETURNING id INTO v_session_null;
  EXCEPTION WHEN OTHERS THEN
    -- Round 2 M6: surface setup failures as a readable diagnostic rather
    -- than a plan-count mismatch later.
    RETURN NEXT fail('8: test 8 setup INSERT failed — ' || SQLSTATE || ' ' || SQLERRM);
    RETURN;
  END;
  BEGIN
    PERFORM public.cogs_insert_turn_voice_v3(
      v_user_null, v_session_null, 1,
      1::numeric, 0.0001::numeric,
      100::int, 0.0001::numeric,
      'fish'::public.cogs_service,
      'fish'::public.tts_provider,
      100::int, 0.001::numeric, 2::numeric,
      'production'::text,
      '{}'::jsonb
    );
    RETURN NEXT fail('8: NULL session snapshot should have raised 22023');
  EXCEPTION
    WHEN SQLSTATE '22023' THEN RETURN NEXT pass('8: NULL sessions.tts_provider_at_session → 22023 (M6 fail-loud)');
    WHEN OTHERS THEN RETURN NEXT fail('8: expected 22023, got ' || SQLSTATE || ' ' || SQLERRM);
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
