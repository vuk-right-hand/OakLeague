-- 20260510000002 — env-configurable kill-switch threshold
--
-- Phase C B4.2: the 150% kill-switch threshold has been hardcoded as
-- `(daily_limit_s * 3) / 2` in `daily_quotas_latch_kill_switch` since
-- migration 20260420000019. Bumping it requires a migration + redeploy.
-- Production needs a faster lever — e.g., during a YC traffic spike where
-- a 200% buffer is preferable to mass-latching legitimate users, or
-- post-incident triage where 120% is preferable to keep cap-burn off.
--
-- Override at the database level:
--   ALTER DATABASE postgres SET app.kill_switch_pct = '200';
-- Or per-session for testing:
--   SET LOCAL app.kill_switch_pct = '120';
-- Default = 150 (matches prior behavior; no change for existing users).
--
-- Tighter (120%) = blocks runaway billing earlier; admin clears latches
-- more often. Looser (200%) = more grace for borderline cases; cost cap
-- moves toward 2× quota.
--
-- Defensive bounds: setting outside [100%, 1000%] falls back to 150
-- rather than disabling the latch entirely (a typo'd '15' or empty
-- string shouldn't accidentally grant unlimited turns).
--
-- Preserves the seconds_used > OLD.seconds_used predicate from migration
-- 20260510000001 (audit C1 — prevents retro-latch on downward cap mirror).

CREATE OR REPLACE FUNCTION public.daily_quotas_latch_kill_switch() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_pct int;
BEGIN
  v_pct := COALESCE(NULLIF(current_setting('app.kill_switch_pct', true), '')::int, 150);
  IF v_pct < 100 OR v_pct > 1000 THEN
    -- Defensive — settings outside [100%, 1000%] are misconfigurations.
    -- Fall back to 150 (the historical default) rather than disabling
    -- the latch entirely.
    v_pct := 150;
  END IF;

  IF (TG_OP = 'INSERT' OR OLD.kill_switch_fired_at IS NULL)
     AND NEW.seconds_used >= (NEW.daily_limit_s * v_pct) / 100
     AND (TG_OP = 'INSERT' OR NEW.seconds_used > OLD.seconds_used) THEN
    NEW.kill_switch_fired_at := now();
  END IF;
  RETURN NEW;
END;$$;
