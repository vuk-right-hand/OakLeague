-- §9.4 / M5: cooldown is an on-the-fly CTE, not a materialized view.
-- Asserting no user_hook_cooldowns MV exists guards against a future
-- "let's cache this for perf" change that would re-introduce the
-- staleness trap M5 protects against.
BEGIN;
SELECT plan(1);

SELECT is(
  (SELECT count(*)::int FROM pg_matviews
    WHERE schemaname = 'public' AND matviewname = 'user_hook_cooldowns'),
  0,
  '1: no materialized view named user_hook_cooldowns exists (M5)'
);

SELECT * FROM finish();
ROLLBACK;
