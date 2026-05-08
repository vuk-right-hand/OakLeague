-- R1 S7: post-approve creator has system_prompt populated and
-- brain_compiled_at set, but brain_status STAYS 'training' (R2 M1 — voice
-- + face still required for 'ready').
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin   uuid := tests.create_auth_user('appr-admin@test');
  v_user    uuid := tests.create_auth_user('appr-applicant@test');
  v_app_id  uuid;
  v_creator uuid;
BEGIN
  INSERT INTO admin_roles (user_id, email, role) VALUES (v_admin, 'appr-admin@test', 'superadmin');

  UPDATE public.profiles SET handle = NULL WHERE id = v_user;

  INSERT INTO public.creator_applications
    (user_id, status, handle, display_name, bio, topics, proof)
  VALUES
    (v_user, 'submitted', 'apprbrain', 'Approved Mentor',
     'I teach things.',
     '[{"slug":"general","title":"General","description":"x"}]'::jsonb,
     '[{"kind":"link","url":"https://example.com"}]'::jsonb)
  RETURNING id INTO v_app_id;

  PERFORM tests.set_authenticated(v_admin);
  v_creator := public.approve_creator_application(v_app_id);
  PERFORM tests.reset_role();

  RETURN NEXT ok(
    (SELECT system_prompt FROM creators WHERE id = v_creator) IS NOT NULL,
    '1: post-approve system_prompt populated');
  RETURN NEXT ok(
    (SELECT brain_compiled_at FROM creators WHERE id = v_creator) IS NOT NULL,
    '2: brain_compiled_at set');
  RETURN NEXT is(
    (SELECT brain_status::text FROM creators WHERE id = v_creator),
    'training',
    '3: brain_status stays training (NOT flipped to ready)');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
