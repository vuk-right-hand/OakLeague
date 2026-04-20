-- Partial UNIQUE: one active application per user.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('dup-app@test');
BEGIN
  INSERT INTO public.creator_applications
    (user_id, display_name, handle, topics, proof)
    VALUES (v_uid, 'A', 'dupapp', '[]'::jsonb, '{}'::jsonb);

  RETURN NEXT throws_like(
    format($$ INSERT INTO public.creator_applications
              (user_id, display_name, handle, topics, proof)
              VALUES ('%s', 'A2', 'dupapp2', '[]'::jsonb, '{}'::jsonb) $$, v_uid),
    '%duplicate%',
    'second active application rejected'
  );

  -- Moving first to 'rejected' allows a second.
  UPDATE public.creator_applications SET status = 'rejected' WHERE user_id = v_uid;
  INSERT INTO public.creator_applications
    (user_id, display_name, handle, topics, proof)
    VALUES (v_uid, 'A3', 'dupapp3', '[]'::jsonb, '{}'::jsonb);
  RETURN NEXT pass('new application after rejection allowed');
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
