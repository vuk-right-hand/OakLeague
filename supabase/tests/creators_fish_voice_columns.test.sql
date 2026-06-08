-- FISH_AUDIO_PHASE_1 §6 wire-up gap M5 — Fish voice column shape +
-- append-only trigger extension regression suite +
-- defensive fish raise on voice_clone_finalize_locked_v2.
--
-- Covers (migration 20260608100005_creators_fish_voice_columns.sql):
--   1.  creators.fish_voice_id columns exist (production / preview / dev).
--   2.  CHECK length: empty string rejected.
--   3.  CHECK length: > 128 char rejected.
--   4.  CHECK charset: rejects path-shaped value (e.g. 'models/abc').
--   5.  voice_clone_uploads.fish_voice_id exists with CHECK.
--   6.  Trigger allows fish_voice_id NULL → non-NULL on fish-provider row.
--   7.  Trigger blocks fish_voice_id non-NULL → NULL (reverse) on fish row.
--   8.  Trigger blocks fish_voice_id non-NULL → different-non-NULL on fish row.
--   9.  Regression: trigger still allows cartesia_voice_id NULL → non-NULL on cartesia row.
--   10. Regression: trigger still allows hume paired (id + name) NULL → non-NULL on hume row.
--   11. C3 tightening: cartesia row attempting fish_voice_id fill → 42501.
--   12. C3 tightening: cartesia row attempting hume_voice_id + hume_voice_name fill → 42501.
--   13. C3 tightening: hume row attempting cartesia_voice_id fill → 42501.
--   14. C3 tightening: hume row attempting fish_voice_id fill → 42501.
--   15. C3 tightening: fish row attempting cartesia_voice_id fill → 42501.
--   16. C3 tightening: fish row attempting hume_voice_id + hume_voice_name fill → 42501.
--   17. Regression: tts_provider IMMUTABLE after insert.
--   18. C1: voice_clone_finalize_locked_v2 with p_tts_provider='fish' raises
--       0A000 fish_finalize_not_implemented.

BEGIN;
SELECT plan(18);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_creator_user uuid := tests.create_auth_user('fishvoicecreator@test');
  v_admin_user   uuid := tests.create_auth_user('fishvoiceadmin@test');
  v_app          uuid;
  v_creator      uuid;
  v_upload_fish  bigint;
  v_upload_cart  bigint;
  v_upload_hume  bigint;
  v_count        int;
  v_fish_id      text;
