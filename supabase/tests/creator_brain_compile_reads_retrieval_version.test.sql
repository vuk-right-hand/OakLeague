-- RAG SOTA plan M1b — _creator_brain_compile_unsafe body extension.
--
-- Audit-3 C3: my plan draft proposed extending the function signature to 3
-- args, which would have broken every existing caller. The correct fix is
-- a body-only CREATE OR REPLACE that reads retrieval_version internally.
--
-- This test verifies:
-- 1. Function still has the canonical 1-arg signature (uuid).
-- 2. Existing caller approve_creator_application still works unchanged.
-- 3. system_prompt is generated and non-empty for both retrieval_version=1
--    and retrieval_version=2 (bodies identical for now per Spike #2 hold).
-- 4. creator_not_found raises 42704.

BEGIN;
SELECT plan(6);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin     uuid := tests.create_auth_user('bc-admin@test');
  v_user1     uuid := tests.create_auth_user('bc-user1@test');
  v_user2     uuid := tests.create_auth_user('bc-user2@test');
  v_creator1  uuid;
  v_creator2  uuid;
  v_app1      uuid;
  v_app2      uuid;
  v_sys_v1    text;
  v_sys_v2    text;
  v_sig_args  int;
  v_fn_count  int;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'bc-admin@test', 'superadmin');

  -- 1a: exactly ONE function named _creator_brain_compile_unsafe.
  -- Audit-4 M2: prior test only checked pronargs of a single row, which would
  -- pass if a future migration accidentally created an overload alongside the
  -- existing function. Assert overload count first.
  SELECT count(*) INTO v_fn_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = '_creator_brain_compile_unsafe';
  RETURN NEXT is(v_fn_count, 1, '1a: exactly one _creator_brain_compile_unsafe function exists (no overloads)');

  -- 1b: canonical 1-arg signature preserved.
  SELECT pronargs INTO v_sig_args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = '_creator_brain_compile_unsafe';
  RETURN NEXT is(v_sig_args, 1, '1b: _creator_brain_compile_unsafe still has 1-arg signature');

  -- 2: existing caller approve_creator_application still works unchanged.
  -- Creator 1 via approve flow.
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user1, 'submitted', 'BC Creator One', 'bccreator1', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app1;
  PERFORM tests.set_authenticated(v_admin);
  SELECT public.approve_creator_application(v_app1) INTO v_creator1;
  PERFORM tests.reset_role();
  SELECT system_prompt INTO v_sys_v1 FROM public.creators WHERE id = v_creator1;
  RETURN NEXT ok(v_sys_v1 IS NOT NULL AND length(v_sys_v1) > 0,
    '2: approve_creator_application still compiles persona unchanged');

  -- 3: persona generated under retrieval_version=2 (manually flip then recompile).
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user2, 'approved', 'BC Creator Two', 'bccreator2', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app2;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, brain_mode, retrieval_version)
    VALUES (gen_random_uuid(), v_user2, v_app2, 'BC Creator Two', 'bccreator2', 'ready', 'vector', 2)
    RETURNING id INTO v_creator2;
  PERFORM public._creator_brain_compile_unsafe(v_creator2);
  SELECT system_prompt INTO v_sys_v2 FROM public.creators WHERE id = v_creator2;
  RETURN NEXT ok(v_sys_v2 IS NOT NULL AND length(v_sys_v2) > 0,
    '3: retrieval_version=2 creator still gets persona compiled');

  -- 4: missing creator raises 42704.
  BEGIN
    PERFORM public._creator_brain_compile_unsafe(gen_random_uuid());
    RETURN NEXT fail('4: missing creator should have raised');
  EXCEPTION
    WHEN sqlstate '42704' THEN
      RETURN NEXT pass('4: missing creator → 42704 creator_not_found');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('4: missing creator → unexpected sqlstate %s', SQLSTATE));
  END;

  -- 5: REGRESSION TEST FOR AUDIT-4 C1.
  -- The 2026-05-12 M14 strong-clarifier production fix (migration 20260512000014)
  -- must survive every future CREATE OR REPLACE of this function. Earlier
  -- draft of 001b silently reverted M14 to the M10 weak clarifier. This test
  -- asserts the M14 signature phrase is present in the compiled vector-mode
  -- persona. If a future migration weakens the clarifier, this test fails
  -- LOUDLY before merge.
  --
  -- v_creator2 was created with brain_mode='vector', retrieval_version=2 in
  -- step 3 above; its system_prompt was compiled there.
  RETURN NEXT ok(
    v_sys_v2 LIKE '%First-turn rule on substantive questions%' AND
    v_sys_v2 LIKE '%MUST be ONLY a%' AND
    v_sys_v2 LIKE '%end with ?%',
    '5: M14 strong-clarifier survives in vector-mode persona (audit-4 C1 regression test)'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
