-- D8 / React-duet — creator T&Cs duet consent.
-- Required at application submission. Stored as a timestamptz on
-- creator_applications (NULL = not consented; non-null = consent moment)
-- + terms_version text (which version of the Creator Terms the creator
-- agreed to — pinned in app code at CREATOR_TERMS_VERSION).
--
-- Defense in depth (5 layers, audit R1 C1):
--   1. Form: required checkbox + submit-disabled gating.
--   2. Server action: z.literal(true) at the action boundary.
--   3. RPC submit_creator_application: raises 'duet_consent_required'.
--   4. RPC approve_creator_application: explicit consent guard
--      (raises 'duet_consent_missing' with structured error code) so
--      admins see a clean message instead of a raw CHECK violation.
--   5. CHECK constraint: (status <> 'approved' OR duet_consent_at IS
--      NOT NULL). Catches direct service-role inserts that bypass the
--      RPC layer.
--
-- Layer scope (audit R2 M6):
--   - Schema enforces "an approved row has a consent timestamp set".
--   - Schema does NOT prevent an admin with service-role from manually
--     setting that timestamp. Stopping a malicious admin from forging
--     consent is a process-control problem (audit log review, role
--     separation), not a schema-control problem. The CHECK + RPC guard
--     ensure the LEGITIMATE flow records consent atomically and
--     visibly; out-of-band admin abuse is out of scope here.
--
-- Legacy rows: NOT VALID applies the constraint to new writes and
-- updates only. Pre-migration rows (today: only the Vuk seed via
-- the real invite flow per CLAUDE.md) are grandfathered as-is.
--
-- Deploy ordering (audit R1 C2): the old 6-arg signature is kept as
-- a backwards-compat shim that raises 'duet_consent_required'. This
-- closes the brief window between DB migration application and app
-- code deploy where in-flight requests from old client bundles would
-- otherwise hit the new DB and get 'function does not exist'. Old
-- clients now get a clean structured error → action.ts maps to
-- 'stale_client' → form forces window.location.reload() to fetch the
-- new bundle (which has the consent checkbox).

ALTER TABLE public.creator_applications
  ADD COLUMN duet_consent_at         timestamptz,
  ADD COLUMN duet_consent_terms_version text
                                       CHECK (duet_consent_terms_version IS NULL
                                              OR char_length(duet_consent_terms_version) <= 32);

ALTER TABLE public.creator_applications
  ADD CONSTRAINT creator_applications_consent_required_for_approval
  CHECK (status <> 'approved' OR duet_consent_at IS NOT NULL)
  NOT VALID;

-- Backwards-compat shim for the deploy window. Raises immediately
-- without touching DB state — does not consume the claim nonce.
-- See header for full context.
CREATE OR REPLACE FUNCTION public.submit_creator_application(
  p_claim_nonce  text,
  p_display_name text,
  p_handle       text,
  p_bio          text,
  p_topics       jsonb,
  p_proof        jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'duet_consent_required' USING ERRCODE = '42501';
END;$$;

-- New 8-arg signature — adds p_duet_consent boolean and
-- p_duet_consent_terms_version text. Body identical to the original
-- 6-arg save the consent gate (line A) and INSERT column addition
-- (line B).
CREATE FUNCTION public.submit_creator_application(
  p_claim_nonce              text,
  p_display_name             text,
  p_handle                   text,
  p_bio                      text,
  p_topics                   jsonb,
  p_proof                    jsonb,
  p_duet_consent             boolean,
  p_duet_consent_terms_version text
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

  -- (line A) Consent gate. Fails fast — BEFORE the claim nonce is
  -- consumed and BEFORE the invitation is marked used. This is
  -- intentional: an unconsented submission must not burn the user's
  -- one-shot nonce / invite, so the user can retry on the form with
  -- the checkbox ticked. PG three-valued logic: NULL IS NOT TRUE → TRUE,
  -- so this branch fires for false AND null AND any non-true value.
  IF p_duet_consent IS NOT TRUE THEN
    RAISE EXCEPTION 'duet_consent_required' USING ERRCODE = '42501';
  END IF;
  -- The app passes a hardcoded 11-char CREATOR_TERMS_VERSION constant
  -- so the >32 length branch is effectively unreachable from the form
  -- path; it's defense-in-depth against a service-role caller bypassing
  -- the action layer with a malformed value, redundant with the column
  -- CHECK but kept so the RPC fails with a structured error code
  -- (vs raw 23514) for that pathological case.
  IF p_duet_consent_terms_version IS NULL
     OR char_length(p_duet_consent_terms_version) = 0
     OR char_length(p_duet_consent_terms_version) > 32 THEN
    RAISE EXCEPTION 'duet_consent_terms_version_invalid' USING ERRCODE = '42501';
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

  -- (line B) duet_consent_at = now() — atomic with the application row.
  -- UPDATE is admin-only per existing RLS so this is the only path that
  -- can set the consent timestamp from an authenticated user.
  BEGIN
    INSERT INTO public.creator_applications
      (user_id, invitation_id, display_name, handle, bio, topics, proof, status,
       duet_consent_at, duet_consent_terms_version)
    VALUES
      (v_uid, v_inv_id, p_display_name, v_handle::text, p_bio, p_topics, p_proof, 'submitted',
       now(), p_duet_consent_terms_version)
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

REVOKE EXECUTE ON FUNCTION public.submit_creator_application(
  text, text, text, text, jsonb, jsonb, boolean, text
) FROM public;
GRANT  EXECUTE ON FUNCTION public.submit_creator_application(
  text, text, text, text, jsonb, jsonb, boolean, text
) TO authenticated;

-- Approve RPC guard (audit R2 C2). Fails fast with a structured error
-- code BEFORE the UPDATE that would otherwise be rejected by the
-- partial CHECK with raw 23514 / unhelpful constraint name. Admin sees
-- 'duet_consent_missing' instead of 'check constraint
-- creator_applications_consent_required_for_approval failed'. The
-- CHECK still fires as the unbypassable backstop if this guard is
-- ever removed.
CREATE OR REPLACE FUNCTION public.approve_creator_application(p_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user_id      uuid;
  v_handle       citext;
  v_display_name text;
  v_creator_id   uuid;
BEGIN
  PERFORM public._assert_caller_is_admin();

  -- Consent guard — explicit. Without this, the UPDATE below would
  -- raise 23514 with the constraint name. Same effect, uglier UX.
  IF NOT EXISTS (
    SELECT 1 FROM public.creator_applications
     WHERE id = p_id
       AND duet_consent_at IS NOT NULL
  ) THEN
    -- Distinguish "row missing" from "consent missing" so admin UI
    -- can render the right message. Row-missing falls through to
    -- the not_pending path below.
    IF EXISTS (SELECT 1 FROM public.creator_applications WHERE id = p_id) THEN
      RAISE EXCEPTION 'duet_consent_missing' USING ERRCODE = '42501';
    END IF;
  END IF;

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
