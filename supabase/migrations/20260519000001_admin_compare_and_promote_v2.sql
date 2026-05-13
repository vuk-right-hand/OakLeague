-- 20260519000001 — Day-7 admin tooling: side-by-side v1 vs v2 retrieval
-- comparison + "Promote v2" cleanup of v1 chunks for a creator.
--
-- Day-7 RAG-SOTA build (docs/_planning/RAG_SOTA_PLAN.md §5 step 4 + §11.Day7).
--
-- Two RPCs in this migration:
--
--   1. _admin_compare_v1_v2_retrieval_unsafe(p_admin_user_id, p_creator_id,
--      p_query_vec, p_k) — service-role-only. Runs cosine top-K against BOTH
--      chunker_version=1 (legacy) and chunker_version=2 (v2 narrative +
--      contextual) chunks of the same creator. Returns parallel result rows
--      so the UI can render side-by-side with the SAME query for fair
--      comparison. Hybrid (BM25 + RRF + rerank) lands in Phase 2; Day-7
--      tool is cosine-only because that's all v1 supports and we want the
--      apples-to-apples baseline.
--
--   2. _admin_promote_v2_chunks_unsafe(p_admin_user_id, p_creator_id) —
--      service-role-only. DELETEs every chunker_version=1 chunk for the
--      creator after confirming chunker_version=2 chunks exist (refuses if
--      v2 corpus is empty — that's the "ran the re-process script but the
--      worker errored out" footgun). Also DELETEs v1 narrative_units would
--      be a no-op (narrative_units is a v2-only table) so we skip it.
--
-- Plus public wrappers:
--   admin_compare_v1_v2_retrieval(p_creator_id, p_query_vec, p_k)
--   admin_promote_v2_chunks(p_creator_id)
--
-- which assert admin via _assert_caller_is_admin() and forward.
--
-- Audit
-- ─────
-- Compare is read-only — no audit row (we'd otherwise log every keystroke).
-- Promote writes one audit row with the v1 chunk-count deleted + the v2
-- chunk-count that gated the operation.

-- ───────────────────────────────────────────────────────────────────────────
-- _admin_compare_v1_v2_retrieval_unsafe — service-role implementation
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._admin_compare_v1_v2_retrieval_unsafe(
  p_admin_user_id uuid,
  p_creator_id    uuid,
  p_query_vec     halfvec(768),
  p_k             int DEFAULT 5
) RETURNS TABLE (
  chunker_version  smallint,
  chunk_id         uuid,
  sample_id        uuid,
  sample_title     text,
  chunk_context    text,
  text             text,
  similarity       numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_exists boolean;
  v_k            int;
BEGIN
  -- Caller responsibility — auth at Next-layer for the route, but verify
  -- the supplied admin_user_id is currently an active admin so a leaked
  -- service-role key can't query arbitrary creators' corpora.
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
  IF p_query_vec IS NULL THEN
    RAISE EXCEPTION USING errcode='22023', message='query_vec_null';
  END IF;

  -- Audit-2 M4: verify creator existence so a typo'd / stale id raises
  -- 42704 instead of silently returning zero rows from both buckets
  -- (which an admin would misread as "this creator has no chunks").
  -- Matches the symmetric check in _admin_promote_v2_chunks_unsafe.
  IF NOT EXISTS (SELECT 1 FROM public.creators WHERE id = p_creator_id) THEN
    RAISE EXCEPTION USING errcode='42704', message='creator_not_found';
  END IF;

  v_k := LEAST(GREATEST(COALESCE(p_k, 5), 1), 20);

  -- v1 top-K (chunker_version=1; no chunk_context). Mirrors the structure
  -- of creator_knowledge_topk but without the dedup-by-md5 step so the
  -- admin sees the raw ranking, including near-duplicates.
  RETURN QUERY
    (
      SELECT 1::smallint AS chunker_version,
             c.id        AS chunk_id,
             c.sample_id,
             s.title     AS sample_title,
             NULL::text  AS chunk_context,
             LEFT(c.text, 2000) AS text,
             (1 - (c.embedding <=> p_query_vec))::numeric AS similarity
        FROM public.sample_content_chunks c
        JOIN public.sample_content s ON s.id = c.sample_id
       WHERE c.creator_id = p_creator_id
         AND c.chunker_version = 1
         AND c.embedding IS NOT NULL
       ORDER BY c.embedding <=> p_query_vec
       LIMIT v_k
    )
    UNION ALL
    (
      SELECT 2::smallint AS chunker_version,
             c.id        AS chunk_id,
             c.sample_id,
             s.title     AS sample_title,
             LEFT(c.chunk_context, 1000) AS chunk_context,
             LEFT(c.text, 2000)          AS text,
             (1 - (c.embedding <=> p_query_vec))::numeric AS similarity
        FROM public.sample_content_chunks c
        JOIN public.sample_content s ON s.id = c.sample_id
       WHERE c.creator_id = p_creator_id
         AND c.chunker_version = 2
         AND c.embedding IS NOT NULL
       ORDER BY c.embedding <=> p_query_vec
       LIMIT v_k
    );
END;$$;

REVOKE ALL ON FUNCTION public._admin_compare_v1_v2_retrieval_unsafe(uuid, uuid, halfvec(768), int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_compare_v1_v2_retrieval_unsafe(uuid, uuid, halfvec(768), int)
  TO service_role;

COMMENT ON FUNCTION public._admin_compare_v1_v2_retrieval_unsafe(uuid, uuid, halfvec(768), int) IS
  'Day-7 admin tool: parallel cosine top-K against v1 + v2 chunks of one creator. Returns one row per matched chunk with chunker_version discriminator. Used by /admin/creators/[id] side-by-side comparison panel. Hybrid + rerank are Phase-2 — this RPC is cosine-only baseline for apples-to-apples v1 vs v2 readout.';


CREATE OR REPLACE FUNCTION public.admin_compare_v1_v2_retrieval(
  p_creator_id uuid,
  p_query_vec  halfvec(768),
  p_k          int DEFAULT 5
) RETURNS TABLE (
  chunker_version  smallint,
  chunk_id         uuid,
  sample_id        uuid,
  sample_title     text,
  chunk_context    text,
  text             text,
  similarity       numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._assert_caller_is_admin();
  RETURN QUERY
    SELECT u.chunker_version, u.chunk_id, u.sample_id, u.sample_title,
           u.chunk_context, u.text, u.similarity
      FROM public._admin_compare_v1_v2_retrieval_unsafe(auth.uid(), p_creator_id, p_query_vec, p_k) u;
END;$$;

REVOKE ALL ON FUNCTION public.admin_compare_v1_v2_retrieval(uuid, halfvec(768), int)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_compare_v1_v2_retrieval(uuid, halfvec(768), int)
  TO authenticated;


-- ───────────────────────────────────────────────────────────────────────────
-- _admin_promote_v2_chunks_unsafe — service-role implementation
-- ───────────────────────────────────────────────────────────────────────────
-- Refuses if the creator has zero chunker_version=2 chunks (footgun guard:
-- running this after a failed reprocess job would leave the creator with no
-- chunks at all and break retrieval). Returns the deleted-v1-count + the
-- v2-count that gated the operation.

CREATE OR REPLACE FUNCTION public._admin_promote_v2_chunks_unsafe(
  p_admin_user_id uuid,
  p_creator_id    uuid
) RETURNS TABLE (
  deleted_v1_count int,
  remaining_v2_count int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_exists      boolean;
  v_v2_count          int;
  v_v1_pre_count      int;
  v_deleted_v1        int;
  v_creator_exists    boolean;
  v_active_processing int;
BEGIN
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

  -- Phase-1 unit audit C1: explicit serialization vs. the v2 reprocess
  -- worker. The worker's `claim_corpus_reprocess_job` (migration
  -- 20260516000002) does NOT currently take a session-spanning advisory
  -- lock — the COMMENT on that function PROMISES it (line 78-79) but the
  -- actual worker code does not pair with it. Until Phase-2 fixes the
  -- worker to hold a session-level lock for the duration of a job, we use
  -- a STATE-BASED guard here: refuse promote if ANY corpus_reprocess_jobs
  -- row for a sample of this creator is currently `status='processing'`.
  -- This catches the active-reprocess race the advisory lock was meant to
  -- catch, without requiring worker changes that risk other Phase-1 work.
  --
  -- The advisory lock below is STILL useful: it serializes concurrent
  -- admin Promote / admin set_retrieval_version calls (both touch the
  -- same key), and gives admins a fail-fast (5s) signal if another
  -- admin action is in flight.
  --
  -- Audit-2 C3: lock_timeout=5s so the function fails fast if another
  -- admin holds the lock (Vercel function timeout is 10s Hobby / 60s
  -- Pro; without a lock_timeout an admin click would hang indefinitely
  -- and surface as a generic 504 / 'promote_failed' with no diagnostic).
  -- Raises 55P03 (lock_not_available) on timeout; route maps to 409
  -- 'reprocess_in_progress' so the panel can show "wait, a re-process is
  -- still running" instead of "promote_failed".
  SET LOCAL lock_timeout = '5s';
  PERFORM pg_advisory_xact_lock(hashtext('reprocess:' || p_creator_id::text));

  SELECT count(*)::int INTO v_active_processing
    FROM public.corpus_reprocess_jobs j
    JOIN public.sample_content s ON s.id = j.sample_id
   WHERE s.creator_id = p_creator_id
     AND j.status = 'processing'
     AND j.claimed_at IS NOT NULL
     AND j.claimed_at > now() - INTERVAL '540 seconds';
  IF v_active_processing > 0 THEN
    RAISE EXCEPTION USING errcode='55P03',
      message='reprocess_in_progress — wait for active worker to finish';
  END IF;

  SELECT count(*)::int INTO v_v2_count
    FROM public.sample_content_chunks
   WHERE creator_id = p_creator_id
     AND chunker_version = 2
     AND embedding IS NOT NULL;
  IF v_v2_count = 0 THEN
    RAISE EXCEPTION USING errcode='22023',
      message='no_v2_chunks_yet — re-process before promoting';
  END IF;

  -- Audit-2 M2: capture pre-state count BEFORE the DELETE so the audit row's
  -- `before` accurately reflects state, not the delete-count.
  SELECT count(*)::int INTO v_v1_pre_count
    FROM public.sample_content_chunks
   WHERE creator_id = p_creator_id
     AND chunker_version = 1;

  -- Audit-2 M3 note: sample_content_embedding_jobs is keyed by sample_id
  -- (not chunk_id) and does NOT carry chunker_version. Deleting v1 chunks
  -- does not orphan rows in that queue. corpus_reprocess_jobs is keyed by
  -- (sample_id, target_version=2) and tracks v2 work; also unaffected.

  WITH del AS (
    DELETE FROM public.sample_content_chunks
     WHERE creator_id = p_creator_id
       AND chunker_version = 1
    RETURNING 1
  )
  SELECT count(*)::int INTO v_deleted_v1 FROM del;

  INSERT INTO public.admin_audit_log
    (admin_user_id, action, target_kind, target_id, before, after)
  VALUES
    (p_admin_user_id,
     'creator_promote_v2_chunks',
     'creator',
     p_creator_id,
     jsonb_build_object('v1_chunks_present', v_v1_pre_count, 'v2_chunks_present', v_v2_count),
     jsonb_build_object('v1_chunks_deleted', v_deleted_v1, 'v2_chunks_remaining', v_v2_count));

  deleted_v1_count   := v_deleted_v1;
  remaining_v2_count := v_v2_count;
  RETURN NEXT;
END;$$;

REVOKE ALL ON FUNCTION public._admin_promote_v2_chunks_unsafe(uuid, uuid)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_promote_v2_chunks_unsafe(uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public._admin_promote_v2_chunks_unsafe(uuid, uuid) IS
  'Day-7 admin tool: DELETE chunker_version=1 chunks for a creator after confirming chunker_version=2 chunks exist. Held under pg_advisory_xact_lock(reprocess:<creator_id>) so a concurrent reprocess worker can''t race with the cleanup. Refuses with 22023 if v2 is empty. Writes one admin_audit_log row.';


CREATE OR REPLACE FUNCTION public.admin_promote_v2_chunks(
  p_creator_id uuid
) RETURNS TABLE (
  deleted_v1_count   int,
  remaining_v2_count int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._assert_caller_is_admin();
  RETURN QUERY
    SELECT u.deleted_v1_count, u.remaining_v2_count
      FROM public._admin_promote_v2_chunks_unsafe(auth.uid(), p_creator_id) u;
END;$$;

REVOKE ALL ON FUNCTION public.admin_promote_v2_chunks(uuid)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_promote_v2_chunks(uuid)
  TO authenticated;

COMMENT ON FUNCTION public.admin_promote_v2_chunks(uuid) IS
  'Authenticated-admin wrapper for _admin_promote_v2_chunks_unsafe. Asserts admin via _assert_caller_is_admin() and forwards.';
