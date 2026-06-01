-- Whole-build audit C1/H1 guard: the v2/v3 retrieval RPCs are SECURITY DEFINER +
-- trust a caller-supplied creator_id, so they MUST NOT be EXECUTE-able by
-- `authenticated` (or anon) — only service_role. A grant to authenticated +
-- PostgREST public-schema exposure = any logged-in user reads any creator's
-- verbatim corpus by passing an arbitrary creator_id. The v1 RPC got this right;
-- v2/v3 regressed (migration 20260601000001 revoked it). This pins it so a future
-- CREATE OR REPLACE that re-adds `TO ... authenticated` trips here.
--
-- Pattern (per algo_retention_purge_functions_grant_matrix.test.sql): assert via
-- has_function_privilege, NOT SET ROLE (crashes pgTAP on some local builds).

BEGIN;
SELECT plan(18);

-- helper: every overload of proname must satisfy the privilege predicate.
-- We assert count of overloads WHERE authenticated HAS execute = 0, and
-- count WHERE service_role HAS execute = (total overloads).

-- ── authenticated MUST NOT have EXECUTE (the C1/H1 fix) ──────────────────────
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='creator_knowledge_topk_v2'
  AND has_function_privilege('authenticated', oid, 'EXECUTE')), 0,
  '1: authenticated denied creator_knowledge_topk_v2');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='_creator_knowledge_topk_v3'
  AND has_function_privilege('authenticated', oid, 'EXECUTE')), 0,
  '2: authenticated denied _creator_knowledge_topk_v3');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='_creator_route_sections_v3'
  AND has_function_privilege('authenticated', oid, 'EXECUTE')), 0,
  '3: authenticated denied _creator_route_sections_v3');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='_creator_active_section_ids_v3'
  AND has_function_privilege('authenticated', oid, 'EXECUTE')), 0,
  '4: authenticated denied _creator_active_section_ids_v3');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='_fetch_active_parents_v3'
  AND has_function_privilege('authenticated', oid, 'EXECUTE')), 0,
  '5: authenticated denied _fetch_active_parents_v3');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='creator_v3_ready'
  AND has_function_privilege('authenticated', oid, 'EXECUTE')), 0,
  '6: authenticated denied creator_v3_ready (H1)');

-- ── anon MUST NOT have EXECUTE ───────────────────────────────────────────────
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='creator_knowledge_topk_v2'
  AND has_function_privilege('anon', oid, 'EXECUTE')), 0,
  '7: anon denied creator_knowledge_topk_v2');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='_creator_knowledge_topk_v3'
  AND has_function_privilege('anon', oid, 'EXECUTE')), 0,
  '8: anon denied _creator_knowledge_topk_v3');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='_creator_route_sections_v3'
  AND has_function_privilege('anon', oid, 'EXECUTE')), 0,
  '9: anon denied _creator_route_sections_v3');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='_creator_active_section_ids_v3'
  AND has_function_privilege('anon', oid, 'EXECUTE')), 0,
  '10: anon denied _creator_active_section_ids_v3');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='_fetch_active_parents_v3'
  AND has_function_privilege('anon', oid, 'EXECUTE')), 0,
  '11: anon denied _fetch_active_parents_v3');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='creator_v3_ready'
  AND has_function_privilege('anon', oid, 'EXECUTE')), 0,
  '12: anon denied creator_v3_ready');

-- ── service_role MUST RETAIN EXECUTE on every overload (legit caller) ─────────
SELECT is(
  (SELECT count(*)::int FROM pg_proc WHERE proname='creator_knowledge_topk_v2'
     AND NOT has_function_privilege('service_role', oid, 'EXECUTE')), 0,
  '13: service_role retains creator_knowledge_topk_v2');
SELECT is(
  (SELECT count(*)::int FROM pg_proc WHERE proname='_creator_knowledge_topk_v3'
     AND NOT has_function_privilege('service_role', oid, 'EXECUTE')), 0,
  '14: service_role retains _creator_knowledge_topk_v3');
SELECT is(
  (SELECT count(*)::int FROM pg_proc WHERE proname='_creator_route_sections_v3'
     AND NOT has_function_privilege('service_role', oid, 'EXECUTE')), 0,
  '15: service_role retains _creator_route_sections_v3');
SELECT is(
  (SELECT count(*)::int FROM pg_proc WHERE proname='_creator_active_section_ids_v3'
     AND NOT has_function_privilege('service_role', oid, 'EXECUTE')), 0,
  '16: service_role retains _creator_active_section_ids_v3');
SELECT is(
  (SELECT count(*)::int FROM pg_proc WHERE proname='_fetch_active_parents_v3'
     AND NOT has_function_privilege('service_role', oid, 'EXECUTE')), 0,
  '17: service_role retains _fetch_active_parents_v3');
SELECT is(
  (SELECT count(*)::int FROM pg_proc WHERE proname='creator_v3_ready'
     AND NOT has_function_privilege('service_role', oid, 'EXECUTE')), 0,
  '18: service_role retains creator_v3_ready');

SELECT * FROM finish();
ROLLBACK;
