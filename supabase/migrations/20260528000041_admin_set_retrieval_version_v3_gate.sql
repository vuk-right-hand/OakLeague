-- 20260528000041 -- admin_set_creator_retrieval_version: accept v3, gate on
-- creator_v3_ready (RAG v3 step 6 / plan §6 step 3).
--
-- -- Three changes --------------------------------------------------------
-- 1. Widen creators.retrieval_version CHECK from (1, 2) -> (1, 2, 3) using
--    NOT VALID + VALIDATE (same online discipline as the chunker_version
--    extension in 20260528000012). No row rewrite. The old constraint is
--    found by inspecting pg_constraint with the exact CHECK signature
--    (round-5 C4) rather than guessing the auto-name -- robust against
--    history-rewrite snapshots and against accumulated CHECK suffixes.
-- 2. Update admin_set_creator_retrieval_version to accept p_version=3.
-- 3. CRITICAL: when flipping TO 3, RAISE unless creator_v3_ready returns
--    true. The "admin literally cannot flip a half-built creator" gate
--    that's the only thing standing between the rollout and the UX-death
--    "he blanks every turn" scenario from plan §6 step 1.
--
-- v3->v2 zombie cleanup is NOT yet wired. Plan §6 says monotonic 1->2->3,
-- so v3->v2 downgrades are uncommon and out of scope here. If a downgrade
-- is ever required (rollback during a v3 prod incident), the same DELETE
-- pattern applies. Deferred to CLEANUP_BACKLOG as a forward-note. Test 4
-- in the pgTAP captures the survived-chunks state explicitly so the next
-- implementer can flip the assertion when the cleanup lands (round-5 M6).
--
-- -- PostgREST cache concern -----------------------------------------------
-- Function signature is UNCHANGED (uuid, smallint). PostgREST sees the
-- same callable; no NOTIFY pgrst, 'reload schema' needed.

-- 1. Widen the CHECK constraint online.
ALTER TABLE public.creators
  ADD CONSTRAINT creators_retrieval_version_v3_check
    CHECK (retrieval_version IN (1, 2, 3)) NOT VALID;

ALTER TABLE public.creators
  VALIDATE CONSTRAINT creators_retrieval_version_v3_check;

-- Round-5 C4: find + drop the OLD (1, 2) CHECK by inspecting pg_constraint
-- rather than guessing the auto-generated name. Robust against renamed
-- constraints, accumulated suffixes from history-rewrite snapshots, and
-- against ANY future migration that adds a second inline CHECK to this
-- column. We require exactly one match (the v1/v2 constraint); raise loud
-- on zero (already cleaned -- safe but worth knowing) or >1 (ambiguous --
-- a human must look). The new v3 constraint we just added is EXCLUDED by
-- name so the search only finds the legacy one.
DO $do$
DECLARE
  v_attnum  smallint;
  v_names   text[];
  v_name    text;
BEGIN
  SELECT a.attnum INTO v_attnum
    FROM pg_attribute a
   WHERE a.attrelid = 'public.creators'::regclass
     AND a.attname  = 'retrieval_version'
     AND NOT a.attisdropped;
  IF v_attnum IS NULL THEN
    RAISE EXCEPTION 'retrieval_version column not found on public.creators';
  END IF;

  -- Match any CHECK constraint whose conkey is EXACTLY [retrieval_version]
  -- (single-column scope). Exclude our newly-added v3 constraint by name.
  -- We don't grep the constraint body because pg_get_constraintdef
  -- canonicalizes `IN (1, 2)` -> `= ANY (ARRAY[1, 2])` -- a body-text match
  -- on either form silently mis-matches the other. Single-column CHECKs on
  -- creators.retrieval_version are rare (NOT NULL lives on attnotnull, not
  -- a CHECK), so the "everything except our new one" filter is safe.
  SELECT array_agg(c.conname ORDER BY c.conname)
    INTO v_names
    FROM pg_constraint c
   WHERE c.conrelid = 'public.creators'::regclass
     AND c.contype  = 'c'
     AND c.conkey   = ARRAY[v_attnum]::int2[]
     AND c.conname  <> 'creators_retrieval_version_v3_check';

  IF v_names IS NULL OR array_length(v_names, 1) = 0 THEN
    -- Legacy constraint already gone (e.g. partial-snapshot replay). Safe.
    RAISE NOTICE 'creators retrieval_version legacy (1,2) CHECK already absent -- nothing to drop';
  ELSIF array_length(v_names, 1) > 1 THEN
    RAISE EXCEPTION 'ambiguous: % CHECK constraints on creators.retrieval_version match "IN (1, 2)": %',
      array_length(v_names, 1), v_names;
  ELSE
    v_name := v_names[1];
    EXECUTE format('ALTER TABLE public.creators DROP CONSTRAINT %I', v_name);
    RAISE NOTICE 'dropped legacy CHECK constraint %', v_name;
  END IF;
