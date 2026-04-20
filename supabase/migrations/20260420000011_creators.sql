-- 0011 — creators
-- v1 creator_type CHECK-pinned to 'human'. Interactive-ads (brand /
-- sponsored_segment) values exist in the enum but fail the CHECK until v2.
-- Publication integrity: published_at only set when brain_status = 'ready'.
-- Handle sync mirrors profiles_handle_sync AND promotes an applicant's
-- profile-held handle to creator ownership atomically (R4-M3, Option B).

CREATE TABLE public.creators (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid          NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  application_id  uuid          UNIQUE
                                REFERENCES public.creator_applications(id)
                                DEFERRABLE INITIALLY DEFERRED,
  creator_type    creator_type  NOT NULL DEFAULT 'human'
                                CHECK (creator_type = 'human'),
  display_name    text          NOT NULL CHECK (char_length(display_name) <= 80),
  handle          citext        NOT NULL CHECK (
                                  char_length(handle) BETWEEN 3 AND 30
                                  AND handle ~ '^[a-z0-9_]+$'
                                ),
  bio             text          CHECK (bio IS NULL OR char_length(bio) <= 2000),
  avatar_url      text          CHECK (avatar_url IS NULL OR char_length(avatar_url) <= 500),
  brain_status    brain_status  NOT NULL DEFAULT 'pending',
  voice_id        text,
  simli_face_id   text,
  tavus_replica_id text,
  published_at    timestamptz,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  CHECK (published_at IS NULL OR brain_status = 'ready')
);

CREATE INDEX creators_brain_status_idx ON public.creators (brain_status);
CREATE INDEX creators_published_idx    ON public.creators (published_at) WHERE published_at IS NOT NULL;

CREATE TRIGGER creators_touch_updated_at
  BEFORE UPDATE ON public.creators
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Attach the block-delete trigger that 0010 defined but needed creators to exist.
CREATE TRIGGER creator_applications_block_delete_with_creator
  BEFORE DELETE ON public.creator_applications
  FOR EACH ROW EXECUTE FUNCTION public.creator_applications_block_delete_with_creator();

-- creators_handle_sync: reserved-guard + lower() + promotion + registry mirror

CREATE FUNCTION public.creators_handle_sync_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.handle := lower(NEW.handle);
  IF EXISTS (SELECT 1 FROM reserved_handles WHERE handle = NEW.handle) THEN
    RAISE EXCEPTION 'handle "%" is reserved', NEW.handle
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.creators_handle_sync_before() FROM public;

CREATE TRIGGER creators_handle_sync_before
  BEFORE INSERT OR UPDATE OF handle ON public.creators
  FOR EACH ROW EXECUTE FUNCTION public.creators_handle_sync_before();

CREATE FUNCTION public.creators_handle_sync_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_promoted boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- R4-M3: if applicant already holds this handle as a profile, promote it.
    UPDATE handles_registry
       SET owner_kind = 'creator', owner_id = NEW.id
     WHERE handle = NEW.handle
       AND owner_kind = 'profile'
       AND owner_id = NEW.user_id;
    GET DIAGNOSTICS v_promoted = ROW_COUNT;

    IF v_promoted = 0::boolean THEN
      -- Not a promotion; fresh insert. Will violate UNIQUE if another owner has it.
      INSERT INTO handles_registry (handle, owner_kind, owner_id)
      VALUES (NEW.handle, 'creator', NEW.id);
    END IF;

    -- Null the profile's now-vacated handle so the user can pick a new one.
    UPDATE profiles SET handle = NULL
     WHERE id = NEW.user_id AND handle = NEW.handle;

  ELSIF TG_OP = 'UPDATE' AND NEW.handle IS DISTINCT FROM OLD.handle THEN
    -- Rename: delete creator's old row, insert new. No promotion path on rename.
    DELETE FROM handles_registry
     WHERE owner_kind = 'creator' AND owner_id = NEW.id;
    INSERT INTO handles_registry (handle, owner_kind, owner_id)
    VALUES (NEW.handle, 'creator', NEW.id);
  END IF;
  RETURN NULL;
END;$$;

REVOKE EXECUTE ON FUNCTION public.creators_handle_sync_after() FROM public;

CREATE TRIGGER creators_handle_sync_after
  AFTER INSERT OR UPDATE OF handle ON public.creators
  FOR EACH ROW EXECUTE FUNCTION public.creators_handle_sync_after();

CREATE FUNCTION public.creators_handle_sync_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM handles_registry
   WHERE owner_kind = 'creator' AND owner_id = OLD.id;
  RETURN OLD;
END;$$;

REVOKE EXECUTE ON FUNCTION public.creators_handle_sync_delete() FROM public;

CREATE TRIGGER creators_handle_sync_delete
  BEFORE DELETE ON public.creators
  FOR EACH ROW EXECUTE FUNCTION public.creators_handle_sync_delete();

-- RLS ---------------------------------------------------------------------

ALTER TABLE public.creators ENABLE ROW LEVEL SECURITY;

-- Public read for published human creators.
CREATE POLICY "creators public read when published"
  ON public.creators FOR SELECT
  USING (published_at IS NOT NULL AND creator_type = 'human');

-- A creator may read their own row regardless of publication.
CREATE POLICY "creators own read"
  ON public.creators FOR SELECT
  USING (user_id = auth.uid());
