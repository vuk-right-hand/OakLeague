-- 0004 — handles_registry
-- Polymorphic uniqueness table. Registry rows are mutated only through
-- profiles_handle_sync / creators_handle_sync SECURITY DEFINER triggers
-- (owner = postgres). Grants migration revokes direct write paths from
-- every other role — see 0021_grants.sql (R5-S3).

CREATE TABLE public.handles_registry (
  handle      citext             PRIMARY KEY,
  owner_kind  handle_owner_kind  NOT NULL,
  owner_id    uuid               NOT NULL,
  created_at  timestamptz        NOT NULL DEFAULT now(),
  UNIQUE (owner_kind, owner_id)
);

CREATE INDEX handles_registry_owner_idx
  ON public.handles_registry (owner_kind, owner_id);

ALTER TABLE public.handles_registry ENABLE ROW LEVEL SECURITY;
-- Service-role only. Zero policies.
