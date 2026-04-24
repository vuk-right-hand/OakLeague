-- §9.8 / NC4 tombstone: there is NO function named log_scored_impressions.
-- The admin score_explain surface (D6) calls compute_hook_score() live; no
-- replay table. Guards against a future refactor re-introducing the
-- undefined reference that C4's plan removed.
BEGIN;
SELECT plan(1);

SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'log_scored_impressions'),
  0,
  '1: no function named log_scored_impressions exists (NC4 tombstone)'
);

SELECT * FROM finish();
ROLLBACK;
