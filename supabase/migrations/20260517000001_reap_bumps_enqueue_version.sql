-- 20260517000001 — Day-5 audit C5: reaper bumps enqueue_version on requeue.
--
-- Closes the duplicate-write data-corruption window on Fly scale-to-zero:
--
--   Worker A claims job, starts pipeline. Fly suspends the machine.
--   600s passes. reap_stuck_corpus_reprocess_jobs UPDATEs the row back
--   to status='pending' (with enqueue_version UNCHANGED in the original
--   migration). Worker B claims the now-pending row, processes from
--   scratch, calls corpus_reprocess_mark_done(jobId, claimedVersion) —
--   SUCCEEDS because enqueue_version was never bumped. Worker A resumes,
--   finishes its pipeline, calls mark_done with the SAME claimed_version
--   — ALSO SUCCEEDS. Both writers INSERT narrative_units for the same
--   sample. UNIQUE(sample_id, unit_index) raises mid-flight on the second
--   writer. Sample's corpus ends up half-A, half-B.
--
-- Fix: reaper increments enqueue_version when it requeues. mark_done's
-- version-check (corpus_reprocess_jobs.sql:79-91, post-audit-5 C2) now
-- rejects the stale worker → silent abandon. The new worker processes
-- the new enqueue_version cleanly.
--
-- Same pattern applies to legacy sample_content_embedding_jobs reaper —
-- batched into this migration to fix both queues in one shot. Both reapers
-- now atomically advance the version sentinel on requeue.

CREATE OR REPLACE FUNCTION public.reap_stuck_corpus_reprocess_jobs() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_reaped int;
BEGIN
  UPDATE public.corpus_reprocess_jobs
     SET status          = 'pending',
         claimed_by      = NULL,
         claimed_at      = NULL,
         -- Day-5-audit C5: bump enqueue_version so any zombie worker
         -- holding the prior version's claim returns NULL from mark_done
         -- and silently abandons its partial work.
         enqueue_version = enqueue_version + 1,
         updated_at      = now()
   WHERE status = 'processing'
     AND claimed_at < now() - INTERVAL '600 seconds';
  GET DIAGNOSTICS v_reaped = ROW_COUNT;
  RETURN v_reaped;
END;$$;

REVOKE ALL ON FUNCTION public.reap_stuck_corpus_reprocess_jobs() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reap_stuck_corpus_reprocess_jobs() TO service_role;


-- Same fix for the legacy queue. finalize_embedding_job (20260512000011)
-- already does the version check; same fencing semantics apply.

CREATE OR REPLACE FUNCTION public.reap_stuck_embedding_jobs() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_reaped int;
BEGIN
  UPDATE public.sample_content_embedding_jobs
     SET status          = 'pending',
         claimed_by      = NULL,
         claimed_at      = NULL,
         -- Same Day-5-audit C5 fencing as the corpus_reprocess_jobs reaper.
         enqueue_version = enqueue_version + 1,
         updated_at      = now()
   WHERE status = 'processing'
     AND claimed_at < now() - INTERVAL '60 seconds';
  GET DIAGNOSTICS v_reaped = ROW_COUNT;
  RETURN v_reaped;
END;$$;

REVOKE ALL ON FUNCTION public.reap_stuck_embedding_jobs() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reap_stuck_embedding_jobs() TO service_role;
