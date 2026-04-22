-- 0053 — sessions.cost_usd_cap + resume_prior_cost_usd + tier trigger extension
--
-- Days 8–12 plan REV 5, migration 9 of 11.
-- Per-session USD hard kill-switch for Pro pipeline (N2-M6), reshaped by
-- N3-M1: the AFTER INSERT trigger on cogs_log is DROPPED. The proxy is the
-- single source of truth for running cost accounting; writes
-- `sessions.total_cost_usd` on every turn_end (not every 5) and closes
-- WS with 4003 `reason='usd_cap_hit'` in the same turn that trips the cap.
--
-- Cap sentinel is NULL (N3-M6), not 0. NULL means "no cap, seconds-latch
-- holds the floor". Proxy logic:
--   if (cap !== null && costAccum >= cap) fireCostKill();
-- Resumed sessions reuse the sessions row → cap is lifetime-of-session
-- (N3-M8), resume_prior_cost_usd snapshots the accumulator at resume time
-- for analytics. No reset.
--
-- Drift alarm: proxy cross-checks in-memory accumulator vs
-- SUM(cogs_log.cost_usd) every 20 turns (N3-M1). Delta > $0.05 → Sentry
-- warning, no enforcement.

-- 1. Columns -------------------------------------------------------------------
-- total_cost_usd already exists on sessions (migration 0017 column 18).
-- Add only the cap + resume-snapshot.

ALTER TABLE public.sessions
  ADD COLUMN cost_usd_cap          numeric(10, 4) CHECK (cost_usd_cap IS NULL OR cost_usd_cap > 0),
  ADD COLUMN resume_prior_cost_usd numeric(10, 4) CHECK (resume_prior_cost_usd IS NULL OR resume_prior_cost_usd >= 0);

-- 2. Trigger: set cap per tier at session insert -------------------------------
-- Extends `sessions_enforce_tier_and_kill_switch` (migration 0017). The
-- existing body snapshotted tier + upserted today's quota row; we append
-- the cost-cap assignment. SECURITY DEFINER preserved.

CREATE OR REPLACE FUNCTION public.sessions_enforce_tier_and_kill_switch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tier       profile_tier;
  v_tz         text;
  v_limit_s    int;
  v_local_date date;
  v_latched    boolean;
BEGIN
  SELECT tier, timezone INTO v_tier, v_tz
    FROM public.profiles WHERE id = NEW.user_id;
  IF v_tier IS NULL THEN
    RAISE EXCEPTION 'sessions.user_id % has no profile', NEW.user_id USING ERRCODE = '23503';
  END IF;

  -- Snapshot tier onto the session row.
  NEW.tier_at_session := v_tier;

  -- Per-tier cost cap (REV 5 N3-M1 + N3-M6). NULL sentinel = no cap; free
  -- tier relies on the seconds-based latch, which stays as-is.
  NEW.cost_usd_cap := CASE v_tier
    WHEN 'free'      THEN NULL
    WHEN 'premium'   THEN 3.0000
    WHEN 'boardroom' THEN 10.0000
  END;

  -- Tier → daily limit in seconds. Free = 10min, premium = 60min, boardroom = 240min.
  v_limit_s := CASE v_tier
    WHEN 'free'      THEN 600
    WHEN 'premium'   THEN 3600
    WHEN 'boardroom' THEN 14400
  END;

  v_local_date := (now() AT TIME ZONE v_tz)::date;

  -- Fast pre-check: already latched?
  SELECT kill_switch_fired_at IS NOT NULL INTO v_latched
    FROM public.daily_quotas
   WHERE user_id = NEW.user_id AND quota_date = v_local_date;
  IF v_latched THEN
    RAISE EXCEPTION 'kill_switch_fired'
      USING HINT    = 'daily quota latched; admin must clear to unlock',
            ERRCODE = 'P0001';
  END IF;

  -- Upsert today's quota row. ON CONFLICT skips latched rows.
  INSERT INTO public.daily_quotas (user_id, quota_date, tier_snapshot, daily_limit_s)
  VALUES (NEW.user_id, v_local_date, v_tier, v_limit_s)
  ON CONFLICT (user_id, quota_date)
  DO UPDATE SET
    daily_limit_s = EXCLUDED.daily_limit_s,
    tier_snapshot = EXCLUDED.tier_snapshot
  WHERE public.daily_quotas.kill_switch_fired_at IS NULL;

  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.sessions_enforce_tier_and_kill_switch() FROM public;

-- Trigger itself was created in 0017; CREATE OR REPLACE FUNCTION rebinds
-- it automatically without touching the trigger definition.
