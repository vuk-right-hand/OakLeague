-- v1 CHECK pins creator_type = 'human'. brand / sponsored_segment exist but fail.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('cth@test');
BEGIN
  RETURN NEXT throws_like(
    format($$ INSERT INTO public.creators (user_id, display_name, handle, creator_type)
              VALUES ('%s', 'Brand', 'brandy', 'brand') $$, v_uid),
    '%check%',
    'creator_type = brand rejected in v1'
  );

  INSERT INTO public.creators (user_id, display_name, handle, creator_type)
    VALUES (v_uid, 'Human', 'humany', 'human');
  RETURN NEXT pass('creator_type = human accepted');
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
