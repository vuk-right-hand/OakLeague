-- secdef grant-leak guard (2026-06-01 incident rule): every Growth & Minutes
-- Economy SECURITY DEFINER fn that can read/write balance MUST be service_role
-- only — never EXECUTE-able by anon or authenticated. Asserted via
-- has_function_privilege (NOT SET ROLE — segfaults pgTAP per project_pg17_secdef_role_segfault).
-- Growth & Minutes Economy Phase 1 (migrations 20260615000001/000002) +
-- Phase 7 reconcile fns (migration 20260616000001).
BEGIN;
SELECT plan(21);

-- ── authenticated MUST NOT have EXECUTE ──────────────────────────────────────
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='minute_grant_insert'
  AND has_function_privilege('authenticated', oid, 'EXECUTE')), 0,
  '1: authenticated denied minute_grant_insert');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='voice_balance_check'
  AND has_function_privilege('authenticated', oid, 'EXECUTE')), 0,
  '2: authenticated denied voice_balance_check (no balance oracle, R1-S3)');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='voice_usage_record_v2'
  AND has_function_privilege('authenticated', oid, 'EXECUTE')), 0,
  '3: authenticated denied voice_usage_record_v2');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='voice_fuse_anchor_apply'
  AND has_function_privilege('authenticated', oid, 'EXECUTE')), 0,
  '4: authenticated denied voice_fuse_anchor_apply');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='monthly_window_start'
  AND has_function_privilege('authenticated', oid, 'EXECUTE')), 0,
  '5: authenticated denied monthly_window_start');

-- ── anon MUST NOT have EXECUTE ───────────────────────────────────────────────
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='minute_grant_insert'
  AND has_function_privilege('anon', oid, 'EXECUTE')), 0,
  '6: anon denied minute_grant_insert');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='voice_balance_check'
  AND has_function_privilege('anon', oid, 'EXECUTE')), 0,
  '7: anon denied voice_balance_check');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='voice_usage_record_v2'
  AND has_function_privilege('anon', oid, 'EXECUTE')), 0,
  '8: anon denied voice_usage_record_v2');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='voice_fuse_anchor_apply'
  AND has_function_privilege('anon', oid, 'EXECUTE')), 0,
  '9: anon denied voice_fuse_anchor_apply');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='monthly_window_start'
  AND has_function_privilege('anon', oid, 'EXECUTE')), 0,
  '10: anon denied monthly_window_start');

-- ── service_role MUST RETAIN EXECUTE (the legit caller) ──────────────────────
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='minute_grant_insert'
  AND NOT has_function_privilege('service_role', oid, 'EXECUTE')), 0,
  '11: service_role retains minute_grant_insert');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='voice_balance_check'
  AND NOT has_function_privilege('service_role', oid, 'EXECUTE')), 0,
  '12: service_role retains voice_balance_check');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='voice_usage_record_v2'
  AND NOT has_function_privilege('service_role', oid, 'EXECUTE')), 0,
  '13: service_role retains voice_usage_record_v2');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='voice_fuse_anchor_apply'
  AND NOT has_function_privilege('service_role', oid, 'EXECUTE')), 0,
  '14: service_role retains voice_fuse_anchor_apply');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='monthly_window_start'
  AND NOT has_function_privilege('service_role', oid, 'EXECUTE')), 0,
  '15: service_role retains monthly_window_start');

-- ── Phase 7 reconcile fns: service-role only (no balance/PII oracle) ─────────
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='minutes_reconcile_summary'
  AND has_function_privilege('authenticated', oid, 'EXECUTE')), 0,
  '16: authenticated denied minutes_reconcile_summary');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='minutes_reconcile_violations'
  AND has_function_privilege('authenticated', oid, 'EXECUTE')), 0,
  '17: authenticated denied minutes_reconcile_violations');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='minutes_reconcile_summary'
  AND has_function_privilege('anon', oid, 'EXECUTE')), 0,
  '18: anon denied minutes_reconcile_summary');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='minutes_reconcile_violations'
  AND has_function_privilege('anon', oid, 'EXECUTE')), 0,
  '19: anon denied minutes_reconcile_violations');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='minutes_reconcile_summary'
  AND NOT has_function_privilege('service_role', oid, 'EXECUTE')), 0,
  '20: service_role retains minutes_reconcile_summary');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='minutes_reconcile_violations'
  AND NOT has_function_privilege('service_role', oid, 'EXECUTE')), 0,
  '21: service_role retains minutes_reconcile_violations');

SELECT * FROM finish();
ROLLBACK;
