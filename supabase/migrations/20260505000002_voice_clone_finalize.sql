-- R3-C5 / R4-S2 — voice_clone_finalize RPC.
--
-- Atomically writes (a) voice_clone_uploads.cartesia_voice_id (NULL→non-NULL
-- transition allowed by the fill-once trigger from 0047) and (b)
-- creators.voice_id, in one transaction.
--
-- WHY this RPC exists (R4-S2 rationale): the Supabase JS client cannot
-- bundle two `.update()` calls into one transaction. Without this RPC, a
-- partial failure between the two updates would lock the upload row at
-- fill-once (per 0047 trigger) and leave creators.voice_id NULL —
-- bricking re-upload for that creator.
--
-- CLAUDE.md hard rules satisfied:
--   * SET search_path = public, pg_temp.
--   * REVOKE EXECUTE from public, anon, authenticated.
--   * Caller's admin_user_id verified against the upload row.
--   * Upload's creator_id verified against the caller-supplied creator id.
--   * Append-only: only allows the NULL→non-NULL transition (the existing
--     fill-once trigger on voice_clone_uploads enforces this).
--
-- Service-role only. The Next.js /api/admin/voice-clone route is the
-- sole caller; it has already authenticated the admin via
-- assertAdminFromSession before invoking this RPC.

CREATE FUNCTION public.voice_clone_finalize(
  p_admin_user_id  uuid,
  p_upload_id      bigint,
  p_creator_id     uuid,
  p_voice_id       text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
  v_upload   record;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'voice_clone_finalize: service_role only'
      USING ERRCODE = '42501';
  END IF;

  IF p_voice_id IS NULL OR char_length(p_voice_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid voice_id length' USING ERRCODE = '22023';
  END IF;

  SELECT admin_user_id, creator_id, cartesia_voice_id
    INTO v_upload
    FROM public.voice_clone_uploads
   WHERE id = p_upload_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'upload % not found', p_upload_id USING ERRCODE = '23503';
  END IF;
  IF v_upload.admin_user_id IS DISTINCT FROM p_admin_user_id THEN
    RAISE EXCEPTION 'admin mismatch on upload %', p_upload_id
      USING ERRCODE = '42501';
  END IF;
  IF v_upload.creator_id IS DISTINCT FROM p_creator_id THEN
    RAISE EXCEPTION 'creator mismatch on upload %', p_upload_id
      USING ERRCODE = '42501';
  END IF;
  IF v_upload.cartesia_voice_id IS NOT NULL THEN
    RAISE EXCEPTION 'upload % already finalized', p_upload_id
      USING ERRCODE = '23505';
  END IF;

  -- Both UPDATEs in this single transaction. The 0047 fill-once trigger
  -- runs on the first UPDATE and allows the NULL→non-NULL transition.
  UPDATE public.voice_clone_uploads
     SET cartesia_voice_id = p_voice_id
   WHERE id = p_upload_id;

  UPDATE public.creators
     SET voice_id = p_voice_id
   WHERE id = p_creator_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_clone_finalize(uuid, bigint, uuid, text)
  FROM public, anon, authenticated;
