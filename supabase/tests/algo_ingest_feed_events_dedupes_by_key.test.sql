-- §9.2: ingest_feed_events dedupes by (user_id, event_name, idempotency_key).
-- Second call with same key returns deduped=1; raw table has exactly 1 row.
BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-dedupe@test');
  v_key  uuid := gen_random_uuid();
  v_batch jsonb := jsonb_build_array(jsonb_build_object(
    'event_name',      'hook_impression',
    'idempotency_key', v_key::text,
    'payload',         '{}'::jsonb
  ));
  v_inserted int;
  v_deduped  int;
BEGIN
  PERFORM tests.set_authenticated(v_user);

  SELECT inserted, deduped INTO v_inserted, v_deduped
    FROM public.ingest_feed_events(v_batch);
  RETURN NEXT is(v_inserted, 1, '1: first call inserts 1 row');
  RETURN NEXT is(v_deduped,  0, '2: first call has 0 dedupes');

  SELECT inserted, deduped INTO v_inserted, v_deduped
    FROM public.ingest_feed_events(v_batch);
  RETURN NEXT is(v_inserted, 0, '3: second call with same key inserts 0');
  RETURN NEXT is(v_deduped,  1, '4: second call reports deduped=1');

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
