-- §4.7: every admin_algo_* function and the private narrative helper must:
--   • be SECURITY DEFINER (prosecdef = true) — admin guard bypasses RLS
--     on cross-user reads only when SECURITY DEFINER + owner has bypass.
--   • be owned by a role that bypasses RLS — never authenticated/anon
--     (those roles have RLS applied even from inside SECURITY DEFINER).
--
-- Environment-portable check (replaces the manual deploy-checklist step
-- from v4 — proowner is captured at migration apply time, not runtime).
BEGIN;
SELECT plan(2);

SELECT is(
  (SELECT count(*)::int
     FROM pg_proc
    WHERE proname IN (
      'admin_algo_log_inspector_view',
      'admin_algo_user_summary',
      'admin_algo_top_topics',
      'admin_algo_top_creators',
      'admin_algo_funnel_7d',
      'admin_algo_recent_events',
      'admin_algo_score_explain'
    )
      AND prosecdef = true
      AND proowner::regrole::text NOT IN ('authenticated', 'anon')),
  7,
  '1: all 7 admin_algo_* functions are SECURITY DEFINER + owned by RLS-bypassing role'
);

SELECT is(
  (SELECT count(*)::int
     FROM pg_proc
    WHERE proname = '_admin_algo_narrative_from_breakdown'
      AND proowner::regrole::text NOT IN ('authenticated', 'anon')),
  1,
  '2: narrative helper owned by RLS-bypassing role'
);

SELECT * FROM finish();
ROLLBACK;
