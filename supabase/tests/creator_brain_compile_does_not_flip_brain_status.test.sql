-- R2 audit M1: persona compile MUST NOT flip brain_status. Pre-existing
-- 'training' or 'errored' rows stay where they are. Publish-readiness is
-- a separate concern (voice + face), not coupled to persona.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user1   uuid := tests.create_auth_user('cbc-bs1@test');
  v_user2   uuid := tests.create_auth_user('cbc-bs2@test');
  v_c1      uuid;
  v_c2      uuid;
BEGIN
  UPDATE public.profiles SET handle = 'cbcbs1' WHERE id = v_user1;
  UPDATE public.profiles SET handle = 'cbcbs2' WHERE id = v_user2;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_user1, 'BS1', 'cbcbs1', 'training') RETURNING id INTO v_c1;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_user2, 'BS2', 'cbcbs2', 'errored') RETURNING id INTO v_c2;

  PERFORM public._creator_brain_compile_unsafe(v_c1);
  PERFORM public._creator_brain_compile_unsafe(v_c2);

  RETURN NEXT is(
    (SELECT brain_status::text FROM creators WHERE id = v_c1),
    'training',
    '1: training stays training');
  RETURN NEXT is(
    (SELECT brain_status::text FROM creators WHERE id = v_c2),
    'errored',
    '2: errored stays errored');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
