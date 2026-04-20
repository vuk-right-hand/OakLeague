-- 0026 — founder bootstrap (R3-M7, R4-C3, R5-C1, R5-C2, R5-C3).
-- Renumbered from 0024 per R5-C3 — runs AFTER admin_roles.user_id exists.
--
-- One-shot RPC that promotes the hardcoded founder email to superadmin after
-- their first Google OAuth login. Layered defense:
--   (a) hardcoded founder email inside body (not a parameter)
--   (b) provider = 'google' AND email_confirmed_at IS NOT NULL required
--   (c) one-shot latch in system_flags (race-safe via INSERT ... ON CONFLICT
--       DO NOTHING RETURNING — R5-C2)
--   (d) idempotent re-run for the legitimate founder (R5-C1): latch match →
--       'already_promoted'; admin_roles insert uses ON CONFLICT DO NOTHING
--
-- Emergency runbook (partial-failure recovery):
--   If the bootstrap endpoint returns 500 after a partial success (e.g.
--   network dropped between latch insert and admin_roles insert), re-POST
--   the bootstrap endpoint. Step 3 returns latch-exists-for-me, step 4
--   upserts, resolves to 'already_promoted'.
--   If the latch was written for a wrong user_id (should only happen under
--   operator error), service-role:
--     DELETE FROM system_flags WHERE key = 'founder_bootstrapped';
--   then re-run. Document in README alongside the curl.

CREATE TABLE public.system_flags (
  key     text        PRIMARY KEY,
  value   jsonb       NOT NULL,
  set_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.system_flags ENABLE ROW LEVEL SECURITY;
-- Service-role only. Zero policies.

REVOKE ALL ON public.system_flags FROM PUBLIC, authenticated, anon;

CREATE FUNCTION public.promote_founder_if_first() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_founder_email constant citext := 'vukpjescic@gmail.com'::citext;
  v_uid       uuid := auth.uid();
  v_email     citext;
  v_provider  text;
  v_confirmed timestamptz;
  v_latched   jsonb;
  v_existing  uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT u.email::citext,
         u.raw_app_meta_data->>'provider',
         u.email_confirmed_at
    INTO v_email, v_provider, v_confirmed
    FROM auth.users u
   WHERE u.id = v_uid;

  IF v_email IS NULL THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_email <> c_founder_email THEN
    RAISE EXCEPTION 'not_founder' USING ERRCODE = '42501';
  END IF;

  IF v_provider IS DISTINCT FROM 'google' THEN
    RAISE EXCEPTION 'provider_not_google' USING ERRCODE = '42501';
  END IF;

  IF v_confirmed IS NULL THEN
    RAISE EXCEPTION 'email_not_confirmed' USING ERRCODE = '42501';
  END IF;

  -- R5-C2: latch-first. INSERT ... ON CONFLICT DO NOTHING RETURNING either
  -- returns the new row (we got the latch) or NULL (latch already held).
  INSERT INTO public.system_flags (key, value)
  VALUES ('founder_bootstrapped', jsonb_build_object('user_id', v_uid))
  ON CONFLICT (key) DO NOTHING
  RETURNING value INTO v_latched;

  IF v_latched IS NULL THEN
    -- Latch exists. Is it for us? (R5-C1 idempotent re-run.)
    SELECT (value->>'user_id')::uuid INTO v_existing
      FROM public.system_flags WHERE key = 'founder_bootstrapped';
    IF v_existing IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'founder_already_set' USING ERRCODE = '42501';
    END IF;
    -- Fall through to upsert admin_roles defensively.
    INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_uid, v_email, 'superadmin')
    ON CONFLICT (user_id) DO NOTHING;
    RETURN 'already_promoted';
  END IF;

  -- We hold the latch. Insert admin_roles (idempotent — R5-C1).
  INSERT INTO public.admin_roles (user_id, email, role)
  VALUES (v_uid, v_email, 'superadmin')
  ON CONFLICT (user_id) DO NOTHING;

  RETURN 'promoted';
END;$$;

REVOKE EXECUTE ON FUNCTION public.promote_founder_if_first() FROM public;
GRANT  EXECUTE ON FUNCTION public.promote_founder_if_first() TO authenticated;
