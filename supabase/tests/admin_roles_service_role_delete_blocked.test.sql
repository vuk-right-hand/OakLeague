-- R4-S2: service_role cannot DELETE from admin_roles. Grant revoke + trigger.
--
-- Migration 20260420000025 DELETEs the vukpjescic@gmail.com seed in the shadow
-- DB (auth.users is empty at migration time, so the backfill orphans it).
-- Seed a test row here so both test 1 (permission error, fires before trigger)
-- and test 2 (trigger error, requires a matching row) have something to hit.
BEGIN;
SELECT plan(2);

DO $$
DECLARE
  v_uid uuid := tests.create_auth_user('delete-target@test');
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_uid, 'delete-target@test', 'superadmin');
END;
$$;

SET LOCAL role service_role;

-- REVOKE DELETE kicks in before the BEFORE DELETE trigger, so the error is
-- the generic permission denied (not our custom message).
SELECT throws_like(
  $$ DELETE FROM public.admin_roles WHERE email = 'delete-target@test' $$,
  '%permission%',
  'service_role DELETE on admin_roles blocked'
);

-- even postgres role hits the BEFORE DELETE trigger
RESET role;
SELECT throws_like(
  $$ DELETE FROM public.admin_roles WHERE email = 'delete-target@test' $$,
  '%cannot be deleted%',
  'postgres role DELETE on admin_roles blocked by trigger'
);

SELECT * FROM finish();
ROLLBACK;
