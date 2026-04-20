-- 0033 — tighten creator_applications.invitation_id FK to RESTRICT (R3-Small).
-- ON DELETE SET NULL lost the audit trail (who invited this applicant) when
-- an admin deleted the invite. RESTRICT keeps the reference intact — admins
-- revoke an invite by updating its used_at / revoked_at instead.

ALTER TABLE public.creator_applications
  DROP CONSTRAINT creator_applications_invitation_id_fkey;

ALTER TABLE public.creator_applications
  ADD CONSTRAINT creator_applications_invitation_id_fkey
  FOREIGN KEY (invitation_id) REFERENCES public.creator_invitations(id)
  ON DELETE RESTRICT;
