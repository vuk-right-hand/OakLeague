-- ─────────────────────────────────────────────────────────────────────────
-- RAG v3 prerequisite — Step 1b (RAG_SCALING_V3_PLAN.md §8 step 1b, R3-C2).
-- Standalone, pre-v3, isolated from the v3 lockstep migration set.
--
-- DEPENDS ON: corpus_reprocess_finalize (migration 20260521000001). This
-- migration replaces mark_done's body with a thin wrapper that delegates
-- to that finalize RPC. Do NOT drop finalize without first re-implementing
-- mark_done's body inline OR shipping a v3 mark_done_v3 replacement.
--
-- WHY: the live v2 worker (server/voice-proxy/embed-worker.js:1205) calls
-- corpus_reprocess_mark_done to finish a job. Today that RPC only sets
-- status='done'; it does NOT bump creators.current_corpus_version and does
-- NOT delete the sample's chunker_version=1 zombie chunks. The cache
-- (semantic_query_cache, keyed on current_corpus_version) therefore continues
-- serving pre-reprocess parent rows for up to its 7-day TTL — a real cost
-- regression at multi-sample scale (round-2 R2-C1; severity corrected DOWN
-- in round-3 R3-C2 from "he blanks" to "7-day cache uselessness" after
-- verifying retrieve-knowledge.ts:628-655 falls through to fresh retrieve).
-- See rag_v3_regression_baseline.test.sql Block A for the pinned baseline.
--
-- WHY HERE (not under v3): the v3 plan (§13/R3-C2) is explicit — ship this
-- as its own pre-v3 migration so a wrong edit to a live ingestion RPC
-- cannot ride into the experimental path's blast radius. v3 will add its
-- OWN finish RPC (per §11/C1 option (i): corpus_reprocess_mark_done_v3 the
-- v3 worker branch calls), keeping this v2 path's contract frozen after
-- this fix.
--
-- WHAT: replace mark_done's body with a thin wrapper that delegates to
-- public.corpus_reprocess_finalize (the orphaned-since-Day-8 RPC that
-- already implements the correct delete + version-bump pair under
-- pg_advisory_xact_lock + lock_timeout — audit-day-8 C4 + Day-9-cross C1).
-- mark_done's external SIGNATURE stays uuid-in / uuid-out so the live
-- worker needs no code change; only its body changes.
--
-- BEHAVIOR (after this migration):
--   • status='processing' + enqueue_version match → DELETE this sample's
--     chunker_version=1 chunks, UPDATE creators.current_corpus_version + 1,
--     mark job done, RETURN p_job_id.
--   • Any condition not met (job missing, not processing, version mismatch)
--     → RETURN NULL (silent abandon; worker requeue logic unchanged).
--   • Per-creator pg_advisory_xact_lock serializes concurrent finalizes;
--     5s lock_timeout matches finalize's own (won't stall on Day-7 promote).
--
-- SIDE-EFFECT INTENT:
--   • rag_v3_regression_baseline.test.sql Block A goes RED on purpose →
--     forces an explicit, audited update of A1/A2 in the SAME PR as this
--     migration (done in the test file alongside this commit).
--   • corpus_reprocess_jobs.test.sql tests 10/11 keep passing — they set
--     status='processing' explicitly before calling mark_done, so the
--     tightened "status = 'processing'" check inherited from finalize is
--     satisfied.
--   • Orphan finalize stays in place (it has its own pgTAP coverage); a
--     follow-up cleanup migration can drop it once v3 ships its own
--     mark_done_v3, but doing so now is scope creep for Step 1b.
--
-- TX: standalone migration, single statement under one BEGIN. Idempotent
-- via CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION public.corpus_reprocess_mark_done(
  p_job_id          uuid,
  p_claimed_version int
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_new_version int;
BEGIN
  -- Delegate to finalize. Returns the post-bump current_corpus_version on
  -- success, NULL on silent-abandon. Translate to mark_done's uuid contract.
  v_new_version := public.corpus_reprocess_finalize(p_job_id, p_claimed_version);
  IF v_new_version IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN p_job_id;
END;
$$;

COMMENT ON FUNCTION public.corpus_reprocess_mark_done(uuid, int) IS
  'Atomic worker-finish for corpus_reprocess_jobs. Delegates to corpus_reprocess_finalize (per-creator advisory-locked + 5s lock_timeout): deletes the sample''s chunker_version=1 chunks, bumps creators.current_corpus_version, marks the job done. Returns p_job_id on success, NULL on silent-abandon (admin re-enqueued mid-flight, job CASCADE-deleted between claim and finish, OR job not in processing state). Migration 20260528000001 (RAG v3 step 1b) added the delete + version-bump; prior body only flipped status. Service-role only.';

-- Privileges unchanged from migration 20260515000001 — REVOKE/GRANT only
-- matter on first CREATE, not on CREATE OR REPLACE: per Postgres docs
-- (https://www.postgresql.org/docs/17/sql-createfunction.html — "When
-- CREATE OR REPLACE FUNCTION is used to replace an existing function, the
-- ownership and permissions of the function do not change"). Re-asserted
-- defensively in case a future migration ever DROPs and recreates:
REVOKE ALL ON FUNCTION public.corpus_reprocess_mark_done(uuid, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.corpus_reprocess_mark_done(uuid, int)
  TO service_role;
