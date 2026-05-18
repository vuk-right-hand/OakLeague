-- HUME_TTS_PLAN §3.4 — voice_clone_finalize_locked_v2 (provider-aware paired write)
--
-- v2 extends v1 with p_tts_provider + p_voice_name parameters, returns
-- prior_voice_name alongside prior_voice_id. Dispatches to either
-- creators.voice_id (cartesia) OR creators.hume_voice_id + hume_voice_name
-- (hume) atomically inside the per-creator advisory lock.
--
-- R3-C1 fix: writing creators.hume_voice_id WITHOUT hume_voice_name would
-- violate creators_hume_voice_paired_chk (added in migration
-- 20260520000002). v2 writes both columns in the same UPDATE statement so
-- the CHECK never sees an intermediate state.
--
-- v1 RPC stays as a forwarding shim (CREATE OR REPLACE at the bottom of
-- this migration). Old route code calling v1 keeps working during the
-- §5 PR deploy window.
--
-- Per HUME_TTS_PLAN §6.6: v1 stays callable indefinitely. Drop-symbol
-- migration is a separate future micro-PR, gated on "zero pre-v2 sessions
-- still open AND ≥30 days since v2 deploy."

CREATE FUNCTION public.voice_clone_finalize_locked_v2(
  p_admin_user_id  uuid,
  p_upload_id      bigint,
  p_creator_id     uuid,
  p_tts_provider   public.tts_provider,
  p_voice_id       text,
  p_voice_name     text,        -- REQUIRED when p_tts_provider='hume', NULL allowed for cartesia
  p_force          boolean DEFAULT false
) RETURNS TABLE (
  prior_voice_id   text,
  prior_voice_name text,        -- NULL for cartesia rows
  active_sessions  bigint
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
  v_upload   record;
  v_admin    record;
  v_open     bigint;
  v_prior_id   text;
  v_prior_name text;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'voice_clone_finalize_locked_v2: service_role only'
      USING ERRCODE = '42501';
  END IF;

  -- Input validation
  IF p_voice_id IS NULL OR char_length(p_voice_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid voice_id length' USING ERRCODE = '22023';
  END IF;

  -- Provider-specific paired-arg validation (R3-C1 + R3-C4 fix)
  IF p_tts_provider = 'hume' THEN
    IF p_voice_name IS NULL OR char_length(p_voice_name) NOT BETWEEN 1 AND 128 THEN
      RAISE EXCEPTION 'hume_voice_name_required: tts_provider=hume requires non-null p_voice_name (1..128 chars)'
        USING ERRCODE = '22023';
    END IF;
  END IF;
  -- For cartesia, p_voice_name is ignored (Cartesia keys deletes by id, not name).

  -- Admin still active?
  SELECT user_id, role, revoked_at
    INTO v_admin
    FROM public.admin_roles
   WHERE user_id = p_admin_user_id
     AND revoked_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin not active' USING ERRCODE = '42501';
  END IF;

  -- Per-creator transactional advisory lock — coexists with reaper's lock.
  PERFORM pg_advisory_xact_lock(hashtext('voice_clone_overwrite:' || p_creator_id::text));

  -- Upload row exists + owned by this admin + not already finalized?
  -- Note: v2 inspects BOTH cartesia_voice_id and hume_voice_id for the
  -- "already finalized" check, so a row can be a clean target for either
  -- provider but only once per provider.
  SELECT admin_user_id, creator_id, cartesia_voice_id, hume_voice_id, hume_voice_name, tts_provider
    INTO v_upload
    FROM public.voice_clone_uploads
   WHERE id = p_upload_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'upload % not found', p_upload_id USING ERRCODE = '23503';
  END IF;
  -- Audit M1 fix (2026-05-13): data mismatches use 22023 (invalid_parameter_value),
  -- NOT 42501 (privilege). The route layer special-cases 42501 for "admin not
  -- active" — if these raised 42501, the admin UI would surface "admin not
  -- active" on what's actually a data mismatch. Gaslighting.
  IF v_upload.admin_user_id IS DISTINCT FROM p_admin_user_id THEN
    RAISE EXCEPTION 'admin mismatch on upload %', p_upload_id USING ERRCODE = '22023';
  END IF;
  IF v_upload.creator_id IS DISTINCT FROM p_creator_id THEN
    RAISE EXCEPTION 'creator mismatch on upload %', p_upload_id USING ERRCODE = '22023';
  END IF;
  IF v_upload.tts_provider IS DISTINCT FROM p_tts_provider THEN
    RAISE EXCEPTION 'tts_provider mismatch on upload % (row=%, arg=%)',
      p_upload_id, v_upload.tts_provider, p_tts_provider
      USING ERRCODE = '22023';
  END IF;
  IF p_tts_provider = 'cartesia' AND v_upload.cartesia_voice_id IS NOT NULL THEN
    RAISE EXCEPTION 'upload % already finalized', p_upload_id USING ERRCODE = '23505';
  END IF;
  IF p_tts_provider = 'hume' AND v_upload.hume_voice_id IS NOT NULL THEN
    RAISE EXCEPTION 'upload % already finalized', p_upload_id USING ERRCODE = '23505';
  END IF;

  -- Snapshot the prior voice (provider-specific) under the lock + check
  -- active sessions if this is an overwrite.
  IF p_tts_provider = 'cartesia' THEN
    SELECT voice_id, NULL::text
      INTO v_prior_id, v_prior_name
      FROM public.creators
     WHERE id = p_creator_id
     FOR UPDATE;
  ELSE -- hume
    SELECT hume_voice_id, hume_voice_name
      INTO v_prior_id, v_prior_name
      FROM public.creators
     WHERE id = p_creator_id
     FOR UPDATE;
  END IF;

  IF v_prior_id IS NOT NULL THEN
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

  -- Provider-specific finalize — voice_clone_uploads write + creators write
  -- in the same statement so the paired-CHECK never sees an intermediate
  -- state. For hume, BOTH hume_voice_id AND hume_voice_name update together.
  IF p_tts_provider = 'cartesia' THEN
    UPDATE public.voice_clone_uploads
       SET cartesia_voice_id = p_voice_id
     WHERE id = p_upload_id;

    UPDATE public.creators
       SET voice_id = p_voice_id
     WHERE id = p_creator_id;
  ELSE -- hume
    UPDATE public.voice_clone_uploads
       SET hume_voice_id   = p_voice_id,
           hume_voice_name = p_voice_name
     WHERE id = p_upload_id;

    UPDATE public.creators
       SET hume_voice_id   = p_voice_id,
           hume_voice_name = p_voice_name
     WHERE id = p_creator_id;
  END IF;

  -- §5 audit M2 fix + unit-wide C1 fix (2026-05-13): if the voice we just
  -- finalized is the SAME one currently sitting in voice_delete_queue
  -- (admin re-paste of a recently-overwritten voice), we must atomically
  -- prevent the worker from dispatching DELETE on it. The naive DELETE
  -- isn't enough — the worker already claimed the row via FOR UPDATE
  -- SKIP LOCKED at the start of its dispatch tick, and may complete the
  -- HTTP DELETE before our DELETE here lands. Result: Hume deletes the
  -- voice we just finalized to.
  --
  -- Safe sequence:
  --   1. SELECT … FOR UPDATE on the queue row. This BLOCKS until the
  --      worker's claim transaction commits/rolls back.
  --   2. If the row no longer exists post-block, the worker successfully
  --      dispatched + dequeued. The voice is GONE from the provider.
  --      RAISE 55006 'voice_just_deleted_retry_paste' so the route
  --      returns a clean error; admin re-pastes a fresh voice.
  --   3. If the row exists with attempts >= 1, the worker is mid-dispatch
  --      OR just failed. Conservative call: also reject — we don't know
  --      whether the HTTP DELETE landed before/after the failure. Force
  --      the admin to wait 60s + re-paste so we don't commit a creators
  --      row pointing at a voice we're racing to delete.
  --   4. If the row exists with attempts = 0 (newly enqueued, never
  --      claimed), the worker hasn't started — safe to DELETE here.
  DECLARE
    v_queue_attempts int;
  BEGIN
    SELECT attempts INTO v_queue_attempts
      FROM public.voice_delete_queue
     WHERE tts_provider = p_tts_provider
       AND voice_id     = p_voice_id
     FOR UPDATE;
    IF FOUND THEN
      IF v_queue_attempts >= 1 THEN
        RAISE EXCEPTION 'voice_just_deleted_retry_paste: worker is/was dispatching DELETE for this voice (attempts=%); retry paste after the worker drains',
          v_queue_attempts
          USING ERRCODE = '55006';
      END IF;
      -- attempts = 0: worker hasn't claimed yet. Lock-protected DELETE
      -- is safe; the worker's next claim will skip this row.
      DELETE FROM public.voice_delete_queue
       WHERE tts_provider = p_tts_provider
         AND voice_id     = p_voice_id;
    END IF;
    -- NOT FOUND: nothing in queue, normal path. Nothing to delete.
  END;

  RETURN QUERY SELECT v_prior_id, v_prior_name, COALESCE(v_open, 0::bigint);
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_clone_finalize_locked_v2(uuid, bigint, uuid, public.tts_provider, text, text, boolean)
  FROM public, anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────
-- v1 forwarding shim
-- ─────────────────────────────────────────────────────────────────────
-- Replace v1 body so existing route code calling
-- voice_clone_finalize_locked(...) keeps working without changes. v1 stays
-- callable indefinitely. The route patches in §5.5 switch to v2 explicitly,
-- but the shim covers the deploy window and any future stragglers.
--
-- Return shape note: v1 returned (prior_voice_id, active_sessions). v2
-- returns (prior_voice_id, prior_voice_name, active_sessions). The shim
-- discards prior_voice_name when forwarding — v1 callers never expected
-- the name column anyway (they only handle Cartesia, where there's no
-- name to track).

CREATE OR REPLACE FUNCTION public.voice_clone_finalize_locked(
  p_admin_user_id  uuid,
  p_upload_id      bigint,
  p_creator_id     uuid,
  p_voice_id       text,
  p_force          boolean DEFAULT false
) RETURNS TABLE (prior_voice_id text, active_sessions bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
    SELECT v2.prior_voice_id, v2.active_sessions
      FROM public.voice_clone_finalize_locked_v2(
        p_admin_user_id, p_upload_id, p_creator_id,
        'cartesia'::public.tts_provider,
        p_voice_id, NULL::text, p_force
      ) AS v2;
END;$$;

-- Unit-wide audit M2 fix (2026-05-13): invalidate PostgREST OpenAPI cache
-- for the v2 finalize RPC + the v1 shim rewrite.
NOTIFY pgrst, 'reload schema';
