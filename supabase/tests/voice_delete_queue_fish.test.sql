-- FISH_AUDIO_PHASE_1 §6 — voice_delete_queue accepts Fish rows.
--
-- After M1 widens the enum, the existing composite PK (tts_provider,
-- voice_id) and the existing v2 RPCs accept Fish rows transparently. This
-- test verifies:
--   1. INSERT with tts_provider='fish' + voice_name NULL succeeds — the
--      voice_delete_queue_hume_needs_name CHECK is "tts_provider != 'hume'
--      OR voice_name IS NOT NULL", so the predicate is true for fish rows
--      regardless of voice_name.
--   2. voice_delete_queue_claim_v2 returns the fish row (no provider
--      filter in the claim's WHERE clause).
--   3. voice_delete_queue_complete_v2('fish', voice_id) removes it.

BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user       uuid := tests.create_auth_user('fishqueue@test');
  v_voice_id   text := 'fish-voice-' || substring(gen_random_uuid()::text, 1, 8);
  v_rows       int;
  v_claimed    record;
  v_claimed_n  int;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- 1: INSERT a fish row with voice_name NULL (Fish DELETE is keyed by id).
  INSERT INTO public.voice_delete_queue (voice_id, tts_provider, voice_name, enqueued_by, due_at)
  VALUES (v_voice_id, 'fish', NULL, v_user, now() - interval '1 second');
  SELECT count(*) INTO v_rows
    FROM public.voice_delete_queue
   WHERE voice_id = v_voice_id AND tts_provider = 'fish';
  RETURN NEXT ok(v_rows = 1, '1: INSERT (fish, voice_id, NULL voice_name) → hume_needs_name CHECK does not block');

  -- 2: claim_v2 returns the fish row.
  v_claimed_n := 0;
  FOR v_claimed IN SELECT * FROM public.voice_delete_queue_claim_v2(10) LOOP
    IF v_claimed.voice_id = v_voice_id AND v_claimed.tts_provider = 'fish' THEN
      v_claimed_n := v_claimed_n + 1;
    END IF;
  END LOOP;
  RETURN NEXT ok(v_claimed_n = 1, '2: voice_delete_queue_claim_v2 returns the fish row (no provider filter)');

  -- 3: complete_v2('fish', voice_id) deletes the row.
  PERFORM public.voice_delete_queue_complete_v2('fish'::public.tts_provider, v_voice_id);
  SELECT count(*) INTO v_rows
    FROM public.voice_delete_queue
   WHERE voice_id = v_voice_id AND tts_provider = 'fish';
  RETURN NEXT ok(v_rows = 0, '3: voice_delete_queue_complete_v2(fish, …) removes the row');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
