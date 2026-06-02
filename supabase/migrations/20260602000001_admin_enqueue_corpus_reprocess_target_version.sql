-- 20260602000001 — admin corpus-reprocess enqueue gains a p_target_version arg.
--
-- WHY THIS EXISTS (V3_FLIP_EXECUTION.md — the one missing piece)
-- ─────────────────────────────────────────────────────────────
-- RAG v3 is fully built + live but DORMANT behind per-creator
-- retrieval_version=3. The intended rollout is BUILD-THEN-FLIP: build a v3
-- corpus for a creator while they keep SERVING v2, then flip via the gated
-- admin_set_creator_retrieval_version once creator_v3_ready() is TRUE.
--
-- That requires enqueuing target_version=3 jobs for a creator who is STILL at
-- retrieval_version=2. Nothing could:
--   * the on-edit trigger (enqueue_sample_embedding_job, 20260528000051) routes
--     by the creator's CURRENT retrieval_version → a v2 creator's edits enqueue
--     target_version=2, only enqueues 3 once already at 3 (chicken-and-egg);
--   * _admin_enqueue_corpus_reprocess_unsafe (20260518000001) HARDCODED
--     target_version=2 in all three sites (two INSERTs + the
--     skipped_already_queued pre-snapshot join).
-- The eval harness sidestepped this by birthing a creator AT retrieval_version=3
-- (diag-eval-v3.mjs) — fine for a throwaway, useless for an existing creator.
--
-- THIS MIGRATION adds `p_target_version smallint DEFAULT 2` to both the
-- service-role implementation and the public wrapper, parameterizing all three
-- hardcoded 2s. DEFAULT 2 keeps every existing caller (route, CLI, pgTAP)
-- enqueuing v2 unchanged; `p_target_version => 3` is the new build-then-flip path.
--
-- WHY DROP, NOT CREATE OR REPLACE (V3_FLIP audit C1)
-- ──────────────────────────────────────────────────
-- Postgres function identity is the argument-type list. Adding a trailing param
-- makes (uuid,uuid,boolean,smallint) a DIFFERENT function from the existing
-- (uuid,uuid,boolean) — CREATE OR REPLACE would create a SECOND overload and
-- leave the old target_version=2-hardcoded function on disk for 3-arg callers to
-- resolve to. So we DROP both old signatures FIRST (wrapper before the unsafe it
-- depends on), then CREATE the new defaulted forms, then RE-STATE the GRANT/REVOKE
-- footer (DROP invalidates the old grants). Post-DROP exactly one of each function
-- exists; a call omitting the defaulted arg resolves to it via the default.
--
-- Single-apply via the Supabase migration ledger. DROP-first makes a clean
-- re-run safe; a mid-file failure is not auto-resumable (CREATE FUNCTION, not
-- OR REPLACE, on the new identities). DROP order matters: the wrapper depends on
-- _unsafe, so drop the wrapper first.

-- ── 0. DROP old signatures (wrapper first — it calls the unsafe one) ─────────
DROP FUNCTION IF EXISTS public.admin_enqueue_corpus_reprocess(uuid, boolean);
DROP FUNCTION IF EXISTS public._admin_enqueue_corpus_reprocess_unsafe(uuid, uuid, boolean);

-- ───────────────────────────────────────────────────────────────────────────
-- _admin_enqueue_corpus_reprocess_unsafe — service-role implementation
-- (4-arg: p_target_version smallint DEFAULT 2 appended; all three hardcoded 2s
--  parameterized — the two INSERT target_version columns + the line-192
--  skipped_already_queued pre-snapshot join.)
-- ───────────────────────────────────────────────────────────────────────────

CREATE FUNCTION public._admin_enqueue_corpus_reprocess_unsafe(
  p_admin_user_id uuid,
  p_creator_id    uuid,
  p_force         boolean  DEFAULT false,
  p_target_version smallint DEFAULT 2
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

  -- v3-flip: target_version must be 2 (the live v2 build) or 3 (the v3
  -- build-then-flip path). Defense-in-depth — the corpus_reprocess_jobs
  -- target_version CHECK already enforces IN (2,3), but fail loud here with a
  -- distinct message so a typo'd CLI/route arg doesn't surface as a generic
  -- constraint violation deep in the INSERT.
  IF p_target_version IS NULL OR p_target_version NOT IN (2, 3) THEN
    RAISE EXCEPTION USING errcode='22023', message='target_version_invalid';
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
      SELECT s.id, p_target_version, 'pending', 0, 1
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
    --
    -- V3_FLIP audit C2: this join MUST filter on p_target_version (was a
    -- hardcoded 2), or a v3 enqueue reports "already queued" counts off the
    -- v2 queue.
    SELECT count(*)::int INTO v_skipped_already_queued
      FROM public.sample_content s
      JOIN public.corpus_reprocess_jobs j
        ON j.sample_id = s.id AND j.target_version = p_target_version
     WHERE s.creator_id = p_creator_id
       AND s.raw_text IS NOT NULL
       AND j.status IN ('pending', 'processing');

    WITH ins AS (
      INSERT INTO public.corpus_reprocess_jobs
        (sample_id, target_version, status, attempts, enqueue_version)
      SELECT s.id, p_target_version, 'pending', 0, 1
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
       'force',               p_force,
       'target_version',      p_target_version
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

REVOKE ALL ON FUNCTION public._admin_enqueue_corpus_reprocess_unsafe(uuid, uuid, boolean, smallint)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_enqueue_corpus_reprocess_unsafe(uuid, uuid, boolean, smallint)
  TO service_role;

COMMENT ON FUNCTION public._admin_enqueue_corpus_reprocess_unsafe(uuid, uuid, boolean, smallint) IS
  'Service-role-only implementation. Trusts p_admin_user_id but verifies admin_roles membership for audit-row attribution. Caller is responsible for the actual admin auth (Next route assertAdminFromSession, or admin who possesses service-role key for CLI use). p_target_version (DEFAULT 2) enqueues into the v2 or v3 corpus_reprocess queue — 3 is the v3 build-then-flip path (build while still at retrieval_version=2). Inserts/updates corpus_reprocess_jobs and writes one admin_audit_log row (before.target_version records the queue). Migration 20260602000001.';


-- ───────────────────────────────────────────────────────────────────────────
-- admin_enqueue_corpus_reprocess — public wrapper for authenticated callers
-- ───────────────────────────────────────────────────────────────────────────

CREATE FUNCTION public.admin_enqueue_corpus_reprocess(
  p_creator_id uuid,
  p_force      boolean DEFAULT false,
  p_target_version smallint DEFAULT 2
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
      FROM public._admin_enqueue_corpus_reprocess_unsafe(auth.uid(), p_creator_id, p_force, p_target_version) u;
END;$$;

REVOKE ALL ON FUNCTION public.admin_enqueue_corpus_reprocess(uuid, boolean, smallint)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_enqueue_corpus_reprocess(uuid, boolean, smallint)
  TO authenticated;

COMMENT ON FUNCTION public.admin_enqueue_corpus_reprocess(uuid, boolean, smallint) IS
  'Authenticated-admin wrapper. Asserts admin via _assert_caller_is_admin() and forwards to _admin_enqueue_corpus_reprocess_unsafe with auth.uid() as the audit user. p_force=false (default) re-enqueues only done/errored rows; p_force=true re-enqueues all but skips rows actively claimed (claimed_at > now() - 540s). p_target_version (DEFAULT 2) selects the v2 or v3 queue. Migration 20260602000001 added p_target_version.';
