-- T-D7-11: cron.job has both retention purges registered with the planned
-- schedules. Build-audit S4: with the §1.1 precondition, this test is now
-- safe to add — any environment that ran 20260504000007 must have pg_cron
-- (the migration would have failed otherwise).
--
-- Catches a future migration accidentally dropping one of the schedules.
BEGIN;
SELECT plan(4);

SELECT is(
  (SELECT count(*)::int FROM cron.job
    WHERE jobname IN ('feed_events_raw_purge', 'anon_feed_sessions_purge')),
  2,
  '1: both retention cron jobs registered'
);

SELECT is(
  (SELECT schedule FROM cron.job WHERE jobname = 'feed_events_raw_purge'),
  '0 9 * * *',
  '2: feed_events_raw_purge schedule = 09:00 UTC daily'
);

SELECT is(
  (SELECT schedule FROM cron.job WHERE jobname = 'anon_feed_sessions_purge'),
  '0 10 * * *',
  '3: anon_feed_sessions_purge schedule = 10:00 UTC daily'
);

SELECT is(
  (SELECT count(*)::int FROM cron.job
    WHERE jobname IN ('feed_events_raw_purge', 'anon_feed_sessions_purge')
      AND active = true),
  2,
  '4: both jobs active'
);

SELECT * FROM finish();
ROLLBACK;
