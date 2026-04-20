-- 0019 — daily_quotas
-- quota_date is the USER-LOCAL calendar date, computed as
-- (ts AT TIME ZONE profiles.timezone)::date. Never UTC, never server-local.
-- Every trigger and query keyed on quota_date must use the same formula
-- (R6-C3).
--
-- kill_switch_fired_at is written exclusively by daily_quotas_latch_kill_switch
-- (BEFORE INSERT OR UPDATE, R4-S1 + R5-S1). Once set, the latch survives tier
-- upgrades (R5-S2) — admin must UPDATE … SET kill_switch_fired_at = NULL to clear.

CREATE TABLE public.daily_quotas (
  user_id               uuid          NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  quota_date            date          NOT NULL,
  tier_snapshot         profile_tier  NOT NULL,
  daily_limit_s         int           NOT NULL CHECK (daily_limit_s > 0),
  seconds_used          int           NOT NULL DEFAULT 0 CHECK (seconds_used >= 0),
  kill_switch_fired_at  timestamptz,
  streak_days           int           NOT NULL DEFAULT 0 CHECK (streak_days >= 0),
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, quota_date)
);

CREATE INDEX daily_quotas_date_idx ON public.daily_quotas (quota_date);

CREATE TRIGGER daily_quotas_touch_updated_at
  BEFORE UPDATE ON public.daily_quotas
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Kill-switch latch writer (single writer of kill_switch_fired_at).
-- BEFORE INSERT OR UPDATE covers backfills, manual inserts, and future
-- migrations that may seed quotas pre-populated. TG_OP guard short-circuits
-- before dereferencing OLD on INSERT.

CREATE FUNCTION public.daily_quotas_latch_kill_switch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR OLD.kill_switch_fired_at IS NULL)
     AND NEW.seconds_used >= (NEW.daily_limit_s * 3) / 2 THEN
    NEW.kill_switch_fired_at := now();
  END IF;
  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.daily_quotas_latch_kill_switch() FROM public;

CREATE TRIGGER daily_quotas_latch_kill_switch
  BEFORE INSERT OR UPDATE ON public.daily_quotas
  FOR EACH ROW EXECUTE FUNCTION public.daily_quotas_latch_kill_switch();

-- RLS ---------------------------------------------------------------------

ALTER TABLE public.daily_quotas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "daily_quotas own read"
  ON public.daily_quotas FOR SELECT
  USING (user_id = auth.uid());
-- Writes via service-role (voice service's usage accumulator).
