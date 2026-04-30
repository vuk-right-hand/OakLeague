-- T-D7-12: build-audit B1 regression — SET LOCAL lock_timeout MUST appear
-- BEFORE the pg_advisory_xact_lock call in both purge function bodies.
-- Without this ordering, the advisory-lock acquisition uses whatever
-- lock_timeout the session inherited (typically 0 = unbounded), so an admin
-- click during cron's purge window would hang up to statement_timeout
-- (30min) holding a pooled connection.
--
-- True cross-session lock-contention test would require dblink (not
-- installed) or pg_background. PostgreSQL advisory locks are re-entrant
-- within the same backend, so a single-session pgTAP test cannot simulate
-- the failure mode behaviorally. We do the next-best thing: structural
-- assertion on pg_proc.prosrc — the SET LOCAL line must appear before the
-- PERFORM pg_advisory_xact_lock line. Catches a future refactor that
-- accidentally swaps the order.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.assert_lock_timeout_before_advisory(p_proname text)
RETURNS text LANGUAGE plpgsql AS $fn$
DECLARE
  v_src text;
  v_lock_timeout_pos int;
  v_advisory_pos int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = p_proname;
  IF v_src IS NULL THEN
    RETURN 'function ' || p_proname || ' not found';
  END IF;
  -- Match the actual SQL call sites, not the comment text that documents them
  -- (comments mention these strings in the explanatory header).
  v_lock_timeout_pos := position('SET LOCAL lock_timeout' in v_src);
  v_advisory_pos     := position('PERFORM pg_advisory_xact_lock' in v_src);
  IF v_lock_timeout_pos = 0 THEN
    RETURN 'SET LOCAL lock_timeout missing from ' || p_proname;
  END IF;
  IF v_advisory_pos = 0 THEN
    RETURN 'pg_advisory_xact_lock missing from ' || p_proname;
  END IF;
  IF v_lock_timeout_pos < v_advisory_pos THEN
    RETURN 'OK';
  END IF;
  RETURN format('ORDERING WRONG in %s: lock_timeout at %s, advisory at %s',
                p_proname, v_lock_timeout_pos, v_advisory_pos);
END;
$fn$;

SELECT is(
  pg_temp.assert_lock_timeout_before_advisory('purge_feed_events_raw'),
  'OK',
  '1: purge_feed_events_raw — SET LOCAL lock_timeout precedes pg_advisory_xact_lock'
);

SELECT is(
  pg_temp.assert_lock_timeout_before_advisory('purge_anon_feed_sessions'),
  'OK',
  '2: purge_anon_feed_sessions — SET LOCAL lock_timeout precedes pg_advisory_xact_lock'
);

SELECT * FROM finish();
ROLLBACK;
