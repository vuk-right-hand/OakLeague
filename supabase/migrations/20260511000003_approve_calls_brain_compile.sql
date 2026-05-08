-- 20260511000003 — approve_creator_application calls _creator_brain_compile_unsafe
--
-- Brain wire-up M3. Replaces the comment-stub at migration 20260420000037
-- ("Actual brain-training is a Day-6+ job; this RPC only kicks the row")
-- with a real persona compile. brain_status remains 'training' at approve
-- time — the persona is compiled but the creator isn't publish-ready
-- until voice_id + face are also wired (R2 M1).
--
-- Behavior preserved exactly except for the trailing PERFORM call.
-- _creator_brain_compile_unsafe is called via SECURITY DEFINER chain
-- (this RPC is also SECURITY DEFINER + admin-gated by _assert_caller_is_admin).

CREATE OR REPLACE FUNCTION public.approve_creator_application(p_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user_id      uuid;
  v_handle       citext;
  v_display_name text;
  v_creator_id   uuid;
BEGIN
  PERFORM public._assert_caller_is_admin();

  UPDATE public.creator_applications
     SET status = 'approved',
         reviewed_at = now(),
         reviewed_by = auth.uid()
   WHERE id = p_id
     AND status IN ('submitted', 'under_review')
   RETURNING user_id, handle, display_name
     INTO v_user_id, v_handle, v_display_name;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_pending' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.profiles
     SET handle = NULL
   WHERE id = v_user_id
     AND handle IS DISTINCT FROM v_handle;

  UPDATE public.profiles
     SET handle = v_handle,
         display_name = coalesce(display_name, v_display_name)
   WHERE id = v_user_id;

  INSERT INTO public.creators
    (user_id, application_id, creator_type, display_name, handle, brain_status)
  VALUES
    (v_user_id, p_id, 'human', v_display_name, v_handle::text, 'training')
  RETURNING id INTO v_creator_id;

  -- Compile persona immediately so the new creator has a usable
  -- system_prompt before any session attempts to open against them.
  -- brain_status stays 'training' — voice + face aren't wired yet.
  PERFORM public._creator_brain_compile_unsafe(v_creator_id);

  RETURN v_creator_id;
END;$$;

-- Re-emit ACLs (original at 20260420000037:70-71). CREATE OR REPLACE preserves
-- existing grants, but re-emitting keeps the ACL contract visible alongside
-- the function body (defense-in-depth, R-PR1 audit S3).
REVOKE EXECUTE ON FUNCTION public.approve_creator_application(uuid) FROM public;
GRANT  EXECUTE ON FUNCTION public.approve_creator_application(uuid) TO authenticated;
