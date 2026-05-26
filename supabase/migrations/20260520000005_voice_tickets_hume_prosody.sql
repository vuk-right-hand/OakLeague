-- HUME_TTS_PLAN unit-wide audit C3 fix (2026-05-13)
--
-- HumeTTSBridge constructor (§4) requires ttsSpeed, trailingSilence,
-- description, modelVersion at construction. These live on `creators`
-- as env-scoped columns. The proxy's consumeTicket() reads `voice_tickets`
-- at session-open and is the ONLY DB read per session (Spike-A "no
-- per-turn DB reads" rule). Without these columns on the ticket, the
-- proxy would either (a) re-read creators inside consumeTicket (extra
-- failure surface + WS-open latency), or (b) construct the bridge with
-- defaults that silently ignore admin-set prosody.
--
-- Mint code (§6 — /api/sessions/open → mint-voice-ticket.ts) resolves the
-- current env's creators.hume_*_<env> columns and writes them onto the
-- ticket row. The ticket then carries everything the bridge needs.
-- Cartesia equivalent is already on the ticket as `tts_speed`.
--
-- All four columns nullable — Cartesia tickets don't populate them;
-- Hume tickets populate them; bridge sees null on Cartesia path and
-- uses Cartesia params instead.
--
-- CHECK ranges mirror migration 0002 creators.hume_* exactly so app-
-- layer validation and DB CHECK can't drift.

ALTER TABLE public.voice_tickets
  ADD COLUMN IF NOT EXISTS hume_tts_speed         numeric CHECK (hume_tts_speed         IS NULL OR (hume_tts_speed >= 0.5 AND hume_tts_speed <= 2.0)),
  ADD COLUMN IF NOT EXISTS hume_trailing_silence  numeric CHECK (hume_trailing_silence  IS NULL OR (hume_trailing_silence >= 0 AND hume_trailing_silence <= 5)),
  ADD COLUMN IF NOT EXISTS hume_voice_description text    CHECK (hume_voice_description IS NULL OR char_length(hume_voice_description) BETWEEN 1 AND 1000),
  ADD COLUMN IF NOT EXISTS hume_model_version     text    CHECK (hume_model_version     IS NULL OR hume_model_version IN ('1','2','default'));

COMMENT ON COLUMN public.voice_tickets.hume_tts_speed IS
  'Snapshot of creators.hume_tts_speed_<env> at mint time. NULL on Cartesia tickets. Range [0.5, 2.0] per migration 0002 paired CHECK.';
COMMENT ON COLUMN public.voice_tickets.hume_trailing_silence IS
  'Snapshot of creators.hume_trailing_silence_<env>. NULL on Cartesia. Range [0, 5] seconds.';
COMMENT ON COLUMN public.voice_tickets.hume_voice_description IS
  'Snapshot of creators.hume_voice_description_<env>. Acting-instructions hint per Hume Octave 2 (inert today, "coming soon" per Hume docs).';
COMMENT ON COLUMN public.voice_tickets.hume_model_version IS
  'Snapshot of creators.hume_model_version_<env>. ''1''|''2''|''default''.';

-- Unit-wide audit M2 fix (2026-05-13): NOTIFY pgrst at end of EVERY
-- migration that mutates RPC signatures or public-schema columns
-- exposed via PostgREST. Migrations 0002/0003/0004 also notify; 0005
-- now too.
NOTIFY pgrst, 'reload schema';
