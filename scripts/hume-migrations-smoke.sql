-- Smoke tests for the 4 Hume migrations (20260520000001-004).
-- Run as service_role against the local DB. Each test is wrapped in a
-- savepoint so a failure of one test doesn't break the others.
-- Verifies enum additions, paired-CHECK, composite PK, RPC dispatch, and
-- v1 forwarding shim.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- FIXTURE SETUP — minimal user + admin + creator for tests 3+
-- All rolled back at end of script.
-- ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_user_id    uuid := '11111111-1111-1111-1111-111111111111';
  v_creator_id uuid := '22222222-2222-2222-2222-222222222222';
  v_session_id uuid := '33333333-3333-3333-3333-333333333333';
BEGIN
  -- auth.users requires email, encrypted_password, etc. Use minimal valid row.
  INSERT INTO auth.users (id, email, raw_user_meta_data, aud, role, instance_id, created_at, updated_at)
  VALUES (v_user_id, 'smoke-test@oakleague.local', '{}'::jsonb, 'authenticated', 'authenticated',
          '00000000-0000-0000-0000-000000000000', now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, tier, email)
  VALUES (v_user_id, 'free', 'smoke-test@oakleague.local')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.admin_roles (user_id, email, role)
  VALUES (v_user_id, 'smoke-test@oakleague.local', 'superadmin')
  ON CONFLICT (user_id) DO NOTHING;

  -- handle CHECK: 3-30 chars, lowercase alphanumeric + underscore only
  INSERT INTO public.creators (id, user_id, creator_type, display_name, handle)
  VALUES (v_creator_id, v_user_id, 'human', 'Smoke Test', 'smoke_test_' || substr(md5(random()::text),1,6))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.sessions (id, user_id, creator_id, model_used, tier_at_session, status, ended_at)
  VALUES (v_session_id, v_user_id, v_creator_id, 'gemini_3_1_flash_live_preview', 'free', 'ended', now())
  ON CONFLICT (id) DO NOTHING;

  RAISE NOTICE '🔧 fixture: user=%, creator=%, session=% ready', v_user_id, v_creator_id, v_session_id;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 1: cogs_service enum has 'hume'
-- ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  PERFORM 'hume'::cogs_service;  -- raises if missing
  RAISE NOTICE '✅ TEST 1: cogs_service includes hume';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '❌ TEST 1: cogs_service missing hume — %', SQLERRM;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 2: tts_provider enum has cartesia + hume
-- ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  PERFORM 'cartesia'::tts_provider;
  PERFORM 'hume'::tts_provider;
  RAISE NOTICE '✅ TEST 2: tts_provider enum complete';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '❌ TEST 2: tts_provider enum broken — %', SQLERRM;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 3: creators paired-CHECK rejects unpaired hume_voice_id
-- ─────────────────────────────────────────────────────────────────────
-- Create a throwaway creator for testing
SAVEPOINT t3;
DO $$
DECLARE v_creator_id uuid;
BEGIN
  -- Pick any existing creator OR insert a test one
  SELECT id INTO v_creator_id FROM public.creators LIMIT 1;
  IF v_creator_id IS NULL THEN
    RAISE NOTICE '⏭️  TEST 3: skipping (no creators in DB to test against)';
    RETURN;
  END IF;

  -- Try to set hume_voice_id WITHOUT hume_voice_name → should fail paired-CHECK
  BEGIN
    UPDATE public.creators
       SET hume_voice_id = 'test-id-without-name'
     WHERE id = v_creator_id;
    RAISE NOTICE '❌ TEST 3: paired-CHECK did NOT fire (UPDATE accepted)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '✅ TEST 3: paired-CHECK fired on unpaired id — %', SQLERRM;
  END;
