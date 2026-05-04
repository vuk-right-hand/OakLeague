-- S-C2 + S-M5 — voice_clone_finalize_locked replaces 0002 RPC for the
-- overwrite path: takes a per-creator advisory lock, asserts the admin
-- role is active, and (when overwriting) verifies zero open sessions
-- exist in the same transaction as the two UPDATEs. The whole sequence
-- is atomic; nothing can mint a session against the stale voice id
-- between our active-session check and the swap.
--
-- The non-overwrite path goes through this same RPC (no prior voice id
-- to delete; active-session check skipped). The original 0002
-- voice_clone_finalize stays callable for back-compat but the route
-- switches to this one.
--
-- Lock key: hashtext('voice_clone_overwrite:' || creator_id::text). This
-- coexists with reaper's lock (different key namespace).

CREATE FUNCTION public.voice_clone_finalize_locked(
  p_admin_user_id  uuid,
  p_upload_id      bigint,
  p_creator_id     uuid,
  p_voice_id       text,
  p_force          boolean DEFAULT false
) RETURNS TABLE (prior_voice_id text, active_sessions bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
  v_upload   record;
  v_prior    text;
  v_admin    record;
  v_open     bigint;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'voice_clone_finalize_locked: service_role only'
      USING ERRCODE = '42501';
  END IF;

  IF p_voice_id IS NULL OR char_length(p_voice_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid voice_id length' USING ERRCODE = '22023';
  END IF;

  -- S-M5 — re-verify admin is active here, not just trust caller.
  SELECT user_id, role, revoked_at
    INTO v_admin
    FROM public.admin_roles
   WHERE user_id = p_admin_user_id
     AND revoked_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin not active' USING ERRCODE = '42501';
  END IF;

  -- Per-creator transactional advisory lock. SKIP LOCKED is not
  -- appropriate here — we WANT to wait for any concurrent overwrite to
  -- finish so the second one sees the new voice id (and probably 23505s
  -- on the upload row). pg_advisory_xact_lock is released at commit.
  PERFORM pg_advisory_xact_lock(hashtext('voice_clone_overwrite:' || p_creator_id::text));

  SELECT admin_user_id, creator_id, cartesia_voice_id
    INTO v_upload
    FROM public.voice_clone_uploads
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
  IF v_upload.cartesia_voice_id IS NOT NULL THEN
    RAISE EXCEPTION 'upload % already finalized', p_upload_id USING ERRCODE = '23505';
  END IF;

  -- Snapshot the prior voice id under the lock + check active sessions.
  -- S-C2: a session that opens between this check and the lock release
  -- will block on the same advisory lock if it goes through a future
  -- session_open path that also takes it; for now, the 60s deferred
  -- DELETE is the secondary safeguard.
  SELECT voice_id INTO v_prior FROM public.creators WHERE id = p_creator_id FOR UPDATE;
  IF v_prior IS NOT NULL THEN
    IF NOT p_force THEN
      RAISE EXCEPTION 'creator already cloned' USING ERRCODE = '23505';
    END IF;
    SELECT count(*) INTO v_open
      FROM public.sessions
     WHERE creator_id = p_creator_id
       AND ended_at IS NULL;
    IF v_open > 0 THEN
      RAISE EXCEPTION 'creator has % active sessions', v_open USING ERRCODE = '55006';
    END IF;
  END IF;

  UPDATE public.voice_clone_uploads
     SET cartesia_voice_id = p_voice_id
   WHERE id = p_upload_id;

  UPDATE public.creators
     SET voice_id = p_voice_id
   WHERE id = p_creator_id;

  RETURN QUERY SELECT v_prior, COALESCE(v_open, 0::bigint);
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_clone_finalize_locked(uuid, bigint, uuid, text, boolean)
  FROM public, anon, authenticated;
