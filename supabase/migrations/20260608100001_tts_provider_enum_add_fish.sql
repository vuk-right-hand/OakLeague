-- FISH_AUDIO_PHASE_1 §4 M1 — add 'fish' to tts_provider enum
--
-- STANDALONE migration. PG 12+ permits ALTER TYPE … ADD VALUE inside a
-- transaction, but the new value cannot be USED in the same transaction.
-- Splitting M1 out unconditionally lets every dependent migration (M3
-- cogs_insert_turn_voice_v3 with its 'fish' whitelist, future RLS policies,
-- RPCs that reference 'fish') run in their own tx with the value already
-- committed.
--
-- Existing enum values (pre-migration):
--   cartesia | hume
-- Post-migration:
--   cartesia | hume | fish
--
-- The 'fish' value is consumed by:
--   * creators.tts_provider — per-creator routing (default stays NULL for now)
--   * voice_tickets.tts_provider — session-open snapshot via mint-voice-ticket
--   * cogs_insert_turn_voice_v3 RPC (FISH_AUDIO_PHASE_1 §4 M3) — TTS legs
--   * src/lib/admin/cogs-aggregations.ts — per-provider cost breakdown
--   * server/voice-proxy/index.js — TTS provider switch in onDeepAnswerDone
--
-- PostgREST cache: NOTIFY pgrst signals a schema reload so the new enum
-- value is picked up sooner than the next default poll interval. Delivery
-- is best-effort (commit-time + PostgREST debounce) — assume up to ~60s
-- worst case before the new value is universally accepted by the REST API.
-- Audit M1 (Phase 1): the cutover runbook should NOT gate "fish accepted
-- via PostgREST" on this NOTIFY firing instantly.

ALTER TYPE public.tts_provider ADD VALUE IF NOT EXISTS 'fish';

NOTIFY pgrst, 'reload schema';
