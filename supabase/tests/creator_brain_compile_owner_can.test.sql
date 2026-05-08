-- Public wrapper: creator-owner can call.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user    uuid := tests.create_auth_user('cbc-own@test');
  v_creator uuid;
BEGIN
  UPDATE public.profiles SET handle = 'cbcown' WHERE id = v_user;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_user, 'Own', 'cbcown', 'training')
    RETURNING id INTO v_creator;

  PERFORM tests.set_authenticated(v_user);
  PERFORM public.creator_brain_compile(v_creator);
  PERFORM tests.reset_role();

  RETURN NEXT ok(
    (SELECT system_prompt FROM creators WHERE id = v_creator) IS NOT NULL,
    '1: owner-call populates system_prompt');
  RETURN NEXT ok(
    (SELECT brain_compiled_at FROM creators WHERE id = v_creator) IS NOT NULL,
    '2: brain_compiled_at set');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
