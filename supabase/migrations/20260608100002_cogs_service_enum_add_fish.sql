-- FISH_AUDIO_PHASE_1 §4 M2 — add 'fish' to cogs_service enum
--
-- STANDALONE migration (see M1 rationale). Mirrors 20260520000001_cogs_service_add_hume.sql.
--
-- Existing enum values (pre-migration):
--   gemini | cartesia | simli | tavus | mux | supabase | livekit | resend
--   | heygen | hume | anthropic | voyage
-- Post-migration:
--   ... | fish
--
-- The 'fish' value is consumed by:
--   * cogs_insert_turn_voice_v3 RPC (FISH_AUDIO_PHASE_1 §4 M3) — legs 3+4
--     service column when admin/creator routed to Fish
--   * src/lib/admin/cogs-aggregations.ts — per-provider cost breakdown
--   * voice-delete-worker writeCogsLog for Fish DELETE calls (optional —
--     dispatchFish does not currently log; Phase 1 keeps parity with Hume)

ALTER TYPE public.cogs_service ADD VALUE IF NOT EXISTS 'fish';

-- PostgREST cache: best-effort schema reload at commit time. Delivery is
-- not guaranteed instant on managed Supabase — assume up to ~60s before
-- new enum values are universally accepted. Mirrors M1's NOTIFY caveat
-- (audit round 2 S5).
NOTIFY pgrst, 'reload schema';
