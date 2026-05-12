-- 20260512000004 — sample_content_embedding_jobs.
--
-- M4 of pgvector RAG plan. Queue + reaper for the in-process embed-worker
-- (spawned alongside voice-delete-worker / simli-face-delete-worker /
-- face-upload-reaper in server/voice-proxy/index.js).
--
-- Audit fixes baked in:
--   * R1 C4 — single-fly SPOF, double-claim race, ON CONFLICT mid-flight
--     re-enqueue. Fixed via enqueue_version sentinel + 60s reaper +
--     host-fenced claimed_by + attempts cap 5.
--   * R2 C2 — atomic version-check on job-done. The worker calls
--     finalize_embedding_job (M11) which UPDATEs WHERE enqueue_version
--     matches and ROLLBACKs the entire chunk replacement if not.
--   * R3 C3 — pg_cron schedule wrapped in DO/EXCEPTION so the migration
--     applies in environments without pg_cron (mirrors existing
--     20260425000003_ratelimit_cleanup_pgcron.sql pattern). In-process
--     reaper at top of worker poll is the steady-state guard.
--   * Trigger skips raw_text=NULL (R2 Small fix). raw_text deletion
--     CASCADEs chunks via FK; no enqueue needed.

CREATE TABLE public.sample_content_embedding_jobs (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_id       uuid           NOT NULL UNIQUE REFERENCES public.sample_content(id) ON DELETE CASCADE,
  status          text           NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'processing', 'done', 'errored')),
  attempts        int            NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 5),
  last_error      text           CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
  claimed_by      text           CHECK (claimed_by IS NULL OR char_length(claimed_by) <= 64),
  claimed_at      timestamptz,
  finished_at     timestamptz,
  enqueue_version int            NOT NULL DEFAULT 1,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX sample_content_embedding_jobs_status_idx
  ON public.sample_content_embedding_jobs (status, claimed_at NULLS FIRST);

CREATE TRIGGER sample_content_embedding_jobs_touch_updated_at
  BEFORE UPDATE ON public.sample_content_embedding_jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.sample_content_embedding_jobs ENABLE ROW LEVEL SECURITY;
-- Service-role only, zero policies.

-- ── Enqueue trigger ───────────────────────────────────────────────────────
-- ON CONFLICT bumps enqueue_version. The worker captures version at claim
-- time and re-checks at finish; mid-flight re-enqueue → finalize RPC returns
-- NULL → worker abandons the write cleanly.
CREATE FUNCTION public.enqueue_sample_embedding_job() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.raw_text IS NULL THEN
    -- No re-enqueue when raw_text is cleared; chunks CASCADE on sample delete.
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.raw_text IS DISTINCT FROM OLD.raw_text THEN
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
  END IF;
  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.enqueue_sample_embedding_job() FROM public;

CREATE TRIGGER enqueue_sample_embedding_job
  AFTER INSERT OR UPDATE OF raw_text ON public.sample_content
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_sample_embedding_job();

-- ── Stuck-row reaper ──────────────────────────────────────────────────────
-- 60s ceiling >> worst-case batch RTT (~30s). Worker calls this at the top
-- of every poll as the in-process guard; pg_cron schedules it once/min as
-- the out-of-process backstop for a hung-worker process.
CREATE FUNCTION public.reap_stuck_embedding_jobs() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_reaped int;
BEGIN
  UPDATE public.sample_content_embedding_jobs
     SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
         updated_at = now()
   WHERE status = 'processing'
     AND claimed_at < now() - INTERVAL '60 seconds';
  GET DIAGNOSTICS v_reaped = ROW_COUNT;
  RETURN v_reaped;
END;$$;

REVOKE ALL ON FUNCTION public.reap_stuck_embedding_jobs() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reap_stuck_embedding_jobs() TO service_role;

-- ── pg_cron schedule (R3 C3) ──────────────────────────────────────────────
-- Wrapped in DO/EXCEPTION mirroring 20260425000003. Local dev / CI / fresh
-- Supabase projects that don't have pg_cron installed apply this migration
-- cleanly; in-process reaper covers steady state.
DO $$
BEGIN
  PERFORM cron.schedule(
    'reap_stuck_embedding_jobs',
    '* * * * *',
    $sched$SELECT public.reap_stuck_embedding_jobs();$sched$
  );
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'pg_cron not installed; skipping reap_stuck_embedding_jobs schedule. In-process reaper at worker poll covers the steady-state case.';
END$$;
