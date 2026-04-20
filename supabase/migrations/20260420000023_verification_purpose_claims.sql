-- 0023 — add verification_purpose enum values for claim flows.
-- Single-statement file (no other DDL): newly added enum values aren't
-- usable in the same transaction that adds them, so we isolate them here.
-- Audit refs: R2-C1, R3-M6.

ALTER TYPE verification_purpose ADD VALUE IF NOT EXISTS 'email_signup_claim';
ALTER TYPE verification_purpose ADD VALUE IF NOT EXISTS 'creator_invite_claim';
