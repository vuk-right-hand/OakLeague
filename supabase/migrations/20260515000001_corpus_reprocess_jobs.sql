-- 20260515000001 — corpus_reprocess_jobs queue.
--
-- M5 of RAG SOTA plan (docs/_planning/RAG_SOTA_PLAN.md §3, with audit-5 C2 + M1 fixes).
--
-- Separate queue from sample_content_embedding_jobs because:
--   1. Re-process is a different operation (LLM narrative chunking + Anthropic
--      contextual-gen + embed, not just embed).
--   2. Idempotency boundary is different (target_version, not sample_id alone).
--   3. Lets us run forward-only re-process without disturbing the live embedding
--      queue. A creator's regular sample-content edits keep using the existing
--      pipeline; admin-initiated re-process uses this queue.
--
-- ─── Audit-5 C2 fix — enqueue_version + 600s reaper + finalize RPC ───────────
-- The original draft mirrored sample_content_embedding_jobs structurally but
-- OMITTED two critical pieces: (a) the enqueue_version sentinel that closes
-- the mid-flight re-enqueue race, (b) the dedicated finalize RPC that ensures
-- the worker-finish is atomic AND version-checked. Without these, an admin
-- running `corpus-reprocess.mjs --force` while a worker is mid-job will cause
-- the worker to commit chunks for an obsolete spec.
--
-- Also: the original 60s reaper TTL was wrong. Anthropic contextual-gen
-- (per-chunk Haiku call with 1h-TTL caching) + LLM narrative chunking + batched
-- embed for a 500KB corpus realistically runs 5-10 minutes. The bumped 600s
-- TTL (10 min) matches that worst case. CLAIM_TIMEOUT_MS in the worker is
-- set to a value < this ceiling.
--
-- Audit-5 S5 fix: header reference to "finalize RPC lives in Phase 2 migration
-- 20260515000003" was stale (20260515000003 is the test_fixture migration this
-- same day). The Day-2 finalize RPC is below; the Phase 2 corpus_version bump
-- adds a *separate* corpus_reprocess_finalize_with_version_bump RPC that calls
-- this one then bumps creators.current_corpus_version.

CREATE TABLE public.corpus_reprocess_jobs (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_id       uuid           NOT NULL REFERENCES public.sample_content(id) ON DELETE CASCADE,
  target_version  smallint       NOT NULL CHECK (target_version IN (2)),
  status          text           NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending','processing','done','errored')),
  attempts        int            NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 5),
  last_error      text           CHECK (last_error IS NULL OR char_length(last_error) <= 2000),
  -- Audit-5 M5 fix: claimed_by cap bumped to 128 so a future Fly machine-id
  -- format change or added trace-correlation UUID can't silently truncate.
  claimed_by      text           CHECK (claimed_by IS NULL OR char_length(claimed_by) <= 128),
  claimed_at      timestamptz,
  finished_at     timestamptz,
  -- Audit-5 C2 fix: mid-flight re-enqueue sentinel. Worker captures the
  -- version at claim time and the finalize RPC version-checks at finish.
  enqueue_version int            NOT NULL DEFAULT 1,
  progress_json   jsonb          CHECK (progress_json IS NULL OR pg_column_size(progress_json) <= 4096),
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now(),
  UNIQUE (sample_id, target_version)
);

CREATE INDEX corpus_reprocess_jobs_status_idx
  ON public.corpus_reprocess_jobs (status, claimed_at NULLS FIRST);

CREATE TRIGGER corpus_reprocess_jobs_touch_updated_at
  BEFORE UPDATE ON public.corpus_reprocess_jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.corpus_reprocess_jobs ENABLE ROW LEVEL SECURITY;
-- Service-role only, zero policies. Admin dashboard reads via the
-- admin_list_corpus_reprocess_jobs RPC below (audit-5 C4 fix).

COMMENT ON TABLE public.corpus_reprocess_jobs IS
  'Queue for admin-initiated re-processing of a sample from v1 (legacy windowed chunks) to v2 (narrative + contextual + hybrid-ready). Distinct from sample_content_embedding_jobs: different operation, per-(sample_id, target_version) idempotency. Worker takes pg_advisory_xact_lock on creator_id at claim time (audit-2 M4) AND version-checks at finish via corpus_reprocess_mark_done (audit-5 C2).';


-- ── corpus_reprocess_mark_done (audit-5 C2 fix — atomic version-checked finish) ──
--
-- Mirrors finalize_embedding_job from 20260512000011, simplified for Day 2:
-- this RPC only marks the job done atomically conditional on version match.
-- The v1-chunk deletion + corpus_version bump come in a SEPARATE Phase 2
-- migration that wraps this RPC (when creators.current_corpus_version exists).
-- Keeping the wrapping layered means Day 2's queue is functional standalone
-- and Phase 2's wiring is additive.