BEGIN
  -- ── 1: creators columns exist ──────────────────────────────────────
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'creators'
     AND column_name IN ('fish_voice_id', 'fish_voice_id_preview', 'fish_voice_id_dev');
  RETURN NEXT ok(v_count = 3, '1: creators has fish_voice_id / _preview / _dev (3 columns)');

  -- Fixtures: creator + 3 voice_clone_uploads rows (one per provider).
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
  VALUES (gen_random_uuid(), v_creator_user, 'approved', 'Fish Voice Creator', 'fishvoice1', '[]'::jsonb, '{}'::jsonb)
  RETURNING id INTO v_app;

  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, brain_mode)
  VALUES (gen_random_uuid(), v_creator_user, v_app, 'Fish Voice Creator', 'fishvoice1', 'ready', 'vector')
  RETURNING id INTO v_creator;

  -- Admin role required for the finalize RPC test (#18).
  INSERT INTO public.admin_roles (user_id, role)
  VALUES (v_admin_user, 'superadmin')
  ON CONFLICT DO NOTHING;

  -- ── 2: empty string CHECK ──────────────────────────────────────────
  BEGIN
    UPDATE public.creators SET fish_voice_id = '' WHERE id = v_creator;
    RETURN NEXT fail('2: empty-string fish_voice_id should have raised 23514');
  EXCEPTION
    WHEN check_violation THEN RETURN NEXT pass('2: empty fish_voice_id rejected by CHECK');
    WHEN OTHERS          THEN RETURN NEXT fail('2: expected check_violation, got ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ── 3: > 128 char CHECK ────────────────────────────────────────────
  BEGIN
    UPDATE public.creators SET fish_voice_id = repeat('a', 129) WHERE id = v_creator;
    RETURN NEXT fail('3: 129-char fish_voice_id should have raised 23514');
  EXCEPTION
    WHEN check_violation THEN RETURN NEXT pass('3: > 128-char fish_voice_id rejected by CHECK');
    WHEN OTHERS          THEN RETURN NEXT fail('3: expected check_violation, got ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ── 4: charset CHECK rejects path-shaped value (M4) ────────────────
  BEGIN
    UPDATE public.creators SET fish_voice_id = 'models/abc123' WHERE id = v_creator;
    RETURN NEXT fail('4: path-shaped fish_voice_id should have raised 23514');
  EXCEPTION
    WHEN check_violation THEN RETURN NEXT pass('4: charset-violating fish_voice_id rejected by CHECK');
    WHEN OTHERS          THEN RETURN NEXT fail('4: expected check_violation, got ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- Sanity: a valid 32-char hex sets cleanly.
  UPDATE public.creators SET fish_voice_id = 'baa1fcbdb14d4bb492af632c1cb17ace' WHERE id = v_creator;
  SELECT fish_voice_id INTO v_fish_id FROM public.creators WHERE id = v_creator;
  IF v_fish_id IS DISTINCT FROM 'baa1fcbdb14d4bb492af632c1cb17ace' THEN
    RAISE EXCEPTION 'pre-flight: valid 32-char fish_voice_id was not persisted (got %)', v_fish_id;
  END IF;

  -- ── 5: voice_clone_uploads.fish_voice_id exists ────────────────────
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'voice_clone_uploads'
     AND column_name  = 'fish_voice_id';
  RETURN NEXT ok(v_count = 1, '5: voice_clone_uploads has fish_voice_id column');

  -- ── 6: trigger allows fish_voice_id NULL → non-NULL on fish row ────
  INSERT INTO public.voice_clone_uploads (admin_user_id, creator_id, sha256, duration_seconds, mime, bytes, tts_provider)
  VALUES (v_admin_user, v_creator, repeat('f', 64), 10.0, 'audio/wav', 1000, 'fish')
  RETURNING id INTO v_upload_fish;

  BEGIN
    UPDATE public.voice_clone_uploads
       SET fish_voice_id = 'baa1fcbdb14d4bb492af632c1cb17ace'
     WHERE id = v_upload_fish;
    RETURN NEXT pass('6: trigger allows fish_voice_id NULL → non-NULL on fish-provider row');
  EXCEPTION
    WHEN OTHERS THEN RETURN NEXT fail('6: fill-in-once fish_voice_id was blocked: ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ── 7: trigger blocks fish_voice_id non-NULL → NULL reverse ────────
  BEGIN
    UPDATE public.voice_clone_uploads
       SET fish_voice_id = NULL
     WHERE id = v_upload_fish;
    RETURN NEXT fail('7: reverse-to-NULL fish_voice_id should have been blocked');
  EXCEPTION
    WHEN SQLSTATE '42501' THEN RETURN NEXT pass('7: trigger blocks fish_voice_id non-NULL → NULL');
    WHEN OTHERS           THEN RETURN NEXT fail('7: expected 42501, got ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ── 8: trigger blocks fish_voice_id non-NULL → different-non-NULL ──
  BEGIN
    UPDATE public.voice_clone_uploads
       SET fish_voice_id = '1234567890abcdef1234567890abcdef'
     WHERE id = v_upload_fish;
    RETURN NEXT fail('8: rewriting fish_voice_id to a different value should have been blocked');
  EXCEPTION
    WHEN SQLSTATE '42501' THEN RETURN NEXT pass('8: trigger blocks fish_voice_id mutation between non-NULL values');
    WHEN OTHERS           THEN RETURN NEXT fail('8: expected 42501, got ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ── 9: regression — cartesia_voice_id NULL → non-NULL on cartesia row ─
  INSERT INTO public.voice_clone_uploads (admin_user_id, creator_id, sha256, duration_seconds, mime, bytes, tts_provider)
  VALUES (v_admin_user, v_creator, repeat('c', 64), 10.0, 'audio/wav', 1000, 'cartesia')
  RETURNING id INTO v_upload_cart;

  BEGIN
    UPDATE public.voice_clone_uploads
       SET cartesia_voice_id = '11111111-1111-1111-1111-111111111111'
     WHERE id = v_upload_cart;
    RETURN NEXT pass('9: regression — trigger still allows cartesia_voice_id NULL → non-NULL on cartesia row');
  EXCEPTION
    WHEN OTHERS THEN RETURN NEXT fail('9: cartesia transition was blocked: ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ── 10: regression — hume paired NULL → non-NULL on hume row ───────
  INSERT INTO public.voice_clone_uploads (admin_user_id, creator_id, sha256, duration_seconds, mime, bytes, tts_provider)
  VALUES (v_admin_user, v_creator, repeat('h', 64), 10.0, 'audio/wav', 1000, 'hume')
  RETURNING id INTO v_upload_hume;

  BEGIN
    UPDATE public.voice_clone_uploads
       SET hume_voice_id   = 'hume-uuid-here',
           hume_voice_name = 'vuk-clone'
     WHERE id = v_upload_hume;
    RETURN NEXT pass('10: regression — trigger still allows hume (id + name) NULL → non-NULL together on hume row');
  EXCEPTION
    WHEN OTHERS THEN RETURN NEXT fail('10: hume paired transition was blocked: ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ── 11–16: C3 cross-provider fill-in-once REJECTED ─────────────────
  --
  -- 11: cartesia row + fish_voice_id fill → blocked
  DECLARE v_id bigint;
  BEGIN
    INSERT INTO public.voice_clone_uploads (admin_user_id, creator_id, sha256, duration_seconds, mime, bytes, tts_provider)
    VALUES (v_admin_user, v_creator, repeat('1', 64), 10.0, 'audio/wav', 1000, 'cartesia')
    RETURNING id INTO v_id;
    BEGIN
      UPDATE public.voice_clone_uploads SET fish_voice_id = 'aabbccddeeff00112233445566778899' WHERE id = v_id;
      RETURN NEXT fail('11: cartesia row attempting fish_voice_id fill should have been blocked');
    EXCEPTION
      WHEN SQLSTATE '42501' THEN RETURN NEXT pass('11: cartesia row attempting fish_voice_id fill → 42501');
      WHEN OTHERS           THEN RETURN NEXT fail('11: expected 42501, got ' || SQLSTATE || ' ' || SQLERRM);
    END;
  END;

  -- 12: cartesia row + hume paired fill → blocked
  DECLARE v_id bigint;
  BEGIN
    INSERT INTO public.voice_clone_uploads (admin_user_id, creator_id, sha256, duration_seconds, mime, bytes, tts_provider)
    VALUES (v_admin_user, v_creator, repeat('2', 64), 10.0, 'audio/wav', 1000, 'cartesia')
    RETURNING id INTO v_id;
    BEGIN
      UPDATE public.voice_clone_uploads SET hume_voice_id = 'huid', hume_voice_name = 'hname' WHERE id = v_id;
      RETURN NEXT fail('12: cartesia row attempting hume fill should have been blocked');
    EXCEPTION
      WHEN SQLSTATE '42501' THEN RETURN NEXT pass('12: cartesia row attempting hume_voice_id+name fill → 42501');
      WHEN OTHERS           THEN RETURN NEXT fail('12: expected 42501, got ' || SQLSTATE || ' ' || SQLERRM);
    END;
  END;

  -- 13: hume row + cartesia fill → blocked
  DECLARE v_id bigint;
  BEGIN
    INSERT INTO public.voice_clone_uploads (admin_user_id, creator_id, sha256, duration_seconds, mime, bytes, tts_provider)
    VALUES (v_admin_user, v_creator, repeat('3', 64), 10.0, 'audio/wav', 1000, 'hume')
    RETURNING id INTO v_id;
    BEGIN
      UPDATE public.voice_clone_uploads SET cartesia_voice_id = '99999999-9999-9999-9999-999999999999' WHERE id = v_id;
      RETURN NEXT fail('13: hume row attempting cartesia fill should have been blocked');
    EXCEPTION
      WHEN SQLSTATE '42501' THEN RETURN NEXT pass('13: hume row attempting cartesia_voice_id fill → 42501');
      WHEN OTHERS           THEN RETURN NEXT fail('13: expected 42501, got ' || SQLSTATE || ' ' || SQLERRM);
    END;
  END;

  -- 14: hume row + fish fill → blocked
  DECLARE v_id bigint;
  BEGIN
    INSERT INTO public.voice_clone_uploads (admin_user_id, creator_id, sha256, duration_seconds, mime, bytes, tts_provider)
    VALUES (v_admin_user, v_creator, repeat('4', 64), 10.0, 'audio/wav', 1000, 'hume')
    RETURNING id INTO v_id;
    BEGIN
      UPDATE public.voice_clone_uploads SET fish_voice_id = 'aabbccddeeff00112233445566778899' WHERE id = v_id;
      RETURN NEXT fail('14: hume row attempting fish fill should have been blocked');
    EXCEPTION
      WHEN SQLSTATE '42501' THEN RETURN NEXT pass('14: hume row attempting fish_voice_id fill → 42501');
      WHEN OTHERS           THEN RETURN NEXT fail('14: expected 42501, got ' || SQLSTATE || ' ' || SQLERRM);
    END;
  END;

  -- 15: fish row + cartesia fill → blocked
  DECLARE v_id bigint;
  BEGIN
    INSERT INTO public.voice_clone_uploads (admin_user_id, creator_id, sha256, duration_seconds, mime, bytes, tts_provider)
    VALUES (v_admin_user, v_creator, repeat('5', 64), 10.0, 'audio/wav', 1000, 'fish')
    RETURNING id INTO v_id;
    BEGIN
      UPDATE public.voice_clone_uploads SET cartesia_voice_id = '55555555-5555-5555-5555-555555555555' WHERE id = v_id;
      RETURN NEXT fail('15: fish row attempting cartesia fill should have been blocked');
    EXCEPTION
      WHEN SQLSTATE '42501' THEN RETURN NEXT pass('15: fish row attempting cartesia_voice_id fill → 42501');
      WHEN OTHERS           THEN RETURN NEXT fail('15: expected 42501, got ' || SQLSTATE || ' ' || SQLERRM);
    END;
  END;

  -- 16: fish row + hume paired fill → blocked
  DECLARE v_id bigint;
  BEGIN
    INSERT INTO public.voice_clone_uploads (admin_user_id, creator_id, sha256, duration_seconds, mime, bytes, tts_provider)
    VALUES (v_admin_user, v_creator, repeat('6', 64), 10.0, 'audio/wav', 1000, 'fish')
    RETURNING id INTO v_id;
    BEGIN
      UPDATE public.voice_clone_uploads SET hume_voice_id = 'huid', hume_voice_name = 'hname' WHERE id = v_id;
      RETURN NEXT fail('16: fish row attempting hume fill should have been blocked');
    EXCEPTION
      WHEN SQLSTATE '42501' THEN RETURN NEXT pass('16: fish row attempting hume_voice_id+name fill → 42501');
      WHEN OTHERS           THEN RETURN NEXT fail('16: expected 42501, got ' || SQLSTATE || ' ' || SQLERRM);
    END;
  END;

  -- ── 17: regression — tts_provider IMMUTABLE after insert ───────────
  BEGIN
    UPDATE public.voice_clone_uploads
       SET tts_provider = 'cartesia'
     WHERE id = v_upload_fish;
    RETURN NEXT fail('17: changing tts_provider after insert should have been blocked');
  EXCEPTION
    WHEN SQLSTATE '42501' THEN RETURN NEXT pass('17: regression — tts_provider IMMUTABLE after insert');
    WHEN OTHERS           THEN RETURN NEXT fail('17: expected 42501, got ' || SQLSTATE || ' ' || SQLERRM);
  END;

  -- ── 18: C1 — voice_clone_finalize_locked_v2 raises on p_tts_provider='fish' ──
  -- Fresh upload row with tts_provider='fish' so the RPC's "tts_provider
  -- mismatch on upload" guard doesn't fire before our defensive raise.
  DECLARE v_id bigint;
  BEGIN
    INSERT INTO public.voice_clone_uploads (admin_user_id, creator_id, sha256, duration_seconds, mime, bytes, tts_provider)
    VALUES (v_admin_user, v_creator, repeat('7', 64), 10.0, 'audio/wav', 1000, 'fish')
    RETURNING id INTO v_id;

    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

    BEGIN
      PERFORM public.voice_clone_finalize_locked_v2(
        v_admin_user,
        v_id,
        v_creator,
        'fish'::public.tts_provider,
        'aabbccddeeff00112233445566778899',
        NULL,
        false
      );
      RETURN NEXT fail('18: voice_clone_finalize_locked_v2 with fish should have raised 0A000');
    EXCEPTION
      WHEN SQLSTATE '0A000' THEN RETURN NEXT pass('18: voice_clone_finalize_locked_v2(fish, ...) → 0A000 fish_finalize_not_implemented');
      WHEN OTHERS           THEN RETURN NEXT fail('18: expected 0A000, got ' || SQLSTATE || ' ' || SQLERRM);
    END;
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
