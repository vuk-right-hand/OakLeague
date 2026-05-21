-- 20260523000007 — creator_consents table + admin attestation RPC + backfill.
--
-- FIVE_CREATOR_ONBOARDING_READINESS P0-3. Records versioned consent for the
-- legally-meaningful acts: voice cloning, likeness/avatar use, content
-- licensing, and ToS/privacy acceptance. Cloning a person's voice + face with
-- no recorded authorization is real legal exposure once we onboard external
-- creators (creator #1 is self-dogfood; #2..N are not).
--
-- DESIGN (decided 2026-05-21):
--   * Unified table — one versioned consent surface for voice_clone, likeness,
--     content_license, tos, privacy (audience ToS still rides profiles).
--   * Keyed on user_id (exists at apply time; the creators row does NOT exist
--     until approval — auditor M2) PLUS application_id (set on the apply path,
--     NULL for admin-attestation / backfill).
--   * Writes happen ONLY via SECURITY DEFINER RPCs (submit_creator_application
--     for the apply path — migration 20260523000008; admin_attest_creator_consent
--     here for the out-of-band path) or service-role. No client INSERT policy.
--   * Append-only in spirit: a new acceptance is a new row (version-pinned), so
--     re-acceptance after a ToS change is a fresh row, not an overwrite.
--
-- GATE STRICTNESS (decided 2026-05-21): voice-clone + face-upload routes HARD
-- BLOCK when no voice_clone/likeness consent exists, with an admin
-- attestation-on-behalf override (admin records the creator consented
-- out-of-band via admin_attest_creator_consent → source='admin_attestation',
-- logged in admin_audit_log).

CREATE TABLE public.creator_consents (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- RESTRICT (audit M1): the consent's evidentiary value is "consented in the
  -- context of THIS application." SET NULL would unmoor the record. Apps are
  -- never hard-deleted (a trigger blocks delete while a creator references the
  -- app); GDPR erasure deletes the user → CASCADE drops the consent anyway.
  application_id uuid        REFERENCES public.creator_applications(id) ON DELETE RESTRICT,
  consent_type   text        NOT NULL CHECK (consent_type IN
                              ('voice_clone', 'likeness', 'content_license', 'tos', 'privacy')),
  version        text        NOT NULL CHECK (char_length(version) BETWEEN 1 AND 40),
  accepted_at    timestamptz NOT NULL DEFAULT now(),
  -- Revocation (audit C1): a consent is active iff revoked_at IS NULL. The gate
  -- counts only active rows, so admin_revoke_creator_consent flipping this
  -- blocks the next clone/face upload. Append-only acceptance + nullable
  -- revoked_at gives a full accept→revoke→re-accept history.
  revoked_at     timestamptz,
  revoked_by     uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- ip / user_agent are PII. Retention: consent is EVIDENTIARY — retain for the
  -- relationship duration (do NOT sweep on the short voice_tickets cadence).
  -- Revisit a long-horizon purge in P1-2; not a short-purge candidate.
  ip             text        CHECK (ip IS NULL OR char_length(ip) <= 64),
  user_agent     text        CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
  -- 'apply_form' | 'admin_attestation' | 'pre_consent_backfill'.
  source         text        NOT NULL DEFAULT 'apply_form'
                              CHECK (char_length(source) BETWEEN 1 AND 40),
  -- For admin_attestation rows: which admin attested (audit linkage).
  attested_by    uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX creator_consents_user_type_idx
  ON public.creator_consents (user_id, consent_type, accepted_at DESC);
CREATE INDEX creator_consents_application_idx
  ON public.creator_consents (application_id) WHERE application_id IS NOT NULL;
-- Audit C3: at most ONE backfill row per (user_id, consent_type) — makes the
-- backfill INSERT below idempotent on migration replay / db reset. Scoped to
-- the backfill source so it never constrains legitimate append-only
-- (apply_form / admin_attestation) re-acceptance rows.
CREATE UNIQUE INDEX creator_consents_backfill_unique_idx
  ON public.creator_consents (user_id, consent_type)
  WHERE source = 'pre_consent_backfill';

-- RLS — own-read only; all writes via SECURITY DEFINER RPC / service-role.
ALTER TABLE public.creator_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "creator_consents own read"
  ON public.creator_consents FOR SELECT
  USING (user_id = auth.uid());

REVOKE ALL ON public.creator_consents FROM public, anon;
-- authenticated needs table-level SELECT for the own-read policy to apply;
-- rows are still gated by the policy. No INSERT/UPDATE/DELETE grant — writes
-- go through the SECURITY DEFINER RPCs (which run as owner) or service-role.
GRANT SELECT ON public.creator_consents TO authenticated;

COMMENT ON TABLE public.creator_consents IS
  'Versioned creator consent (voice_clone | likeness | content_license | tos | privacy). Keyed on user_id (+ application_id on the apply path). Written only via submit_creator_application (apply) / admin_attest_creator_consent (out-of-band) / service-role. Append-only: re-acceptance is a new row. ip/user_agent are PII — include in retention.';


-- ── admin_attest_creator_consent — out-of-band consent on a creator's behalf ─
-- The "Block + admin override" path: when a creator consented via email/call,
-- an admin records it so the clone/face routes unblock. Writes a consent row
-- (source='admin_attestation', attested_by=admin) + an admin_audit_log row.
CREATE FUNCTION public.admin_attest_creator_consent(
  p_creator_id  uuid,
  p_consent_type text,
  p_version     text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin   uuid := auth.uid();
  v_user_id uuid;
  v_id      uuid;
BEGIN
  PERFORM public._assert_caller_is_admin();

  IF p_consent_type NOT IN ('voice_clone', 'likeness', 'content_license', 'tos', 'privacy') THEN
    RAISE EXCEPTION USING errcode='22023', message='bad_consent_type';
  END IF;
  IF p_version IS NULL OR char_length(p_version) = 0 OR char_length(p_version) > 40 THEN
    RAISE EXCEPTION USING errcode='22023', message='bad_version';
  END IF;

  SELECT user_id INTO v_user_id FROM public.creators WHERE id = p_creator_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING errcode='42704', message='creator_not_found';
  END IF;

  INSERT INTO public.creator_consents
    (user_id, application_id, consent_type, version, source, attested_by)
  VALUES
    (v_user_id, NULL, p_consent_type, p_version, 'admin_attestation', v_admin)
  RETURNING id INTO v_id;

  INSERT INTO public.admin_audit_log
    (admin_user_id, action, target_kind, target_id, before, after)
  VALUES
    (v_admin, 'creator_consent_attested', 'creator', p_creator_id, NULL,
     jsonb_build_object('consent_type', p_consent_type, 'version', p_version, 'user_id', v_user_id));

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_attest_creator_consent(uuid, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_attest_creator_consent(uuid, text, text) TO authenticated;

COMMENT ON FUNCTION public.admin_attest_creator_consent(uuid, text, text) IS
  'P0-3 admin override. Records out-of-band creator consent (source=admin_attestation, attested_by=admin) + an admin_audit_log row. Used by the voice-clone / face-upload routes when an admin attests a creator consented via email/call.';


-- ── admin_revoke_creator_consent — honor a withdrawal (audit C1) ────────────
-- Marks every ACTIVE row of a (creator, consent_type) as revoked. The gate
-- counts only revoked_at IS NULL rows, so the next clone/face upload is
-- blocked. Backs the apply-form "I can revoke … by contacting OakLeague"
-- promise via the admin (self-serve creator revoke UI is a P1 follow-up).
CREATE FUNCTION public.admin_revoke_creator_consent(
  p_creator_id   uuid,
  p_consent_type text
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin   uuid := auth.uid();
  v_user_id uuid;
  v_count   int;
BEGIN
  PERFORM public._assert_caller_is_admin();

  IF p_consent_type NOT IN ('voice_clone', 'likeness', 'content_license', 'tos', 'privacy') THEN
    RAISE EXCEPTION USING errcode='22023', message='bad_consent_type';
  END IF;

  SELECT user_id INTO v_user_id FROM public.creators WHERE id = p_creator_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING errcode='42704', message='creator_not_found';
  END IF;

  UPDATE public.creator_consents
     SET revoked_at = now(), revoked_by = v_admin
   WHERE user_id = v_user_id
     AND consent_type = p_consent_type
     AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Auto-unpublish (holistic-audit C1): revoking voice/likeness consent for a
  -- LIVE creator must take them down immediately — otherwise sessions keep
  -- speaking the cloned voice after the creator withdrew consent. published_at
  -- NULL is CHECK-safe with any brain_status; the session-open + rollover gates
  -- then 409 creator_not_published. Other consent types (tos/content_license)
  -- don't gate clone/face, so they don't force a takedown.
  IF p_consent_type IN ('voice_clone', 'likeness') THEN
    UPDATE public.creators SET published_at = NULL
     WHERE id = p_creator_id AND published_at IS NOT NULL;
  END IF;

  INSERT INTO public.admin_audit_log
    (admin_user_id, action, target_kind, target_id, before, after)
  VALUES
    (v_admin, 'creator_consent_revoked', 'creator', p_creator_id, NULL,
     jsonb_build_object('consent_type', p_consent_type, 'user_id', v_user_id, 'rows_revoked', v_count,
                        'unpublished', p_consent_type IN ('voice_clone', 'likeness')));

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_revoke_creator_consent(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_revoke_creator_consent(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.admin_revoke_creator_consent(uuid, text) IS
  'P0-3 audit C1. Revokes (revoked_at=now) every active row of a (creator, consent_type) + audit row. The clone/face gate counts only revoked_at IS NULL rows, so this blocks the next clone/upload — honoring a consent withdrawal.';


-- ── Backfill: existing creators predate consent capture (auditor C2 + C3) ───
-- EVIDENCE-BASED, not blanket. A creator who ALREADY has a cloned voice
-- (voice_id) or an uploaded face (simli_face_id) was cloned in the pre-consent
-- dogfood era; the existing artifact IS the evidence the act happened with
-- de-facto authorization. We seed ONLY the consent type matching what they
-- already have — voice_clone for the voice-cloned, likeness for the
-- face-uploaded. We do NOT fabricate `tos` or `content_license` (no artifact
-- backs them, and content_license is the most legally loaded). This keeps the
-- gate working for creator #1's re-clone without backdating a consent that has
-- zero evidence. WHERE NOT EXISTS + the partial unique index above make it
-- idempotent on replay (auditor C3). A creator with no prior clone/face gets
-- NO backfill and must go through real apply-flow or admin attestation.
INSERT INTO public.creator_consents (user_id, consent_type, version, source)
SELECT c.user_id, 'voice_clone', 'backfill-2026-05-21', 'pre_consent_backfill'
  FROM public.creators c
 WHERE c.voice_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.creator_consents cc
      WHERE cc.user_id = c.user_id AND cc.consent_type = 'voice_clone'
        AND cc.source = 'pre_consent_backfill');

INSERT INTO public.creator_consents (user_id, consent_type, version, source)
SELECT c.user_id, 'likeness', 'backfill-2026-05-21', 'pre_consent_backfill'
  FROM public.creators c
 WHERE c.simli_face_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.creator_consents cc
      WHERE cc.user_id = c.user_id AND cc.consent_type = 'likeness'
        AND cc.source = 'pre_consent_backfill');
