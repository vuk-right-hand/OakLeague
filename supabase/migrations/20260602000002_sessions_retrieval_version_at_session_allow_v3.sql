-- 20260602000002 — widen sessions.retrieval_version_at_session CHECK to allow 3.
--
-- BUG (found live 2026-06-02 during the first v3 flip): flipping a creator to
-- retrieval_version=3 made EVERY /api/sessions/open 500 with:
--   new row for relation "sessions" violates check constraint
--   "sessions_retrieval_version_at_session_chk"
--
-- session_open snapshots creators.retrieval_version into
-- sessions.retrieval_version_at_session (mig 20260522000100). That column's
-- CHECK was pinned to IN (1, 2) at creation (20260522000100:64). The v3 work
-- widened creators.retrieval_version's CHECK to IN (1, 2, 3) (mig
-- 20260528000041) but MISSED this sibling constraint on sessions — a
-- schema-blast-radius gap. So once a creator is on v3, the snapshot value 3
-- violates the un-widened sessions CHECK and no session can open.
--
-- FIX: widen to IN (1, 2, 3), mirroring the creators widening. Loosening
-- direction — every existing row is 1 or 2, so the re-ADD validates cleanly
-- (no NOT VALID needed). Idempotent: DROP IF EXISTS then ADD.
--
-- (corpus_version_at_session has no enum CHECK — it's a monotonic counter — so
-- this sessions constraint was the only (1,2)-pinned sibling. Verified via
-- grep of all migrations for CHECK ... retrieval_version.)

-- ⚠️ WHEN ADDING retrieval_version=N (v4+): widen BOTH
--   creators_retrieval_version_*_check (mig 20260528000041)
--   AND this sessions_retrieval_version_at_session_chk
-- They are SIBLINGS. The v3 author widened the creators one and missed this one,
-- which cost a prod 500 on every v3 session-open on 2026-06-02. Don't repeat it.

ALTER TABLE public.sessions
  DROP CONSTRAINT IF EXISTS sessions_retrieval_version_at_session_chk;

ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_retrieval_version_at_session_chk
    CHECK (retrieval_version_at_session IN (1, 2, 3));
