-- 0037 — approve/reject creator application RPCs.
-- Admin check via admin_roles.user_id (post-0025 shape). Approve path:
--   (1) transition status to 'approved' (only if pending)
--   (2) null applicant's profile handle if different
--   (3) set profile handle + display_name
--   (4) insert creators row with brain_status='training'
-- Actual brain-training is a Day-6+ job; this RPC only kicks the row.

CREATE FUNCTION public._assert_caller_is_admin() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_roles
     WHERE user_id = auth.uid() AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
END;$$;

REVOKE EXECUTE ON FUNCTION public._assert_caller_is_admin() FROM public;

CREATE FUNCTION public.approve_creator_application(p_id uuid)
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

  -- Clear applicant's current profile handle if it differs (handle is unique
  -- across profiles + creators via handles_registry).
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

  RETURN v_creator_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.approve_creator_application(uuid) FROM public;
GRANT  EXECUTE ON FUNCTION public.approve_creator_application(uuid) TO authenticated;

CREATE FUNCTION public.reject_creator_application(
  p_id             uuid,
  p_reason         text,
  p_internal_notes text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_row_id uuid;
BEGIN
  PERFORM public._assert_caller_is_admin();

  UPDATE public.creator_applications
     SET status = 'rejected',
         rejection_reason = p_reason,
         internal_notes = p_internal_notes,
         reviewed_at = now(),
         reviewed_by = auth.uid()
   WHERE id = p_id
     AND status IN ('submitted', 'under_review')
   RETURNING id INTO v_row_id;

  IF v_row_id IS NULL THEN
    RAISE EXCEPTION 'not_pending' USING ERRCODE = 'P0002';
  END IF;
END;$$;

REVOKE EXECUTE ON FUNCTION public.reject_creator_application(uuid, text, text) FROM public;
GRANT  EXECUTE ON FUNCTION public.reject_creator_application(uuid, text, text) TO authenticated;
