-- Soft-delete via revoked_at. assertAdminFromSession must check revoked_at IS NULL.
-- This test exercises the expected DB-level pattern for that predicate.
BEGIN;
SELECT plan(2);

-- admin_roles.user_id is NOT NULL since migration 20260420000025. Create a
-- real auth.users row (FK target) and reuse its uuid.
DO $$
DECLARE
  v_uid uuid := tests.create_auth_user('jr-admin@test');
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_uid, 'jr-admin@test', 'reviewer');
END;
$$;

SELECT is(
  (SELECT count(*)::int FROM public.admin_roles
     WHERE email = 'jr-admin@test' AND revoked_at IS NULL),
  1,
  'freshly inserted admin appears as active'
);

UPDATE public.admin_roles SET revoked_at = now() WHERE email = 'jr-admin@test';

SELECT is(
  (SELECT count(*)::int FROM public.admin_roles
     WHERE email = 'jr-admin@test' AND revoked_at IS NULL),
  0,
  'revoked admin filtered out by revoked_at IS NULL predicate'
);

SELECT * FROM finish();
ROLLBACK;
