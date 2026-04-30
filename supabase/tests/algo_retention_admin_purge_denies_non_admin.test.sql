-- T-D7-10: admin_purge_* and admin_retention_recent_runs reject non-admin
-- callers with SQLSTATE 42501. Even with EXECUTE granted to authenticated,
-- the function body re-asserts admin_roles before doing any work.
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('d7-non-admin@test');
  v_caught_err text;
BEGIN
  PERFORM tests.set_authenticated(v_user);

  -- admin_purge_feed_events_raw
  BEGIN
    PERFORM public.admin_purge_feed_events_raw();
    v_caught_err := 'NO_ERROR';
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught_err := SQLSTATE;
  END;
  RETURN NEXT is(v_caught_err, '42501',
    '1: admin_purge_feed_events_raw rejects non-admin with 42501');

  -- admin_purge_anon_feed_sessions
  BEGIN
    PERFORM public.admin_purge_anon_feed_sessions();
    v_caught_err := 'NO_ERROR';
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught_err := SQLSTATE;
  END;
  RETURN NEXT is(v_caught_err, '42501',
    '2: admin_purge_anon_feed_sessions rejects non-admin with 42501');

  -- admin_retention_recent_runs
  BEGIN
    PERFORM public.admin_retention_recent_runs(50);
    v_caught_err := 'NO_ERROR';
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught_err := SQLSTATE;
  END;
  RETURN NEXT is(v_caught_err, '42501',
    '3: admin_retention_recent_runs rejects non-admin with 42501');

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
