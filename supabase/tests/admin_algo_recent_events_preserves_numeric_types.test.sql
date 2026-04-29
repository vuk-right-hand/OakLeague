-- recent_events.payload_safe preserves jsonb number type for numeric keys
-- (uses payload->'k' not payload->>'k' under the typeof guard). M1 fix.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-rep-admin@test');
  v_user  uuid := tests.create_auth_user('algo-rep-user@test');
  v_safe  jsonb;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-rep-admin@test', 'superadmin');

  INSERT INTO public.feed_events_raw (user_id, event_name, idempotency_key, payload)
    VALUES (v_user, 'hook_dwell_end', gen_random_uuid(),
            jsonb_build_object('completion_pct', 0.85));

  PERFORM tests.set_authenticated(v_admin);
  SELECT payload_safe INTO v_safe
    FROM public.admin_algo_recent_events(v_user, 50)
   LIMIT 1;

  RETURN NEXT is(
    jsonb_typeof(v_safe->'completion_pct'),
    'number',
    '1: completion_pct preserved as jsonb number'
  );
  RETURN NEXT is(
    (v_safe->>'completion_pct')::real,
    0.85::real,
    '2: numeric value round-trips correctly'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
