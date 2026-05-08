-- Graceful default when bio is NULL and the creator has zero topics.
-- Persona must still be valid and contain "general mentorship" fallback.
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user    uuid := tests.create_auth_user('cbc-null-u@test');
  v_creator uuid;
  v_prompt  text;
BEGIN
  UPDATE public.profiles SET handle = 'cbcnullb' WHERE id = v_user;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_user, 'NullBio Mentor', 'cbcnullb', 'training')
    RETURNING id INTO v_creator;

  PERFORM public._creator_brain_compile_unsafe(v_creator);

  SELECT system_prompt INTO v_prompt FROM public.creators WHERE id = v_creator;
  RETURN NEXT ok(v_prompt LIKE 'You are NullBio Mentor.%',
                 '1: persona starts with display_name on NULL bio');
  RETURN NEXT ok(v_prompt LIKE '%Topics you cover: general mentorship.%',
                 '2: zero topics → fallback "general mentorship"');
  RETURN NEXT ok(octet_length(v_prompt) <= 2000,
                 '3: byte-bounded');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
