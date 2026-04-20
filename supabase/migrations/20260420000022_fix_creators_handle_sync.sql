-- 0022 — fix creators_handle_sync_after: ROW_COUNT is int, not boolean
-- Source bug in 20260420000011_creators.sql:67,76 — `v_promoted boolean := false`
-- received an int from GET DIAGNOSTICS ROW_COUNT, then compared via
-- `v_promoted = 0::boolean`. CREATE OR REPLACE with correct types.
-- Audit ref: R3-C1.

CREATE OR REPLACE FUNCTION public.creators_handle_sync_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_promoted int := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE handles_registry
       SET owner_kind = 'creator', owner_id = NEW.id
     WHERE handle = NEW.handle
       AND owner_kind = 'profile'
       AND owner_id = NEW.user_id;
    GET DIAGNOSTICS v_promoted = ROW_COUNT;

    IF v_promoted = 0 THEN
      INSERT INTO handles_registry (handle, owner_kind, owner_id)
      VALUES (NEW.handle, 'creator', NEW.id);
    END IF;

    UPDATE profiles SET handle = NULL
     WHERE id = NEW.user_id AND handle = NEW.handle;

  ELSIF TG_OP = 'UPDATE' AND NEW.handle IS DISTINCT FROM OLD.handle THEN
    DELETE FROM handles_registry
     WHERE owner_kind = 'creator' AND owner_id = NEW.id;
    INSERT INTO handles_registry (handle, owner_kind, owner_id)
    VALUES (NEW.handle, 'creator', NEW.id);
  END IF;
  RETURN NULL;
END;$$;

REVOKE EXECUTE ON FUNCTION public.creators_handle_sync_after() FROM public;
