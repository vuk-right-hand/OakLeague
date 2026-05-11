-- creators.tts_speed CHECK constraint + default + NOT NULL behavior.
-- Range is [0.6, 1.5] (Cartesia Sonic 3 generation_config.speed bounds).
-- Default 1.0 = Cartesia native no-op.
BEGIN;
SELECT plan(6);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user    uuid := tests.create_auth_user('cts-u@test');
  v_creator uuid;
  v_speed   numeric;
  v_err     text;
BEGIN
  UPDATE public.profiles SET handle = 'ctsu' WHERE id = v_user;

  -- 1) Default value on insert is 1.0 (Cartesia no-op).
  INSERT INTO public.creators
    (user_id, display_name, handle, brain_status)
  VALUES
    (v_user, 'CTS One', 'ctsone', 'training')
  RETURNING id, tts_speed INTO v_creator, v_speed;
  RETURN NEXT is(v_speed, 1.0::numeric, '1: tts_speed default is 1.0');

  -- 2) Valid in-range update (0.85 = slower preset).
  UPDATE public.creators SET tts_speed = 0.85 WHERE id = v_creator;
  SELECT tts_speed INTO v_speed FROM public.creators WHERE id = v_creator;
  RETURN NEXT is(v_speed, 0.85::numeric, '2: tts_speed=0.85 accepted');

  -- 3) Lower bound 0.6 accepted.
  UPDATE public.creators SET tts_speed = 0.6 WHERE id = v_creator;
  SELECT tts_speed INTO v_speed FROM public.creators WHERE id = v_creator;
  RETURN NEXT is(v_speed, 0.6::numeric, '3: tts_speed=0.6 (lower bound) accepted');

  -- 4) Upper bound 1.5 accepted.
  UPDATE public.creators SET tts_speed = 1.5 WHERE id = v_creator;
  SELECT tts_speed INTO v_speed FROM public.creators WHERE id = v_creator;
  RETURN NEXT is(v_speed, 1.5::numeric, '4: tts_speed=1.5 (upper bound) accepted');

  -- 5) Below 0.6 rejected with 23514.
  BEGIN
    UPDATE public.creators SET tts_speed = 0.5 WHERE id = v_creator;
    RETURN NEXT ok(false, '5: tts_speed=0.5 should have raised 23514');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    RETURN NEXT is(v_err, '23514', '5: tts_speed=0.5 → 23514');
  END;

  -- 6) Above 1.5 rejected with 23514.
  BEGIN
    UPDATE public.creators SET tts_speed = 1.6 WHERE id = v_creator;
    RETURN NEXT ok(false, '6: tts_speed=1.6 should have raised 23514');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
    RETURN NEXT is(v_err, '23514', '6: tts_speed=1.6 → 23514');
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
