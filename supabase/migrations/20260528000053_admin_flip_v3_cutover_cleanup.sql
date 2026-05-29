-- 20260528000053 — admin_set_creator_retrieval_version: v1+v2 cutover cleanup
-- on flip TO v3 (RAG v3 step 7 / round-5 audit C1 — the additive-build other half).
--
-- ── Why this exists ─────────────────────────────────────────────────────
-- The additive-build fix (round-5 C1) makes the v3 worker + finalize_v3
-- leave the creator's live v1/v2 corpus UNTOUCHED during the build-then-flip
-- window, so the still-v2 read path keeps working while v3 accumulates
-- invisibly (plan §6 promise restored). That means SOMETHING must delete the
-- now-dead v1+v2 chunks + v2-shape narrative_units at the ONE moment they
-- become dead: the v2→v3 flip. This migration adds that one-shot cutover
-- cleanup to the admin flip RPC, symmetric with the existing v2→v1 downgrade
-- cleanup (20260516000004).
--
-- Fires on ANY flip TO 3 (from v_prev=1 or 2):
--   • DELETE creator's chunker_version IN (1,2) chunks.
--   • DELETE creator's v2-shape narrative_units (section_id NULL). v3 units
--     (section_id NOT NULL) survive. CASCADE on parent_unit_id would also
--     hit chunks, but we delete chunks first so it's a no-op there.
-- Under pg_advisory_xact_lock(hashtext('reprocess:'||creator_id)) — the SAME
-- key finalize_v3 / v2-finalize / claim use — so the cutover never interleaves
-- with an in-flight finalize's delete+bump for the same creator.
--
-- creator_v3_ready=true (the flip gate) guarantees every 'ready' sample has
-- v3 chunks before this delete runs, so the cutover never strands a creator
-- with zero readable chunks.
--
-- ── Everything else preserved verbatim from 20260528000041 ──────────────
-- v3-ready gate, FOR UPDATE serialization, same-version early-return, v2→v1
-- downgrade cleanup, conditional audit jsonb. Only the new flip-TO-3 cleanup
-- block + its audit keys are added.

