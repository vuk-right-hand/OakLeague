-- 0027 — profiles.email mirror (R2-M7, R3-C2, R3-C-γ, R4-M5).
-- We can't own a trigger on auth.users in hosted Supabase (managed schema),
-- so the mirror is maintained at the application boundary + handle_new_user
-- seed on first signup. Backfill once here for any rows that already exist.
--
-- R4-M5: no eager mirror on email-change. `supabase.auth.updateUser({email})`
-- only *requests* the change; auth.users.email doesn't flip until the user
-- clicks the confirmation link. v1 has no email-change UI anyway — defer the
-- confirm-time mirror to v2 when that flow exists.

ALTER TABLE public.profiles
  ADD COLUMN email citext;

-- Backfill from auth.users for any pre-existing profiles.
UPDATE public.profiles p
   SET email = u.email::citext
  FROM auth.users u
 WHERE p.id = u.id
   AND p.email IS NULL;

-- Amend handle_new_user to copy email on signup.
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email::citext)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM public;
