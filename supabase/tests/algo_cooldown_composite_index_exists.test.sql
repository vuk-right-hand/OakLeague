-- §9.8 / NM3: the composite index supporting the cooldown CTE's correlated
-- NOT EXISTS on (user_id, video_id, event_name) must exist. Without it the
-- feed_ranked_page per-call cost is a full-range scan.
--
-- We do NOT EXPLAIN feed_ranked_page here: the plpgsql wrapper shows only
-- a Function Scan node, and the inner CTE plan requires seeded data to
-- prefer the index over a seq scan. Schema-existence is the tightest
-- assertion we can make at test time; the actual EXPLAIN check belongs in
-- a perf-validation script outside the pgTAP suite.
BEGIN;
SELECT plan(2);

SELECT has_index('public', 'feed_events_raw',
  'feed_events_raw_user_video_event_idx',
  '1: NM3 composite index exists');

SELECT ok(
  (SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'feed_events_raw'
      AND indexname = 'feed_events_raw_user_video_event_idx')
    LIKE '%user_id%video_id%event_name%',
  '2: index covers (user_id, video_id, event_name)'
);

SELECT * FROM finish();
ROLLBACK;