CREATE OR REPLACE FUNCTION public.admin_set_creator_retrieval_version(
  p_creator_id uuid,
  p_version    smallint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_id            uuid;
  v_prev                smallint;
  v_chunks_deleted      int := 0;   -- v2→v1 downgrade path
  v_units_deleted       int := 0;   -- v2→v1 downgrade path
  v_v3_chunks_deleted   int := 0;   -- flip-TO-3 cutover path
  v_v3_units_deleted    int := 0;   -- flip-TO-3 cutover path
  v_v3_ready            boolean;
  v_after_jsonb         jsonb;
BEGIN
  v_admin_id := auth.uid();
  PERFORM public._assert_caller_is_admin();

  IF p_version IS NULL OR p_version NOT IN (1, 2, 3) THEN
    RAISE EXCEPTION USING errcode='22023', message='version_invalid';
  END IF;

  -- Fail loud on lock contention instead of hanging (matches finalize/claim).
  SET LOCAL lock_timeout = '5s';

  -- Round-6 C1 (DEADLOCK FIX): when flipping TO 3, take the reprocess
  -- advisory lock BEFORE the creators FOR UPDATE row lock. finalize_v3
  -- acquires (advisory → creators-row) in that order; if this RPC acquired
  -- (creators-row → advisory) it would be a classic ABBA inversion and a
  -- finalize_v3 racing the flip would deadlock at cutover — the highest-
  -- stakes moment. Taking advisory first here makes both paths agree on
  -- order. Only flip-TO-3 takes the advisory lock (only it touches the
  -- reprocess-owned chunk rows), so no other transition can invert.
  -- Re-acquired below inside the cutover block is a no-op (xact-scoped,
  -- re-entrant). The recompile's lock is a DIFFERENT key ('brain_compile:')
  -- so it can't cross-deadlock.
  IF p_version = 3 THEN
    PERFORM pg_advisory_xact_lock(hashtext('reprocess:' || p_creator_id::text));
  END IF;

  -- Round-5 M1: FOR UPDATE to serialize against concurrent workers + flips.
  SELECT retrieval_version INTO v_prev
    FROM public.creators WHERE id = p_creator_id
    FOR UPDATE;
  IF v_prev IS NULL THEN
    RAISE EXCEPTION USING errcode='42704', message='creator_not_found';
  END IF;

  -- Round-5 C3: same-version flip is a no-op (no recompile / audit / lock).
  IF v_prev = p_version THEN
    RETURN;
  END IF;

  -- v3 FLIP GATE — plan §6 step 3. Cannot flip TO 3 unless every 'ready'
  -- sample has v3 chunks + sections + done job.
  IF p_version = 3 THEN
    SELECT public.creator_v3_ready(p_creator_id) INTO v_v3_ready;
    IF NOT v_v3_ready THEN
      RAISE EXCEPTION USING errcode='check_violation',
        message='creator_v3_not_ready -- at least one ready sample is missing v3 sections / chunks / done job. Run creator_v3_ready(creator_id) for diagnostics.';
    END IF;
  END IF;

  UPDATE public.creators
     SET retrieval_version = p_version
   WHERE id = p_creator_id;

  -- v2 zombie cleanup on the v2→v1 downgrade path (preserved verbatim).
  IF v_prev = 2 AND p_version = 1 THEN
    DELETE FROM public.sample_content_chunks
     WHERE creator_id = p_creator_id AND chunker_version = 2;
    GET DIAGNOSTICS v_chunks_deleted = ROW_COUNT;

    DELETE FROM public.sample_content_narrative_units
     WHERE creator_id = p_creator_id;
    GET DIAGNOSTICS v_units_deleted = ROW_COUNT;
  END IF;

  -- NEW (round-5 C1 additive-build): v1+v2 cutover cleanup on flip TO 3.
  -- The additive build left these alive during the build window; NOW they
  -- are dead (read path switches to chunker_version=3). The reprocess
  -- advisory lock is ALREADY held (acquired at the top before FOR UPDATE,
  -- round-6 C1 deadlock fix); this re-acquire is a re-entrant no-op kept for
  -- locality of reasoning.
  IF p_version = 3 THEN
    PERFORM pg_advisory_xact_lock(hashtext('reprocess:' || p_creator_id::text));

    DELETE FROM public.sample_content_chunks
     WHERE creator_id = p_creator_id AND chunker_version IN (1, 2);
    GET DIAGNOSTICS v_v3_chunks_deleted = ROW_COUNT;

    -- v2-shape narrative_units only (section_id NULL). v3 units survive.
    DELETE FROM public.sample_content_narrative_units
     WHERE creator_id = p_creator_id AND section_id IS NULL;
    GET DIAGNOSTICS v_v3_units_deleted = ROW_COUNT;
  END IF;

  -- Per-version persona recompile (preserved).
  PERFORM public._creator_brain_compile_unsafe(p_creator_id);

  -- Round-5 M3 + this migration: conditionally shape the after-jsonb so each
  -- transition carries ONLY its own cleanup counts.
  v_after_jsonb := jsonb_build_object('retrieval_version', p_version);
  IF v_prev = 2 AND p_version = 1 THEN
    v_after_jsonb := v_after_jsonb || jsonb_build_object(
      'v2_chunks_deleted', v_chunks_deleted,
      'v2_narrative_units_deleted', v_units_deleted
    );
  ELSIF p_version = 3 THEN
    v_after_jsonb := v_after_jsonb || jsonb_build_object(
      'cutover_chunks_deleted', v_v3_chunks_deleted,
      'cutover_v2_units_deleted', v_v3_units_deleted
    );
  END IF;

  INSERT INTO public.admin_audit_log
    (admin_user_id, action, target_kind, target_id, before, after)
  VALUES
    (v_admin_id, 'creator_retrieval_version_set', 'creator', p_creator_id,
     jsonb_build_object('retrieval_version', v_prev),
     v_after_jsonb);
END;$$;

COMMENT ON FUNCTION public.admin_set_creator_retrieval_version(uuid, smallint) IS
  'Admin flips creators.retrieval_version between 1, 2, 3. v3 flip GATED on creator_v3_ready (plan §6 step 3). Flip TO 3 does the one-shot v1+v2 cutover cleanup (DELETE chunker_version IN (1,2) chunks + v2-shape narrative_units, under the reprocess advisory lock) — the additive-build counterpart (round-5 C1): the worker + finalize_v3 leave v1/v2 alive during build, this deletes them at the flip when they become dead. v2→v1 downgrade cleans v2 chunks + units. Same-version flip is a no-op. Recompiles persona in-txn. Audits before/after with per-transition cleanup counts. v3→v2 downgrade cleanup still deferred (CLEANUP backlog). Service-role/admin only.';

REVOKE ALL ON FUNCTION public.admin_set_creator_retrieval_version(uuid, smallint)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_creator_retrieval_version(uuid, smallint)
  TO authenticated;
