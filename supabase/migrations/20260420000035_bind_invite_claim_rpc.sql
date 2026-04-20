-- 0035 — bind_invite_claim (R3-C3, R3-C5, R5-M1, R5-M4).
-- Caller (server action) hashes the raw token against both HMAC secrets and
-- passes the candidate hashes. RPC validates invite by hash + email match +
-- not-used + not-expired, then upserts the pending verification nonce.
--
-- R5-M1: partial unique index cannot be referenced by `ON CONFLICT ON
-- CONSTRAINT` — we use inference-form (col list + WHERE predicate). The
-- planner matches by predicate equivalence.
-- R5-M4: only reset expires_at / verification_token when the existing row
-- is already expired. Re-visits to a live claim get the existing nonce back
-- — otherwise the 60-min window could be extended indefinitely, defeating
-- expiry.

CREATE FUNCTION public.bind_invite_claim(p_token_hashes text[])
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_email     citext;
  v_inv_id    uuid;
  v_inv_email citext;
  v_nonce     text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT u.email::citext INTO v_email FROM auth.users u WHERE u.id = v_uid;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT id, email INTO v_inv_id, v_inv_email
    FROM public.creator_invitations
   WHERE token_hash = ANY(p_token_hashes)
     AND used_at IS NULL
     AND expires_at > now()
   LIMIT 1;

  IF v_inv_id IS NULL THEN
    RAISE EXCEPTION 'invite_unavailable' USING ERRCODE = 'P0002';
  END IF;

  -- Forwarded-invite defense: invite email must match session email.
  IF v_inv_email <> v_email THEN
    RAISE EXCEPTION 'invite_unavailable' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.auth_pending_verifications
    (email, purpose, verification_token, expires_at, metadata)
  VALUES (
    v_email,
    'creator_invite_claim',
    gen_random_uuid()::text,
    now() + interval '60 minutes',
    jsonb_build_object('invitation_id', v_inv_id)
  )
  ON CONFLICT (email, purpose, (metadata->>'invitation_id'))
    WHERE purpose = 'creator_invite_claim' AND consumed_at IS NULL
  DO UPDATE SET
    expires_at = CASE
      WHEN public.auth_pending_verifications.expires_at < now()
        THEN excluded.expires_at
      ELSE public.auth_pending_verifications.expires_at
    END,
    verification_token = CASE
      WHEN public.auth_pending_verifications.expires_at < now()
        THEN excluded.verification_token
      ELSE public.auth_pending_verifications.verification_token
    END
  RETURNING verification_token INTO v_nonce;

  RETURN v_nonce;
END;$$;

REVOKE EXECUTE ON FUNCTION public.bind_invite_claim(text[]) FROM public;
GRANT  EXECUTE ON FUNCTION public.bind_invite_claim(text[]) TO authenticated;
