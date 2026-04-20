-- 0008 — auth_pending_verifications
-- Email-signup ghost-user recovery. Magic link flow only; never overwrite
-- password blind (walkthrough Part 6). Service-role only.

CREATE TABLE public.auth_pending_verifications (
  id                 uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext                NOT NULL,
  purpose            verification_purpose  NOT NULL,
  verification_token text                  NOT NULL UNIQUE,
  expires_at         timestamptz           NOT NULL,
  consumed_at        timestamptz,
  created_at         timestamptz           NOT NULL DEFAULT now()
);

CREATE INDEX auth_pending_verifications_email_idx
  ON public.auth_pending_verifications (email);

ALTER TABLE public.auth_pending_verifications ENABLE ROW LEVEL SECURITY;
-- Service-role only. Zero policies.
