-- Audit M5: tombstone for profiles.feed_regime.
-- Mirrors algo_hooks_topic_tags_column_exists; guards against a future
-- migration dropping or renaming the column silently.
BEGIN;
SELECT plan(3);

SELECT has_column('public', 'profiles', 'feed_regime',
  '1: public.profiles.feed_regime column exists');

SELECT col_type_is('public', 'profiles', 'feed_regime', 'feed_regime',
  '2: public.profiles.feed_regime is the feed_regime enum');

-- Enum has the four documented regimes. Use a robust check via
-- pg_enum since pgTAP's enum_has_labels assertions aren't portable.
SELECT is(
  (SELECT array_agg(enumlabel::text ORDER BY enumsortorder)
     FROM pg_enum
    WHERE enumtypid = 'public.feed_regime'::regtype),
  ARRAY['A', 'B', 'C', 'D']::text[],
  '3: feed_regime enum has exactly labels A, B, C, D'
);

SELECT * FROM finish();
ROLLBACK;
