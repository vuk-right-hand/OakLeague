-- Reserved handles reject even for authenticated users.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE v_uid uuid := tests.create_auth_user('rls-reserved@test');
BEGIN
  PERFORM tests.set_authenticated(v_uid);
  RETURN NEXT throws_like(
    $$ UPDATE public.profiles SET handle = 'admin' WHERE id = auth.uid() $$,
    '%reserved%',
    'reserved handle rejected via authenticated role'
  );
  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
