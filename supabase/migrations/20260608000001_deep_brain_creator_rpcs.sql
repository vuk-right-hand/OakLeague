-- 20260608000001 — Deep Brain: creator-scoped enable/activate of retrieval_version=3.
--
-- DEEP_BRAIN_SWITCH_PLAN v2. A creator turns on "Deep Brain" (v3 routed
-- retrieval) from their OWN dashboard — no admin. Three new objects + one
-- refactor of the live admin flip:
--
--   1. creator_audit_log — a creator-action audit sink. CRITICAL (plan C1):
--      admin_audit_log.admin_user_id FKs to admin_roles, so a creator's uid
--      would 23503-violate and roll back the whole RPC. Creators audit here.
--   2. _set_retrieval_version_v3_unsafe(creator_id) — the SHARED →3 core
--      (plan C2): advisory lock + FOR UPDATE + same-version no-op + v3 gate +
--      UPDATE + persona recompile. BOTH the admin flip AND the creator
--      activate call it, so the two paths can NEVER drift. Soft cutover (no
--      chunk deletes) preserved.
--   3. admin_set_creator_retrieval_version — REFACTORED so its →3 branch
--      delegates to the core. The →1/→2 branch (downgrade/rollback/zombie
--      cleanup) is preserved BYTE-FOR-BYTE — its existing behavior + pgTAP
--      are untouched.
--   4. creator_enable_deep_brain() / creator_activate_deep_brain() — the
--      creator-scoped wrappers. They take NO creator_id arg: ownership is
--      derived from auth.uid() so a creator can only ever act on their own
--      brain (plan R1 — IDOR-proof by construction).
--
-- additive + CREATE OR REPLACE only on the admin RPC; no column/enum/signature
-- change. Replay-safe.

-- ── 1. creator_audit_log (plan C1) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.creator_audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action     text NOT NULL,
  target_id  uuid REFERENCES public.creators(id) ON DELETE CASCADE,
  before     jsonb,
  after      jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creator_audit_log_user_idx
  ON public.creator_audit_log (user_id, created_at DESC);

-- FIFO queue-position support (re-audit M2): creator_deep_brain_status counts
-- pending jobs older than the caller's oldest in-flight job on every poll. The
-- table's only other index is (status, claimed_at); this partial index serves
-- the `status='pending' AND created_at < X` scan so polls stay cheap under a
-- backlog (exactly when the count matters).
CREATE INDEX IF NOT EXISTS corpus_reprocess_jobs_pending_created_idx
  ON public.corpus_reprocess_jobs (created_at)
  WHERE status = 'pending';

-- Service-role only: RLS on, zero policies = deny-all for anon/authenticated.
-- Written exclusively by the SECURITY DEFINER creator RPCs below.
ALTER TABLE public.creator_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.creator_audit_log FROM public, anon, authenticated;
GRANT ALL ON TABLE public.creator_audit_log TO service_role;

COMMENT ON TABLE public.creator_audit_log IS
  'Audit sink for creator-initiated self-service actions (e.g. Deep Brain enable/activate). Separate from admin_audit_log because that table FKs admin_user_id to admin_roles — a creator uid would FK-violate. FK to auth.users(id). Service-role only (RLS on, zero policies).';

-- ── 2. Shared →3 core (plan C2) ───────────────────────────────────────────
-- Returns the PREVIOUS retrieval_version, or NULL when the creator was already
-- on 3 (caller returns before auditing — plan M1). Does NOT audit (the caller
-- owns audit, since admin vs creator write to different logs).
CREATE OR REPLACE FUNCTION public._set_retrieval_version_v3_unsafe(p_creator_id uuid)
RETURNS smallint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev  smallint;
  v_ready boolean;
