-- 0009 — creator_invitations
-- Invite-only onboarding. Token stored as HMAC-SHA256 hash (never plaintext).
-- Server computes hash on redemption and does atomic UPDATE with
-- used_at IS NULL AND expires_at > now() guard (see plan §Token strategy).
-- Rotation window supports two concurrent HMAC secrets
-- (INVITE_TOKEN_HMAC_SECRET_CURRENT + _NEXT) for >= max invitation lifetime.

CREATE TABLE public.creator_invitations (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  email            citext       NOT NULL,
  token_hash       text         NOT NULL UNIQUE,
  invited_by       uuid         REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes            text         CHECK (notes IS NULL OR char_length(notes) <= 500),
  expires_at       timestamptz  NOT NULL,
  used_at          timestamptz,
  used_by_user_id  uuid         REFERENCES auth.users(id)       ON DELETE SET NULL,
  created_at       timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX creator_invitations_email_idx
  ON public.creator_invitations (email)
  WHERE used_at IS NULL;

CREATE INDEX creator_invitations_expires_at_idx
  ON public.creator_invitations (expires_at)
  WHERE used_at IS NULL;

ALTER TABLE public.creator_invitations ENABLE ROW LEVEL SECURITY;
-- Service-role only. Zero policies.
