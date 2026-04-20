-- 0010 — creator_applications
-- Applicant submits one active application at a time (partial UNIQUE).
-- Freeze-after-submit trigger: once status != 'submitted', only admin fields
-- may mutate. Delete blocked while a creator row references this app.

CREATE TABLE public.creator_applications (
  id                 uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid                NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  invitation_id      uuid                REFERENCES public.creator_invitations(id) ON DELETE SET NULL,
  display_name       text                NOT NULL CHECK (char_length(display_name) <= 80),
  handle             citext              NOT NULL CHECK (
                                           char_length(handle) BETWEEN 3 AND 30
                                           AND handle ~ '^[a-z0-9_]+$'
                                         ),
  bio                text                CHECK (bio IS NULL OR char_length(bio) <= 2000),
  topics             jsonb               NOT NULL
                                         CHECK (octet_length(topics::text) <= 16384),
  proof              jsonb               NOT NULL
                                         CHECK (octet_length(proof::text) <= 32768),
  status             application_status  NOT NULL DEFAULT 'submitted',
  rejection_reason   text                CHECK (rejection_reason IS NULL OR char_length(rejection_reason) <= 500),
  submitted_at       timestamptz         NOT NULL DEFAULT now(),
  reviewed_at        timestamptz,
  reviewed_by        uuid                REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at         timestamptz         NOT NULL DEFAULT now(),
  updated_at         timestamptz         NOT NULL DEFAULT now()
);

-- One active application per user (submitted OR under_review).
CREATE UNIQUE INDEX creator_applications_one_active_per_user_idx
  ON public.creator_applications (user_id)
  WHERE status IN ('submitted', 'under_review');

CREATE INDEX creator_applications_status_idx
  ON public.creator_applications (status, submitted_at);

CREATE TRIGGER creator_applications_touch_updated_at
  BEFORE UPDATE ON public.creator_applications
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Freeze-after-submit: once past 'submitted', only admin fields mutate.

CREATE FUNCTION public.creator_applications_freeze_after_submit() RETURNS trigger
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

REVOKE EXECUTE ON FUNCTION public.creator_applications_freeze_after_submit() FROM public;

CREATE TRIGGER creator_applications_freeze_after_submit
  BEFORE UPDATE ON public.creator_applications
  FOR EACH ROW EXECUTE FUNCTION public.creator_applications_freeze_after_submit();

-- Block delete while a creator row still references this application.
-- The creators.application_id FK is DEFERRABLE INITIALLY DEFERRED so
-- intra-transaction promotion still works; this trigger catches cross-tx
-- deletion attempts.

CREATE FUNCTION public.creator_applications_block_delete_with_creator() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.creators WHERE application_id = OLD.id) THEN
    RAISE EXCEPTION 'cannot delete creator_application % — creator row references it', OLD.id
      USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;$$;

REVOKE EXECUTE ON FUNCTION public.creator_applications_block_delete_with_creator() FROM public;

-- Trigger created AFTER the creators table exists (see 0011).

ALTER TABLE public.creator_applications ENABLE ROW LEVEL SECURITY;

-- Applicant may read / insert own. UPDATE is admin (service-role) only.
CREATE POLICY "creator_applications own read"
  ON public.creator_applications FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "creator_applications own insert"
  ON public.creator_applications FOR INSERT
  WITH CHECK (user_id = auth.uid());
-- DELETE: superadmin only (via service-role). No public DELETE policy.
