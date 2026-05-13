-- 20260516000003 — Route enqueue_sample_embedding_job by creators.retrieval_version.
--
-- Day-5 build for the Day-1+2+3 integration audit's C1 finding (stale v2
-- chunks after raw_text edit).
--
-- Bug being fixed:
--   When a creator is at retrieval_version=2 (v2 narrative-chunk + contextual-
--   gen + hybrid retrieval), and the creator edits a sample's raw_text, the
--   existing trigger from 20260512000004 enqueues `sample_content_embedding_jobs`.
--   The legacy embed-worker claims, runs v1 chunker, writes fresh v1 chunks.
--   `finalize_embedding_job` (post-Day-2.5 migration 20260515000005) only
--   DELETEs chunker_version=1 rows, so the v2 narrative_units + v2 chunks
--   stay in place — but pointing at stale pre-edit text. Hybrid retrieval
--   surfaces that stale text indefinitely.
--
-- Fix:
--   Trigger reads creator's retrieval_version once at INSERT/UPDATE time
--   and routes to the appropriate queue:
--     retrieval_version=1 (default) → sample_content_embedding_jobs (legacy)
--     retrieval_version=2           → corpus_reprocess_jobs (Day-2 queue)
--   The corpus_reprocess_jobs handler runs the full v2 pipeline:
--   sanitize → narrative-chunk (Flash) → contextual-gen (Haiku) → embed →
--   _insert_chunk_v2_unsafe. That regenerates BOTH narrative_units AND
--   v2 chunks from the post-edit raw_text — no more stale references.
--
-- Why CREATE OR REPLACE on the existing function (not a new trigger):
--   The Day-2 migration already wires the trigger to call the named
--   function. CREATE OR REPLACE swaps the body atomically without
--   touching the trigger registration. Mirrors the pattern used in
--   20260515000005 (finalize_embedding_job v1-only filter).
--
-- v1↔v2 transition edge cases:
--   * Edits enqueued BEFORE a v1→v2 flip and processed AFTER will produce
--     v1 chunks. Read path (`creator_knowledge_topk` with chunker_version=1
--     filter — 20260514000003) is the source of truth for v1 creators;
--     v2 read path ignores chunker_version=1. So v1 chunks for a now-v2
--     creator are storage-cost zombies but cause no read-path incorrectness.
--     Admin can reclaim via the existing corpus-reprocess script which
--     CASCADEs old chunks.
--   * Edits enqueued AFTER a v2→v1 downgrade go to legacy queue (this
--     trigger reads retrieval_version at trigger time). Any stale v2
--     chunks AT downgrade time are now cleaned by the C4-fix migration
--     20260516000004 below.

CREATE OR REPLACE FUNCTION public.enqueue_sample_embedding_job() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_retrieval_version smallint;
BEGIN
  -- raw_text NULL: nothing to embed. Don't enqueue either queue. Same
  -- short-circuit as the original (R2 Small fix).
  IF NEW.raw_text IS NULL THEN
    RETURN NEW;
  END IF;

  -- Fire only on INSERT or actual raw_text change. UPDATE of other columns
  -- (topic_tags, fetch_status, etc.) must not bump the queue. Mirrors the
  -- original; routing is the only new behavior.
  IF TG_OP <> 'INSERT' AND NEW.raw_text IS NOT DISTINCT FROM OLD.raw_text THEN
    RETURN NEW;
  END IF;

  -- Look up creator's retrieval_version. Single-row read by PK — sub-ms.
  SELECT retrieval_version INTO v_retrieval_version
    FROM public.creators
   WHERE id = NEW.creator_id;

  -- Fail-safe: if the creator row isn't found (shouldn't happen — sample
  -- has FK to creators), default to v1 so we never silently drop the work.
  -- A future v=NULL would also fall through this branch.
  IF v_retrieval_version IS NULL OR v_retrieval_version = 1 THEN
    -- Legacy queue — unchanged from the original trigger.
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

  -- v_retrieval_version = 2 (the CHECK on creators.retrieval_version is (1,2),
  -- so this is the only remaining branch).
  --
  -- Route to corpus_reprocess_jobs. Same enqueue_version bump-on-conflict
  -- semantics as the legacy queue, just on the (sample_id, target_version=2)
  -- composite UNIQUE.
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
END;$$;

REVOKE EXECUTE ON FUNCTION public.enqueue_sample_embedding_job() FROM public;

-- Trigger registration is unchanged from 20260512000004; CREATE OR REPLACE
-- swapped only the body. No DROP/CREATE on the trigger itself.

COMMENT ON FUNCTION public.enqueue_sample_embedding_job() IS
  'Sample_content INSERT/UPDATE-OF-raw_text trigger function. Routes to sample_content_embedding_jobs for retrieval_version=1 (legacy) creators and to corpus_reprocess_jobs for retrieval_version=2 (v2 pipeline) creators. Integration-audit C1 fix (Day 5).';
