-- 20260523000008 — submit_creator_application v2: capture consent at apply.
--
-- FIVE_CREATOR_ONBOARDING_READINESS P0-3. Extends the apply RPC to record
-- versioned consent (tos + voice_clone + likeness required; content_license /
-- privacy optional) into creator_consents in the SAME transaction as the
-- application insert. Consent is keyed on the applicant's user_id (auth.uid())
-- + the new application_id — the creators row doesn't exist yet (auditor M2).
--
-- Signature change (added p_consents/p_ip/p_user_agent) → DROP + CREATE.
-- Body is byte-identical to 20260420000036 through the application INSERT;
-- the consent validation + insert is appended before RETURN. Grants re-emitted.

DROP FUNCTION IF EXISTS public.submit_creator_application(text, text, text, text, jsonb, jsonb);

CREATE FUNCTION public.submit_creator_application(
  p_claim_nonce  text,
  p_display_name text,
  p_handle       text,
  p_bio          text,
  p_topics       jsonb,
  p_proof        jsonb,
  p_consents     jsonb,
  p_ip           text DEFAULT NULL,
  p_user_agent   text DEFAULT NULL
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

  -- Consent gate (P0-3): validate BEFORE consuming the nonce/invitation so a
  -- missing-consent submit doesn't burn the single-use invite.
  IF p_consents IS NULL OR jsonb_typeof(p_consents) <> 'array' THEN
    RAISE EXCEPTION 'consent_required' USING ERRCODE = 'P0001';
  END IF;
  -- tos + voice_clone + likeness must all be present.
  IF (SELECT count(DISTINCT e->>'type')
        FROM jsonb_array_elements(p_consents) e
       WHERE e->>'type' IN ('tos', 'voice_clone', 'likeness')) < 3 THEN
    RAISE EXCEPTION 'consent_required' USING ERRCODE = 'P0001';
  END IF;
  -- every supplied element well-formed (allowed type + non-empty version).
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_consents) e
              WHERE coalesce(e->>'version', '') = ''
                 OR (e->>'type') NOT IN
                     ('voice_clone', 'likeness', 'content_license', 'tos', 'privacy')) THEN
    RAISE EXCEPTION 'bad_consent' USING ERRCODE = '22023';
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

  -- Cross-table handle check (R2-C5 / R4-M7).
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

  -- Record every supplied consent, keyed on user_id + this application_id.
  INSERT INTO public.creator_consents
    (user_id, application_id, consent_type, version, ip, user_agent, source)
  SELECT v_uid, v_app_id, e->>'type', e->>'version', p_ip, p_user_agent, 'apply_form'
    FROM jsonb_array_elements(p_consents) e;

  RETURN v_app_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.submit_creator_application(text, text, text, text, jsonb, jsonb, jsonb, text, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.submit_creator_application(text, text, text, text, jsonb, jsonb, jsonb, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
