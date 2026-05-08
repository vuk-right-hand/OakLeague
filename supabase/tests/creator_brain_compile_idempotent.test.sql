-- Re-running compile produces the same persona. brain_compiled_at advances.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user    uuid := tests.create_auth_user('cbc-idem@test');
  v_creator uuid;
  v_p1 text; v_p2 text;
  v_c1 timestamptz; v_c2 timestamptz;
BEGIN
  UPDATE public.profiles SET handle = 'cbcidem' WHERE id = v_user;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, bio)
    VALUES (v_user, 'Idem', 'cbcidem', 'training', 'Bio')
    RETURNING id INTO v_creator;

  PERFORM public._creator_brain_compile_unsafe(v_creator);
  SELECT system_prompt, brain_compiled_at INTO v_p1, v_c1
    FROM public.creators WHERE id = v_creator;

  -- Wipe the row to verify the second _unsafe call actually writes
  -- (R-PR1 M6 — without this, a broken UPDATE on the second call
  --  would still leave v_p2 = v_p1 and the test would pass falsely).
  UPDATE public.creators
     SET system_prompt = NULL, brain_compiled_at = NULL
   WHERE id = v_creator;

  PERFORM public._creator_brain_compile_unsafe(v_creator);
  SELECT system_prompt, brain_compiled_at INTO v_p2, v_c2
    FROM public.creators WHERE id = v_creator;

  RETURN NEXT is(v_p1, v_p2, '1: persona text identical on rerun');
  RETURN NEXT ok(v_c1 IS NOT NULL AND v_c2 IS NOT NULL,
                 '2: brain_compiled_at populated by both calls (post-wipe verifies UPDATE actually ran)');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
