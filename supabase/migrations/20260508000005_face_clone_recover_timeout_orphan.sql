-- Auditor R3+R4 follow-up — Path C: timeout-orphan recovery.
--
-- Scenario the new RPC handles:
--
--   1. Admin uploads a face. POST /api/admin/face-upload sends the image
--      to Simli. Simli accepts and queues, but the response is delayed.
--   2. Our route's AbortController fires before Simli responds. We mark
--      the audit row state='failed' with last_error='simli_timeout'.
--      vendor_face_id is NULL because we never received it.
--   3. Simli completes training in the background. The face_id appears
--      in the admin's Simli Studio "Your Faces" tab.
--   4. Admin should be able to attribute that orphan face back to OakLeague
--      without an SQL hack and without re-uploading + burning another slot.
--
-- This RPC is the recovery primitive. The route validates the face is
-- reachable (compose/token returns 200) before calling, so by the time
-- this RPC runs, we know the orphan has finished training.
--
-- Why a fresh row instead of mutating the failed one:
--   * The append-only trigger (R2-C4 hardening) blocks failed→ready
--     transitions and forbids overwriting last_error / vendor_face_id
--     on the failed row. A new row mirrors finalize_locked exactly:
--     state='ready' from INSERT, vendor_face_id set, ready_at=now().
--   * The prior failed row stays as the audit trail of the timeout.
--     last_error on the recovery row carries the cross-reference.
--
-- Lock namespace: 'face_clone_overwrite:<creator_id>' (same as finalize_locked
-- and admin_force_retrain_creator after migration 0003) so concurrent
-- delete + recovery serialize.

CREATE OR REPLACE FUNCTION public.face_clone_recover_timeout_orphan(
  p_admin_user_id  uuid,
  p_prior_upload_id bigint,
  p_vendor_face_id  text
) RETURNS TABLE (new_upload_id bigint, prior_face_id text, active_sessions bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role  text;
  v_admin     record;
  v_prior_row record;
  v_prior_face text;
  v_open      bigint;
  v_new_id    bigint;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'face_clone_recover_timeout_orphan: service_role only'
      USING ERRCODE = '42501';
  END IF;

  IF p_vendor_face_id IS NULL OR NOT (char_length(p_vendor_face_id) BETWEEN 1 AND 128) THEN
    RAISE EXCEPTION 'invalid vendor_face_id length' USING ERRCODE = '22023';
  END IF;

  -- Re-verify admin is currently active.
  SELECT user_id, revoked_at
    INTO v_admin
    FROM public.admin_roles
   WHERE user_id = p_admin_user_id
     AND revoked_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin not active' USING ERRCODE = '42501';
  END IF;

  -- Load and validate the prior row. Recovery is ONLY allowed from a
  -- timeout-orphan: state='failed' AND last_error contains 'timeout' AND
  -- vendor_face_id IS NULL (we never got it from Simli).
  SELECT id, admin_user_id, creator_id, vendor, media_kind, sha256, mime,
         bytes, width, height, vendor_face_id, state, last_error,
         force_overwrite
    INTO v_prior_row
    FROM public.face_clone_uploads
   WHERE id = p_prior_upload_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prior upload % not found', p_prior_upload_id USING ERRCODE = '23503';
  END IF;
  IF v_prior_row.admin_user_id IS DISTINCT FROM p_admin_user_id THEN
    RAISE EXCEPTION 'admin mismatch on prior upload %', p_prior_upload_id USING ERRCODE = '42501';
  END IF;
  IF v_prior_row.state <> 'failed' THEN
    RAISE EXCEPTION 'prior upload % not in failed state (state=%)',
      p_prior_upload_id, v_prior_row.state USING ERRCODE = 'P0002';
  END IF;
  IF v_prior_row.vendor_face_id IS NOT NULL THEN
    -- Not a timeout orphan — Simli responded with an id we recorded.
    -- finalize_locked is the right path, not recovery.
    RAISE EXCEPTION 'prior upload % has vendor_face_id; use finalize, not recover',
      p_prior_upload_id USING ERRCODE = '22023';
  END IF;
  IF v_prior_row.last_error IS NULL OR v_prior_row.last_error NOT ILIKE '%timeout%' THEN
    RAISE EXCEPTION 'prior upload % is not a timeout orphan (last_error=%)',
      p_prior_upload_id, v_prior_row.last_error USING ERRCODE = 'P0002';
  END IF;

  -- Per-creator advisory lock; serializes against finalize_locked + retrain.
  PERFORM pg_advisory_xact_lock(hashtext('face_clone_overwrite:' || v_prior_row.creator_id::text));

  -- Snapshot prior face id under the lock; respect force_overwrite + active-session
  -- guard exactly like finalize_locked does.
  SELECT simli_face_id INTO v_prior_face
    FROM public.creators WHERE id = v_prior_row.creator_id FOR UPDATE;
  IF v_prior_face IS NOT NULL THEN
    IF NOT v_prior_row.force_overwrite THEN
      RAISE EXCEPTION 'creator already has a face' USING ERRCODE = '23505';
    END IF;
    SELECT count(*) INTO v_open
      FROM public.sessions
     WHERE creator_id = v_prior_row.creator_id
       AND ended_at IS NULL;
    IF v_open > 0 THEN
      RAISE EXCEPTION 'creator has % active sessions', v_open USING ERRCODE = '55006';
    END IF;
  END IF;

  -- INSERT the recovery audit row. State='ready' from the start because
  -- the route already validated the face is trainable (compose/token 200).
  -- The append-only trigger only fires on UPDATE, so INSERT-with-state=ready
  -- is allowed.
  --
  -- The partial unique index (face_clone_uploads_one_ready_per_vendor_idx)
  -- enforces no two ready rows share a vendor_face_id; if the same face_id
  -- is recovered twice this raises 23505 — caller should map to a clear
  -- "already_recovered" UX.
  INSERT INTO public.face_clone_uploads
    (admin_user_id, creator_id, vendor, media_kind, sha256, mime, bytes,
     width, height, vendor_face_id, state, ready_at, force_overwrite, last_error)
  VALUES
    (v_prior_row.admin_user_id, v_prior_row.creator_id, v_prior_row.vendor,
     v_prior_row.media_kind, v_prior_row.sha256, v_prior_row.mime, v_prior_row.bytes,
     v_prior_row.width, v_prior_row.height, p_vendor_face_id, 'ready', now(),
     v_prior_row.force_overwrite,
     'recovered_from_upload_' || p_prior_upload_id)
  RETURNING id INTO v_new_id;

  UPDATE public.creators
     SET simli_face_id = p_vendor_face_id,
         updated_at    = now()
   WHERE id = v_prior_row.creator_id;

  RETURN QUERY SELECT v_new_id, v_prior_face, COALESCE(v_open, 0::bigint);
END;$$;

REVOKE EXECUTE ON FUNCTION public.face_clone_recover_timeout_orphan(uuid, bigint, text)
  FROM public, anon, authenticated;

COMMENT ON FUNCTION public.face_clone_recover_timeout_orphan(uuid, bigint, text) IS
  'Path C recovery — attributes a Simli-trained face_id back to a failed '
  'timeout-orphan upload row. Inserts a new state=ready audit row, sets '
  'creators.simli_face_id, returns prior face_id for delete-queue enqueue. '
  'Refuses if prior row is not state=failed with timeout in last_error.';
