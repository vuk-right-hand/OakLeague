-- FACE_UI_PLAN §8 migration 2 — face_clone_finalize_locked.
--
-- Two-phase finalize because Simli Trinity-1 is async (Phase 0 finding):
--
--   1. Upload route (POST /api/admin/face-upload) calls
--      face_clone_register_pending after Simli accepts the image. Writes
--      vendor_face_id + warnings + force_overwrite to the upload row.
--      Does NOT touch creators.simli_face_id yet — face is unusable
--      until ready.
--
--   2. Status route (GET /api/admin/face-upload/status?uploadId=N) polls
--      Simli; on the first "ready" response, calls
--      face_clone_finalize_locked which atomically:
--        - flips upload row to state='ready'
--        - sets creators.simli_face_id (overwriting under force_overwrite from the row)
--        - returns prior face_id for delete-queue enqueue
--
-- Per Q4=B (no lock unification), face uses its own advisory-lock
-- namespace 'face_clone_overwrite:<creator_id>'.
--
-- Auditor R2 fixes folded:
--   * R2-C3: idempotent re-call must verify creators.simli_face_id still
--     matches the upload's vendor_face_id; otherwise raise face_state_drift
--     so the route can mark the row deleted instead of silently lying.
--   * R2-M2: force flag persisted on the upload row (column
--     force_overwrite); finalize reads it from the row, not from a
--     per-call parameter.

