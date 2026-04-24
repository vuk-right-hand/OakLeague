-- §9.1 RLS: hook_global_stats has zero authenticated/anon policies.
BEGIN;
SELECT plan(3);

-- RLS enabled.
SELECT ok(
  (SELECT relrowsecurity FROM pg_class
    WHERE oid = 'public.hook_global_stats'::regclass),
  '1: RLS enabled on hook_global_stats'
);

-- No policies at all.
SELECT is(
  (SELECT count(*)::int FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'hook_global_stats'),
  0,
  '2: hook_global_stats has zero RLS policies'
);

-- authenticated + anon have no SELECT privileges.
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.hook_global_stats', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.hook_global_stats', 'SELECT'),
  '3: authenticated/anon cannot SELECT hook_global_stats'
);

SELECT * FROM finish();
ROLLBACK;
