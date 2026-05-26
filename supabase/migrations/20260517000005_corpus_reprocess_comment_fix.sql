-- 20260517000005 — Day-5 audit C4 polish: drop stale advisory-lock claim from comments.
--
-- The original 20260515000001_corpus_reprocess_jobs.sql header (line 67)
-- and 20260516000002_claim_corpus_reprocess_job.sql header both claim
-- "Worker takes pg_advisory_xact_lock on creator_id at claim time (audit-2 M4)".
-- The Day-5 worker does NOT take this lock — the disjoint-queue design
-- (legacy worker bails on v2 creators, reprocess worker handles v2 only)
-- closes the same race without an explicit lock. Leaving stale comments
-- in place misleads future maintainers about the safety story.
--
-- This migration overrides the comment on corpus_reprocess_jobs only.
-- The header comments on the migration files are immutable (already applied)
-- but the COMMENT ON TABLE/FUNCTION can be updated forward-only.

COMMENT ON TABLE public.corpus_reprocess_jobs IS
  'Queue for admin-initiated re-processing of a sample from v1 (legacy windowed chunks) to v2 (narrative + contextual + hybrid-ready). Distinct from sample_content_embedding_jobs: different operation, per-(sample_id, target_version) idempotency. Race-free against the legacy queue via the disjoint-routing model — the routing trigger (20260516000003 + 20260517000004) sends v1 creators to sample_content_embedding_jobs and v2 creators here; the legacy worker bails on v2 creators (embed-worker.js v2_skip). Version-checked finish via corpus_reprocess_mark_done; reaper bumps enqueue_version on requeue to fence stale workers (Day-5 audit C5).';
