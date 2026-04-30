-- T-D7-6: enum-drift snapshot for feed_event_name. Forces a forced review
-- of the `event_name <> 'mic_tap'` predicate in purge_feed_events_raw any
-- time the enum changes.
--
-- IF THIS FAILS: a new feed_event_name value was added. AUDIT
-- purge_feed_events_raw before updating the snapshot:
--
--   (a) If the new event IS north-star (deserves forever-retention like
--       mic_tap): add it to the predicate in purge_feed_events_raw —
--       AND event_name NOT IN ('mic_tap', '<new>') — and update the
--       array literal below to match the new enum order.
--
--   (b) If the new event is normal-retention (90d sweep applies): just
--       extend the array literal below to include it. No purge change
--       needed; the existing predicate already retains-then-deletes
--       any non-mic_tap event after 90 days.
BEGIN;
SELECT plan(1);

SELECT is(
  enum_range(NULL::feed_event_name),
  ARRAY[
    'hook_impression',
    'hook_dwell_end',
    'hook_swipe',
    'full_video_open',
    'full_video_quartile',
    'creator_carousel_open',
    'creator_carousel_hook_open',
    'mic_tap'
  ]::feed_event_name[],
  '1: feed_event_name enum matches snapshot — see comment block for recovery menu'
);

SELECT * FROM finish();
ROLLBACK;
