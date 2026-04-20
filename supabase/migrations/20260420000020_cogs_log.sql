-- 0020 — cogs_log
-- Append-only. Every paid API call inserts exactly one row. UPDATE / DELETE
-- / TRUNCATE are blocked by raise_append_only(). Size caps on operation /
-- metadata prevent a buggy adapter from bloating the table (R4-S3).

CREATE TABLE public.cogs_log (
  id          bigserial     PRIMARY KEY,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  user_id     uuid          REFERENCES public.profiles(id) ON DELETE SET NULL,
  session_id  uuid          REFERENCES public.sessions(id) ON DELETE SET NULL,
  service     cogs_service  NOT NULL,
  operation   text          NOT NULL CHECK (length(operation) <= 64),
  units       numeric(12,4) NOT NULL CHECK (units >= 0),
  unit_label  text          NOT NULL CHECK (length(unit_label) <= 32),
  cost_usd    numeric(10,6) NOT NULL CHECK (cost_usd >= 0),
  metadata    jsonb         CHECK (metadata IS NULL OR octet_length(metadata::text) <= 4096)
);

CREATE INDEX cogs_log_created_at_idx ON public.cogs_log (created_at DESC);
CREATE INDEX cogs_log_session_idx    ON public.cogs_log (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX cogs_log_user_idx       ON public.cogs_log (user_id)    WHERE user_id    IS NOT NULL;

-- Append-only guard. DELETE / TRUNCATE are unconditional. UPDATE is blocked
-- for data-mutation but MUST allow the FK cascades that null out user_id /
-- session_id when an auth.users / sessions row is deleted (ON DELETE SET NULL) —
-- otherwise deleting a user would fail because the cascade tries to UPDATE
-- cogs_log.user_id → NULL and hits this trigger.

CREATE FUNCTION public.raise_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cogs_log is append-only' USING ERRCODE = '42501';
END;$$;

REVOKE EXECUTE ON FUNCTION public.raise_append_only() FROM public;

CREATE FUNCTION public.cogs_log_block_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Permit FK-cascade SET NULL: every business column unchanged, and only
  -- user_id / session_id transitioned to NULL.
  IF NEW.id          = OLD.id
 AND NEW.created_at  = OLD.created_at
 AND NEW.service     = OLD.service
 AND NEW.operation   = OLD.operation
 AND NEW.units       = OLD.units
 AND NEW.unit_label  = OLD.unit_label
 AND NEW.cost_usd    = OLD.cost_usd
 AND NEW.metadata    IS NOT DISTINCT FROM OLD.metadata
 AND (NEW.user_id    IS NOT DISTINCT FROM OLD.user_id    OR NEW.user_id    IS NULL)
 AND (NEW.session_id IS NOT DISTINCT FROM OLD.session_id OR NEW.session_id IS NULL)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'cogs_log is append-only' USING ERRCODE = '42501';
END;$$;

REVOKE EXECUTE ON FUNCTION public.cogs_log_block_update() FROM public;

CREATE TRIGGER cogs_log_no_update
  BEFORE UPDATE ON public.cogs_log
  FOR EACH ROW EXECUTE FUNCTION public.cogs_log_block_update();

CREATE TRIGGER cogs_log_no_delete
  BEFORE DELETE ON public.cogs_log
  FOR EACH ROW EXECUTE FUNCTION public.raise_append_only();

CREATE TRIGGER cogs_log_no_truncate
  BEFORE TRUNCATE ON public.cogs_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.raise_append_only();

ALTER TABLE public.cogs_log ENABLE ROW LEVEL SECURITY;
-- Service-role only. Zero policies.
