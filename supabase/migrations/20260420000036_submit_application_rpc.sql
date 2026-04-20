-- 0036 — submit_creator_application (R2-C4, R3-C5, R3-M2, R4-M2, R4-M7,
-- R5-M2).
-- No p_user_id param — authoritative user identity comes from auth.uid()
-- inside the body (R2-C4). Consumes the claim nonce (token + email +
-- purpose), reads invitation_id from metadata, consumes the specific
-- invitation by id (status re-validated — R4-M2 — to block race where
-- invitation expired / got revoked between /claim and /apply).
--
-- R5-M2: unique_violation dispatched via GET STACKED DIAGNOSTICS
-- CONSTRAINT_NAME. Collapsing every unique violation to `handle_taken` lies
-- to users about duplicate submissions (`creator_applications_one_active_
-- per_user_idx` from migration 0010 and `creator_applications_handle_
-- pending_idx` from 0028 are both partial unique indexes — caught here
-- and mapped to distinct structured error codes).

CREATE FUNCTION public.submit_creator_application(
  p_claim_nonce  text,
  p_display_name text,
  p_handle       text,
  p_bio          text,
  p_topics       jsonb,
  p_proof        jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_email       citext;
  v_handle      citext := lower(p_handle)::citext;
  v_inv_id      uuid;
  v_inv_row     record;
  v_claim_row   record;
  v_app_id      uuid;
  v_constraint  text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT u.email::citext INTO v_email FROM auth.users u WHERE u.id = v_uid;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Consume claim nonce (token + email + purpose + unconsumed + unexpired).
  UPDATE public.auth_pending_verifications
     SET consumed_at = now()
   WHERE verification_token = p_claim_nonce
     AND email = v_email
     AND purpose = 'creator_invite_claim'
     AND consumed_at IS NULL
     AND expires_at > now()
   RETURNING metadata INTO v_claim_row;

  IF v_claim_row IS NULL THEN
    RAISE EXCEPTION 'invite_claim_invalid' USING ERRCODE = '42501';
  END IF;

  -- Defensive: metadata must carry invitation_id (CHECK in 0029 guarantees
  -- this at insert time; belt-and-suspenders here in case a future writer
  -- bypasses the partial-unique path).
  v_inv_id := (v_claim_row.metadata->>'invitation_id')::uuid;
  IF v_inv_id IS NULL THEN
    RAISE EXCEPTION 'invite_claim_missing_invitation_id' USING ERRCODE = 'P0002';
  END IF;

  -- Re-validate invitation status (R4-M2). Atomic consume.
  UPDATE public.creator_invitations
     SET used_at = now(), used_by_user_id = v_uid
   WHERE id = v_inv_id
     AND used_at IS NULL
     AND expires_at > now()
     AND email = v_email
   RETURNING id INTO v_inv_row;

  IF v_inv_row IS NULL THEN
    RAISE EXCEPTION 'invite_unavailable' USING ERRCODE = '42501';
  END IF;

  -- Cross-table handle check (R2-C5 / R4-M7): verify handle isn't already
  -- held by a creator or a different profile. Trigger on creators also
  -- enforces at promotion time, but fast-fail here gives a clean error.
  IF EXISTS (SELECT 1 FROM public.handles_registry
              WHERE handle = v_handle
                AND NOT (owner_kind = 'profile' AND owner_id = v_uid))
  THEN
    RAISE EXCEPTION 'handle_taken' USING ERRCODE = '23505';
  END IF;

  BEGIN
    INSERT INTO public.creator_applications
      (user_id, invitation_id, display_name, handle, bio, topics, proof, status)
    VALUES
      (v_uid, v_inv_id, p_display_name, v_handle::text, p_bio, p_topics, p_proof, 'submitted')
    RETURNING id INTO v_app_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    CASE v_constraint
      WHEN 'creator_applications_handle_pending_idx'   THEN RAISE EXCEPTION 'handle_taken' USING ERRCODE = '23505';
      WHEN 'handles_registry_pkey'                     THEN RAISE EXCEPTION 'handle_taken' USING ERRCODE = '23505';
      WHEN 'creator_applications_one_active_per_user_idx' THEN RAISE EXCEPTION 'duplicate_application' USING ERRCODE = '23505';
      ELSE RAISE;
    END CASE;
  END;

  RETURN v_app_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.submit_creator_application(text, text, text, text, jsonb, jsonb) FROM public;
GRANT  EXECUTE ON FUNCTION public.submit_creator_application(text, text, text, text, jsonb, jsonb) TO authenticated;
