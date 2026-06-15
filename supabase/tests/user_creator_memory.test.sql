-- MEMORY_BREADTH_PLAN Unit 1b — user_creator_memory table + RPC.
--
--  1. authenticated has NO EXECUTE on memory_upsert_from_session (secdef
--     footer; asserted via has_function_privilege — NEVER by set_role+call,
--     PG17 segfault rule).
--  2. service_role RPC first call → row created, sessions_count=1, open_loop set.
--  3. idempotent re-fire (same session_id) → no change, count still 1.
--  4. newer session → summary replaced, count=2, parsed-null CLEARS open_loop.
--  5. OLDER concurrent session (earlier started_at) → no clobber (R1-M3).
--  6. summary > 1500 octets → 22001 (cap re-validated in the RPC).
--  7. RLS: owner SELECTs own row; a different user sees ZERO rows.
--  8. RLS: owner can DELETE own row ("Forget our conversations").
--  9. authenticated INSERT directly into the table → denied (no policy).
-- 10. voice_tickets.user_context octet CHECK rejects > 2400 (Unit 1a).

BEGIN;
SELECT plan(11);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user    uuid := tests.create_auth_user('memuser@test');
  v_other   uuid := tests.create_auth_user('memother@test');
  v_creator uuid;
  v_app     uuid;
  v_s1      uuid := gen_random_uuid();
  v_s2      uuid := gen_random_uuid();
  v_s_old   uuid := gen_random_uuid();
  v_rows    int;
  v_summary text;
  v_loop    text;
  v_count   int;
