-- ─────────────────────────────────────────────────────────────────────────
-- RAG SOTA Phase 2 — Day 8/9 cross-cutting audit C2
-- sessions.corpus_version_at_session column
-- ─────────────────────────────────────────────────────────────────────────
--
-- MIG-3 (semantic_query_cache) and the Day-9 TS modules (semantic-cache.ts)
-- document a contract: "corpus_version is caller-supplied (closure-captured
-- at session-open from creators.current_corpus_version, NOT read per-query)."
-- The cache upsert's FOR SHARE check on creators.current_corpus_version is
-- the enforcement, but without a snapshot column the orchestrator (Day 11)
-- has no source for the closure value other than re-reading per-turn — which
-- defeats the closure-capture purpose and creates a TOCTOU window between
-- lookup and upsert across a concurrent finalize.
--
-- This migration adds the snapshot column. Day 11 session-open route writes
-- it alongside tier_at_session. Day 11 proxy reads it from the session row
-- at WS-open and carries it as a closure const for every retrieval call.
--
-- DEFAULT 1 is correct for the bootstrap: every new session starts at
-- whatever the creator's current_corpus_version is at session-open. The
-- session-open route migration (Day 11) writes it explicitly; this default
-- keeps existing rows valid and any future inserts that forget the column
-- valid-but-pinned (cache lookups under version 1 will simply miss for
-- creators on a higher version, which fails open to retrieval).
--
-- The column is NOT updated mid-session. If creators.current_corpus_version
-- bumps via finalize, the session keeps its captured value until next
-- session-open. Cache writes under the stale version get rejected by the
-- upsert RPC's FOR SHARE check; cache reads under the stale version simply
-- miss. Both are graceful — the next session captures the new version.

ALTER TABLE public.sessions
  ADD COLUMN corpus_version_at_session int NOT NULL DEFAULT 1
    CHECK (corpus_version_at_session >= 1);

COMMENT ON COLUMN public.sessions.corpus_version_at_session IS
  'Snapshot of creators.current_corpus_version at session-open time. Used by the retrieval orchestrator (Day 11) as the closure-captured cache key dimension. Never re-read mid-session — Gemini Live reopens preserve the captured value via the existing sessions.gemini_resumption_handle path. Cache writes under a stale value get rejected by semantic_query_cache_upsert''s FOR SHARE check (returns NULL); cache reads simply miss. Both fail open to fresh retrieval.';
