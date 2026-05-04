-- R3-C1 (UX) — Pipeline α' pre-WS gate emits mic_tap_outcome
-- 'creator_voice_not_trained' when /api/sessions/open returns 409
-- because creator.voice_id IS NULL while α' is on. Distinct from
-- 'creator_not_ready' (simli_face_id IS NULL). Mirror in TS at
-- src/types/feed.ts.
--
-- ALTER TYPE ADD VALUE cannot run inside a transaction in PG <= 11; in
-- PG >= 12 it can. Supabase runs PG 15. Safe in a single migration.

ALTER TYPE public.mic_tap_outcome ADD VALUE IF NOT EXISTS 'creator_voice_not_trained';
