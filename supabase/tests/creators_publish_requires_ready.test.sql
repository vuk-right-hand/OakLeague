-- CHECK (published_at IS NULL OR brain_status = 'ready')
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('pub-ready@test');
BEGIN
  UPDATE public.profiles SET handle = 'pubr' WHERE id = v_uid;
  RETURN NEXT throws_like(
    format($$ INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
              VALUES ('%s', 'PR', 'pubr', 'training', now()) $$, v_uid),
    '%check%',
    'published_at + brain_status != ready rejected'
  );

  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_uid, 'PR', 'pubr', 'ready', now());
  RETURN NEXT pass('published_at + ready accepted');
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
