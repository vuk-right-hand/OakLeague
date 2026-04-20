-- profiles_handle_sync_before lowercases handle.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('lowcase@test');
BEGIN
  UPDATE public.profiles SET handle = 'CamelCase_1' WHERE id = v_uid;
  RETURN NEXT is(
    (SELECT handle::text FROM public.profiles WHERE id = v_uid),
    'camelcase_1',
    'handle lowercased before storage'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
