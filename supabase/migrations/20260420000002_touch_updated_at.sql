-- 0002 — touch_updated_at trigger fn
-- Attached per-table throughout later migrations.

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.touch_updated_at() FROM public;
