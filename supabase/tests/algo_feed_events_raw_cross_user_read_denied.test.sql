-- §9.1 RLS: user A cannot read user B's feed_events_raw rows.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user_a uuid := tests.create_auth_user('algo-rls-a@test');
  v_user_b uuid := tests.create_auth_user('algo-rls-b@test');
BEGIN
  -- Insert events as superuser (bypassing the SECURITY DEFINER ingest path).
  INSERT INTO public.feed_events_raw
    (user_id, event_name, idempotency_key, payload)
  VALUES
    (v_user_a, 'hook_impression', gen_random_uuid(), '{}'::jsonb),
    (v_user_b, 'hook_impression', gen_random_uuid(), '{}'::jsonb);

  -- As user A, only A's row is visible.
  PERFORM tests.set_authenticated(v_user_a);
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.feed_events_raw),
    1,
    '1: user A sees 1 row (their own)'
  );

  -- As user B, only B's row is visible.
  PERFORM tests.set_authenticated(v_user_b);
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.feed_events_raw),
    1,
    '2: user B sees 1 row (their own)'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
