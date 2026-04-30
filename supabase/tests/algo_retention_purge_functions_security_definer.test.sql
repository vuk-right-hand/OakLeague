-- T-D7-8: raw purge functions are SECURITY DEFINER (prosecdef = true) and
-- owned by the privileged role. Round-3 C1 / Round-2 C4 fix.
--
-- Owner is asserted as either 'postgres' (local Supabase + most hosted
-- configurations) or 'supabase_admin' (some hosted Supabase managed-Postgres
-- variants re-own SECURITY DEFINER functions to supabase_admin). Test passes
-- on both surfaces; do not lock to a single role name.
BEGIN;
SELECT plan(6);

-- prosecdef = true on both raw purges.
SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE proname = 'purge_feed_events_raw'),
  true,
  '1: purge_feed_events_raw is SECURITY DEFINER'
);
SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE proname = 'purge_anon_feed_sessions'),
  true,
  '2: purge_anon_feed_sessions is SECURITY DEFINER'
);

-- Owner role is one of the privileged candidates.
SELECT ok(
  (SELECT rolname FROM pg_roles
    WHERE oid = (SELECT proowner FROM pg_proc WHERE proname = 'purge_feed_events_raw'))
    IN ('postgres', 'supabase_admin'),
  '3: purge_feed_events_raw owner is postgres or supabase_admin'
);
SELECT ok(
  (SELECT rolname FROM pg_roles
    WHERE oid = (SELECT proowner FROM pg_proc WHERE proname = 'purge_anon_feed_sessions'))
    IN ('postgres', 'supabase_admin'),
  '4: purge_anon_feed_sessions owner is postgres or supabase_admin'
);

-- Admin wrappers also SECURITY DEFINER (so they can write admin_audit_log
-- and call the postgres-owned raw purge).
SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE proname = 'admin_purge_feed_events_raw'),
  true,
  '5: admin_purge_feed_events_raw is SECURITY DEFINER'
);
SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE proname = 'admin_purge_anon_feed_sessions'),
  true,
  '6: admin_purge_anon_feed_sessions is SECURITY DEFINER'
);

SELECT * FROM finish();
ROLLBACK;