END $$;
ROLLBACK TO SAVEPOINT t3;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 4: creators paired-CHECK ACCEPTS atomic id+name write
-- ─────────────────────────────────────────────────────────────────────
SAVEPOINT t4;
DO $$
DECLARE v_creator_id uuid;
BEGIN
  SELECT id INTO v_creator_id FROM public.creators LIMIT 1;
  IF v_creator_id IS NULL THEN
    RAISE NOTICE '⏭️  TEST 4: skipping (no creators)';
    RETURN;
  END IF;
  UPDATE public.creators
     SET hume_voice_id   = 'test-id',
         hume_voice_name = 'test name'
   WHERE id = v_creator_id;
  RAISE NOTICE '✅ TEST 4: atomic id+name UPDATE accepted';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '❌ TEST 4: atomic id+name UPDATE rejected — %', SQLERRM;
END $$;
ROLLBACK TO SAVEPOINT t4;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 5: hume_tts_speed CHECK [0.5, 2.0] (Hume's own range)
-- ─────────────────────────────────────────────────────────────────────
-- Audit C3 + founder call (2026-05-13): widened from [0.85, 1.10] to
-- match Hume's documented + dashboard-exposed range. 1.5 must be accepted
-- (founder tested + verified). 2.1 must still be rejected (outside Hume's
-- supported range).
SAVEPOINT t5;
DO $$
DECLARE v_creator_id uuid;
BEGIN
  SELECT id INTO v_creator_id FROM public.creators LIMIT 1;
  IF v_creator_id IS NULL THEN
    RAISE NOTICE '⏭️  TEST 5: skipping (no creators)';
    RETURN;
  END IF;
  BEGIN
    UPDATE public.creators SET hume_tts_speed = 1.5 WHERE id = v_creator_id;
    RAISE NOTICE '✅ TEST 5a: speed=1.5 accepted (founder-tested config)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '❌ TEST 5a: speed=1.5 rejected — CHECK is wrong (must allow founder-tested 1.5)';
  END;
  BEGIN
    UPDATE public.creators SET hume_tts_speed = 0.5 WHERE id = v_creator_id;
    RAISE NOTICE '✅ TEST 5b: speed=0.5 accepted (lower bound of Hume range)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '❌ TEST 5b: speed=0.5 rejected — must allow';
  END;
  BEGIN
    UPDATE public.creators SET hume_tts_speed = 2.0 WHERE id = v_creator_id;
    RAISE NOTICE '✅ TEST 5c: speed=2.0 accepted (upper bound of Hume range)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '❌ TEST 5c: speed=2.0 rejected — must allow';
  END;
  BEGIN
    UPDATE public.creators SET hume_tts_speed = 2.1 WHERE id = v_creator_id;
    RAISE NOTICE '❌ TEST 5d: speed=2.1 was accepted (outside Hume range — should reject)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '✅ TEST 5d: speed=2.1 rejected (outside Hume range)';
  END;
END $$;
ROLLBACK TO SAVEPOINT t5;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 5e: hume_trailing_silence CHECK [0, 5] with DEFAULT 0.3
-- ─────────────────────────────────────────────────────────────────────
SAVEPOINT t5e;
DO $$
DECLARE v_creator_id uuid; v_default numeric;
BEGIN
  SELECT id INTO v_creator_id FROM public.creators LIMIT 1;
  IF v_creator_id IS NULL THEN RAISE NOTICE '⏭️  TEST 5e: skipping'; RETURN; END IF;
  SELECT hume_trailing_silence INTO v_default FROM public.creators WHERE id = v_creator_id;
  IF v_default = 0.3 THEN
    RAISE NOTICE '✅ TEST 5e-default: hume_trailing_silence DEFAULT 0.3 applied';
  ELSE
    RAISE NOTICE '❌ TEST 5e-default: expected 0.3 got %', v_default;
  END IF;
  BEGIN
    UPDATE public.creators SET hume_trailing_silence = 5.1 WHERE id = v_creator_id;
    RAISE NOTICE '❌ TEST 5e: silence=5.1 accepted (out of range)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '✅ TEST 5e: silence=5.1 rejected (>5)';
  END;
  BEGIN
    UPDATE public.creators SET hume_trailing_silence = -0.1 WHERE id = v_creator_id;
    RAISE NOTICE '❌ TEST 5e: silence=-0.1 accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '✅ TEST 5e: silence=-0.1 rejected (<0)';
  END;
END $$;
ROLLBACK TO SAVEPOINT t5e;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 5f: hume_model_version CHECK + DEFAULT '2' (Octave 2)
-- ─────────────────────────────────────────────────────────────────────
SAVEPOINT t5f;
DO $$
DECLARE v_creator_id uuid; v_model text;
BEGIN
  SELECT id INTO v_creator_id FROM public.creators LIMIT 1;
  IF v_creator_id IS NULL THEN RAISE NOTICE '⏭️  TEST 5f: skipping'; RETURN; END IF;
  SELECT hume_model_version INTO v_model FROM public.creators WHERE id = v_creator_id;
  IF v_model = '2' THEN
    RAISE NOTICE '✅ TEST 5f-default: hume_model_version DEFAULT ''2'' applied (Octave 2)';
  ELSE
    RAISE NOTICE '❌ TEST 5f-default: expected ''2'' got %', v_model;
  END IF;
  BEGIN
    UPDATE public.creators SET hume_model_version = '3' WHERE id = v_creator_id;
    RAISE NOTICE '❌ TEST 5f: ''3'' accepted (not in enum)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '✅ TEST 5f: ''3'' rejected (not in (1|2|default))';
  END;
  BEGIN
    UPDATE public.creators SET hume_model_version = '1' WHERE id = v_creator_id;
    RAISE NOTICE '✅ TEST 5f: ''1'' accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '❌ TEST 5f: ''1'' rejected — must allow for acting-direction fallback';
  END;
END $$;
ROLLBACK TO SAVEPOINT t5f;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 5g: hume_voice_description CHECK length ≤ 1000
-- ─────────────────────────────────────────────────────────────────────
SAVEPOINT t5g;
DO $$
DECLARE v_creator_id uuid;
BEGIN
  SELECT id INTO v_creator_id FROM public.creators LIMIT 1;
  IF v_creator_id IS NULL THEN RAISE NOTICE '⏭️  TEST 5g: skipping'; RETURN; END IF;
  BEGIN
    UPDATE public.creators SET hume_voice_description = repeat('x', 1001) WHERE id = v_creator_id;
    RAISE NOTICE '❌ TEST 5g: 1001-char description accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '✅ TEST 5g: 1001-char description rejected (>1000)';
  END;
  BEGIN
    UPDATE public.creators SET hume_voice_description = 'warm, conversational, leaning forward' WHERE id = v_creator_id;
    RAISE NOTICE '✅ TEST 5g: typical-length description accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '❌ TEST 5g: typical description rejected unexpectedly';
  END;
END $$;
ROLLBACK TO SAVEPOINT t5g;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 6: voice_delete_queue composite PK
-- ─────────────────────────────────────────────────────────────────────
-- Same voice_id under different providers should coexist (composite PK
-- design intent).
SAVEPOINT t6;
DO $$
DECLARE v_admin uuid;
BEGIN
  -- Need a real admin uuid for the FK; pick any admin role
  SELECT user_id INTO v_admin FROM public.admin_roles WHERE revoked_at IS NULL LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE NOTICE '⏭️  TEST 6: skipping (no admin in DB)';
    RETURN;
  END IF;

  INSERT INTO public.voice_delete_queue (tts_provider, voice_id, voice_name, enqueued_by, due_at)
  VALUES ('cartesia', 'collision-test-id', NULL, v_admin, now() + interval '60 seconds');
  INSERT INTO public.voice_delete_queue (tts_provider, voice_id, voice_name, enqueued_by, due_at)
  VALUES ('hume',     'collision-test-id', 'collision test', v_admin, now() + interval '60 seconds');

  RAISE NOTICE '✅ TEST 6: same voice_id under cartesia+hume coexists (composite PK works)';
END $$;
ROLLBACK TO SAVEPOINT t6;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 7: cogs_insert_turn_voice_v2 — happy path for hume
-- ─────────────────────────────────────────────────────────────────────
SAVEPOINT t7;
DO $$
DECLARE
  v_user    uuid := '11111111-1111-1111-1111-111111111111';
  v_session uuid := '33333333-3333-3333-3333-333333333333';
BEGIN

  -- Service-role caller bypasses auth.uid() check
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  PERFORM public.cogs_insert_turn_voice_v2(
    v_user, v_session, 1,
    1.5,      -- gemini_audio_in_seconds
    0.000125, -- gemini_audio_in_cost
    100,      -- gemini_audio_out_tokens
    0.0012,   -- gemini_audio_out_cost
    'hume'::cogs_service,
    'hume'::tts_provider,
    200,      -- tts_characters
    0.00152,  -- tts_cost (200 chars × $7.60/1M)
    3.5,      -- tts_audio_seconds
    'dev',
    '{}'::jsonb
  );

  -- Verify 4 rows landed with correct service column
  IF (SELECT count(*) FROM public.cogs_log WHERE session_id = v_session AND service = 'hume') = 2
     AND (SELECT count(*) FROM public.cogs_log WHERE session_id = v_session AND service = 'gemini') = 2
  THEN
    RAISE NOTICE '✅ TEST 7: cogs_insert_turn_voice_v2 hume — 2 gemini legs + 2 hume legs';
  ELSE
    RAISE NOTICE '❌ TEST 7: row count wrong — %', (SELECT json_object_agg(service, c) FROM (SELECT service, count(*) c FROM public.cogs_log WHERE session_id = v_session GROUP BY service) s);
  END IF;
END $$;
ROLLBACK TO SAVEPOINT t7;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 8: cogs_insert_turn_voice_v2 — service/provider mismatch rejected
-- ─────────────────────────────────────────────────────────────────────
SAVEPOINT t8;
DO $$
DECLARE v_user uuid;
BEGIN
  SELECT id INTO v_user FROM auth.users LIMIT 1;
  IF v_user IS NULL THEN
    RAISE NOTICE '⏭️  TEST 8: skipping';
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  BEGIN
    PERFORM public.cogs_insert_turn_voice_v2(
      v_user, gen_random_uuid(), 1,
      0, 0, 0, 0,
      'hume'::cogs_service, 'cartesia'::tts_provider,  -- MISMATCH
      0, 0, 0, 'dev', '{}'::jsonb
    );
    RAISE NOTICE '❌ TEST 8: mismatch was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%must match%' THEN
      RAISE NOTICE '✅ TEST 8: service/provider mismatch rejected';
    ELSE
      RAISE NOTICE '❌ TEST 8: rejected with WRONG error — %', SQLERRM;
    END IF;
  END;
END $$;
ROLLBACK TO SAVEPOINT t8;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 9: cogs_insert_turn_voice (v1) forwarding shim writes cartesia rows
-- ─────────────────────────────────────────────────────────────────────
SAVEPOINT t9;
DO $$
DECLARE
  v_user    uuid := '11111111-1111-1111-1111-111111111111';
  v_session uuid := '33333333-3333-3333-3333-333333333333';
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  PERFORM public.cogs_insert_turn_voice(
    v_user, v_session, 2,  -- turn 2 (test 7 used turn 1; idempotency would reject duplicates)
    1.0, 0.0001, 50, 0.0006, 100, 0.005, 2.0, 'dev', '{}'::jsonb
  );

  IF (SELECT count(*) FROM public.cogs_log WHERE session_id = v_session AND turn_number = 2 AND service = 'cartesia') = 2
  THEN
    RAISE NOTICE '✅ TEST 9: v1 shim wrote 2 cartesia legs (legs 3+4 via v2 default)';
  ELSE
    RAISE NOTICE '❌ TEST 9: v1 shim row count wrong';
  END IF;
END $$;
ROLLBACK TO SAVEPOINT t9;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 10: voice_clone_finalize_locked_v2 hume — name required
-- ─────────────────────────────────────────────────────────────────────
SAVEPOINT t10;
DO $$
DECLARE v_admin uuid;
BEGIN
  SELECT user_id INTO v_admin FROM public.admin_roles WHERE revoked_at IS NULL LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE NOTICE '⏭️  TEST 10: skipping (no admin)';
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  BEGIN
    PERFORM public.voice_clone_finalize_locked_v2(
      v_admin, 1, gen_random_uuid(),
      'hume'::tts_provider,
      'test-voice-id',
      NULL,  -- missing name for hume → should raise
      false
    );
    RAISE NOTICE '❌ TEST 10: NULL voice_name was accepted for hume';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%hume_voice_name_required%' THEN
      RAISE NOTICE '✅ TEST 10: hume + NULL voice_name rejected with correct error';
    ELSE
      RAISE NOTICE '⚠️ TEST 10: rejected but with different error — %', SQLERRM;
    END IF;
  END;
END $$;
ROLLBACK TO SAVEPOINT t10;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 11: v1 voice_clone_finalize_locked shim still callable
-- ─────────────────────────────────────────────────────────────────────
SAVEPOINT t11;
DO $$
DECLARE v_admin uuid;
BEGIN
  SELECT user_id INTO v_admin FROM public.admin_roles WHERE revoked_at IS NULL LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE NOTICE '⏭️  TEST 11: skipping (no admin)';
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  BEGIN
    -- Will raise "upload not found" (23503) because the upload_id is fake;
    -- that's the expected error. We're testing the function is CALLABLE,
    -- not that it succeeds.
    PERFORM public.voice_clone_finalize_locked(
      v_admin, 999999, gen_random_uuid(),
      'test-voice-id', false
    );
    RAISE NOTICE '⚠️ TEST 11: v1 shim returned without error (unexpected — fake upload_id should have raised 23503)';
  EXCEPTION
    WHEN sqlstate '23503' THEN
      RAISE NOTICE '✅ TEST 11: v1 shim callable + dispatches to v2 (got expected upload-not-found)';
    WHEN OTHERS THEN
      RAISE NOTICE '❌ TEST 11: v1 shim failed with unexpected error — %, %', SQLSTATE, SQLERRM;
  END;
END $$;
ROLLBACK TO SAVEPOINT t11;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 12: voice_delete_queue_claim_v2 callable + returns tts_provider
-- ─────────────────────────────────────────────────────────────────────
SAVEPOINT t12;
DO $$
DECLARE
  v_count int;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  SELECT count(*) INTO v_count FROM public.voice_delete_queue_claim_v2(5);
  RAISE NOTICE '✅ TEST 12: voice_delete_queue_claim_v2 returned (claimed=%)', v_count;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '❌ TEST 12: claim_v2 failed — %', SQLERRM;
END $$;
ROLLBACK TO SAVEPOINT t12;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 13: voice_delete_queue CHECK (hume → voice_name NOT NULL) — Audit M3
-- ─────────────────────────────────────────────────────────────────────
SAVEPOINT t13;
DO $$
DECLARE v_admin uuid;
BEGIN
  SELECT user_id INTO v_admin FROM public.admin_roles WHERE revoked_at IS NULL LIMIT 1;
  IF v_admin IS NULL THEN RAISE NOTICE '⏭️  TEST 13: skipping'; RETURN; END IF;
  -- Hume row WITHOUT voice_name must be rejected by the CHECK
  BEGIN
    INSERT INTO public.voice_delete_queue (tts_provider, voice_id, voice_name, enqueued_by, due_at)
    VALUES ('hume', 'm3-test-id', NULL, v_admin, now());
    RAISE NOTICE '❌ TEST 13: hume row with NULL voice_name accepted (worker would orphan it)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '✅ TEST 13: hume row with NULL voice_name rejected';
  END;
  -- Cartesia with NULL voice_name still works (Cartesia keys by id, not name)
  BEGIN
    INSERT INTO public.voice_delete_queue (tts_provider, voice_id, voice_name, enqueued_by, due_at)
    VALUES ('cartesia', 'm3-test-id-cartesia', NULL, v_admin, now());
    RAISE NOTICE '✅ TEST 13: cartesia row with NULL voice_name still accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '❌ TEST 13: cartesia row with NULL voice_name unexpectedly rejected';
  END;
END $$;
ROLLBACK TO SAVEPOINT t13;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 14: cogs_insert_turn_voice_v2 session-provider parity guard — Audit M2
-- ─────────────────────────────────────────────────────────────────────
-- The fixture session was opened with tts_provider_at_session=NULL (pre-
-- migration construction); to test the guard we INSERT a fresh session
-- with tts_provider_at_session='cartesia' then attempt to write hume cogs.
SAVEPOINT t14;
DO $$
DECLARE
  v_user        uuid := '11111111-1111-1111-1111-111111111111';
  v_creator_id  uuid := '22222222-2222-2222-2222-222222222222';
  v_session_id  uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  INSERT INTO public.sessions (id, user_id, creator_id, model_used, tier_at_session, tts_provider_at_session, status, ended_at)
  VALUES (v_session_id, v_user, v_creator_id, 'gemini_3_1_flash_live_preview', 'free', 'cartesia', 'ended', now());

  BEGIN
    PERFORM public.cogs_insert_turn_voice_v2(
      v_user, v_session_id, 1,
      0.5, 0.0001, 50, 0.0006,
      'hume'::cogs_service, 'hume'::tts_provider,  -- HUME against a CARTESIA session
      100, 0.0008, 2.0, 'dev', '{}'::jsonb
    );
    RAISE NOTICE '❌ TEST 14: hume call against cartesia session was accepted (parity guard failed)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%disagrees with sessions.tts_provider_at_session%' THEN
      RAISE NOTICE '✅ TEST 14: parity guard fired on provider mismatch with session row';
    ELSE
      RAISE NOTICE '⚠️ TEST 14: rejected but with different error — %', SQLERRM;
    END IF;
  END;
END $$;
ROLLBACK TO SAVEPOINT t14;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 15: SQLSTATE 22023 on data mismatch in voice_clone_finalize_locked_v2
-- ─────────────────────────────────────────────────────────────────────
-- Audit M1 fix: data mismatches return 22023 (invalid parameter), not
-- 42501 (privilege error which the route layer special-cases as "admin
-- not active"). To exercise the mismatch path, the admin must be valid
-- (passes admin_active check) but the creator_id arg differs from the
-- upload row's creator_id.
SAVEPOINT t15;
DO $$
DECLARE
  v_admin       uuid := '11111111-1111-1111-1111-111111111111';
  v_creator_id  uuid := '22222222-2222-2222-2222-222222222222';
  v_upload_id   bigint;
  v_state       text;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  INSERT INTO public.voice_clone_uploads
    (admin_user_id, creator_id, tts_provider, sha256, duration_seconds, mime, bytes, created_at)
  VALUES
    (v_admin, v_creator_id, 'cartesia',
     'deadbeef' || repeat('00',28), 30.0, 'audio/wav', 1000, now())
  RETURNING id INTO v_upload_id;

  BEGIN
    -- Valid admin, WRONG creator_id → triggers creator-mismatch branch
    -- which now raises 22023 (was 42501 before audit M1 fix).
    PERFORM public.voice_clone_finalize_locked_v2(
      v_admin,
      v_upload_id, gen_random_uuid(),  -- wrong creator
      'cartesia'::public.tts_provider,
      'test-vid', NULL, false
    );
    RAISE NOTICE '❌ TEST 15: creator-mismatch was accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF v_state = '22023' THEN
      RAISE NOTICE '✅ TEST 15: creator-mismatch raised 22023 (was 42501 before fix)';
    ELSE
      RAISE NOTICE '❌ TEST 15: creator-mismatch raised %, expected 22023', v_state;
    END IF;
  END;
END $$;
ROLLBACK TO SAVEPOINT t15;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 16: dependency guard in migration 0003 — Audit C6
-- ─────────────────────────────────────────────────────────────────────
-- Can only be tested INDIRECTLY: the function was created successfully,
-- which means the DO $$ ... $$ guard found both 'hume'::cogs_service and
-- 'cartesia'::tts_provider. Re-running the guard inline asserts the
-- preconditions still hold.
SAVEPOINT t16;
DO $$
BEGIN
  PERFORM 'hume'::public.cogs_service;
  PERFORM 'cartesia'::public.tts_provider;
  RAISE NOTICE '✅ TEST 16: migration 0003 dependency guard preconditions hold (hume + tts_provider exist)';
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE '❌ TEST 16: dependency guard would FAIL — %', SQLERRM;
END $$;
ROLLBACK TO SAVEPOINT t16;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 17: voice_tickets has Hume prosody columns (migration 0005)
-- ─────────────────────────────────────────────────────────────────────
SAVEPOINT t17;
DO $$
DECLARE v_col_count int;
BEGIN
  SELECT count(*) INTO v_col_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'voice_tickets'
     AND column_name IN ('hume_tts_speed', 'hume_trailing_silence', 'hume_voice_description', 'hume_model_version');
  IF v_col_count = 4 THEN
    RAISE NOTICE '✅ TEST 17: voice_tickets has all 4 Hume prosody columns (migration 0005)';
  ELSE
    RAISE NOTICE '❌ TEST 17: voice_tickets missing prosody columns (found %, expected 4)', v_col_count;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT t17;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 18: voice_tickets.tts_provider has DEFAULT 'cartesia' (audit M1 atomic fix)
-- ─────────────────────────────────────────────────────────────────────
-- Migration 0002 (post unit-wide M1 fix) makes ADD COLUMN ... NOT NULL
-- DEFAULT 'cartesia' atomic. Concurrent INSERTs during the migration
-- window can no longer hit the SET-NOT-NULL race.
SAVEPOINT t18;
DO $$
DECLARE v_default text;
BEGIN
  SELECT column_default INTO v_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'voice_tickets'
     AND column_name  = 'tts_provider';
  IF v_default LIKE '%cartesia%' THEN
    RAISE NOTICE '✅ TEST 18: voice_tickets.tts_provider DEFAULT cartesia present';
  ELSE
    RAISE NOTICE '⚠️ TEST 18: voice_tickets.tts_provider DEFAULT = %', v_default;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT t18;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 19: voice_clone_uploads + voice_delete_queue tts_provider DEFAULTs DROPPED (migration 0007)
-- ─────────────────────────────────────────────────────────────────────
-- §5.5 follow-up: after CI grep enforces explicit tts_provider on every
-- writer, the DEFAULT is dropped so omissions 23502 instead of mis-tag.
SAVEPOINT t19;
DO $$
DECLARE v_uploads_default text; v_queue_default text;
BEGIN
  SELECT column_default INTO v_uploads_default
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='voice_clone_uploads' AND column_name='tts_provider';
  SELECT column_default INTO v_queue_default
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='voice_delete_queue' AND column_name='tts_provider';
  IF v_uploads_default IS NULL AND v_queue_default IS NULL THEN
    RAISE NOTICE '✅ TEST 19: voice_clone_uploads + voice_delete_queue tts_provider DEFAULTs dropped (0007)';
  ELSE
    RAISE NOTICE '❌ TEST 19: DEFAULTs not dropped — uploads=%, queue=%', v_uploads_default, v_queue_default;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT t19;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 20: writer-missing-tts_provider now 23502 (DEFAULT dropped)
-- ─────────────────────────────────────────────────────────────────────
SAVEPOINT t20;
DO $$
DECLARE v_user uuid; v_creator uuid;
BEGIN
  SELECT id INTO v_user    FROM auth.users LIMIT 1;
  SELECT id INTO v_creator FROM public.creators LIMIT 1;
  IF v_user IS NULL OR v_creator IS NULL THEN RAISE NOTICE '⏭️  TEST 20: skipping'; RETURN; END IF;
  BEGIN
    INSERT INTO public.voice_clone_uploads (admin_user_id, creator_id, sha256, duration_seconds, mime, bytes)
    VALUES (v_user, v_creator, 'a' || repeat('b',63), 5.0, 'audio/wav', 1000);
    RAISE NOTICE '❌ TEST 20: voice_clone_uploads INSERT without tts_provider was accepted (DEFAULT not dropped?)';
  EXCEPTION WHEN not_null_violation THEN
    RAISE NOTICE '✅ TEST 20: voice_clone_uploads INSERT without tts_provider → 23502 (writer discipline enforced)';
  END;
END $$;
ROLLBACK TO SAVEPOINT t20;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 21: voice_delete_queue_purge_dead RPC
-- ─────────────────────────────────────────────────────────────────────
-- §5 audit C1 (2026-05-13): pg_cron invokes the job as DB owner (postgres)
-- with no JWT context. The RPC must accept (a) service_role JWT for manual
-- ops invocations AND (b) postgres/supabase_admin DB role for cron context.
-- The smoke test runs over psql AS postgres so the bypass fires regardless
-- of the simulated JWT — we test the postgres-bypass path here. The
-- JWT-rejection path (anon/authenticated) is exercised by route-level
-- integration tests against PostgREST.
SAVEPOINT t21;
DO $$
DECLARE v_deleted bigint; v_current_user text;
BEGIN
  SELECT current_user INTO v_current_user;
  IF v_current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE NOTICE '⏭️  TEST 21: skipping (current_user=% — bypass would not apply)', v_current_user;
    RETURN;
  END IF;
  -- With postgres bypass, no JWT context needed. Empty JSON object so
  -- the function's current_setting() cast doesn't error.
  PERFORM set_config('request.jwt.claims', '{}', true);
  SELECT public.voice_delete_queue_purge_dead() INTO v_deleted;
  RAISE NOTICE '✅ TEST 21: voice_delete_queue_purge_dead callable from postgres role without JWT (cron context simulation; purged=%)', v_deleted;
END $$;
ROLLBACK TO SAVEPOINT t21;

-- ─────────────────────────────────────────────────────────────────────
-- TEST 22: voice_delete_queue_purge_dead purges old + skips fresh
-- ─────────────────────────────────────────────────────────────────────
SAVEPOINT t22;
DO $$
DECLARE v_admin uuid; v_deleted bigint;
BEGIN
  SELECT user_id INTO v_admin FROM public.admin_roles WHERE revoked_at IS NULL LIMIT 1;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- Old + maxed: should purge
  INSERT INTO public.voice_delete_queue (tts_provider, voice_id, voice_name, attempts, enqueued_by, due_at, updated_at)
  VALUES ('cartesia', 'old-maxed-1', NULL, 10, v_admin, now() - interval '60 days', now() - interval '60 days');
  -- Old but not maxed: should NOT purge
  INSERT INTO public.voice_delete_queue (tts_provider, voice_id, voice_name, attempts, enqueued_by, due_at, updated_at)
  VALUES ('cartesia', 'old-not-maxed', NULL, 5, v_admin, now() - interval '60 days', now() - interval '60 days');
  -- Fresh + maxed: should NOT purge (only 30-day-old maxed rows)
  INSERT INTO public.voice_delete_queue (tts_provider, voice_id, voice_name, attempts, enqueued_by, due_at, updated_at)
  VALUES ('cartesia', 'fresh-maxed', NULL, 10, v_admin, now(), now());

  SELECT public.voice_delete_queue_purge_dead() INTO v_deleted;

  IF v_deleted = 1 AND
     NOT EXISTS (SELECT 1 FROM public.voice_delete_queue WHERE voice_id = 'old-maxed-1') AND
     EXISTS (SELECT 1 FROM public.voice_delete_queue WHERE voice_id = 'old-not-maxed') AND
     EXISTS (SELECT 1 FROM public.voice_delete_queue WHERE voice_id = 'fresh-maxed') THEN
    RAISE NOTICE '✅ TEST 22: purge_dead deletes ONLY old-maxed rows (purged 1, kept old-not-maxed + fresh-maxed)';
  ELSE
    RAISE NOTICE '❌ TEST 22: purge_dead wrong row selection (deleted=%)', v_deleted;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT t22;

ROLLBACK;
