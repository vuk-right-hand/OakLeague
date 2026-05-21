-- 20260523000009 — profiles ToS/Privacy acceptance columns.
--
-- FIVE_CREATOR_ONBOARDING_READINESS P0-4. Records audience acceptance of the
-- Terms of Service + Privacy Policy. Creators accept explicit voice/likeness +
-- ToS consent via the apply checkboxes (P0-3 creator_consents); the audience
-- accepts ToS implicitly by signing in ("by continuing you agree to ...", shown
-- on the login page), recorded here on the auth/callback path.
--
-- Version-pinned + write-once-per-version (auditor M4 on the original plan):
-- auth/callback writes only WHEN tos_accepted_at IS NULL OR tos_version is
-- behind the current version, so a re-login never overwrites the ORIGINAL
-- acceptance timestamp (which is the legal record of when they first agreed).

ALTER TABLE public.profiles
  ADD COLUMN tos_accepted_at timestamptz,
  ADD COLUMN tos_version     text CHECK (tos_version IS NULL OR char_length(tos_version) BETWEEN 1 AND 40);

COMMENT ON COLUMN public.profiles.tos_accepted_at IS
  'When this user first accepted the current ToS/Privacy version (P0-4). Set once per version on the auth/callback path; never overwritten on re-login for the same version.';
COMMENT ON COLUMN public.profiles.tos_version IS
  'The ToS/Privacy version accepted (matches CONSENT_VERSIONS.tos in src/lib/consent.ts).';
