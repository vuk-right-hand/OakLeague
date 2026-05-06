-- FACE_UI_PLAN auditor R3 follow-ups.
--
-- NC2 — pending-row reaper. A row that registered with vendor_face_id
-- but never transitioned out of pending (Simli vendor-side outage,
-- network partition during finalize, page closed before resume) sits in
-- the audit table forever. M1 resume keeps re-attaching to a dead row on
-- every page load. This migration adds:
--   * face_clone_uploads_reap_stale_pending(p_max_age_minutes int)
--     marks rows older than p_max_age failed and enqueues their
--     vendor_face_id for delete. Returns count.
--   * Called every 30s tick from voice-proxy startup (next to the
--     existing simli-face-delete worker).
--
-- NC3 — pending_retry_count. simli_face_delete_queue's worker rolls
-- attempts back when Simli returns 400 "Failed to Delete FaceId" so a
-- still-training face doesn't trip the 10-attempt fatal alert. Side
-- effect: a genuinely stuck face (Simli vendor outage AFTER training)
-- never alerts. Add a non-decrementable counter that lives parallel to
-- attempts; alert at threshold.
--
-- NM5 — face_clone_orphan_cleanup currently allows enqueueing a vendor
-- face_id even when it points at the live creators.simli_face_id (a
-- replayed/stale orphan_cleanup call would queue a delete on the live
-- face). Guard against it.
--
-- NM6 — face_clone_finalize_locked raises P0001 on multiple paths;
-- status route only matches /face_state_drift/. Tag the wrong-state
-- raise with a distinct ERRCODE so unrelated P0001s don't fall into
-- generic finalize_failed 500s.

-- 1. NC3: pending_retry_count ----------------------------------------------

ALTER TABLE public.simli_face_delete_queue
  ADD COLUMN IF NOT EXISTS pending_retry_count int NOT NULL DEFAULT 0
    CHECK (pending_retry_count >= 0 AND pending_retry_count <= 50);

COMMENT ON COLUMN public.simli_face_delete_queue.pending_retry_count IS
  'Count of times the worker observed Simli returning 400 "Failed to Delete '
  'FaceId" because the vendor face is still pending generation. Independent '
  'of the 10-attempt fatal-orphan threshold (the worker rolls attempts back '
  'on these). Alert at 12 (~ 1 hour at 5-min retry cadence).';

-- 2. NC2: stale-pending reaper RPC -----------------------------------------

CREATE OR REPLACE FUNCTION public.face_clone_uploads_reap_stale_pending(
  p_max_age_minutes int DEFAULT 30
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
  v_count    int := 0;
  v_row      record;
  v_updated  int;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'face_clone_uploads_reap_stale_pending: service_role only'
      USING ERRCODE = '42501';
  END IF;
  IF p_max_age_minutes IS NULL OR p_max_age_minutes < 5 OR p_max_age_minutes > 1440 THEN
    RAISE EXCEPTION 'p_max_age_minutes out of range (5..1440)' USING ERRCODE = '22023';
  END IF;

  -- Auditor R4-M1 — concurrent reaper replicas race to UPDATE the same
  -- pending rows. Only the first writer's UPDATE returns rowcount=1; the
  -- others see the row already 'failed' and rowcount=0. Count only true
  -- transitions so the worker's log line doesn't overcount on Fly redeploy
  -- with N replicas.
  FOR v_row IN
    SELECT id, admin_user_id, creator_id, vendor_face_id
      FROM public.face_clone_uploads
     WHERE state = 'pending'
       AND created_at < (now() - make_interval(mins => p_max_age_minutes))
     ORDER BY created_at ASC
     LIMIT 50
  LOOP
    UPDATE public.face_clone_uploads
       SET state      = 'failed',
           last_error = 'reaper_timeout_no_terminal_status'
     WHERE id = v_row.id
       AND state = 'pending';
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated = 1 AND v_row.vendor_face_id IS NOT NULL THEN
      INSERT INTO public.simli_face_delete_queue
        (face_id, creator_id, enqueued_by, due_at)
      VALUES
        (v_row.vendor_face_id, v_row.creator_id, v_row.admin_user_id, now())
      ON CONFLICT (face_id) DO UPDATE
        SET due_at = EXCLUDED.due_at,
            attempts = 0,
            last_error = NULL,
            enqueued_by = EXCLUDED.enqueued_by,
            updated_at = now();
    END IF;

    IF v_updated = 1 THEN v_count := v_count + 1; END IF;
  END LOOP;
  RETURN v_count;
END;$$;

REVOKE EXECUTE ON FUNCTION public.face_clone_uploads_reap_stale_pending(int)
  FROM public, anon, authenticated;

-- 3. NM5: tighten orphan_cleanup against replay against a live face --------

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
  v_live_face text;
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

  -- NM5 — refuse to enqueue a delete for the currently-live face. A
  -- replayed orphan_cleanup against a 'ready' row whose face is still
  -- pointed-to by creators.simli_face_id would otherwise schedule a
  -- self-deletion of the live avatar.
  SELECT simli_face_id INTO v_live_face FROM public.creators WHERE id = p_creator_id;
  IF v_upload.state = 'ready' AND v_live_face = p_vendor_face_id THEN
    RAISE EXCEPTION 'orphan_cleanup_refused_live_face' USING ERRCODE = '42501';
  END IF;

  IF v_upload.state = 'pending' THEN
    UPDATE public.face_clone_uploads
       SET state      = 'failed',
           last_error = LEFT(coalesce(p_reason, 'orphan_cleanup'), 500)
     WHERE id = p_upload_id;
  END IF;

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

-- 4. NM6: distinct ERRCODE for non-drift wrong-state finalize raise --------
-- Re-define face_clone_finalize_locked so the "cannot finalize from state=X"
-- raise uses ERRCODE 'P0002' (a sentinel we reserve for "wrong state, not a
-- drift") so the status route's regex match on P0001+/face_state_drift/
-- doesn't accidentally tag unrelated raises as drift.

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

  SELECT user_id, revoked_at
    INTO v_admin
    FROM public.admin_roles
   WHERE user_id = p_admin_user_id
     AND revoked_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin not active' USING ERRCODE = '42501';
  END IF;

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
    SELECT simli_face_id INTO v_prior FROM public.creators WHERE id = p_creator_id;
    IF v_prior IS DISTINCT FROM p_vendor_face_id THEN
      RAISE EXCEPTION 'face_state_drift: creators.simli_face_id=% expected=%', v_prior, p_vendor_face_id
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT NULL::text, 0::bigint;
    RETURN;
  END IF;
  IF v_upload.state <> 'pending' THEN
    -- NM6 — distinct ERRCODE so route mapper doesn't conflate with drift.
    RAISE EXCEPTION 'upload % cannot finalize from state=%', p_upload_id, v_upload.state
      USING ERRCODE = 'P0002';
  END IF;

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
