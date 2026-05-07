-- pgTAP for migration 20260509000001 + the spike-a/ticket route fix.
--
-- Audit-found: /api/voice/spike-a/ticket inserts voice_tickets with the
-- default purpose='voice_session' AND no avatar_provider. After migration
-- 20260509000001 added the
-- voice_tickets_avatar_provider_purpose_match CHECK, that insert
-- violates 23514 and the route 500s every mint — silently breaking the
-- daily voice-pin measurement harness (CLAUDE.md hard rule: "Real-API
-- gated test for the voice provider").
--
-- This pgTAP locks in:
--   1. CHECK rejects voice_session ticket without avatar_provider (the
--      bug that final-audit C4 caught).
--   2. CHECK accepts voice_session ticket WITH avatar_provider='simli'
--      (the shape the fixed spike-a/ticket route inserts).
--   3. CHECK accepts voice_clone ticket without avatar_provider
--      (the voice-clone path which legitimately has no avatar).
--   4. CHECK rejects voice_clone ticket WITH avatar_provider (would
--      mean a clone-flow caller wired an avatar id on the wrong purpose).
--
-- We pass a fake creator_id to satisfy voice_tickets_creator_id_not_null;
-- the resulting FK violation (23503) on tests 2 and 3 PROVES the CHECK
-- passed (the test's "wanted" SQLSTATE is 23503 specifically — we'd see
-- 23514 if our CHECK were the rejection cause).

BEGIN;
SELECT plan(4);

-- 1. NEGATIVE: voice_session without avatar_provider → 23514
SELECT throws_ok(
  $$ INSERT INTO public.voice_tickets (user_id, creator_id, bound_ua_hash, expires_at, purpose)
     VALUES (gen_random_uuid(), gen_random_uuid(), repeat('a', 64), now()+interval '1m', 'voice_session') $$,
  '23514',
  NULL,
  'voice_session ticket without avatar_provider rejected (CHECK fires)'
);

-- 2. POSITIVE: voice_session with avatar_provider='simli' → only 23503 FK
--    miss (proves the CHECK passed; we'd see 23514 if it were the bug).
SELECT throws_ok(
  $$ INSERT INTO public.voice_tickets (user_id, creator_id, bound_ua_hash, expires_at, purpose, avatar_provider)
     VALUES (gen_random_uuid(), gen_random_uuid(), repeat('a', 64), now()+interval '1m', 'voice_session', 'simli') $$,
  '23503',
  NULL,
  'voice_session ticket WITH avatar_provider=simli passes CHECK (only FK miss downstream)'
);

-- 3. POSITIVE: voice_clone without avatar_provider passes CHECK
SELECT throws_ok(
  $$ INSERT INTO public.voice_tickets (user_id, creator_id, bound_ua_hash, expires_at, purpose)
     VALUES (gen_random_uuid(), gen_random_uuid(), repeat('a', 64), now()+interval '1m', 'voice_clone') $$,
  '23503',
  NULL,
  'voice_clone ticket without avatar_provider passes CHECK (only FK miss downstream)'
);

-- 4. NEGATIVE: voice_clone with avatar_provider rejected (purpose mismatch)
SELECT throws_ok(
  $$ INSERT INTO public.voice_tickets (user_id, creator_id, bound_ua_hash, expires_at, purpose, avatar_provider)
     VALUES (gen_random_uuid(), gen_random_uuid(), repeat('a', 64), now()+interval '1m', 'voice_clone', 'simli') $$,
  '23514',
  NULL,
  'voice_clone ticket WITH avatar_provider rejected (CHECK fires)'
);

SELECT * FROM finish();
ROLLBACK;
