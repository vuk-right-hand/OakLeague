-- 20260511000004 — voice_tickets.system_prompt + prefix_turns
--
-- Brain wire-up M4. Carries the per-session brain payload from /api
-- routes through to the proxy via the existing voice_tickets row, so the
-- proxy gets system_prompt + paired prefix_turns in the same atomic
-- consume that already returns user_id/creator_id/session_id.
--
-- Why on voice_tickets and not a separate table:
--   * Already creator-scoped (carries creator_id)
--   * Already TTL'd (auto-purged via voice_tickets_purge_consumed)
--   * Already consumed atomically by proxy in one round-trip
--   * Adding columns means proxy gets brain payload "for free" — no
--     extra Supabase read inside the WS open hot path
--
-- Audit dispositions baked in:
--   * R3 audit C5 — pre-DB size guard in route, no error-mapping change.
--     Database CHECK at 96KB is defense-in-depth; should never fire.
--   * R3 audit M3 — prefix_turns jsonb carries creator sample_content
--     PII; 7-day retention via voice_tickets_purge_consumed (M5).
--   * Plan §verified contract — paired user/model history, NOT a single
--     hanging user turn (would race auto-VAD).

ALTER TABLE public.voice_tickets
  ADD COLUMN system_prompt text,
  ADD COLUMN prefix_turns  jsonb;

ALTER TABLE public.voice_tickets
  ADD CONSTRAINT voice_tickets_system_prompt_len_chk
    CHECK (system_prompt IS NULL OR (octet_length(system_prompt) BETWEEN 1 AND 2000));

ALTER TABLE public.voice_tickets
  ADD CONSTRAINT voice_tickets_prefix_turns_size_chk
    CHECK (prefix_turns IS NULL OR pg_column_size(prefix_turns) < 96 * 1024);

COMMENT ON COLUMN public.voice_tickets.system_prompt IS
  'Pre-compiled creator persona. Mirrors creators.system_prompt at session-open. Riding the ticket lets the proxy pass it as Gemini Live LiveConnectConfig.systemInstruction without an extra round-trip.';

COMMENT ON COLUMN public.voice_tickets.prefix_turns IS
  'Per-session topic-drawer seed for Gemini Live (paired user/model Content[] history). Built per-session-open from sample_content rows whose topic_tags[] overlap hooks.topic_tags[]. Contains creator sample_content excerpts (mastermind transcripts, testimonials) — subject to 7-day PII retention via voice_tickets_purge_consumed.';
