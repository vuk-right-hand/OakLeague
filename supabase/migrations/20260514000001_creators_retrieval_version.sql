-- 20260514000001 — creators.retrieval_version + admin_set_creator_retrieval_version RPC.
--
-- M1 of RAG SOTA plan (docs/_planning/RAG_SOTA_PLAN.md §3).
--
-- Discriminates v1 (legacy 300-token-window chunks + single-embed top-3) vs v2
-- (narrative chunks + contextual headers + hybrid retrieval + rerank) INSIDE
-- brain_mode='vector', without mutating the brain_mode enum (audit-2 M6: enum
-- additions are forward-only on Postgres without downtime).
--
-- Three orthogonal switches, all on creators row:
--   * brain_mode='drawer'                          → legacy topic-drawer path
--   * brain_mode='vector' AND retrieval_version=1  → current production RAG (v1)
--   * brain_mode='vector' AND retrieval_version=2  → new SOTA pipeline (Phase 2)
--
-- Admin-only flip via admin_set_creator_retrieval_version (defined below), which
-- recompiles the persona inside the same transaction. The brain_compile body
-- extension that READS retrieval_version lands in the immediately-following
-- migration 20260514000001b — together these two migrations are the v1<->v2
-- switch and the recompile hook. Splitting them lets each have its own pgTAP
-- coverage without one large migration.

ALTER TABLE public.creators
  ADD COLUMN retrieval_version smallint NOT NULL DEFAULT 1
    CHECK (retrieval_version IN (1, 2));

COMMENT ON COLUMN public.creators.retrieval_version IS
  'Discriminates v1 (legacy 300-token-window chunks + single-embed top-3) vs v2 (narrative chunks + contextual headers + hybrid retrieval + rerank) inside brain_mode=''vector''. Default 1 keeps every existing creator on the proven path until admin explicitly flips. Flip via admin_set_creator_retrieval_version; flip triggers persona recompile inside the same transaction.';


-- ── admin_set_creator_retrieval_version ──────────────────────────────────────
--
-- Mirrors admin_set_creator_brain_mode (20260512000007) line-for-line:
--   * _assert_caller_is_admin() PERFORM call (the canonical helper, defined in
--     20260420000037). Audit-3 C1: my plan draft hallucinated _is_admin_caller();
--     the real helper name is _assert_caller_is_admin.
--   * admin_audit_log uses the real schema (admin_user_id, action, target_kind,
--     target_id, before, after) — verified in 20260502000004:19-28. Audit-3 C2:
--     plan draft used a non-existent 'metadata' column.
--   * Recompile via _creator_brain_compile_unsafe(p_creator_id) — 1-arg, unchanged
--     signature. Audit-3 C3: plan draft extended the function to 3 args and broke
--     every existing caller.
--   * Action name follows existing convention: 'creator_retrieval_version_set'
--     (cf 'creator_brain_mode_set' from M7).

CREATE FUNCTION public.admin_set_creator_retrieval_version(
  p_creator_id uuid,
  p_version    smallint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_prev     smallint;
BEGIN
  -- Audit-4 M5 fix: capture auth.uid() ONCE at function entry. Previous draft
  -- called auth.uid() inside _assert_caller_is_admin AND again at audit INSERT;
  -- a JWT expiring between the two calls would surface as not_null_violation
  -- on admin_audit_log.admin_user_id (NOT NULL — see 20260502000004:21) instead
  -- of the expected insufficient_privilege error. One capture, one truth.
  v_admin_id := auth.uid();

  PERFORM public._assert_caller_is_admin();

  -- Defense-in-depth: CHECK on the column already enforces (1,2), but
  -- PostgREST clients can pass NULL via missing-arg defaults.
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

  -- Per-version persona recompile inside the same transaction. The body
  -- extension that reads retrieval_version lands in 20260514000001b; until
  -- that migration applies the recompile is a no-op for version flips (both
  -- versions produce the same persona). The PERFORM is kept here from day
  -- one so the contract is "every flip recompiles", not "every flip after
  -- migration X recompiles".
  PERFORM public._creator_brain_compile_unsafe(p_creator_id);

  -- admin_audit_log shape (admin_user_id, action, target_kind, target_id, before, after).
  -- before/after carry the version transition for rollback observability.
  INSERT INTO public.admin_audit_log
    (admin_user_id, action, target_kind, target_id, before, after)
  VALUES
    (v_admin_id, 'creator_retrieval_version_set', 'creator', p_creator_id,
     jsonb_build_object('retrieval_version', v_prev),
     jsonb_build_object('retrieval_version', p_version));
END;$$;

COMMENT ON FUNCTION public.admin_set_creator_retrieval_version(uuid, smallint) IS
  'Admin flips creators.retrieval_version between 1 (legacy v1 RAG) and 2 (new SOTA hybrid+rerank pipeline) inside brain_mode=''vector''. Recompiles persona in the same transaction. Audits before/after to admin_audit_log.';

REVOKE ALL ON FUNCTION public.admin_set_creator_retrieval_version(uuid, smallint)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_creator_retrieval_version(uuid, smallint)
  TO authenticated;
