-- 20260528000051 — enqueue_sample_embedding_job routes retrieval_version=3
-- to the v3 reprocess queue (RAG v3 step 7 / plan §4 item 9).
--
-- ── The tripwire this closes ────────────────────────────────────────────
-- 20260517000004 (Day-5 audit M9) made the trigger RAISE on any
-- retrieval_version not in {1, 2, NULL}, by design — "forces schema-bump
-- migrations to extend this trigger before bumping creators.retrieval_version
-- CHECK." Step 6a (migration 20260528000041) widened that CHECK to (1, 2, 3).
-- So RIGHT NOW, a sample edit for a creator at retrieval_version=3 hits the
-- RAISE feature_not_supported branch and the whole INSERT/UPDATE fails. This
-- migration adds the v=3 arm, closing the deliberate tripwire.
--
-- ── What the v=3 arm does ───────────────────────────────────────────────
-- Routes to corpus_reprocess_jobs with target_version=3 (the v3 queue). The
-- corpus_reprocess_jobs.target_version CHECK already accepts 3 (widened in
-- 20260528000020). The ON CONFLICT key is (sample_id, target_version), so a
-- v3 enqueue conflicts only with a prior v3 job for the same sample — same
-- bump-on-conflict semantics as v2.
--
-- ── FOR SHARE preserved ─────────────────────────────────────────────────
-- The creators read keeps FOR SHARE (Day-5 audit M2) so a concurrent
-- admin_set_creator_retrieval_version flip can't strand a sample edit in
-- the wrong queue. The mig-41 admin flip RPC takes FOR UPDATE on the
-- creators row; this trigger's FOR SHARE blocks that UPDATE until the
-- trigger commits — the edit lands in the OLD queue, the flip runs after,
-- subsequent edits route to the NEW queue. No stranded sample.
--
-- ── Legacy worker v3-skip — ALREADY SATISFIED, no worker change ─────────
-- Plan §4 item 9 also says "extend the legacy worker's v2-skip to also skip
-- v3 creators." The legacy embed-worker (server/voice-proxy/embed-worker.js
-- :284) already guards with `if (retrievalVersion !== 1)` — that condition
-- skips ANY non-v1 creator, v3 included. The error string it writes
-- (`creator_is_v${retrievalVersion}_skip_legacy_worker`) interpolates the
-- real version, so a v3 creator gets `creator_is_v3_skip_legacy_worker`.
-- The captureMessage event name (`...skipped_v2_creator`) is v2-flavored
-- but functionally harmless telemetry. No worker change needed for v3
-- correctness — deliberately keeping step 7 SQL-only (the worker is the
-- riskiest file + is already v3-correct here).
--
-- ── RAISE arm now triggers on v>=4 ──────────────────────────────────────
-- The future-proof guard stays — it now fires for retrieval_version>=4, so
-- a hypothetical v4 schema bump still trips the same tripwire and must
-- extend this trigger + the target_version CHECK together.

CREATE OR REPLACE FUNCTION public.enqueue_sample_embedding_job() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_retrieval_version smallint;
BEGIN
  IF NEW.raw_text IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' AND NEW.raw_text IS NOT DISTINCT FROM OLD.raw_text THEN
    RETURN NEW;
  END IF;

  -- FOR SHARE so admin_set_creator_retrieval_version's concurrent UPDATE
  -- waits for our trigger to commit (Day-5 audit M2).
  SELECT retrieval_version INTO v_retrieval_version
    FROM public.creators
   WHERE id = NEW.creator_id
   FOR SHARE;

  -- NULL or 1 → legacy queue.
  IF v_retrieval_version IS NULL OR v_retrieval_version = 1 THEN
    INSERT INTO public.sample_content_embedding_jobs (sample_id, status, attempts, enqueue_version)
    VALUES (NEW.id, 'pending', 0, 1)
    ON CONFLICT (sample_id) DO UPDATE
      SET status          = 'pending',
          attempts        = 0,
          last_error      = NULL,
          claimed_by      = NULL,
          claimed_at      = NULL,
          finished_at     = NULL,
          enqueue_version = public.sample_content_embedding_jobs.enqueue_version + 1,
          updated_at      = now();
    RETURN NEW;
  END IF;

  -- 2 → v2 reprocess queue.
  IF v_retrieval_version = 2 THEN
    INSERT INTO public.corpus_reprocess_jobs
      (sample_id, target_version, status, attempts, enqueue_version)
    VALUES (NEW.id, 2, 'pending', 0, 1)
    ON CONFLICT (sample_id, target_version) DO UPDATE
      SET status          = 'pending',
          attempts        = 0,
          last_error      = NULL,
          claimed_by      = NULL,
          claimed_at      = NULL,
          finished_at     = NULL,
          enqueue_version = public.corpus_reprocess_jobs.enqueue_version + 1,
          updated_at      = now();
    RETURN NEW;
  END IF;

  -- 3 → v3 reprocess queue (RAG v3 step 7). Same bump-on-conflict semantics
  -- as v2, on the (sample_id, target_version=3) composite UNIQUE.
  IF v_retrieval_version = 3 THEN
    INSERT INTO public.corpus_reprocess_jobs
      (sample_id, target_version, status, attempts, enqueue_version)
    VALUES (NEW.id, 3, 'pending', 0, 1)
    ON CONFLICT (sample_id, target_version) DO UPDATE
      SET status          = 'pending',
          attempts        = 0,
          last_error      = NULL,
          claimed_by      = NULL,
          claimed_at      = NULL,
          finished_at     = NULL,
          enqueue_version = public.corpus_reprocess_jobs.enqueue_version + 1,
          updated_at      = now();
    RETURN NEW;
  END IF;

  -- Future-proof guard: v>=4 means a schema bump extended
  -- creators.retrieval_version without extending this trigger. Hard-fail so
  -- the migration's pgTAP catches it (same tripwire that caught v3 here).
  RAISE EXCEPTION
    'enqueue_sample_embedding_job: unknown creator retrieval_version=%, extend this trigger AND corpus_reprocess_jobs.target_version CHECK before bumping creators.retrieval_version CHECK',
    v_retrieval_version
    USING ERRCODE = 'feature_not_supported';
END;$$;

REVOKE EXECUTE ON FUNCTION public.enqueue_sample_embedding_job() FROM public;

COMMENT ON FUNCTION public.enqueue_sample_embedding_job() IS
  'sample_content INSERT/UPDATE-OF-raw_text trigger. Routes v1 creators to sample_content_embedding_jobs, v2 creators to corpus_reprocess_jobs (target_version=2), v3 creators to corpus_reprocess_jobs (target_version=3 — RAG v3 step 7). Reads creators with FOR SHARE to serialize against admin_set_creator_retrieval_version. Raises on retrieval_version>=4 to catch schema-bump misses at deploy time. Day-5 audit M2 + M9; v3 arm added migration 20260528000051.';
