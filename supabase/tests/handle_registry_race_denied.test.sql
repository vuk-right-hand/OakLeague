-- Two profiles racing for the same handle: UNIQUE on registry blocks the loser.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_a uuid := tests.create_auth_user('race-a@test');
  v_b uuid := tests.create_auth_user('race-b@test');
BEGIN
  UPDATE public.profiles SET handle = 'racer' WHERE id = v_a;
  RETURN NEXT throws_like(
    format($$ UPDATE public.profiles SET handle = 'racer' WHERE id = '%s' $$, v_b),
    '%duplicate%',
    'second profile cannot claim same handle'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
