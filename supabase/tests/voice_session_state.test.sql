-- RAG SOTA Phase 2 — Day 8 MIG-4 pgTAP
-- voice_session_state + purge function
--
-- Setup as postgres (BYPASSRLS). Service-role-only table.
--
-- Coverage:
--   1. RLS deny-all (enabled + zero policies)
--   2. PRIMARY KEY = session_id; INSERT with NULL session_id rejected
--   3. FK to sessions: orphan session_id INSERT rejected
--   4. ON DELETE CASCADE: deleting parent session removes state row
--   5. CHECK last_assistant_response ≤ 2000 chars
--   6. CHECK last_user_query ≤ 2000 chars
--   7. Both response columns nullable
--   8. updated_at trigger bumps on UPDATE
--   9. Purge function deletes rows with updated_at older than 7 days
--  10. Purge function leaves recent rows alone
--  11. REVOKE ALL FROM authenticated, anon (defense-in-depth)

BEGIN;
SELECT plan(11);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user          uuid;
  v_user2         uuid;
  v_user3         uuid;
  v_app           uuid;
  v_creator       uuid;
  v_session1      uuid;
  v_session2      uuid;
  v_rls_enabled   bool;
  v_n_policies    int;
  v_row_count     int;
  v_updated_1     timestamptz;
  v_updated_2     timestamptz;
  v_priv_count    int;
  v_purged        int;