BEGIN
  SET LOCAL lock_timeout = '5s';

  -- Advisory lock FIRST (before the creators FOR UPDATE) so the flip serializes
  -- against an in-flight finalize_v3 for the SAME creator — the creator_v3_ready
  -- read below must see a stable, committed build, never a half-finalized one.
  -- Same key + lock order as finalize_v3 / claim_corpus_reprocess_job /
  -- admin_purge_legacy_chunks, so no deadlock.
  PERFORM pg_advisory_xact_lock(hashtext('reprocess:' || p_creator_id::text));

  SELECT retrieval_version INTO v_prev
    FROM public.creators WHERE id = p_creator_id
    FOR UPDATE;
  IF v_prev IS NULL THEN
    RAISE EXCEPTION USING errcode='42704', message='creator_not_found';
  END IF;

  -- Already on v3 → no-op. Caller RETURNs before any audit write.
  IF v_prev = 3 THEN
    RETURN NULL;
  END IF;

  -- v3 FLIP GATE: cannot flip to 3 unless every ready sample is v3-warm
  -- (sections + non-NULL embeddings + done job + child chunks). The whole
  -- point — a half-built creator must not serve via the v3 read path.
  SELECT public.creator_v3_ready(p_creator_id) INTO v_ready;
  IF NOT v_ready THEN
    RAISE EXCEPTION USING errcode='check_violation',
      message='creator_v3_not_ready -- at least one ready sample is missing v3 sections / chunks / done job. Run creator_v3_ready(creator_id) for diagnostics.';
  END IF;

  -- SOFT CUTOVER: no chunk deletes — v1/v2 chunks go dormant (the v3 read path
  -- version-filters them) so a rollback off v3 restores retrieval instantly.
  UPDATE public.creators SET retrieval_version = 3 WHERE id = p_creator_id;

  -- Per-version persona recompile, in-txn (raises on failure → whole flip
  -- rolls back, keeping the flip atomic).
  PERFORM public._creator_brain_compile_unsafe(p_creator_id);

  RETURN v_prev;
END;$$;

COMMENT ON FUNCTION public._set_retrieval_version_v3_unsafe(uuid) IS
  'Shared →3 flip core (DEEP_BRAIN plan C2). advisory-lock + FOR UPDATE + same-version no-op + creator_v3_ready gate + UPDATE retrieval_version=3 (soft cutover, no deletes) + persona recompile. Returns prev version, or NULL if already 3. Does NOT audit. Called by admin_set_creator_retrieval_version (→3 path) and creator_activate_deep_brain so the two can never drift. Internal — not granted to anon/authenticated; SECDEF wrappers reach it via ownership.';

REVOKE ALL ON FUNCTION public._set_retrieval_version_v3_unsafe(uuid)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._set_retrieval_version_v3_unsafe(uuid) TO service_role;

