-- 0025 — admin_roles: restructure to user_id PK (R1-C3, R2-C-α, R4-C2, R5-C3).
-- email FK'd on text is brittle (stale-email hijack, Unicode confusables).
-- assertAdminFromSession must lookup by auth.users.id, not email string.
--
-- Renumbered from 0026 per R5-C3: must run BEFORE the founder promotion RPC
-- (0026) references the new shape.
--
-- Step order is load-bearing:
--   1. ADD COLUMN user_id (nullable first, FK RESTRICT)
--   2. Backfill from auth.users via citext email match
--   3. DELETE orphan rows (the 0006 seed is orphan until Vuk signs in)
--      — temp-disable block-delete trigger for this one migration
--   4. SET NOT NULL
--   5. Swap PK from email → user_id
--   6. Re-enable block-delete trigger

ALTER TABLE public.admin_roles
  ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT;

UPDATE public.admin_roles ar
   SET user_id = u.id
  FROM auth.users u
 WHERE ar.email::citext = u.email::citext
   AND ar.user_id IS NULL;

ALTER TABLE public.admin_roles DISABLE TRIGGER admin_roles_block_delete;

DELETE FROM public.admin_roles WHERE user_id IS NULL;

ALTER TABLE public.admin_roles ENABLE TRIGGER admin_roles_block_delete;

ALTER TABLE public.admin_roles ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE public.admin_roles DROP CONSTRAINT admin_roles_pkey;
ALTER TABLE public.admin_roles ADD PRIMARY KEY (user_id);

-- email kept for display; now nullable + non-unique (sources of truth: auth.users).
ALTER TABLE public.admin_roles ALTER COLUMN email DROP NOT NULL;