END;
$do$;

COMMENT ON COLUMN public.creators.retrieval_version IS
  $c$Discriminates v1 (legacy 300-token windows + single-embed top-3), v2
  (narrative chunks + contextual headers + hybrid retrieval + rerank), v3
  (routed hierarchical retrieval: Doc -> Section -> Unit -> Child + MAX-child
  ranking) inside brain_mode='vector'. Default 1; admin flips via
  admin_set_creator_retrieval_version. v3 flip is gated on creator_v3_ready
  (plan §6 step 3) -- the admin literally cannot flip a half-built creator.$c$;

-- 2 + 3. Rewrite the admin RPC.
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
  v_v3_ready            boolean;
  v_after_jsonb         jsonb;
BEGIN
  v_admin_id := auth.uid();
  PERFORM public._assert_caller_is_admin();

  -- Defense-in-depth: CHECK on column already enforces (1, 2, 3) but
  -- PostgREST default-arg drift can send NULL.
  IF p_version IS NULL OR p_version NOT IN (1, 2, 3) THEN
    RAISE EXCEPTION USING errcode='22023', message='version_invalid';
  END IF;

  -- Round-5 M1: FOR UPDATE to serialize against concurrent workers writing
  -- chunks/sections for the same creator. The advisory lock in the recompile
  -- below fires too late (after the UPDATE), so without FOR UPDATE a worker
  -- DELETE of v3 chunks between the gate-check and the UPDATE could leave
  -- the creator at v=3 with broken serving. FOR UPDATE on creators is a
  -- narrow per-row lock; concurrent flips of a DIFFERENT creator are
  -- unaffected.
  SELECT retrieval_version INTO v_prev
    FROM public.creators WHERE id = p_creator_id
    FOR UPDATE;
  IF v_prev IS NULL THEN
    RAISE EXCEPTION USING errcode='42704', message='creator_not_found';
  END IF;

  -- Round-5 C3: same-version flip is a no-op. Early-return BEFORE recompile
  -- + audit-log + advisory lock. Two admin double-clicks 200ms apart no
  -- longer cause: (a) wasted persona recompile (advisory lock serializes
  -- them anyway, so the second blocks for the full compile), (b) audit-log
  -- noise (two before=after=N rows), (c) the gate skip ambiguity from
  -- round-5 C2 in the test file.
  IF v_prev = p_version THEN
    RETURN;
  END IF;

  -- v3 FLIP GATE -- plan §6 step 3. Cannot flip TO 3 unless every 'ready'
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

  -- v2 zombie cleanup on the v2->v1 downgrade path (preserved from
  -- 20260516000004:67-74). No v3->v2 zombie cleanup yet -- plan §6's
  -- monotonic 1->2->3 means downgrades are uncommon; deferred to CLEANUP.
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

  -- Round-5 M3: conditionally shape the after-jsonb so dashboards that
  -- filter on `after ? 'v2_chunks_deleted'` only see the cleanup-bearing
  -- transitions. Other transitions write just the new version number.
  v_after_jsonb := jsonb_build_object('retrieval_version', p_version);
  IF v_prev = 2 AND p_version = 1 THEN
    v_after_jsonb := v_after_jsonb || jsonb_build_object(
      'v2_chunks_deleted', v_chunks_deleted,
      'v2_narrative_units_deleted', v_units_deleted
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
  $c$Admin flips creators.retrieval_version between 1 (legacy v1 RAG), 2
  (SOTA hybrid+rerank), and 3 (routed hierarchical with MAX-child ranking).
  v3 FLIP IS GATED on creator_v3_ready (plan §6 step 3) -- a half-built
  creator cannot be flipped. Same-version flip is a no-op (round-5 C3).
  v2->v1 downgrade cleans v2 chunks + narrative_units (integration-audit C4).
  v3->v2 downgrade cleanup is deferred (CLEANUP backlog -- plan §6 monotonic
  1->2->3 means it's uncommon). Recompiles persona in the same transaction.
  Audits before/after to admin_audit_log; cleanup counts only present on
  v2->v1 transitions (round-5 M3). FOR UPDATE on creators row serializes
  against concurrent worker writes (round-5 M1).$c$;

REVOKE ALL ON FUNCTION public.admin_set_creator_retrieval_version(uuid, smallint)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_creator_retrieval_version(uuid, smallint)
  TO authenticated;
