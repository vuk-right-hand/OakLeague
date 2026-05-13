-- 20260517000004 — Day-5 audit M2 + M9: harden enqueue_sample_embedding_job.
--
-- Two changes vs 20260516000003:
--
-- 1. `FOR SHARE` lock on the creators row when reading retrieval_version.
--    The original trigger reads the creator's retrieval_version with no
--    lock. If admin_set_creator_retrieval_version is mid-flight (its
--    UPDATE on creators has acquired the row-level write lock), the
--    trigger's read sees the value at the moment of the read — which may
--    be the pre-flip or post-flip value depending on snapshot timing.
--    Result: a sample edit landing in the WRONG queue during a v1→v2
--    flip. The legacy worker bails on v2 creators (per the Day 5 worker
--    fix), so this isn't data corruption — but the sample sits errored
--    until admin intervention.
--
--    `FOR SHARE` is the right lock here: the trigger reads, the admin
--    RPC writes. The trigger's row-level SHARE lock blocks the admin
--    RPC's UPDATE (which needs ROW EXCLUSIVE) until the trigger commits.
--    Admin's UPDATE waits one trigger-fire duration (~microseconds). The
--    trigger commits with the OLD version value AND enqueues to the OLD
--    queue. Admin's UPDATE then runs and flips. Subsequent edits route
--    to the NEW queue. No sample stranded in the wrong queue.
--
-- 2. RAISE EXCEPTION on unknown retrieval_version. The original trigger
--    treats anything ≠ 1 as "v2 → corpus_reprocess_jobs". The
--    corpus_reprocess_jobs table CHECK is `target_version IN (2)` — if
--    a future schema bump adds v3 to creators.retrieval_version's CHECK,
--    the trigger silently INSERTs `target_version=2` for v3 creators,
--    or fails the INSERT with 23514 on the target_version CHECK,
--    blocking the whole sample_content INSERT/UPDATE. Both are silent-
--    surprise failure modes. Better: trigger raises a clear error so
--    the schema-bump migration's pgTAP catches the gap.

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

  -- Day-5-audit M2: FOR SHARE so admin_set_creator_retrieval_version's
  -- concurrent UPDATE waits for our trigger to commit. Prevents a
  -- "sample edit lands in wrong queue mid-flip" race.
  SELECT retrieval_version INTO v_retrieval_version
    FROM public.creators
   WHERE id = NEW.creator_id
   FOR SHARE;

  -- Day-5-audit M9: explicit branching on KNOWN versions. NULL or 1 →
  -- legacy; 2 → reprocess; anything else → raise (forces schema-bump
  -- migrations to extend this trigger and add a queue row, surfacing
  -- the breaking change at deploy time).
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

  -- Future-proof guard: anything other than 1, 2, or NULL means a schema
  -- migration extended creators.retrieval_version without extending this
  -- trigger. Hard-fail so the migration's pgTAP catches it.
  RAISE EXCEPTION
    'enqueue_sample_embedding_job: unknown creator retrieval_version=%, extend this trigger AND corpus_reprocess_jobs.target_version CHECK before bumping creators.retrieval_version CHECK',
    v_retrieval_version
    USING ERRCODE = 'feature_not_supported';
END;$$;

REVOKE EXECUTE ON FUNCTION public.enqueue_sample_embedding_job() FROM public;

COMMENT ON FUNCTION public.enqueue_sample_embedding_job() IS
  'sample_content INSERT/UPDATE-OF-raw_text trigger. Routes v1 creators to sample_content_embedding_jobs and v2 creators to corpus_reprocess_jobs. Reads creators with FOR SHARE to serialize against admin_set_creator_retrieval_version. Raises on unknown retrieval_version to catch schema-bump misses at deploy time. Day-5 audit M2 + M9.';
