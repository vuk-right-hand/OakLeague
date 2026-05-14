-- ─────────────────────────────────────────────────────────────────────────
-- RAG SOTA Phase 2 — Day-8/9/10 cross-cutting unit-audit M1
-- Backfill sessions.corpus_version_at_session from creators.current_corpus_version
-- ─────────────────────────────────────────────────────────────────────────
--
-- MIG-6 (20260521000006) added `sessions.corpus_version_at_session int NOT
-- NULL DEFAULT 1`. PG metadata-only-default behavior means every pre-
-- migration session row got value 1 without a table rewrite. That is
-- correct for closed sessions but creates a silent degradation path for
-- OPEN sessions at migration time:
--
--   - Gemini Live reopens reuse the same sessions.id (load-bearing
--     contract documented in MIG-4 header).
--   - On reopen, the Day-11 proxy reads `corpus_version_at_session` from
--     the row. If the creator is on `current_corpus_version > 1`, the
--     session keeps the pin at 1 and:
--       * Cache reads under version 1 miss for all creators that have
--         re-processed past 1.
--       * Cache writes under version 1 get rejected by the upsert RPC's
--         FOR SHARE check on creators.current_corpus_version (returns
--         NULL → 'stale_corpus').
--     Both fail open to fresh retrieval — graceful, but the session
--     spends its remaining lifetime cache-less without any telemetry.
--
-- This migration backfills any session row whose creator has advanced
-- past 1. Safe to run multiple times (idempotent — UPDATE only changes
-- rows where the values differ). Bounded: the join is on a creator FK,
-- and the WHERE clause limits to sessions where the corpus_version_at_
-- session is the default 1 and the creator has a higher current value.
--
-- After Day-11 ships, new sessions write the column explicitly at
-- session-open and this backfill is a one-time event. The migration is
-- additive (no schema change) so rollback is trivial: `UPDATE sessions
-- SET corpus_version_at_session = 1 WHERE corpus_version_at_session > 1`
-- would walk back to the pre-MIG-7 state (not recommended; would re-
-- introduce the degradation).

UPDATE public.sessions s
SET corpus_version_at_session = c.current_corpus_version
FROM public.creators c
WHERE s.creator_id = c.id
  AND s.corpus_version_at_session = 1
  AND c.current_corpus_version > 1;

-- Telemetry: emit the affected row count via NOTICE so it lands in the
-- migration apply log. Useful for ops to confirm the backfill actually
-- ran against expected scope (typically 0 rows at Day-8 deploy time
-- since no creator has bumped current_corpus_version yet — but bumps
-- happen during Phase-1 finalize testing on staging).
DO $$
DECLARE
  v_affected int;
BEGIN
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  RAISE NOTICE 'sessions_corpus_version_backfill: % rows updated', v_affected;
END $$;
