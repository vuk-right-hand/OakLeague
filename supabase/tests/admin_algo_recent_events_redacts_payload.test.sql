-- recent_events.payload_safe is a whitelist projection — non-whitelisted
-- keys are dropped. Sensitive client-side keys never reach admin UI raw.
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-redact-admin@test');
  v_user  uuid := tests.create_auth_user('algo-redact-user@test');
  v_safe  jsonb;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-redact-admin@test', 'superadmin');

  INSERT INTO public.feed_events_raw (user_id, event_name, idempotency_key, payload)
    VALUES (v_user, 'hook_dwell_end', gen_random_uuid(),
            jsonb_build_object(
              'completion_pct',          0.85,
              'secret_field',            'do not expose',
              'tracking_id',             'pii-leak',
              'mic_tap_outcome',         'session_opened'
            ));

  PERFORM tests.set_authenticated(v_admin);
  SELECT payload_safe INTO v_safe
    FROM public.admin_algo_recent_events(v_user, 50)
   LIMIT 1;

  RETURN NEXT ok(
    NOT (v_safe ? 'secret_field'),
    '1: secret_field stripped from payload_safe'
  );
  RETURN NEXT ok(
    NOT (v_safe ? 'tracking_id'),
    '2: tracking_id stripped from payload_safe'
  );
  RETURN NEXT ok(
    v_safe ? 'completion_pct',
    '3: whitelisted completion_pct retained'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
