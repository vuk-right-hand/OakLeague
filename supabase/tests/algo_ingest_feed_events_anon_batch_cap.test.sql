-- §9.8 / NC1: ingest_feed_events_anon rejects batches > 50 events.
-- SQLSTATE 22023 (invalid_parameter_value) → 400 in the API route.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_anon_id uuid := gen_random_uuid();
  v_arr     jsonb := '[]'::jsonb;
  i int;
BEGIN
  INSERT INTO public.anon_feed_sessions (anon_id) VALUES (v_anon_id);

  FOR i IN 1..51 LOOP
    v_arr := v_arr || jsonb_build_array(jsonb_build_object(
      'event_name', 'hook_impression',
      'payload', '{}'::jsonb
    ));
  END LOOP;

  RETURN NEXT throws_ok(
    format('SELECT public.ingest_feed_events_anon(%L, %L::jsonb)', v_anon_id, v_arr::text),
    '22023',
    'batch too large (max 50)',
    '1: 51-event batch rejected with SQLSTATE 22023'
  );

  -- 50-event batch accepted.
  v_arr := '[]'::jsonb;
  FOR i IN 1..50 LOOP
    v_arr := v_arr || jsonb_build_array(jsonb_build_object(
      'event_name', 'hook_impression',
      'payload', '{}'::jsonb
    ));
  END LOOP;
  PERFORM public.ingest_feed_events_anon(v_anon_id, v_arr);
  RETURN NEXT ok(true, '2: 50-event batch accepted (no exception)');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
