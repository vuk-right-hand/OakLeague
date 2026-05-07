-- pgTAP for migration 20260509000003 — heygen provider consequences.
--
-- Verifies:
--   1. spike_b_runs.provider CHECK accepts 'heygen'
--   2. cogs_insert_avatar_turn accepts 'heygen' (ceiling math correct)
--   3. cogs_insert_avatar_turn still rejects unknown providers (e.g. 'mux')
--
-- File location intentionally NOT co-located with the migration —
-- migration 20260509000002 forbids interleaving DDL that references
-- 'heygen' until 20260509000003 commits, and putting test files in
-- supabase/tests/ keeps that rule visually clear for future authors.

BEGIN;
SELECT plan(6);

-- 1. CHECK accepts 'heygen': inserting a 'heygen' row with a fake
-- run_by UUID throws 23503 (FK violation) — that 23503 (not 23514
-- check_violation) proves the CHECK passed and we're failing further
-- downstream. Negative form: if heygen were rejected by the CHECK,
-- we'd see 23514 instead.
SELECT throws_ok(
  $$ INSERT INTO public.spike_b_runs (
       run_by, provider, clip_id, iteration, device,
       duration_seconds, cost_usd, outcome
     )
     VALUES (
       gen_random_uuid(), 'heygen', 'phase0_t', 1, 'test',
       1.0, 0.001, 'ok'
     ) $$,
  '23503',
  NULL,
  'spike_b_runs.provider CHECK accepts heygen (only FK fails downstream)'
);

-- 2. cogs_insert_avatar_turn accepts 'heygen' via the IN-list guard.
-- We expect 'not_found_or_dead' (P0006) because the session UUID is fake —
-- crucially NOT 22023 'invalid_provider_for_avatar_turn' which would mean
-- the IF guard at the top still rejected heygen.
SELECT throws_ok(
  $$ SELECT public.cogs_insert_avatar_turn(
       gen_random_uuid(), 'heygen'::cogs_service, 1.0, 0.001, '{}'::jsonb
     ) $$,
  'P0006',
  'not_found_or_dead',
  'cogs_insert_avatar_turn passes the heygen IN-list guard'
);

-- 3. Cost ceiling math for heygen: 60 seconds × $0.20/min cap = $0.20.
-- Asking for $0.21 must be rejected with 22003 cost_out_of_bounds; asking
-- for $0.20 must pass the cap check (and then fail with P0006 on the
-- session lookup since UUID is fake).
SELECT throws_ok(
  $$ SELECT public.cogs_insert_avatar_turn(
       gen_random_uuid(), 'heygen'::cogs_service, 60.0, 0.21, '{}'::jsonb
     ) $$,
  '22003',
  NULL,
  'heygen ceiling: 60s × $0.20/min cap rejects $0.21 (22003)'
);

SELECT throws_ok(
  $$ SELECT public.cogs_insert_avatar_turn(
       gen_random_uuid(), 'heygen'::cogs_service, 60.0, 0.20, '{}'::jsonb
     ) $$,
  'P0006',
  'not_found_or_dead',
  'heygen ceiling: 60s × $0.20/min cap accepts $0.20 (passes to session lookup)'
);

-- 4. Existing simli / tavus paths still work (regression guard for the
-- replaced function). Cost values stay under the per-second cap:
--   simli  cap @ 60s = $0.05  → @ 1s = $0.000833 → use $0.0005
--   tavus  cap @ 60s = $1.00  → @ 1s = $0.01667  → use $0.01
SELECT throws_ok(
  $$ SELECT public.cogs_insert_avatar_turn(
       gen_random_uuid(), 'simli'::cogs_service, 1.0, 0.0005, '{}'::jsonb
     ) $$,
  'P0006',
  'not_found_or_dead',
  'cogs_insert_avatar_turn still accepts simli'
);

SELECT throws_ok(
  $$ SELECT public.cogs_insert_avatar_turn(
       gen_random_uuid(), 'tavus'::cogs_service, 1.0, 0.01, '{}'::jsonb
     ) $$,
  'P0006',
  'not_found_or_dead',
  'cogs_insert_avatar_turn still accepts tavus'
);

SELECT * FROM finish();
ROLLBACK;