-- ── 3. Refactor admin flip: →3 delegates to the core ──────────────────────
CREATE OR REPLACE FUNCTION public.admin_set_creator_retrieval_version(
  p_creator_id uuid,
  p_version    smallint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_id         uuid;
  v_prev             smallint;
  v_legacy_purged_at timestamptz;
  v_chunks_deleted   int := 0;
  v_units_deleted    int := 0;
BEGIN
  v_admin_id := auth.uid();
  PERFORM public._assert_caller_is_admin();

  IF p_version IS NULL OR p_version NOT IN (1, 2, 3) THEN
    RAISE EXCEPTION USING errcode='22023', message='version_invalid';
  END IF;

  SET LOCAL lock_timeout = '5s';

  -- ── Flip TO 3: delegate to the shared core so admin + creator paths can
  -- never drift (DEEP_BRAIN plan C2). Core does advisory lock + FOR UPDATE +
  -- same-version no-op + v3 gate + update + recompile (soft cutover). ──
  IF p_version = 3 THEN
    v_prev := public._set_retrieval_version_v3_unsafe(p_creator_id);
    IF v_prev IS NULL THEN
      RETURN;  -- already on v3 — no-op (no recompile / audit)
    END IF;
    INSERT INTO public.admin_audit_log
      (admin_user_id, action, target_kind, target_id, before, after)
    VALUES
      (v_admin_id, 'creator_retrieval_version_set', 'creator', p_creator_id,
       jsonb_build_object('retrieval_version', v_prev),
       jsonb_build_object('retrieval_version', 3, 'soft_cutover', true, 'legacy_chunks_purged', false));
    RETURN;
  END IF;

  -- ── Flip TO 1 or 2: PRESERVED VERBATIM from 20260531000001 (downgrade /
  -- rollback-refusal / v2→v1 zombie cleanup). Behavior + pgTAP unchanged. ──
  SELECT retrieval_version, legacy_purged_at INTO v_prev, v_legacy_purged_at
    FROM public.creators WHERE id = p_creator_id
    FOR UPDATE;
  IF v_prev IS NULL THEN
    RAISE EXCEPTION USING errcode='42704', message='creator_not_found';
  END IF;

  IF v_prev = p_version THEN
    RETURN;
  END IF;

  IF v_prev = 3 AND p_version IN (1, 2) AND v_legacy_purged_at IS NOT NULL THEN
    RAISE EXCEPTION USING errcode='check_violation',
      message='rollback_refused_legacy_purged -- legacy v1/v2 chunks were purged (admin_purge_legacy_chunks) at '||v_legacy_purged_at||'; rolling back to v'||p_version||' would read an empty corpus. Re-ingest the legacy corpus before downgrading.';
  END IF;

  UPDATE public.creators
     SET retrieval_version = p_version
   WHERE id = p_creator_id;

  IF v_prev = 2 AND p_version = 1 THEN
    DELETE FROM public.sample_content_chunks
     WHERE creator_id = p_creator_id AND chunker_version = 2;
    GET DIAGNOSTICS v_chunks_deleted = ROW_COUNT;

    DELETE FROM public.sample_content_narrative_units
     WHERE creator_id = p_creator_id;
    GET DIAGNOSTICS v_units_deleted = ROW_COUNT;
  END IF;

  PERFORM public._creator_brain_compile_unsafe(p_creator_id);

  INSERT INTO public.admin_audit_log
    (admin_user_id, action, target_kind, target_id, before, after)
  VALUES
    (v_admin_id, 'creator_retrieval_version_set', 'creator', p_creator_id,
     jsonb_build_object('retrieval_version', v_prev),
     CASE WHEN v_prev = 2 AND p_version = 1
       THEN jsonb_build_object('retrieval_version', p_version,
              'v2_chunks_deleted', v_chunks_deleted,
              'v2_narrative_units_deleted', v_units_deleted)
       ELSE jsonb_build_object('retrieval_version', p_version)
     END);
END;$$;

COMMENT ON FUNCTION public.admin_set_creator_retrieval_version(uuid, smallint) IS
  'Admin flips creators.retrieval_version between 1, 2, 3. The →3 path delegates to _set_retrieval_version_v3_unsafe (shared with creator_activate_deep_brain — DEEP_BRAIN plan C2) so admin + creator flips never drift: gated on creator_v3_ready, soft cutover (no v1/v2 deletes). →1/→2 path unchanged: same-version no-op, 3→2/3→1 rollback refused after legacy purge, v2→v1 cleans dead v2 chunks+units. Recompiles persona in-txn. Audits. Service-role/admin only.';

REVOKE ALL ON FUNCTION public.admin_set_creator_retrieval_version(uuid, smallint)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_creator_retrieval_version(uuid, smallint)
  TO authenticated;

-- ── 4a. creator_enable_deep_brain() — enqueue the v3 build ─────────────────
-- Ownership from auth.uid() (NO creator_id arg). Enqueues a v3 reprocess for
-- the creator's text samples that DON'T already have a done v3 job (plan C4:
-- never re-embed an already-built sample → no runaway COGS). One-way switch:
-- refuses once already on v3. Idempotent: re-clicking enqueues nothing new.
CREATE OR REPLACE FUNCTION public.creator_enable_deep_brain()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_creator_id   uuid;
  v_brain_status text;
  v_rv           smallint;
  v_buildable    int;
  v_enqueued     int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING errcode='28000', message='not_authenticated';
  END IF;

  SELECT id, brain_status, retrieval_version
    INTO v_creator_id, v_brain_status, v_rv
    FROM public.creators WHERE user_id = v_uid;
  IF v_creator_id IS NULL THEN
    RAISE EXCEPTION USING errcode='42501', message='not_a_creator';
  END IF;

  -- One-way switch: already on Deep Brain → nothing to build.
  IF v_rv = 3 THEN
    RETURN jsonb_build_object('already_on', true, 'enqueued', 0);
  END IF;

  -- Don't build a deep brain into a broken brain (plan M4).
  IF v_brain_status = 'errored' THEN
    RAISE EXCEPTION USING errcode='P0001', message='brain_errored';
  END IF;

  -- Buildable = READY text samples. Must match creator_v3_ready's gate
  -- predicate (fetch_status='ready') — re-audit M5: if enable counted/enqueued
  -- raw_text rows that aren't 'ready', a creator could build yet never satisfy
  -- the activate gate (which only inspects 'ready' samples) → stuck "Building"
  -- forever. Non-ready rows catch up via the on-sample trigger once they ready.
  SELECT count(*)::int INTO v_buildable
    FROM public.sample_content
   WHERE creator_id = v_creator_id AND fetch_status = 'ready' AND raw_text IS NOT NULL;
  IF v_buildable = 0 THEN
    RAISE EXCEPTION USING errcode='P0001', message='no_ready_samples';
  END IF;

  -- Enqueue v3 ONLY for text samples WITHOUT a done v3 job (plan C4). On
  -- conflict, resurrect ONLY 'errored' rows (a genuinely-broken sample re-bills
  -- its failed pipeline — acceptable, the alternative is it never builds);
  -- never disturb 'pending'/'processing' (worker is on them) or 'done' (those
  -- aren't even selected). finished_at reset on resurrect (plan S1).
  WITH ins AS (
    INSERT INTO public.corpus_reprocess_jobs
      (sample_id, target_version, status, attempts, enqueue_version)
    SELECT s.id, 3, 'pending', 0, 1
      FROM public.sample_content s
     WHERE s.creator_id = v_creator_id
       AND s.fetch_status = 'ready'
       AND s.raw_text IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.corpus_reprocess_jobs j
          WHERE j.sample_id = s.id AND j.target_version = 3 AND j.status = 'done'
       )
    ON CONFLICT (sample_id, target_version) DO UPDATE
      SET status          = 'pending',
          attempts        = 0,
          last_error      = NULL,
          claimed_by      = NULL,
          claimed_at      = NULL,
          finished_at     = NULL,
          enqueue_version = public.corpus_reprocess_jobs.enqueue_version + 1,
          updated_at      = now()
    WHERE public.corpus_reprocess_jobs.status = 'errored'
    RETURNING 1 AS r
  )
  SELECT count(*)::int INTO v_enqueued FROM ins;

  INSERT INTO public.creator_audit_log (user_id, action, target_id, before, after)
  VALUES (v_uid, 'creator_deep_brain_enable', v_creator_id,
          jsonb_build_object('retrieval_version', v_rv),
          jsonb_build_object('enqueued', v_enqueued, 'buildable', v_buildable));

  RETURN jsonb_build_object('already_on', false, 'enqueued', v_enqueued, 'buildable', v_buildable);
END;$$;

COMMENT ON FUNCTION public.creator_enable_deep_brain() IS
  'Creator-scoped (ownership via auth.uid(), NO creator_id arg). Enqueues a v3 corpus reprocess for the caller''s text samples lacking a done v3 job (idempotent; never re-embeds a built sample). Refuses if already on v3 or brain errored or no text samples. Audits to creator_audit_log. DEEP_BRAIN plan Step 1.';

REVOKE ALL ON FUNCTION public.creator_enable_deep_brain() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.creator_enable_deep_brain() TO authenticated;

-- ── 4b. creator_activate_deep_brain() — flip to v3 once built ──────────────
CREATE OR REPLACE FUNCTION public.creator_activate_deep_brain()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_creator_id uuid;
  v_prev       smallint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING errcode='28000', message='not_authenticated';
  END IF;

  SELECT id INTO v_creator_id
    FROM public.creators WHERE user_id = v_uid;
  IF v_creator_id IS NULL THEN
    RAISE EXCEPTION USING errcode='42501', message='not_a_creator';
  END IF;

  -- Shared core: advisory lock + gate + flip + recompile. Raises
  -- creator_v3_not_ready (check_violation) if the build isn't complete.
  v_prev := public._set_retrieval_version_v3_unsafe(v_creator_id);

  -- Already on v3 → idempotent no-op, RETURN before audit (plan M1: a
  -- cross-tab double-activate doesn't write a redundant audit row).
  IF v_prev IS NULL THEN
    RETURN jsonb_build_object('activated', true, 'already', true);
  END IF;

  INSERT INTO public.creator_audit_log (user_id, action, target_id, before, after)
  VALUES (v_uid, 'creator_deep_brain_activate', v_creator_id,
          jsonb_build_object('retrieval_version', v_prev),
          jsonb_build_object('retrieval_version', 3, 'soft_cutover', true));

  RETURN jsonb_build_object('activated', true, 'already', false);
END;$$;

COMMENT ON FUNCTION public.creator_activate_deep_brain() IS
  'Creator-scoped (ownership via auth.uid(), NO creator_id arg). Flips the caller''s creator to retrieval_version=3 via the shared _set_retrieval_version_v3_unsafe core (gated on creator_v3_ready; soft cutover). Idempotent if already on v3. Audits to creator_audit_log. DEEP_BRAIN plan Step 1.';

REVOKE ALL ON FUNCTION public.creator_activate_deep_brain() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.creator_activate_deep_brain() TO authenticated;

-- ── 4c. creator_deep_brain_status() — drive the dashboard card ─────────────
-- Creator-scoped read (ownership via auth.uid()). Returns the caller's own
-- retrieval_version, v3 readiness, per-status v3 job counts, and a FIFO queue
-- position ("N jobs ahead of you" — plan C5: a single worker means the second
-- creator building waits behind the first; show it honestly, not a spinner).
-- corpus_reprocess_jobs is RLS deny-all and creator_v3_ready is service-role
-- only, so this SECDEF function is how the creator reads its own build state
-- (plan M3 — never a client-supplied creator_id).
CREATE OR REPLACE FUNCTION public.creator_deep_brain_status()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_creator_id uuid;
  v_rv         smallint;
  v_ready      boolean;
  v_counts     jsonb;
  v_total      int;
  v_oldest     timestamptz;
  v_ahead      int := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING errcode='28000', message='not_authenticated';
  END IF;
  SELECT id, retrieval_version INTO v_creator_id, v_rv
    FROM public.creators WHERE user_id = v_uid;
  IF v_creator_id IS NULL THEN
    RAISE EXCEPTION USING errcode='42501', message='not_a_creator';
  END IF;

  v_ready := public.creator_v3_ready(v_creator_id);

  SELECT coalesce(jsonb_object_agg(status, c), '{}'::jsonb), coalesce(sum(c), 0)::int
    INTO v_counts, v_total
    FROM (
      SELECT j.status, count(*)::int AS c
        FROM public.corpus_reprocess_jobs j
        JOIN public.sample_content s ON s.id = j.sample_id
       WHERE s.creator_id = v_creator_id AND j.target_version = 3
       GROUP BY j.status
    ) t;

  -- FIFO position: how many OTHER pending jobs are older than this creator's
  -- oldest still-running v3 job (worker claims oldest-first, one at a time).
  SELECT min(j.created_at) INTO v_oldest
    FROM public.corpus_reprocess_jobs j
    JOIN public.sample_content s ON s.id = j.sample_id
   WHERE s.creator_id = v_creator_id AND j.target_version = 3
     AND j.status IN ('pending', 'processing');
  IF v_oldest IS NOT NULL THEN
    SELECT count(*)::int INTO v_ahead
      FROM public.corpus_reprocess_jobs j
     WHERE j.status = 'pending' AND j.created_at < v_oldest;
  END IF;

  RETURN jsonb_build_object(
    'retrieval_version', v_rv,
    'ready',             v_ready,
    'counts',            v_counts,
    'total',             v_total,
    'queue_ahead',       v_ahead,
    'oldest_pending_at', v_oldest
  );
END;$$;

COMMENT ON FUNCTION public.creator_deep_brain_status() IS
  'Creator-scoped (ownership via auth.uid(), NO creator_id arg). Returns the caller''s retrieval_version, creator_v3_ready, per-status v3 reprocess job counts, total, and FIFO queue_ahead. Drives the dashboard Deep Brain card. DEEP_BRAIN plan Step 3.';

REVOKE ALL ON FUNCTION public.creator_deep_brain_status() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.creator_deep_brain_status() TO authenticated;
