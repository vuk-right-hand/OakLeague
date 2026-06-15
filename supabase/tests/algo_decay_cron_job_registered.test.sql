-- 0613-02: nightly decay job registered in pg_cron. Mirrors
-- algo_retention_cron_jobs_registered (safe precondition: any environment
-- that ran 20260504000007 has pg_cron).
BEGIN;
SELECT plan(3);

SELECT is(
  (SELECT count(*)::int FROM cron.job WHERE jobname = 'hook_global_stats_decay_daily'),
  1,
  '1: hook_global_stats_decay_daily registered'
);

SELECT is(
  (SELECT schedule FROM cron.job WHERE jobname = 'hook_global_stats_decay_daily'),
  '47 3 * * *',
  '2: schedule = 03:47 UTC daily'
);

SELECT ok(
  (SELECT active FROM cron.job WHERE jobname = 'hook_global_stats_decay_daily'),
  '3: job active'
);

SELECT * FROM finish();
ROLLBACK;
