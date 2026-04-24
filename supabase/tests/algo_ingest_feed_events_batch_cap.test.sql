-- §9.2: ingest_feed_events batch boundary.
-- 51 events → rejected with SQLSTATE 22023.
-- 50 events → accepted (audit S1 — proves the boundary hasn't slipped to
-- >= 50 in a future refactor).
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-batchcap@test');
  v_arr  jsonb := '[]'::jsonb;
  v_inserted int;
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

  -- S1: 50 events succeed. Rebuild v_arr at exactly 50.
  v_arr := '[]'::jsonb;
  FOR i IN 1..50 LOOP
    v_arr := v_arr || jsonb_build_array(jsonb_build_object(
      'event_name',      'hook_impression',
      'idempotency_key', gen_random_uuid()::text,
      'payload',         '{}'::jsonb
    ));
  END LOOP;
  SELECT inserted INTO v_inserted FROM public.ingest_feed_events(v_arr);
  RETURN NEXT is(v_inserted, 50, '2: 50-event batch accepted (inserted = 50)');

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
