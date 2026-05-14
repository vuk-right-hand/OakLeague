-- ─────────────────────────────────────────────────────────────────────────
-- RAG SOTA Phase 2 — final ship-readiness audit M2
-- voice_session_state.last_assistant_response cap 2000 → 4000
-- ─────────────────────────────────────────────────────────────────────────
--
-- Day-8 MIG-4 capped `last_assistant_response` at 2000 chars. CLAUDE.md
-- documents the Gemini Live `outputTranscript` per-turn cap as 4000 chars
-- (load-bearing for the voice_accumulate_seconds kill-switch). A
-- 3500-char assistant reply gets truncated to 2000 via `slice(0, 2000)`
-- in voice-session-state.ts BEFORE persistence. Next-turn rewrite then
-- expands "tell me more about that" using only the first 57% of the
-- actual assistant reply — the follow-up's topic anchor is lost when
-- the cut happens to land before the topic noun.
--
-- This widens BOTH columns (last_assistant_response + last_user_query)
-- to 4000 chars to match the transcript cap. The TS truncate() helper
-- in voice-session-state.ts already pulls VOICE_SESSION_STATE_MAX_CHARS
-- from the module — bump that constant in the same commit.
--
-- Rollback: ALTER COLUMN CHECK clauses back to (... <= 2000). Safe since
-- the new cap is strictly larger; no existing data violates the looser
-- bound.

ALTER TABLE public.voice_session_state
  DROP CONSTRAINT IF EXISTS voice_session_state_last_assistant_response_check;

ALTER TABLE public.voice_session_state
  ADD CONSTRAINT voice_session_state_last_assistant_response_check
  CHECK (
    last_assistant_response IS NULL
    OR char_length(last_assistant_response) <= 4000
  );

ALTER TABLE public.voice_session_state
  DROP CONSTRAINT IF EXISTS voice_session_state_last_user_query_check;

ALTER TABLE public.voice_session_state
  ADD CONSTRAINT voice_session_state_last_user_query_check
  CHECK (
    last_user_query IS NULL
    OR char_length(last_user_query) <= 4000
  );

COMMENT ON COLUMN public.voice_session_state.last_assistant_response IS
  'Last full assistant transcript for the session, ≤4000 chars (matches Gemini Live outputTranscript per-turn cap). Persisted on turn_complete by the Day-13 proxy. Used as context for the next turn rewrite; truncating here loses pronoun-resolution accuracy on follow-up turns.';

COMMENT ON COLUMN public.voice_session_state.last_user_query IS
  'Last rewritten user query for diagnostics. ≤4000 chars to match the assistant column for symmetry.';
