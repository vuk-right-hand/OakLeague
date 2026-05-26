-- 20260516000004 — admin_set_creator_retrieval_version cleans v2 zombies on downgrade.
--
-- Day-5 build for the Day-1+2+3 integration audit's C4 finding.
--
-- Bug being fixed:
--   When admin downgrades a creator from retrieval_version=2 back to 1
--   (the documented rollback path — see 20260514000001 header), the
--   creator's v2 chunks (chunker_version=2 in sample_content_chunks) and
--   v2 narrative_units stay in place. They're invisible to v1 reads
--   (creator_knowledge_topk filters chunker_version=1, per 20260514000003)
--   but consume storage AND occupy the HNSW index. Worse: if the same
--   creator is later re-flipped to v2 without a corpus reprocess, the
--   stale v2 chunks are silently used as if fresh — pointing at whatever
--   raw_text the creator had at the time of the FIRST v2 flip.
--
-- Fix:
--   Extend the admin RPC to DELETE chunker_version=2 rows + narrative_units
--   rows for this creator when downgrading. CASCADE FK from narrative_units
--   on chunks (per 20260514000002:32) would handle the chunks-side cleanup
--   if we delete narrative_units, BUT chunker_version=2 rows in
--   sample_content_chunks have parent_unit_id NOT NULL — the CASCADE works
--   only in the direction unit→chunks. We explicitly DELETE chunks first
--   to make the ordering self-documenting AND to be robust against future
--   schema changes that drop the CASCADE.
--
--   Cleanup happens inside the SAME transaction as the version flip + audit
--   log write — atomic. Either everything succeeds or nothing changes.

CREATE OR REPLACE FUNCTION public.admin_set_creator_retrieval_version(
  p_creator_id uuid,
  p_version    smallint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_id            uuid;
  v_prev                smallint;
  v_chunks_deleted      int := 0;
  v_units_deleted       int := 0;
BEGIN
  -- Audit-4 M5 (preserved from original): capture auth.uid() ONCE at entry.
  v_admin_id := auth.uid();
  PERFORM public._assert_caller_is_admin();

  -- Defense-in-depth (preserved): CHECK on column already enforces (1,2)
  -- but PostgREST default-arg drift can send NULL.
  IF p_version IS NULL OR p_version NOT IN (1, 2) THEN
    RAISE EXCEPTION USING errcode='22023', message='version_invalid';
  END IF;

  SELECT retrieval_version INTO v_prev
    FROM public.creators WHERE id = p_creator_id;
  IF v_prev IS NULL THEN
    RAISE EXCEPTION USING errcode='42704', message='creator_not_found';
  END IF;

  UPDATE public.creators
     SET retrieval_version = p_version
   WHERE id = p_creator_id;

  -- Day-5 integration-audit C4 fix: clean v2 zombies on downgrade.
  -- Only fires on the v2 → v1 transition; no-op on 1→1, 1→2, 2→2.
  -- Order: chunks first (parent_unit_id FK), then narrative_units. Both
  -- DELETEs are scoped by creator_id so we never touch other creators'
  -- data even if the CASCADE chain has bugs.
  IF v_prev = 2 AND p_version = 1 THEN
    DELETE FROM public.sample_content_chunks
     WHERE creator_id = p_creator_id AND chunker_version = 2;
    GET DIAGNOSTICS v_chunks_deleted = ROW_COUNT;

    DELETE FROM public.sample_content_narrative_units
     WHERE creator_id = p_creator_id;
    GET DIAGNOSTICS v_units_deleted = ROW_COUNT;
  END IF;

  -- Per-version persona recompile (preserved). The body extension that
  -- reads retrieval_version is in 20260514000001b.
  PERFORM public._creator_brain_compile_unsafe(p_creator_id);

  -- admin_audit_log shape (admin_user_id, action, target_kind, target_id, before, after).
  -- Day-5 enhancement: `after` carries the zombie-cleanup counts on the
  -- downgrade path so rollbacks are visible in audit history.
  INSERT INTO public.admin_audit_log
    (admin_user_id, action, target_kind, target_id, before, after)
  VALUES
    (v_admin_id, 'creator_retrieval_version_set', 'creator', p_creator_id,
     jsonb_build_object('retrieval_version', v_prev),
     jsonb_build_object(
       'retrieval_version', p_version,
       'v2_chunks_deleted', v_chunks_deleted,
       'v2_narrative_units_deleted', v_units_deleted
     ));
END;$$;

COMMENT ON FUNCTION public.admin_set_creator_retrieval_version(uuid, smallint) IS
  'Admin flips creators.retrieval_version between 1 (legacy v1 RAG) and 2 (new SOTA hybrid+rerank pipeline). On v2→v1 downgrade, cleans v2 chunks + narrative_units for this creator (integration-audit C4 fix). Recompiles persona in the same transaction. Audits before/after to admin_audit_log; downgrade audit carries zombie-cleanup counts.';

-- ACLs survive CREATE OR REPLACE on the body but re-apply defensively.
REVOKE ALL ON FUNCTION public.admin_set_creator_retrieval_version(uuid, smallint)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_creator_retrieval_version(uuid, smallint)
  TO authenticated;
