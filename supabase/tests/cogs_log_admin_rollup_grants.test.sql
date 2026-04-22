-- R2-M2: cogs_log_admin_rollup is owner-only. Every client role (PUBLIC,
-- anon, authenticated) must be denied SELECT.
BEGIN;
SELECT plan(3);

SET LOCAL role anon;
SELECT throws_like(
  $$ SELECT count(*) FROM public.cogs_log_admin_rollup $$,
  '%permission%',
  'anon SELECT on cogs_log_admin_rollup blocked'
);

SET LOCAL role authenticated;
SELECT throws_like(
  $$ SELECT count(*) FROM public.cogs_log_admin_rollup $$,
  '%permission%',
  'authenticated SELECT on cogs_log_admin_rollup blocked'
);

RESET role;

-- Sanity: service_role is not explicitly granted either but Supabase allows it
-- to bypass. Postgres superuser does too. We only care that client roles are
-- denied — assert ownership.
SELECT is(
  (SELECT relowner::regrole::text FROM pg_class
    WHERE relname = 'cogs_log_admin_rollup' AND relkind = 'm'),
  'postgres',
  'cogs_log_admin_rollup owner is postgres'
);

SELECT * FROM finish();
ROLLBACK;
