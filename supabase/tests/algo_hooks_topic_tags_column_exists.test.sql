-- §9.8 / NC2 tombstone: assert hooks.topic_tags column exists with the
-- expected shape. Guards against a future migration rename breaking the
-- rollup trigger (migration 6) silently.
BEGIN;
SELECT plan(2);

SELECT has_column('public', 'hooks', 'topic_tags',
  '1: public.hooks.topic_tags column exists');

SELECT col_type_is('public', 'hooks', 'topic_tags', 'text[]',
  '2: public.hooks.topic_tags is text[]');

SELECT * FROM finish();
ROLLBACK;
