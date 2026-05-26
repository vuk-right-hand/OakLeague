-- DECOUPLED_BRAIN_PLAN P1-10 audit M1+M2 — admin_set_creator_brain_mode
-- guard against leaving a decoupled=true creator on a non-vector mode.
--
-- Setup: creator A is decoupled=true / vector (canonical state). Admin
-- attempts to flip brain_mode → drawer. The hardened RPC refuses with
-- 22023. Then admin calls admin_set_creator_decoupled(false) first,
-- then admin_set_creator_brain_mode(drawer) — both succeed.

BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin    uuid := tests.create_auth_user('decoupled-guard-admin@test');
  v_user     uuid := tests.create_auth_user('decoupled-guard-user@test');
  v_creator  uuid;
  v_app      uuid;
  v_mode     public.brain_mode;
  v_dec      boolean;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'decoupled-guard-admin@test', 'superadmin');

  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
  VALUES (gen_random_uuid(), v_user, 'approved', 'Decoupled Guard Creator', 'dguardc1',
          '[]'::jsonb, '[]'::jsonb)
  RETURNING id INTO v_app;

  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, bio, brain_mode)
  VALUES (gen_random_uuid(), v_user, v_app, 'Decoupled Guard Creator', 'dguardc1', 'ready',
          'I help founders', 'drawer')
  RETURNING id INTO v_creator;

  -- Put creator into the canonical decoupled state via the new RPC.
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_set_creator_decoupled(v_creator, true);
  PERFORM tests.reset_role();

  -- 1: admin attempts to drawer-flip a decoupled=true creator → 22023.
  PERFORM tests.set_authenticated(v_admin);
  BEGIN
    PERFORM public.admin_set_creator_brain_mode(v_creator, 'drawer');
    RETURN NEXT fail('1: drawer-flip on decoupled=true creator should have raised');
  EXCEPTION
    WHEN sqlstate '22023' THEN
      RETURN NEXT pass('1: drawer-flip on decoupled=true → 22023 cannot_change_brain_mode_while_decoupled');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('1: drawer-flip → unexpected sqlstate %s', SQLSTATE));
  END;
  PERFORM tests.reset_role();

  -- 2: state unchanged after the refusal (decoupled=true, mode=vector).
  SELECT decoupled, brain_mode INTO v_dec, v_mode FROM public.creators WHERE id = v_creator;
  RETURN NEXT is(v_dec, true,         '2a: decoupled unchanged after refusal');
  RETURN NEXT is(v_mode::text, 'vector', '2b: brain_mode unchanged after refusal');

  -- 3: the canonical two-step admin sequence works:
  --    (a) admin_set_creator_decoupled(false) → leaves brain_mode at 'vector'
  --    (b) admin_set_creator_brain_mode(drawer) → succeeds (creator now decoupled=false)
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_set_creator_decoupled(v_creator, false);
  PERFORM public.admin_set_creator_brain_mode(v_creator, 'drawer');
  PERFORM tests.reset_role();
  SELECT decoupled, brain_mode INTO v_dec, v_mode FROM public.creators WHERE id = v_creator;
  RETURN NEXT is(v_mode::text, 'drawer', '3: canonical two-step admin sequence (decoupled=false → brain_mode=drawer) succeeded');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
