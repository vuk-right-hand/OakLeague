-- 20260518000001 — Day-6 admin RPC: enqueue corpus_reprocess_jobs for all
-- ready samples of a creator.
--
-- Day-6 RAG-SOTA build (docs/_planning/RAG_SOTA_PLAN.md §5 + §11.Day6).
--
-- WHY THIS EXISTS
-- ───────────────
-- Phase 1 ships with `creators.retrieval_version=1` for every creator. The
-- on-`sample_content` trigger (`enqueue_sample_embedding_job`, migration
-- 20260516000003) routes a v1 creator's sample edits to the LEGACY queue.
-- It only routes to `corpus_reprocess_jobs` for creators ALREADY at
-- retrieval_version=2. But the entire Phase 1 dogfood premise is the
-- opposite: re-process v1 creators into v2 chunks BEFORE flipping their
-- retrieval_version. Admin needs an out-of-band enqueue path that bypasses
-- the trigger's version gate.
--
-- TWO ENTRY POINTS (mirroring _creator_brain_compile_unsafe / brain-recompile)
-- ─────────────────────────────────────────────────────────────────────────
--   1. `_admin_enqueue_corpus_reprocess_unsafe(p_admin_user_id, p_creator_id,
--      p_force)` — service-role only. Used by:
--        * /api/admin/corpus-reprocess (gated at Next-level by
--          assertAdminFromSession())
--        * scripts/corpus-reprocess.mjs (CLI; service-role key in env)
--      Caller must guarantee admin auth; the function trusts p_admin_user_id
--      for the audit row.
--   2. `admin_enqueue_corpus_reprocess(p_creator_id, p_force)` — public
--      wrapper. Asserts admin via `_assert_caller_is_admin()` and forwards
--      to the unsafe variant with auth.uid() as the audit user. Used by:
--        * Direct in-DB SQL sessions (admin SQL editor)
--        * Future authenticated server actions if Next-level gating is
--          ever dropped in favor of DB-level gating only.
--
-- IDEMPOTENCY
-- ───────────
-- ON CONFLICT (sample_id, target_version) — the unique key from migration
-- 20260515000001:
--   * p_force = false (default): only re-enqueue rows in status='done' or
--     'errored'. Skip rows that are 'pending' or 'processing' (already in
--     flight or queued).
--   * p_force = true: re-enqueue every row regardless of status, BUT skip
--     rows currently `claimed_at > now() - 540s` (the worker's
--     CLAIM_TIMEOUT_MS) as a courtesy — forcing into an actively-claimed
--     row creates a re-enqueue race that the worker's `enqueue_version`
--     sentinel handles correctly (corpus_reprocess_mark_done returns NULL
--     → silent abandon) but wastes an entire claim cycle.
--
-- AUDIT
-- ─────
-- Every call writes one `admin_audit_log` row with
--   action      = 'creator_corpus_reprocess_enqueue'
--   target_kind = 'creator'
--   target_id   = p_creator_id
--   before      = {total_ready_samples, force}
--   after       = {enqueued_count, skipped_in_flight}
-- Zero-enqueue calls still audit (the click happened — that's worth knowing).

-- ───────────────────────────────────────────────────────────────────────────
-- _admin_enqueue_corpus_reprocess_unsafe — service-role implementation
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._admin_enqueue_corpus_reprocess_unsafe(
  p_admin_user_id uuid,
  p_creator_id    uuid,
  p_force         boolean DEFAULT false
) RETURNS TABLE (
  enqueued_count        int,
  total_ready_samples   int,
  skipped_in_flight     int,
  skipped_already_queued int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_enqueued              int := 0;
  v_total_ready           int := 0;
  v_skipped_inflight      int := 0;
  v_skipped_already_queued int := 0;
  v_creator_exists        boolean;
  v_admin_exists          boolean;
BEGIN
  -- Validate p_admin_user_id. The CLI / Next route is responsible for
  -- proving the caller is admin (via service-role key + Next gate); we still
  -- verify the supplied admin_user_id is currently an active admin so a
  -- compromised service-role key can't write audit rows attributed to an
  -- arbitrary user.
  IF p_admin_user_id IS NULL THEN
    RAISE EXCEPTION USING errcode='22023', message='admin_user_id_null';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.admin_roles
     WHERE user_id = p_admin_user_id AND revoked_at IS NULL
  ) INTO v_admin_exists;
  IF NOT v_admin_exists THEN
    RAISE EXCEPTION USING errcode='42501', message='not_an_active_admin';
  END IF;

  IF p_creator_id IS NULL THEN
    RAISE EXCEPTION USING errcode='22023', message='creator_id_null';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.creators WHERE id = p_creator_id)
    INTO v_creator_exists;
  IF NOT v_creator_exists THEN
    RAISE EXCEPTION USING errcode='42704', message='creator_not_found';
  END IF;

  SELECT count(*)::int INTO v_total_ready
    FROM public.sample_content
   WHERE creator_id = p_creator_id
     AND raw_text IS NOT NULL;

  -- p_force=true branch first (full re-enqueue with in-flight courtesy skip).
  IF p_force THEN
    WITH ins AS (
      INSERT INTO public.corpus_reprocess_jobs
        (sample_id, target_version, status, attempts, enqueue_version)
      SELECT s.id, 2, 'pending', 0, 1
        FROM public.sample_content s
       WHERE s.creator_id = p_creator_id
         AND s.raw_text IS NOT NULL
      ON CONFLICT (sample_id, target_version) DO UPDATE
        SET status          = CASE
                                WHEN public.corpus_reprocess_jobs.status = 'processing'
                                 AND public.corpus_reprocess_jobs.claimed_at IS NOT NULL
                                 AND public.corpus_reprocess_jobs.claimed_at > now() - INTERVAL '540 seconds'
                                THEN public.corpus_reprocess_jobs.status
                                ELSE 'pending'
                              END,
            attempts        = CASE
                                WHEN public.corpus_reprocess_jobs.status = 'processing'
                                 AND public.corpus_reprocess_jobs.claimed_at IS NOT NULL
                                 AND public.corpus_reprocess_jobs.claimed_at > now() - INTERVAL '540 seconds'
                                THEN public.corpus_reprocess_jobs.attempts
                                ELSE 0
                              END,
            last_error      = CASE
                                WHEN public.corpus_reprocess_jobs.status = 'processing'
                                 AND public.corpus_reprocess_jobs.claimed_at IS NOT NULL
                                 AND public.corpus_reprocess_jobs.claimed_at > now() - INTERVAL '540 seconds'
                                THEN public.corpus_reprocess_jobs.last_error
                                ELSE NULL
                              END,
            claimed_by      = CASE
                                WHEN public.corpus_reprocess_jobs.status = 'processing'
                                 AND public.corpus_reprocess_jobs.claimed_at IS NOT NULL
                                 AND public.corpus_reprocess_jobs.claimed_at > now() - INTERVAL '540 seconds'
                                THEN public.corpus_reprocess_jobs.claimed_by
                                ELSE NULL
                              END,
            claimed_at      = CASE
                                WHEN public.corpus_reprocess_jobs.status = 'processing'
                                 AND public.corpus_reprocess_jobs.claimed_at IS NOT NULL
                                 AND public.corpus_reprocess_jobs.claimed_at > now() - INTERVAL '540 seconds'
                                THEN public.corpus_reprocess_jobs.claimed_at
                                ELSE NULL
                              END,
            finished_at     = CASE
                                WHEN public.corpus_reprocess_jobs.status = 'processing'
                                 AND public.corpus_reprocess_jobs.claimed_at IS NOT NULL
                                 AND public.corpus_reprocess_jobs.claimed_at > now() - INTERVAL '540 seconds'
                                THEN public.corpus_reprocess_jobs.finished_at
                                ELSE NULL
                              END,
            enqueue_version = public.corpus_reprocess_jobs.enqueue_version + 1,
            updated_at      = now()
      RETURNING
        (xmax = 0) AS inserted_now,
        (status = 'processing'
         AND claimed_at IS NOT NULL
         AND claimed_at > now() - INTERVAL '540 seconds') AS still_in_flight
    )
    SELECT
      count(*) FILTER (WHERE inserted_now OR NOT still_in_flight)::int,
      count(*) FILTER (WHERE still_in_flight)::int
      INTO v_enqueued, v_skipped_inflight
      FROM ins;
  ELSE
    -- p_force=false branch — re-enqueue ONLY done/errored rows. Pending /
    -- processing rows are intentionally skipped (the worker is already
    -- handling them). Audit-1 C3 fix: track skipped_already_queued so the
    -- UI can show "5 already queued, 5 newly enqueued" instead of
    -- "5 of 10" with no explanation for the missing 5.
    --
    -- Audit-3 follow-up: capture the pre-INSERT pending/processing count
    -- BEFORE the UPSERT runs. Counting after the INSERT overcounts because
    -- newly-inserted rows arrive with status='pending' and look identical
    -- to "already-queued" pending rows. The pre-snapshot is the only
    -- correct source of truth.
    SELECT count(*)::int INTO v_skipped_already_queued
      FROM public.sample_content s
      JOIN public.corpus_reprocess_jobs j
        ON j.sample_id = s.id AND j.target_version = 2
     WHERE s.creator_id = p_creator_id
       AND s.raw_text IS NOT NULL
       AND j.status IN ('pending', 'processing');

    WITH ins AS (
      INSERT INTO public.corpus_reprocess_jobs
        (sample_id, target_version, status, attempts, enqueue_version)
      SELECT s.id, 2, 'pending', 0, 1
        FROM public.sample_content s
       WHERE s.creator_id = p_creator_id
         AND s.raw_text IS NOT NULL
      ON CONFLICT (sample_id, target_version) DO UPDATE
        SET status          = 'pending',
            attempts        = 0,
            last_error      = NULL,
            claimed_by      = NULL,
            claimed_at      = NULL,
            finished_at     = NULL,
            enqueue_version = public.corpus_reprocess_jobs.enqueue_version + 1,
            updated_at      = now()
      WHERE public.corpus_reprocess_jobs.status IN ('done', 'errored')
      RETURNING 1 AS r
    )
    SELECT count(*)::int INTO v_enqueued FROM ins;

    v_skipped_inflight := 0;
  END IF;

  INSERT INTO public.admin_audit_log
    (admin_user_id, action, target_kind, target_id, before, after)
  VALUES
    (p_admin_user_id,
     'creator_corpus_reprocess_enqueue',
     'creator',
     p_creator_id,
     jsonb_build_object(
       'total_ready_samples', v_total_ready,
       'force',               p_force
     ),
     jsonb_build_object(
       'enqueued_count',         v_enqueued,
       'skipped_in_flight',      v_skipped_inflight,
       'skipped_already_queued', v_skipped_already_queued
     ));

  enqueued_count         := v_enqueued;
  total_ready_samples    := v_total_ready;
  skipped_in_flight      := v_skipped_inflight;
  skipped_already_queued := v_skipped_already_queued;
  RETURN NEXT;
