-- 0006 — admin_roles
-- Service-role only. Physical DELETE blocked at grant level AND via
-- BEFORE DELETE trigger (defense-in-depth — R4-S2). Demotions use
-- UPDATE admin_roles SET revoked_at = now(). assertAdminFromSession()
-- must require revoked_at IS NULL.

CREATE TABLE public.admin_roles (
  email       citext            PRIMARY KEY,
  role        admin_role_name   NOT NULL DEFAULT 'superadmin',
  revoked_at  timestamptz,
  created_at  timestamptz       NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_roles ENABLE ROW LEVEL SECURITY;
-- Service-role only. Zero policies.

-- Seed: founder superadmin.
INSERT INTO public.admin_roles (email, role) VALUES ('vukpjescic@gmail.com', 'superadmin');

-- Block DELETE: soft-delete via revoked_at only. Raises regardless of role.

CREATE FUNCTION public.admin_roles_block_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin_roles rows cannot be deleted; set revoked_at instead'
    USING ERRCODE = '42501';
END;$$;

REVOKE EXECUTE ON FUNCTION public.admin_roles_block_delete() FROM public;

CREATE TRIGGER admin_roles_block_delete
  BEFORE DELETE ON public.admin_roles
  FOR EACH ROW EXECUTE FUNCTION public.admin_roles_block_delete();
