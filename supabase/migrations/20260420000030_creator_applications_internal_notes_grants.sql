-- 0030 — internal_notes + column-level grants (R2-Small, R3-M4, R3-M-α,
-- R4-C1).
-- internal_notes is admin-only. We avoided a security_invoker view (R4-C1:
-- invoker privileges propagate through the view and fight with REVOKE on the
-- base table — "permission denied" even when RLS would allow). Column-level
-- GRANTs are the right tool: row filtering via RLS, column filtering via
-- grants.

ALTER TABLE public.creator_applications
  ADD COLUMN internal_notes text
  CHECK (internal_notes IS NULL OR char_length(internal_notes) <= 4000);

-- Also allow freeze-after-submit trigger to tolerate internal_notes mutation
-- post-submission (admins must be able to annotate reviewed apps). Patch it.
CREATE OR REPLACE FUNCTION public.creator_applications_freeze_after_submit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'submitted' THEN
    RETURN NEW;
  END IF;
  IF  NEW.display_name  IS DISTINCT FROM OLD.display_name
   OR NEW.handle        IS DISTINCT FROM OLD.handle
   OR NEW.bio           IS DISTINCT FROM OLD.bio
   OR NEW.topics        IS DISTINCT FROM OLD.topics
   OR NEW.proof         IS DISTINCT FROM OLD.proof
   OR NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
  THEN
    RAISE EXCEPTION 'creator_application fields are frozen after submission; status=%', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;$$;

-- Column-level grants: authenticated sees everything except internal_notes.
-- (Applicant's own row via RLS; admins use service-role which bypasses.)
REVOKE SELECT ON public.creator_applications FROM authenticated;
GRANT  SELECT (
  id, user_id, invitation_id, display_name, handle, bio, topics, proof,
  status, rejection_reason, submitted_at, reviewed_at, reviewed_by,
  created_at, updated_at
) ON public.creator_applications TO authenticated;
