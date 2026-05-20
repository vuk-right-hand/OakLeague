-- pgvector RAG plan M7 — admin_set_creator_brain_mode gated to admins.
--
-- Regular user → 42501 unauthorized.
-- Admin → flips brain_mode + writes admin_audit_log row carrying
-- previous_mode (rollback observability).
-- NULL p_mode → 22023 mode_required (R3 Small fix).

BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin    uuid := tests.create_auth_user('brain-mode-admin@test');
  v_user     uuid := tests.create_auth_user('brain-mode-user@test');
  v_creator  uuid;
  v_app      uuid;
  v_mode     public.brain_mode;
  v_audit_n  int;
  v_prev     text;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'brain-mode-admin@test', 'superadmin');

  -- topics + proof are NOT NULL on creator_applications (migration
  -- 20260420000010); this test was pre-existing broken until 2026-05-21
  -- (P1-10 cleanup). Same as the fix in admin_set_creator_decoupled's test.
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
  VALUES (gen_random_uuid(), v_user, 'approved', 'Brain Mode Creator', 'brainmodec1',
          '[]'::jsonb, '[]'::jsonb)
  RETURNING id INTO v_app;

  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
  VALUES (gen_random_uuid(), v_user, v_app, 'Brain Mode Creator', 'brainmodec1', 'ready')
  RETURNING id INTO v_creator;

  -- 1: regular user (the creator's own user even — still not admin) → 42501.
  PERFORM tests.set_authenticated(v_user);
  BEGIN
    PERFORM public.admin_set_creator_brain_mode(v_creator, 'vector');
    RETURN NEXT fail('1: regular user should have been blocked');
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN NEXT pass('1: regular user → 42501 unauthorized');
  END;
  PERFORM tests.reset_role();

  -- 2: admin flips brain_mode → vector, recompile fires.
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_set_creator_brain_mode(v_creator, 'vector');
  -- P1-10 cleanup: reset role before SELECT so RLS on creators doesn't
  -- hide the just-written row from the authenticated user's read path.
  PERFORM tests.reset_role();
  SELECT brain_mode INTO v_mode FROM public.creators WHERE id = v_creator;
  RETURN NEXT is(v_mode::text, 'vector', '2: admin flipped brain_mode to vector');

  -- 3: admin_audit_log row carries previous_mode in `before`.
  SELECT before->>'brain_mode' INTO v_prev
    FROM public.admin_audit_log
   WHERE action = 'creator_brain_mode_set' AND target_id = v_creator
   ORDER BY created_at DESC LIMIT 1;
  RETURN NEXT is(v_prev, 'drawer', '3: admin_audit_log.before carries previous_mode');

  -- 4: NULL p_mode should raise (R3 Small fix). PostgREST would pass missing
  -- arg as default; we call explicitly with NULL to exercise the guard.
  PERFORM tests.set_authenticated(v_admin);
  BEGIN
    PERFORM public.admin_set_creator_brain_mode(v_creator, NULL);
    RETURN NEXT fail('4: NULL p_mode should have raised');
  EXCEPTION
    WHEN sqlstate '22023' THEN
      RETURN NEXT pass('4: NULL p_mode → 22023 mode_required');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('4: NULL p_mode → unexpected sqlstate %s', SQLSTATE));
  END;
  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
