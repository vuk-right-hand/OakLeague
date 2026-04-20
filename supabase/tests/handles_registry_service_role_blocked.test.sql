-- R5-S3: service_role cannot directly DELETE/UPDATE/INSERT into handles_registry.
-- SECURITY DEFINER sync triggers still work because their owner = postgres.
BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.seed_and_check() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('srr-test@test');
BEGIN
  UPDATE public.profiles SET handle = 'srr_test' WHERE id = v_uid;
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.handles_registry WHERE handle = 'srr_test'),
    'sync trigger (runs as postgres) can write handles_registry'
  );
END;
$fn$;

SELECT * FROM pg_temp.seed_and_check();

SET LOCAL role service_role;

SELECT throws_like(
  $$ INSERT INTO public.handles_registry (handle, owner_kind, owner_id)
     VALUES ('direct_insert', 'profile', '00000000-0000-0000-0000-000000000001') $$,
  '%permission%',
  'service_role direct INSERT blocked'
);

SELECT throws_like(
  $$ UPDATE public.handles_registry SET handle = 'renamed' WHERE handle = 'srr_test' $$,
  '%permission%',
  'service_role direct UPDATE blocked'
);

SELECT throws_like(
  $$ DELETE FROM public.handles_registry WHERE handle = 'srr_test' $$,
  '%permission%',
  'service_role direct DELETE blocked'
);

RESET role;

SELECT * FROM finish();
ROLLBACK;
