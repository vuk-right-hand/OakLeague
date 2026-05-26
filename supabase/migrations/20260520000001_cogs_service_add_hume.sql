-- HUME_TTS_PLAN §3.1 — add 'hume' to cogs_service enum
--
-- STANDALONE migration. ALTER TYPE … ADD VALUE historically required its own
-- transaction (PG ≤ 11). PG ≥ 12 allows it inside a tx but only if the value
-- is not USED in the same tx. Splitting it out unconditionally is the safe
-- pattern: every dependent migration (cogs_insert_turn_voice_v2, etc.) can
-- reference 'hume' freely once this one has committed.
--
-- Existing enum values (pre-migration):
--   gemini | cartesia | simli | tavus | mux | supabase | livekit | resend | heygen
-- Post-migration:
--   gemini | cartesia | simli | tavus | mux | supabase | livekit | resend | heygen | hume
--
-- The 'hume' value is consumed by:
--   * cogs_insert_turn_voice_v2 RPC — legs 3+4 service column when admin /
--     creator routed to Hume (HUME_TTS_PLAN §3.3)
--   * src/lib/admin/cogs-aggregations.ts — per-provider cost breakdown
--     (HUME_TTS_PLAN §6.5)

ALTER TYPE public.cogs_service ADD VALUE IF NOT EXISTS 'hume';
