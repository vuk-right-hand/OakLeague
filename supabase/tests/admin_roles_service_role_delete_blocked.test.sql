-- R4-S2: service_role cannot DELETE from admin_roles. Grant revoke + trigger.
BEGIN;
SELECT plan(2);

SET LOCAL role service_role;

-- REVOKE DELETE kicks in before the BEFORE DELETE trigger, so the error is
-- the generic permission denied (not our custom message).
SELECT throws_like(
  $$ DELETE FROM public.admin_roles WHERE email = 'vukpjescic@gmail.com' $$,
  '%permission%',
  'service_role DELETE on admin_roles blocked'
);

-- even postgres role hits the BEFORE DELETE trigger
RESET role;
SELECT throws_like(
  $$ DELETE FROM public.admin_roles WHERE email = 'vukpjescic@gmail.com' $$,
  '%cannot be deleted%',
  'postgres role DELETE on admin_roles blocked by trigger'
);

SELECT * FROM finish();
ROLLBACK;
