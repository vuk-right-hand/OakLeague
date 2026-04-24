-- §9.2: ingest_feed_events rejects batches > 50 with SQLSTATE 22023.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-batchcap@test');
  v_arr  jsonb := '[]'::jsonb;
  i int;
BEGIN
  PERFORM tests.set_authenticated(v_user);

  FOR i IN 1..51 LOOP
    v_arr := v_arr || jsonb_build_array(jsonb_build_object(
      'event_name',      'hook_impression',
      'idempotency_key', gen_random_uuid()::text,
      'payload',         '{}'::jsonb
    ));
  END LOOP;

  RETURN NEXT throws_ok(
    format('SELECT public.ingest_feed_events(%L::jsonb)', v_arr::text),
    '22023',
    'batch too large (max 50)',
    '1: 51-event batch rejected with SQLSTATE 22023'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
