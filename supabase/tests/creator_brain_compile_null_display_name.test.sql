-- R3 audit M3: NULL display_name must not raise 42704 (creator_not_found).
-- It should fall back to '<unnamed creator>' so approve_creator_application
-- doesn't transactionally roll back during the window between approval and
-- profile completion.
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user    uuid := tests.create_auth_user('cbc-null-name@test');
  v_creator uuid;
  v_prompt  text;
BEGIN
  -- creators.display_name is NOT NULL by schema (migration 0011), but we
  -- can simulate by inserting then UPDATE'ing to empty string. Empty
  -- string and NULL are both COALESCE'd to '<unnamed creator>' via NULLIF.
  UPDATE public.profiles SET handle = 'cbcnullname' WHERE id = v_user;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_user, 'Placeholder', 'cbcnullname', 'training')
    RETURNING id INTO v_creator;
  UPDATE public.creators SET display_name = '' WHERE id = v_creator;

  PERFORM public._creator_brain_compile_unsafe(v_creator);

  SELECT system_prompt INTO v_prompt FROM public.creators WHERE id = v_creator;
  RETURN NEXT ok(v_prompt IS NOT NULL,
                 '1: empty display_name still produces a persona (no 42704)');
  RETURN NEXT ok(v_prompt LIKE 'You are <unnamed creator>.%',
                 '2: persona uses placeholder when display_name is empty');
  RETURN NEXT ok(octet_length(v_prompt) <= 2000,
                 '3: byte-bounded');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
