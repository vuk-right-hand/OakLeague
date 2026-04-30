-- T-D7-5: full grant matrix for D7 retention functions.
--
-- Negative (raw purge functions): anon, authenticated, service_role MUST NOT
-- have EXECUTE — destructive primitives are postgres-only. Round-3 M4 fix.
--
-- Positive (admin wrappers + read RPC): authenticated MUST have EXECUTE
-- (body asserts admin_roles); anon MUST NOT. Guards against future REVOKE
-- accidents on the wrappers. Round-4 S1 fix.
--
-- Cannot use SET ROLE inside a pgTAP function (server crashes on some
-- supabase local builds — see admin_algo_rpcs_deny_anon.test.sql:5-8).
-- Instead, assert proacl via has_function_privilege.
BEGIN;
SELECT plan(18);

-- Negative on raw purges: anon + authenticated + service_role denied.
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'purge_feed_events_raw'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  0,
  '1: anon has no EXECUTE on purge_feed_events_raw'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'purge_feed_events_raw'
      AND has_function_privilege('authenticated', oid, 'EXECUTE')),
  0,
  '2: authenticated has no EXECUTE on purge_feed_events_raw'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'purge_feed_events_raw'
      AND has_function_privilege('service_role', oid, 'EXECUTE')),
  0,
  '3: service_role has no EXECUTE on purge_feed_events_raw (round-3 M4)'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'purge_anon_feed_sessions'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  0,
  '4: anon has no EXECUTE on purge_anon_feed_sessions'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'purge_anon_feed_sessions'
      AND has_function_privilege('authenticated', oid, 'EXECUTE')),
  0,
  '5: authenticated has no EXECUTE on purge_anon_feed_sessions'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'purge_anon_feed_sessions'
      AND has_function_privilege('service_role', oid, 'EXECUTE')),
  0,
  '6: service_role has no EXECUTE on purge_anon_feed_sessions (round-3 M4)'
);

-- Positive on admin wrappers: authenticated has EXECUTE; anon does not.
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'admin_purge_feed_events_raw'
      AND has_function_privilege('authenticated', oid, 'EXECUTE')),
  1,
  '7: authenticated HAS EXECUTE on admin_purge_feed_events_raw (body asserts admin)'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'admin_purge_feed_events_raw'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  0,
  '8: anon has no EXECUTE on admin_purge_feed_events_raw'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'admin_purge_anon_feed_sessions'
      AND has_function_privilege('authenticated', oid, 'EXECUTE')),
  1,
  '9: authenticated HAS EXECUTE on admin_purge_anon_feed_sessions'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'admin_purge_anon_feed_sessions'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  0,
  '10: anon has no EXECUTE on admin_purge_anon_feed_sessions'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'admin_retention_recent_runs'
      AND has_function_privilege('authenticated', oid, 'EXECUTE')),
  1,
  '11: authenticated HAS EXECUTE on admin_retention_recent_runs'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'admin_retention_recent_runs'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  0,
  '12: anon has no EXECUTE on admin_retention_recent_runs'
);

-- retention_run_log table itself: service-role-only (RLS enabled, zero policies).
SELECT is(
  (SELECT relrowsecurity::int
     FROM pg_class
    WHERE relname = 'retention_run_log' AND relnamespace = 'public'::regnamespace),
  1,
  '13: retention_run_log has RLS enabled'
);
SELECT is(
  (SELECT count(*)::int FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'retention_run_log'),
  0,
  '14: retention_run_log has zero RLS policies (service-role only)'
);
SELECT is(
  (SELECT has_table_privilege('authenticated', 'public.retention_run_log', 'SELECT')::int),
  0,
  '15: authenticated cannot SELECT retention_run_log directly (must go through RPC)'
);

-- Build-audit M1: Supabase grants service_role full DML on every public.*
-- table by default. Must REVOKE explicitly. Negative assertions for SELECT,
-- INSERT, DELETE.
SELECT is(
  (SELECT has_table_privilege('service_role', 'public.retention_run_log', 'SELECT')::int),
  0,
  '16: service_role cannot SELECT retention_run_log (build-audit M1)'
);
SELECT is(
  (SELECT has_table_privilege('service_role', 'public.retention_run_log', 'INSERT')::int),
  0,
  '17: service_role cannot INSERT retention_run_log (build-audit M1)'
);
SELECT is(
  (SELECT has_table_privilege('service_role', 'public.retention_run_log', 'DELETE')::int),
  0,
  '18: service_role cannot DELETE retention_run_log (build-audit M1)'
);

SELECT * FROM finish();
ROLLBACK;
