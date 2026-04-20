-- 0005 — profiles
-- Extends auth.users. Handle uniqueness lives in handles_registry (not here).
-- Timezone column (R6-C1) anchors all quota_date math.

CREATE TABLE public.profiles (
  id            uuid         PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  text         CHECK (display_name IS NULL OR char_length(display_name) <= 80),
  handle        citext       CHECK (
                              handle IS NULL
                              OR (char_length(handle) BETWEEN 3 AND 30
                                  AND handle ~ '^[a-z0-9_]+$')
                            ),
  avatar_url    text         CHECK (avatar_url IS NULL OR char_length(avatar_url) <= 500),
  tier          profile_tier NOT NULL DEFAULT 'free',
  timezone      text         NOT NULL DEFAULT 'UTC'
                            CHECK (public._is_valid_timezone(timezone)),
  goals         text[]       CHECK (public._all_text_array_elems_within(goals, 200)),
  obstacles     text[]       CHECK (public._all_text_array_elems_within(obstacles, 200)),
  onboarded_at  timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE TRIGGER profiles_touch_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- handle_new_user: on auth.users insert create a profiles row -------------

CREATE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public.profiles (id) VALUES (NEW.id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM public;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- profiles_handle_sync: reserved-name guard + lower() + registry mirror ---

CREATE FUNCTION public.profiles_handle_sync_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.handle IS NOT NULL THEN
    NEW.handle := lower(NEW.handle);
    IF EXISTS (SELECT 1 FROM reserved_handles WHERE handle = NEW.handle) THEN
      RAISE EXCEPTION 'handle "%" is reserved', NEW.handle
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.profiles_handle_sync_before() FROM public;

CREATE TRIGGER profiles_handle_sync_before
  BEFORE INSERT OR UPDATE OF handle ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_handle_sync_before();

CREATE FUNCTION public.profiles_handle_sync_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.handle IS NOT NULL THEN
      INSERT INTO handles_registry (handle, owner_kind, owner_id)
      VALUES (NEW.handle, 'profile', NEW.id);
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.handle IS DISTINCT FROM OLD.handle THEN
      DELETE FROM handles_registry
       WHERE owner_kind = 'profile' AND owner_id = NEW.id;
      IF NEW.handle IS NOT NULL THEN
        INSERT INTO handles_registry (handle, owner_kind, owner_id)
        VALUES (NEW.handle, 'profile', NEW.id);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;$$;

REVOKE EXECUTE ON FUNCTION public.profiles_handle_sync_after() FROM public;

CREATE TRIGGER profiles_handle_sync_after
  AFTER INSERT OR UPDATE OF handle ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_handle_sync_after();

CREATE FUNCTION public.profiles_handle_sync_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM handles_registry
   WHERE owner_kind = 'profile' AND owner_id = OLD.id;
  RETURN OLD;
END;$$;

REVOKE EXECUTE ON FUNCTION public.profiles_handle_sync_delete() FROM public;

CREATE TRIGGER profiles_handle_sync_delete
  BEFORE DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_handle_sync_delete();

-- RLS ---------------------------------------------------------------------

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles own read"
  ON public.profiles FOR SELECT
  USING (id = auth.uid());

CREATE POLICY "profiles own update"
  ON public.profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());
-- No INSERT/DELETE policies: handle_new_user + auth.users cascade own those.
