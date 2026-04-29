-- Round-3 medium: unknown hook_id raises P0002 (matches admin_set_profile_tier
-- and admin_force_close_session codebase precedent). Soft-error envelope was
-- rejected; RAISE is the established pattern.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-uh-admin@test');
  v_user  uuid := tests.create_auth_user('algo-uh-user@test');
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-uh-admin@test', 'superadmin');

  UPDATE public.videos SET published_at = now() WHERE published_at IS NULL;
  PERFORM tests.set_authenticated(v_admin);

  RETURN NEXT throws_ok(
    format('SELECT public.admin_algo_score_explain(%L, %L, %L)',
           v_user, gen_random_uuid(), gen_random_uuid()),
    'P0002', NULL,
    '1: unknown hook_id → P0002 (no soft error, no UPDATE-in-place)'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
