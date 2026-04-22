-- admin_audit_log.before / after — 4096 byte cap on jsonb payloads.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('auditcaps-admin@test');
  v_small jsonb := jsonb_build_object('k', repeat('a', 100));
  v_big   jsonb := jsonb_build_object('k', repeat('a', 5000));
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'auditcaps-admin@test', 'superadmin');

  -- Small payload accepted.
  INSERT INTO public.admin_audit_log (admin_user_id, action, target_kind, before, after)
    VALUES (v_admin, 'test', 'profile', v_small, v_small);
  RETURN NEXT ok(true, '1: small payload accepted');

  -- 5000-char payload rejected by CHECK.
  RETURN NEXT throws_like(
    format(
      'INSERT INTO public.admin_audit_log (admin_user_id, action, target_kind, before, after) VALUES (%L, %L, %L, %L::jsonb, %L::jsonb)',
      v_admin, 'test', 'profile', v_big::text, v_big::text
    ),
    '%check%',
    '2: jsonb > 4096 bytes rejected'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