CREATE FUNCTION public.corpus_reprocess_mark_done(
  p_job_id          uuid,
  p_claimed_version int
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_done uuid;
BEGIN
  UPDATE public.corpus_reprocess_jobs
     SET status = 'done', finished_at = now()
   WHERE id = p_job_id
     AND enqueue_version = p_claimed_version
   RETURNING id INTO v_done;
  -- v_done IS NULL ⇔ concurrent re-enqueue bumped enqueue_version mid-flight.
  -- Worker treats this as silent abandon; the re-enqueued row stays at
  -- status='processing' from the prior claim and the reaper requeues after
  -- the 600s TTL.
  RETURN v_done;
END;$$;

COMMENT ON FUNCTION public.corpus_reprocess_mark_done(uuid, int) IS
  'Atomic worker-finish for corpus_reprocess_jobs. Version-checks p_claimed_version against enqueue_version; returns NULL on mismatch (silent abandon — admin re-enqueued mid-flight). Service-role only.';

REVOKE ALL ON FUNCTION public.corpus_reprocess_mark_done(uuid, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.corpus_reprocess_mark_done(uuid, int)
  TO service_role;


-- ── admin_list_corpus_reprocess_jobs (audit-5 C4 fix — admin dashboard read) ──
--
-- corpus_reprocess_jobs has RLS deny-all (service-role only). The admin
-- dashboard's server actions run with the user's JWT, not service-role.
-- Without this RPC, admin reads would return zero rows and the "review v2
-- chunks" deliverable (plan §5) would silently render an empty queue.
-- Routes through _assert_caller_is_admin() the same way other admin reads do.

CREATE FUNCTION public.admin_list_corpus_reprocess_jobs(
  p_creator_id uuid DEFAULT NULL,    -- NULL = list all queue rows
  p_limit      int  DEFAULT 100
) RETURNS TABLE (
  id             uuid,
  sample_id      uuid,
  sample_title   text,
  creator_id     uuid,
  target_version smallint,
  status         text,
  attempts       int,
  last_error     text,
  claimed_by     text,
  claimed_at     timestamptz,
  finished_at    timestamptz,
  enqueue_version int,
  progress_json  jsonb,
  created_at     timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._assert_caller_is_admin();
  RETURN QUERY
    SELECT j.id, j.sample_id, s.title, s.creator_id, j.target_version,
           j.status, j.attempts, j.last_error, j.claimed_by, j.claimed_at,
           j.finished_at, j.enqueue_version, j.progress_json, j.created_at
      FROM public.corpus_reprocess_jobs j
      JOIN public.sample_content s ON s.id = j.sample_id
     WHERE (p_creator_id IS NULL OR s.creator_id = p_creator_id)
     ORDER BY j.created_at DESC
     LIMIT GREATEST(LEAST(p_limit, 500), 1);
END;$$;

COMMENT ON FUNCTION public.admin_list_corpus_reprocess_jobs(uuid, int) IS
  'Admin-readable view of the corpus_reprocess_jobs queue. RLS deny-all on the table itself; this RPC is the only authenticated read path. Asserts admin via _assert_caller_is_admin. p_creator_id NULL = list all; LIMIT clamped 1-500.';

REVOKE ALL ON FUNCTION public.admin_list_corpus_reprocess_jobs(uuid, int)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_corpus_reprocess_jobs(uuid, int)
  TO authenticated;


-- ── Stuck-row reaper ─────────────────────────────────────────────────────────
-- Audit-5 C2 fix: 600s TTL (was 60s — wrong for the actual workload). Worst
-- case per-sample reprocess is multi-minute (Anthropic contextual-gen + LLM
-- chunking + batched embed for 500KB corpus). Worker's CLAIM_TIMEOUT_MS
-- should be set below this ceiling (e.g. 540s = 9 min).

CREATE FUNCTION public.reap_stuck_corpus_reprocess_jobs() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_reaped int;
BEGIN
  UPDATE public.corpus_reprocess_jobs
     SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
         updated_at = now()
   WHERE status = 'processing'
     AND claimed_at < now() - INTERVAL '600 seconds';
  GET DIAGNOSTICS v_reaped = ROW_COUNT;
  RETURN v_reaped;
END;$$;

REVOKE ALL ON FUNCTION public.reap_stuck_corpus_reprocess_jobs() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reap_stuck_corpus_reprocess_jobs() TO service_role;


-- ── pg_cron schedule ─────────────────────────────────────────────────────────
-- Mirrors the wrap pattern from 20260512000004:104-113. Idempotently
-- unschedule before re-registering so re-applies / snapshot restores don't
-- leave dangling schedules (audit-5 C3-adjacent — also applied to the
-- test-fixture migration).

DO $$
BEGIN
  BEGIN
    PERFORM cron.unschedule('reap_stuck_corpus_reprocess_jobs');
  EXCEPTION
    -- Narrow per audit-6 small: pg_cron raises a generic exception with
    -- message "could not find valid entry for job ..." when the schedule
    -- doesn't exist; undefined_function fires when pg_cron isn't installed.
    -- Both are safe to swallow; anything else (e.g., FK / permission errors)
    -- bubbles up so we don't silently mask deploy bugs.
    WHEN undefined_function THEN NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%could not find valid entry%' THEN
        NULL;
      ELSE
        RAISE;
      END IF;
  END;

  PERFORM cron.schedule(
    'reap_stuck_corpus_reprocess_jobs',
    '* * * * *',
    $sched$SELECT public.reap_stuck_corpus_reprocess_jobs();$sched$
  );
EXCEPTION WHEN undefined_function THEN
  -- pg_cron not installed (local dev / CI / fresh Supabase). The in-process
  -- reaper inside the worker covers steady state when pg_cron is absent.
  RAISE NOTICE 'pg_cron not installed; skipping reap_stuck_corpus_reprocess_jobs schedule.';
END$$;