CREATE OR REPLACE FUNCTION public.face_clone_register_pending(
  p_admin_user_id  uuid,
  p_upload_id      bigint,
  p_creator_id     uuid,
  p_vendor_face_id text,
  p_warnings       jsonb DEFAULT '[]'::jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
  v_upload   record;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'face_clone_register_pending: service_role only'
      USING ERRCODE = '42501';
  END IF;

  IF p_vendor_face_id IS NULL OR NOT (char_length(p_vendor_face_id) BETWEEN 1 AND 128) THEN
    RAISE EXCEPTION 'invalid vendor_face_id length' USING ERRCODE = '22023';
  END IF;
  IF p_warnings IS NULL OR jsonb_typeof(p_warnings) <> 'array' THEN
    RAISE EXCEPTION 'warnings must be a JSON array' USING ERRCODE = '22023';
  END IF;

  SELECT id, admin_user_id, creator_id, vendor_face_id, state
    INTO v_upload
    FROM public.face_clone_uploads
   WHERE id = p_upload_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'upload % not found', p_upload_id USING ERRCODE = '23503';
  END IF;
  IF v_upload.admin_user_id IS DISTINCT FROM p_admin_user_id THEN
    RAISE EXCEPTION 'admin mismatch on upload %', p_upload_id USING ERRCODE = '42501';
  END IF;
  IF v_upload.creator_id IS DISTINCT FROM p_creator_id THEN
    RAISE EXCEPTION 'creator mismatch on upload %', p_upload_id USING ERRCODE = '42501';
  END IF;
  IF v_upload.vendor_face_id IS NOT NULL THEN
    RAISE EXCEPTION 'upload % already has a vendor_face_id', p_upload_id USING ERRCODE = '23505';
  END IF;
  IF v_upload.state <> 'pending' THEN
    RAISE EXCEPTION 'upload % not in pending state (state=%)', p_upload_id, v_upload.state
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.face_clone_uploads
     SET vendor_face_id = p_vendor_face_id,
         warnings       = p_warnings
   WHERE id = p_upload_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.face_clone_register_pending(uuid, bigint, uuid, text, jsonb)
  FROM public, anon, authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.face_clone_finalize_locked(
  p_admin_user_id uuid,
  p_upload_id     bigint,
  p_creator_id    uuid,
  p_vendor_face_id text
) RETURNS TABLE (prior_face_id text, active_sessions bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
  v_admin    record;
  v_upload   record;
  v_prior    text;
  v_open     bigint;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'face_clone_finalize_locked: service_role only'
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

  -- Per-creator advisory lock. Distinct namespace from voice_clone /
  -- creator_retrain per Q4=B. Released on commit.
  PERFORM pg_advisory_xact_lock(hashtext('face_clone_overwrite:' || p_creator_id::text));

  SELECT id, admin_user_id, creator_id, vendor_face_id, state, force_overwrite
    INTO v_upload
    FROM public.face_clone_uploads
   WHERE id = p_upload_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'upload % not found', p_upload_id USING ERRCODE = '23503';
  END IF;
  IF v_upload.admin_user_id IS DISTINCT FROM p_admin_user_id THEN
    RAISE EXCEPTION 'admin mismatch on upload %', p_upload_id USING ERRCODE = '42501';
  END IF;
  IF v_upload.creator_id IS DISTINCT FROM p_creator_id THEN
    RAISE EXCEPTION 'creator mismatch on upload %', p_upload_id USING ERRCODE = '42501';
  END IF;
  IF v_upload.vendor_face_id IS DISTINCT FROM p_vendor_face_id THEN
    RAISE EXCEPTION 'vendor_face_id mismatch (upload=% caller=%)', v_upload.vendor_face_id, p_vendor_face_id
      USING ERRCODE = '22023';
  END IF;
  IF v_upload.state = 'ready' THEN
    -- Auditor R2-C3 — idempotent re-call must confirm reality before
    -- short-circuiting. If creators.simli_face_id no longer matches our
    -- vendor_face_id (e.g., admin force-retrained between the two polls),
    -- the upload row's claim "this is the live face" is a lie. Raise so
    -- the status route can mark the row deleted instead of silently
    -- returning stale prior_face_id values that would orphan the new face.
    SELECT simli_face_id INTO v_prior FROM public.creators WHERE id = p_creator_id;
    IF v_prior IS DISTINCT FROM p_vendor_face_id THEN
      RAISE EXCEPTION 'face_state_drift: creators.simli_face_id=% expected=%', v_prior, p_vendor_face_id
        USING ERRCODE = 'P0001';
    END IF;
    -- True idempotent re-call: client polled twice, finalize already ran.
    -- prior_face_id is irrelevant on this branch (delete-queue enqueue
    -- already happened on the first call).
    RETURN QUERY SELECT NULL::text, 0::bigint;
    RETURN;
  END IF;
  IF v_upload.state <> 'pending' THEN
    RAISE EXCEPTION 'upload % cannot finalize from state=%', p_upload_id, v_upload.state
      USING ERRCODE = '22023';
  END IF;

  -- Snapshot prior face id under the lock + check active sessions.
  SELECT simli_face_id INTO v_prior FROM public.creators WHERE id = p_creator_id FOR UPDATE;
  IF v_prior IS NOT NULL THEN
    IF NOT v_upload.force_overwrite THEN
      RAISE EXCEPTION 'creator already has a face' USING ERRCODE = '23505';
    END IF;
    SELECT count(*) INTO v_open
      FROM public.sessions
     WHERE creator_id = p_creator_id
       AND ended_at IS NULL;
    IF v_open > 0 THEN
      RAISE EXCEPTION 'creator has % active sessions', v_open USING ERRCODE = '55006';
    END IF;
  END IF;

  -- Atomic flip.
  UPDATE public.face_clone_uploads
     SET state    = 'ready',
         ready_at = now()
   WHERE id = p_upload_id;

  UPDATE public.creators
     SET simli_face_id = p_vendor_face_id,
         updated_at    = now()
   WHERE id = p_creator_id;

  RETURN QUERY SELECT v_prior, COALESCE(v_open, 0::bigint);
END;$$;

REVOKE EXECUTE ON FUNCTION public.face_clone_finalize_locked(uuid, bigint, uuid, text)
  FROM public, anon, authenticated;

-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.face_clone_mark_failed(
  p_admin_user_id uuid,
  p_upload_id     bigint,
  p_last_error    text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
  v_upload   record;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'face_clone_mark_failed: service_role only'
      USING ERRCODE = '42501';
  END IF;

  SELECT id, admin_user_id, state INTO v_upload
    FROM public.face_clone_uploads
   WHERE id = p_upload_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'upload % not found', p_upload_id USING ERRCODE = '23503';
  END IF;
  IF v_upload.admin_user_id IS DISTINCT FROM p_admin_user_id THEN
    RAISE EXCEPTION 'admin mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_upload.state <> 'pending' THEN
    -- already terminal — no-op so the status route doesn't need to
    -- distinguish "first failure" from "repeated poll after failure".
    RETURN;
  END IF;

  UPDATE public.face_clone_uploads
     SET state      = 'failed',
         last_error = LEFT(coalesce(p_last_error, 'unknown'), 500)
   WHERE id = p_upload_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.face_clone_mark_failed(uuid, bigint, text)
  FROM public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Auditor R2-C2 — orphan-cleanup helper. Status route invokes when
-- finalize raises 23505 on a losing-race upload (concurrent admin tabs
-- both POSTed; one wins, the other's vendor face is now unowned). Marks
-- the upload row failed AND enqueues vendor_face_id for delete. Single
-- RPC so the two writes are atomic.
CREATE OR REPLACE FUNCTION public.face_clone_orphan_cleanup(
  p_admin_user_id  uuid,
  p_upload_id      bigint,
  p_creator_id     uuid,
  p_vendor_face_id text,
  p_reason         text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
  v_upload   record;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'face_clone_orphan_cleanup: service_role only'
      USING ERRCODE = '42501';
  END IF;
  IF p_vendor_face_id IS NULL OR NOT (char_length(p_vendor_face_id) BETWEEN 1 AND 128) THEN
    RAISE EXCEPTION 'invalid vendor_face_id length' USING ERRCODE = '22023';
  END IF;

  SELECT id, admin_user_id, creator_id, vendor_face_id, state INTO v_upload
    FROM public.face_clone_uploads
   WHERE id = p_upload_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'upload % not found', p_upload_id USING ERRCODE = '23503';
  END IF;
  IF v_upload.admin_user_id IS DISTINCT FROM p_admin_user_id THEN
    RAISE EXCEPTION 'admin mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_upload.creator_id IS DISTINCT FROM p_creator_id THEN
    RAISE EXCEPTION 'creator mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_upload.vendor_face_id IS DISTINCT FROM p_vendor_face_id THEN
    RAISE EXCEPTION 'vendor_face_id mismatch' USING ERRCODE = '22023';
  END IF;

  IF v_upload.state = 'pending' THEN
    UPDATE public.face_clone_uploads
       SET state      = 'failed',
           last_error = LEFT(coalesce(p_reason, 'orphan_cleanup'), 500)
     WHERE id = p_upload_id;
  END IF;

  -- Enqueue with no defer; worker will pick it up on the next 30s tick.
  -- If the face is still pending in Simli, the worker's 400 retry-later
  -- path handles it.
  INSERT INTO public.simli_face_delete_queue
    (face_id, creator_id, enqueued_by, due_at)
  VALUES
    (p_vendor_face_id, p_creator_id, p_admin_user_id, now())
  ON CONFLICT (face_id) DO UPDATE
    SET due_at = EXCLUDED.due_at,
        attempts = 0,
        last_error = NULL,
        enqueued_by = EXCLUDED.enqueued_by,
        updated_at = now();
END;$$;

REVOKE EXECUTE ON FUNCTION public.face_clone_orphan_cleanup(uuid, bigint, uuid, text, text)
  FROM public, anon, authenticated;