BEGIN
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
  VALUES (gen_random_uuid(), v_other, 'approved', 'Mem Creator', 'memcreator1', '[]'::jsonb, '{}'::jsonb)
  RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, brain_mode)
  VALUES (gen_random_uuid(), v_other, v_app, 'Mem Creator', 'memcreator1', 'ready', 'vector')
  RETURNING id INTO v_creator;

  -- 1: secdef lockdown (has_function_privilege, NOT set-role-and-call).
  RETURN NEXT ok(
    NOT has_function_privilege('authenticated',
      'public.memory_upsert_from_session(uuid,uuid,uuid,timestamptz,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon',
      'public.memory_upsert_from_session(uuid,uuid,uuid,timestamptz,text,text)', 'EXECUTE')
    AND has_function_privilege('service_role',
      'public.memory_upsert_from_session(uuid,uuid,uuid,timestamptz,text,text)', 'EXECUTE'),
    '1: RPC EXECUTE = service_role only (secdef footer)'
  );

  -- 2: first extraction creates the row.
  PERFORM public.memory_upsert_from_session(
    v_user, v_creator, v_s1, now() - interval '1 hour',
    'User is building an app; struggling with focus.', 'said he would ship the landing page');
  SELECT count(*), max(summary), max(open_loop), max(sessions_count)
    INTO v_rows, v_summary, v_loop, v_count
    FROM public.user_creator_memory
   WHERE user_id = v_user AND creator_id = v_creator;
  RETURN NEXT ok(
    v_rows = 1 AND v_count = 1
      AND v_summary = 'User is building an app; struggling with focus.'
      AND v_loop = 'said he would ship the landing page',
    '2: first session → row created with summary + open_loop, count=1'
  );

  -- 3: idempotent re-fire (same session id) → no-op.
  PERFORM public.memory_upsert_from_session(
    v_user, v_creator, v_s1, now() - interval '1 hour',
    'A DIFFERENT summary that must NOT land.', NULL);
  SELECT max(summary), max(sessions_count) INTO v_summary, v_count
    FROM public.user_creator_memory
   WHERE user_id = v_user AND creator_id = v_creator;
  RETURN NEXT ok(
    v_summary = 'User is building an app; struggling with focus.' AND v_count = 1,
    '3: same-session re-fire is a no-op (R1-M3 idempotency)'
  );

  -- 4: newer session replaces summary; parsed-null CLEARS open_loop (R1-S3).
  PERFORM public.memory_upsert_from_session(
    v_user, v_creator, v_s2, now(),
    'User shipped the landing page; now working on retention.', NULL);
  SELECT max(summary), max(open_loop), max(sessions_count) INTO v_summary, v_loop, v_count
    FROM public.user_creator_memory
   WHERE user_id = v_user AND creator_id = v_creator;
  RETURN NEXT ok(
    v_summary = 'User shipped the landing page; now working on retention.'
      AND v_loop IS NULL AND v_count = 2,
    '4: newer session updates summary, count=2, null clears open_loop'
  );

  -- 5: an OLDER concurrent session must not clobber (R1-M3 ordering).
  PERFORM public.memory_upsert_from_session(
    v_user, v_creator, v_s_old, now() - interval '2 hours',
    'STALE summary from an older session.', 'stale loop');
  SELECT max(summary), max(open_loop) INTO v_summary, v_loop
    FROM public.user_creator_memory
   WHERE user_id = v_user AND creator_id = v_creator;
  RETURN NEXT ok(
    v_summary = 'User shipped the landing page; now working on retention.' AND v_loop IS NULL,
    '5: older concurrent session cannot clobber a newer summary'
  );

  -- 6: summary cap re-validated → 22001.
  BEGIN
    PERFORM public.memory_upsert_from_session(
      v_user, v_creator, gen_random_uuid(), now(), repeat('x', 1501), NULL);
    RETURN NEXT fail('6: 1501-octet summary should have raised 22001');
  EXCEPTION
    WHEN SQLSTATE '22001' THEN RETURN NEXT pass('6: summary > 1500 octets → 22001');
    WHEN OTHERS THEN RETURN NEXT fail('6: expected 22001, got ' || SQLSTATE);
  END;

  -- 7: RLS — owner sees own row; other user sees nothing.
  PERFORM tests.set_authenticated(v_user);
  SELECT count(*) INTO v_rows FROM public.user_creator_memory;
  PERFORM tests.set_authenticated(v_other);
  SELECT count(*) INTO v_count FROM public.user_creator_memory;
  PERFORM tests.reset_role();
  RETURN NEXT ok(
    v_rows = 1 AND v_count = 0,
    '7: RLS — owner SELECTs own row (1), other user sees zero'
  );

  -- 8: RLS — owner DELETE works (the "Forget our conversations" path).
  PERFORM tests.set_authenticated(v_user);
  DELETE FROM public.user_creator_memory WHERE creator_id = v_creator;
  SELECT count(*) INTO v_rows FROM public.user_creator_memory;
  PERFORM tests.reset_role();
  SELECT count(*) INTO v_count FROM public.user_creator_memory
   WHERE user_id = v_user AND creator_id = v_creator;
  RETURN NEXT ok(
    v_rows = 0 AND v_count = 0,
    '8: owner DELETE removes the row (visible as gone to postgres too)'
  );

  -- 9: authenticated direct INSERT denied (no INSERT policy).
  PERFORM tests.set_authenticated(v_user);
  BEGIN
    INSERT INTO public.user_creator_memory (user_id, creator_id, summary)
    VALUES (v_user, v_creator, 'client-forged memory');
    RETURN NEXT fail('9: client INSERT should have been denied');
  EXCEPTION
    WHEN insufficient_privilege OR SQLSTATE '42501' THEN
      RETURN NEXT pass('9: client INSERT denied (service-role writes only)');
    WHEN OTHERS THEN
      -- RLS denial on INSERT surfaces as 42501; new-row-violates-policy also OK.
      IF SQLSTATE = '42P17' OR SQLERRM LIKE '%row-level security%' THEN
        RETURN NEXT pass('9: client INSERT denied by RLS');
      ELSE
        RETURN NEXT fail('9: expected RLS/privilege denial, got ' || SQLSTATE || ' ' || SQLERRM);
      END IF;
  END;
  PERFORM tests.reset_role();

  -- 10: grants sanity — authenticated has SELECT+DELETE, not INSERT/UPDATE.
  RETURN NEXT ok(
    has_table_privilege('authenticated', 'public.user_creator_memory', 'SELECT')
      AND has_table_privilege('authenticated', 'public.user_creator_memory', 'DELETE')
      AND NOT has_table_privilege('authenticated', 'public.user_creator_memory', 'INSERT')
      AND NOT has_table_privilege('authenticated', 'public.user_creator_memory', 'UPDATE')
      AND has_table_privilege('service_role', 'public.user_creator_memory', 'INSERT'),
    '10: table grants — authenticated SELECT+DELETE only; service_role full'
  );

  -- 11: voice_tickets.user_context octet CHECK (Unit 1a defense-in-depth).
  -- NOT NULL columns (tts_provider, avatar_provider-for-voice_session)
  -- satisfied so the user_context CHECK is the one that fires.
  BEGIN
    INSERT INTO public.voice_tickets
      (ticket_id, user_id, creator_id, purpose, expires_at, bound_ua_hash,
       tts_provider, avatar_provider, user_context)
    VALUES
      (gen_random_uuid(), v_user, v_creator, 'voice_session',
       now() + interval '5 minutes', 'hash', 'cartesia', 'simli', repeat('x', 2401));
    RETURN NEXT fail('11: 2401-octet user_context should have violated the CHECK');
  EXCEPTION
    WHEN check_violation THEN
      RETURN NEXT pass('11: voice_tickets_user_context_len_chk rejects > 2400 octets');
    WHEN OTHERS THEN
      -- Other NOT NULL/CHECK columns may fire first on this minimal insert;
      -- accept only an explicit user_context message as pass otherwise fail.
      IF SQLERRM LIKE '%user_context%' THEN
        RETURN NEXT pass('11: user_context cap enforced (' || SQLSTATE || ')');
      ELSE
        RETURN NEXT fail('11: expected user_context check_violation, got ' || SQLSTATE || ' ' || SQLERRM);
      END IF;
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
