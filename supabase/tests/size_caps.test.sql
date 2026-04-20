-- Spot-check key size CHECKs.
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('sizecap@test');
BEGIN
  RETURN NEXT throws_like(
    format($$ UPDATE public.profiles SET display_name = '%s' WHERE id = '%s' $$,
           repeat('x', 81), v_uid),
    '%check%',
    'display_name > 80 chars rejected'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT throws_like(
  $$ INSERT INTO public.waitlist (email, source)
     VALUES ('sz@test', repeat('s', 101)) $$,
  '%check%',
  'waitlist.source > 100 chars rejected'
);

SELECT lives_ok(
  $$ INSERT INTO public.reserved_handles (handle) VALUES (repeat('z', 300)) $$,
  'citext accepts long values; no implicit cap on reserved_handles.handle'
);

SELECT * FROM finish();
ROLLBACK;
