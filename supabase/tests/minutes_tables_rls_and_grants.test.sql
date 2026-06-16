-- minute_grants + voice_usage_monthly are service-role-only: RLS ENABLED + ZERO
-- policies (the actual security guarantee — denies every row to anon/authenticated
-- regardless of any default table grant, which differs local-vs-prod across the
-- 2026-10-30 Supabase default-grant change) + service_role retains full access.
-- This is the TABLE-level guard for the 2026-06-01 cross-tenant read-leak threat
-- (the rpc test covers functions). S7.
-- Growth & Minutes Economy Phase 1 (migrations 20260615000001/000002).
BEGIN;
SELECT plan(8);

-- minute_grants
SELECT is((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.minute_grants'::regclass),
  true, '1: minute_grants has RLS enabled');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname='public' AND tablename='minute_grants'),
  0, '2: minute_grants has ZERO policies (service-role only)');
SELECT is(has_table_privilege('service_role', 'public.minute_grants', 'SELECT'),
  true, '3: service_role can SELECT minute_grants');
SELECT is(has_table_privilege('service_role', 'public.minute_grants', 'INSERT'),
  true, '4: service_role can INSERT minute_grants');

-- voice_usage_monthly
SELECT is((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.voice_usage_monthly'::regclass),
  true, '5: voice_usage_monthly has RLS enabled');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname='public' AND tablename='voice_usage_monthly'),
  0, '6: voice_usage_monthly has ZERO policies');
SELECT is(has_table_privilege('service_role', 'public.voice_usage_monthly', 'SELECT'),
  true, '7: service_role can SELECT voice_usage_monthly');
SELECT is(has_table_privilege('service_role', 'public.voice_usage_monthly', 'INSERT'),
  true, '8: service_role can INSERT voice_usage_monthly');

SELECT * FROM finish();
ROLLBACK;
