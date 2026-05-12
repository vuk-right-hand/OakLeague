-- 20260512000007 — admin_set_creator_brain_mode RPC.
--
-- M7 of pgvector RAG plan (R1 M6 + R2 Small + R3 M3 fixes).
--
-- Flips creators.brain_mode and recompiles the persona inside the same
-- transaction. Per-mode personas (M10) emit different clauses — drawer
-- mode without the clarifier rule, vector mode with it — so a flip MUST
-- be paired with a recompile or the next session opens with a stale
-- persona-for-the-other-mode.
--
-- Active-admin gated via _assert_caller_is_admin (same helper as the
-- rest of the admin RPC surface). admin_audit row carries previous_mode
-- for rollback observability.

CREATE FUNCTION public.admin_set_creator_brain_mode(
  p_creator_id uuid,
  p_mode       public.brain_mode
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_prev public.brain_mode;
BEGIN
  PERFORM public._assert_caller_is_admin();

  -- Defense-in-depth: enum CHECK already excludes NULL, but PostgREST clients
  -- could in theory pass NULL via missing-arg defaults. R3 Small.
  IF p_mode IS NULL THEN
    RAISE EXCEPTION USING errcode='22023', message='mode_required';
  END IF;

  SELECT brain_mode INTO v_prev FROM public.creators WHERE id = p_creator_id;
  IF v_prev IS NULL THEN
    RAISE EXCEPTION USING errcode='42704', message='creator_not_found';
  END IF;

  UPDATE public.creators SET brain_mode = p_mode WHERE id = p_creator_id;

  -- R3 M3: per-mode persona — recompile inside the same transaction so a
  -- flip + next session-open pair is always consistent. _unsafe is the
  -- SECURITY DEFINER internal entry; we're already inside SECURITY DEFINER
  -- with an admin assertion so this is the right call.
  PERFORM public._creator_brain_compile_unsafe(p_creator_id);

  -- admin_audit_log shape: (admin_user_id, action, target_kind, target_id, before, after).
  -- before/after carry the mode transition for rollback observability.
  INSERT INTO public.admin_audit_log (admin_user_id, action, target_kind, target_id, before, after)
  VALUES (auth.uid(), 'creator_brain_mode_set', 'creator', p_creator_id,
          jsonb_build_object('brain_mode', v_prev::text),
          jsonb_build_object('brain_mode', p_mode::text));
END;$$;

REVOKE ALL ON FUNCTION public.admin_set_creator_brain_mode(uuid, public.brain_mode)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_creator_brain_mode(uuid, public.brain_mode) TO authenticated;