END;$$;

REVOKE ALL ON FUNCTION public._admin_enqueue_corpus_reprocess_unsafe(uuid, uuid, boolean)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_enqueue_corpus_reprocess_unsafe(uuid, uuid, boolean)
  TO service_role;

COMMENT ON FUNCTION public._admin_enqueue_corpus_reprocess_unsafe(uuid, uuid, boolean) IS
  'Service-role-only implementation. Trusts p_admin_user_id but verifies admin_roles membership for audit-row attribution. Caller is responsible for the actual admin auth (Next route assertAdminFromSession, or admin who possesses service-role key for CLI use). Inserts/updates corpus_reprocess_jobs and writes one admin_audit_log row.';


-- ───────────────────────────────────────────────────────────────────────────
-- admin_enqueue_corpus_reprocess — public wrapper for authenticated callers
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_enqueue_corpus_reprocess(
  p_creator_id uuid,
  p_force      boolean DEFAULT false
) RETURNS TABLE (
  enqueued_count         int,
  total_ready_samples    int,
  skipped_in_flight      int,
  skipped_already_queued int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._assert_caller_is_admin();
  RETURN QUERY
    SELECT u.enqueued_count, u.total_ready_samples, u.skipped_in_flight, u.skipped_already_queued
      FROM public._admin_enqueue_corpus_reprocess_unsafe(auth.uid(), p_creator_id, p_force) u;
END;$$;

REVOKE ALL ON FUNCTION public.admin_enqueue_corpus_reprocess(uuid, boolean)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_enqueue_corpus_reprocess(uuid, boolean)
  TO authenticated;

COMMENT ON FUNCTION public.admin_enqueue_corpus_reprocess(uuid, boolean) IS
  'Authenticated-admin wrapper. Asserts admin via _assert_caller_is_admin() and forwards to _admin_enqueue_corpus_reprocess_unsafe with auth.uid() as the audit user. p_force=false (default) re-enqueues only done/errored rows; p_force=true re-enqueues all but skips rows actively claimed (claimed_at > now() - 540s).';
