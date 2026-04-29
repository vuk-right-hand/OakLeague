-- Anon role has no EXECUTE grant on admin_algo_* — call must error before
-- the function body runs (42501 / insufficient_privilege).
--
-- Cannot use SET ROLE anon inside a pgTAP function (server crashes on some
-- supabase local builds). Instead, assert the proacl directly: anon must
-- NOT appear in the EXECUTE grant list for any admin_algo_* function.
BEGIN;
SELECT plan(7);

SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'admin_algo_log_inspector_view'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  0,
  '1: anon has no EXECUTE on admin_algo_log_inspector_view'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'admin_algo_user_summary'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  0,
  '2: anon has no EXECUTE on admin_algo_user_summary'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'admin_algo_top_topics'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  0,
  '3: anon has no EXECUTE on admin_algo_top_topics'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'admin_algo_top_creators'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  0,
  '4: anon has no EXECUTE on admin_algo_top_creators'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'admin_algo_funnel_7d'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  0,
  '5: anon has no EXECUTE on admin_algo_funnel_7d'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'admin_algo_recent_events'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  0,
  '6: anon has no EXECUTE on admin_algo_recent_events'
);
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'admin_algo_score_explain'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  0,
  '7: anon has no EXECUTE on admin_algo_score_explain'
);

SELECT * FROM finish();
ROLLBACK;