BEGIN
  -- Setup: create real sessions for the FK target. Sessions enforce one
  -- active session per user, so each test session gets a distinct user.
  v_user  := tests.create_auth_user('vss-user1@test');
  v_user2 := tests.create_auth_user('vss-user2@test');
  v_user3 := tests.create_auth_user('vss-user3@test');
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user, 'approved', 'VSS', 'vss1', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user, v_app, 'VSS', 'vss1', 'ready')
    RETURNING id INTO v_creator;
  INSERT INTO public.sessions (id, user_id, creator_id, model_used, tier_at_session, status)
    VALUES (gen_random_uuid(), v_user, v_creator, 'gemini_3_1_flash_live_preview'::voice_model,
            'free'::profile_tier, 'active'::session_status)
    RETURNING id INTO v_session1;
  INSERT INTO public.sessions (id, user_id, creator_id, model_used, tier_at_session, status)
    VALUES (gen_random_uuid(), v_user2, v_creator, 'gemini_3_1_flash_live_preview'::voice_model,
            'free'::profile_tier, 'active'::session_status)
    RETURNING id INTO v_session2;

  -- ── 1: RLS enabled + zero policies ─────────────────────────────────────
  SELECT relrowsecurity INTO v_rls_enabled
    FROM pg_class WHERE oid = 'public.voice_session_state'::regclass;
  SELECT count(*) INTO v_n_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'voice_session_state';
  RETURN NEXT ok(
    v_rls_enabled AND v_n_policies = 0,
    format('1: RLS enabled (%s) + zero policies (%s) = deny-all', v_rls_enabled, v_n_policies)
  );

  -- ── 2: NULL session_id rejected ────────────────────────────────────────
  BEGIN
    INSERT INTO public.voice_session_state (session_id, last_assistant_response)
    VALUES (NULL, 'hello');
    RETURN NEXT fail('2: NULL session_id should have raised');
  EXCEPTION
    WHEN not_null_violation THEN
      RETURN NEXT pass('2: NULL session_id rejected');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('2: unexpected sqlstate %s', SQLSTATE));
  END;

  -- ── 3: FK violation on orphan session_id ──────────────────────────────
  BEGIN
    INSERT INTO public.voice_session_state (session_id, last_assistant_response)
    VALUES (gen_random_uuid(), 'orphan');
    RETURN NEXT fail('3: orphan session_id should have raised FK violation');
  EXCEPTION
    WHEN foreign_key_violation THEN
      RETURN NEXT pass('3: FK violation on orphan session_id');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('3: unexpected sqlstate %s', SQLSTATE));
  END;

  -- ── 4: ON DELETE CASCADE ──────────────────────────────────────────────
  INSERT INTO public.voice_session_state (session_id, last_assistant_response, last_user_query)
  VALUES (v_session2, 'response text', 'query text');
  DELETE FROM public.sessions WHERE id = v_session2;
  SELECT count(*) INTO v_row_count
    FROM public.voice_session_state WHERE session_id = v_session2;
  RETURN NEXT ok(
    v_row_count = 0,
    format('4: ON DELETE CASCADE removed state row (remaining=%s)', v_row_count)
  );

  -- ── 5: CHECK last_assistant_response ≤ 2000 chars ─────────────────────
  BEGIN
    INSERT INTO public.voice_session_state (session_id, last_assistant_response)
    VALUES (v_session1, repeat('a', 2001));
    RETURN NEXT fail('5: 2001-char response should have raised CHECK');
  EXCEPTION
    WHEN check_violation THEN
      RETURN NEXT pass('5: CHECK rejects last_assistant_response > 2000 chars');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('5: unexpected sqlstate %s', SQLSTATE));
  END;

  -- ── 6: CHECK last_user_query ≤ 2000 chars ─────────────────────────────
  BEGIN
    INSERT INTO public.voice_session_state (session_id, last_user_query)
    VALUES (v_session1, repeat('q', 2001));
    RETURN NEXT fail('6: 2001-char user query should have raised CHECK');
  EXCEPTION
    WHEN check_violation THEN
      RETURN NEXT pass('6: CHECK rejects last_user_query > 2000 chars');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('6: unexpected sqlstate %s', SQLSTATE));
  END;

  -- ── 7: both columns nullable ──────────────────────────────────────────
  INSERT INTO public.voice_session_state (session_id) VALUES (v_session1);
  SELECT count(*) INTO v_row_count
    FROM public.voice_session_state
   WHERE session_id = v_session1
     AND last_assistant_response IS NULL
     AND last_user_query IS NULL;
  RETURN NEXT ok(
    v_row_count = 1,
    format('7: both response columns nullable (got %s rows)', v_row_count)
  );

  -- ── 8: updated_at trigger bumps on UPDATE ─────────────────────────────
  -- `now()` is frozen within a single transaction, so we can't observe a
  -- timestamp shift by UPDATEing twice. Instead: backdate updated_at via
  -- direct UPDATE … then UPDATE again to fire the trigger and confirm
  -- the trigger overrides the backdated value back to now().
  --
  -- Wait — the trigger fires on every UPDATE, so the "backdate UPDATE"
  -- is itself trigger-overridden. Cleanest test: drop and re-add the row
  -- with an explicit past updated_at (INSERT bypasses BEFORE UPDATE), then
  -- UPDATE and confirm the trigger pushed it to now().
  DELETE FROM public.voice_session_state WHERE session_id = v_session1;
  INSERT INTO public.voice_session_state (session_id, last_assistant_response, updated_at)
    VALUES (v_session1, 'pre-existing', '2020-01-01 00:00:00+00');
  SELECT updated_at INTO v_updated_1
    FROM public.voice_session_state WHERE session_id = v_session1;
  UPDATE public.voice_session_state
     SET last_assistant_response = 'updated response'
   WHERE session_id = v_session1;
  SELECT updated_at INTO v_updated_2
    FROM public.voice_session_state WHERE session_id = v_session1;
  RETURN NEXT ok(
    v_updated_2 > v_updated_1 AND v_updated_2 >= (now() - interval '1 minute'),
    format('8: trigger overrode backdated updated_at (was %s, now %s)', v_updated_1, v_updated_2)
  );

  -- ── 9 + 10: purge deletes stale, leaves fresh ─────────────────────────
  -- Re-insert v_session1's row with an explicit 8-day-old updated_at
  -- (INSERT bypasses BEFORE UPDATE trigger, so the backdate sticks).
  DELETE FROM public.voice_session_state WHERE session_id = v_session1;
  INSERT INTO public.voice_session_state (session_id, last_assistant_response, updated_at)
    VALUES (v_session1, 'stale', now() - interval '8 days');

  -- Fresh row on a distinct user's session.
  INSERT INTO public.sessions (id, user_id, creator_id, model_used, tier_at_session, status)
    VALUES (gen_random_uuid(), v_user3, v_creator, 'gemini_3_1_flash_live_preview'::voice_model,
            'free'::profile_tier, 'active'::session_status)
    RETURNING id INTO v_session2;
  INSERT INTO public.voice_session_state (session_id, last_assistant_response)
    VALUES (v_session2, 'fresh');

  v_purged := public.voice_session_state_purge_stale();
  RETURN NEXT ok(
    v_purged = 1,
    format('9: purge deleted exactly 1 stale row (got %s)', v_purged)
  );

  SELECT count(*) INTO v_row_count
    FROM public.voice_session_state WHERE session_id = v_session2;
  RETURN NEXT ok(
    v_row_count = 1,
    format('10: purge left fresh row alive (got %s)', v_row_count)
  );

  -- ── 11: REVOKE ALL on authenticated + anon ────────────────────────────
  -- has_table_privilege returns false when no grant exists. Verify both
  -- standard application roles have zero privileges.
  SELECT
    (has_table_privilege('authenticated', 'public.voice_session_state', 'SELECT')::int)
  + (has_table_privilege('authenticated', 'public.voice_session_state', 'INSERT')::int)
  + (has_table_privilege('authenticated', 'public.voice_session_state', 'UPDATE')::int)
  + (has_table_privilege('authenticated', 'public.voice_session_state', 'DELETE')::int)
  + (has_table_privilege('anon',          'public.voice_session_state', 'SELECT')::int)
  + (has_table_privilege('anon',          'public.voice_session_state', 'INSERT')::int)
  + (has_table_privilege('anon',          'public.voice_session_state', 'UPDATE')::int)
  + (has_table_privilege('anon',          'public.voice_session_state', 'DELETE')::int)
  INTO v_priv_count;
  RETURN NEXT ok(
    v_priv_count = 0,
    format('11: zero authenticated/anon privileges on voice_session_state (defense-in-depth) — got %s', v_priv_count)
  );

END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
