-- 0029 — auth_pending_verifications metadata + partial unique (R3-C3, R3-C4,
-- R4-M1, R5-M1).
-- invitation_id lives in metadata.jsonb (not a column) because the claim flow
-- is the only purpose that cares. CHECK forbids NULL invitation_id for that
-- purpose (R4-M1 — otherwise partial-unique treats every NULL as distinct).
-- Partial UNIQUE on (email, purpose, invitation_id) WHERE unconsumed allows
-- idempotent re-visits to /claim to return the same nonce.
--
-- R5-M1: `ON CONFLICT ON CONSTRAINT <index>` does NOT work for partial unique
-- indexes (they have no pg_constraint entry — only pg_class). Callers use the
-- inference form `ON CONFLICT (cols) WHERE <predicate>` instead. Index name
-- is human-readable, not structurally referenced.

ALTER TABLE public.auth_pending_verifications
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.auth_pending_verifications
  ADD CONSTRAINT auth_pending_verifications_invite_claim_metadata_chk
  CHECK (purpose <> 'creator_invite_claim' OR metadata ? 'invitation_id');

CREATE UNIQUE INDEX auth_pending_verifications_invite_claim_uidx
  ON public.auth_pending_verifications
      (email, purpose, (metadata->>'invitation_id'))
  WHERE purpose = 'creator_invite_claim' AND consumed_at IS NULL;
