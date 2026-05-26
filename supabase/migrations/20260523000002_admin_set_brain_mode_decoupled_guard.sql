-- 20260523000002 — admin_set_creator_brain_mode now refuses to leave
-- a decoupled=true creator on a non-vector mode.
--
-- DECOUPLED_BRAIN_PLAN P1-10 audit M1+M2 (whole-build audit, 2026-05-21).
-- The original admin_set_creator_brain_mode RPC (20260512000007) does
-- not read `creators.decoupled`. An admin call to flip a decoupled=true
-- creator to 'drawer' (or any non-vector mode) succeeds at the UPDATE
-- (no DB CHECK on creators — the CHECK lives on voice_tickets) and
-- leaves the creator in the invalid combination decoupled=true +
-- brain_mode='drawer'. The next /api/sessions/open then mints with
-- those mismatched values and the INSERT into voice_tickets fires
-- 23514 against `voice_tickets_decoupled_requires_vector_chk`, which
-- the route maps to a misleading 403 session_not_owned (mint-voice-
-- ticket.ts:248). Admin has no visibility into the cause.
--
-- This migration hardens admin_set_creator_brain_mode to RAISE 22023
-- when an admin tries to drawer-flip a decoupled=true creator. The
-- right path for the admin is: call admin_set_creator_decoupled(false)
-- first (which leaves brain_mode at 'vector' by design), then call
-- admin_set_creator_brain_mode(drawer). Two atomic steps; explicit
-- audit trail; no invalid intermediate state.
--
-- Also closes the M2 concurrency window: even with two admins racing,
-- the second UPDATE either re-validates against the current decoupled
-- value (and gets refused) or proceeds because decoupled is already
-- false. No interleaving leaves an invalid combination.

CREATE OR REPLACE FUNCTION public.admin_set_creator_brain_mode(
  p_creator_id uuid,
  p_mode       public.brain_mode
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_mode      public.brain_mode;
  v_prev_decoupled boolean;
BEGIN
  PERFORM public._assert_caller_is_admin();

  IF p_mode IS NULL THEN
    RAISE EXCEPTION USING errcode='22023', message='mode_required';
  END IF;

  SELECT brain_mode, decoupled
    INTO v_prev_mode, v_prev_decoupled
    FROM public.creators
   WHERE id = p_creator_id;

  IF v_prev_mode IS NULL THEN
    RAISE EXCEPTION USING errcode='42704', message='creator_not_found';
  END IF;

  -- P1-10 audit M1/M2 guard — a decoupled=true creator MUST stay on
  -- brain_mode='vector' (voice_tickets_decoupled_requires_vector_chk).
  -- Refuse the operation; the admin should call
  -- admin_set_creator_decoupled(false) first if they want to revert
  -- back to drawer.
  IF v_prev_decoupled AND p_mode <> 'vector'::public.brain_mode THEN
    RAISE EXCEPTION USING
      errcode='22023',
      message='cannot_change_brain_mode_while_decoupled — call admin_set_creator_decoupled(false) first';
  END IF;

  UPDATE public.creators SET brain_mode = p_mode WHERE id = p_creator_id;

  -- R3 M3: per-mode persona — recompile inside the same transaction so a
  -- flip + next session-open pair is always consistent.
  PERFORM public._creator_brain_compile_unsafe(p_creator_id);

  -- admin_audit_log shape: (admin_user_id, action, target_kind, target_id, before, after).
  -- before/after carry the mode transition for rollback observability.
  -- Decoupled stays unchanged (this RPC doesn't touch it); not in
  -- before/after to keep diff intent obvious.
  INSERT INTO public.admin_audit_log (admin_user_id, action, target_kind, target_id, before, after)
  VALUES (auth.uid(), 'creator_brain_mode_set', 'creator', p_creator_id,
          jsonb_build_object('brain_mode', v_prev_mode::text),
          jsonb_build_object('brain_mode', p_mode::text));
END;$$;

COMMENT ON FUNCTION public.admin_set_creator_brain_mode(uuid, public.brain_mode) IS
  'Flips creators.brain_mode + recompiles persona. P1-10 audit M1/M2 hardening: refuses to leave decoupled=true creators on a non-vector mode (admin must call admin_set_creator_decoupled(false) first).';

NOTIFY pgrst, 'reload schema';
