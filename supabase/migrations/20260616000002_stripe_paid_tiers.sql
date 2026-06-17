-- 20260616000002 — Growth & Minutes Economy, Phase 6: self-serve paid tiers
--
-- Plan: docs/_planning/GROWTH_MINUTES_ECONOMY_PLAN.md §8 (LOCKED 2026-06-16).
--
-- Two self-serve subs reusing the EXISTING profile_tier enum (no supporter flag,
-- no new enum value): Evangelist=`premium` $3.36/mo·110min, Boardroom=`boardroom`
-- $27/mo·800min. A paid sub flips `tier` via the Stripe webhook (service-role),
-- and the tier's MONTHLY avatar-talk allowance is the entitlement; lapse → free.
--
-- SCOPE NOTE: this migration changes ONLY the paid tiers. The plan's free-tier
-- monthly model (§12.5: 5min/day + 40min/MONTH, weekly removed) is a DELIBERATE
-- FOLLOW-UP — it touches every free user (column defaults + a mass backfill), so
-- it ships on its own with explicit sign-off, not bundled here. Free is untouched.
--
-- Pieces:
--   1. stripe_events     — webhook dedup + audit (PK on event_id)
--   2. stripe_customers  — per-user subscription state (billing period drives the
--                          paid monthly-allowance boundary)
--   3. tier_default_voice_caps  — premium/boardroom gain a binding MONTHLY cap
--                          (uncapped days); free unchanged
--   4. profiles backfill — apply the new PAID tier defaults to un-customized rows
--   5. set_profile_tier_from_subscription — the webhook's tier flip (service-role,
--                          does NOT block on an active session, unlike the admin RPC)
--   6. monthly_window_start  — CREATE OR REPLACE → billing-period for entitled subs
--   7. voice_usage_ticket_check — left UNCHANGED (audit C2; see §7 note in body)
--   8. stripe_subscription_reconcile (lapse + re-assert) / stripe_events_purge — cron
--
-- NOTE on env-tunable caps (plan §10): SQL can't read process.env, so the cap
-- VALUES live in tier_default_voice_caps (the single source of truth — tuning is a
-- one-line migration, matching the existing design). The TIER_*_SECONDS env vars
-- are NOT wired into the SQL path (would require a config table; out of scope).

BEGIN;

-- ── 1. stripe_events — webhook idempotency + audit ─────────────────────────
-- PK on the Stripe event_id ('evt_…') makes the webhook exactly-once: a retry
-- (Stripe backs off up to ~72h) hits the PK and is a no-op. Retain ≥3 days;
-- the GC fn (§8) prunes >30 days.
CREATE TABLE public.stripe_events (
  event_id     text        PRIMARY KEY,
  type         text        NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  payload      jsonb       CHECK (payload IS NULL OR octet_length(payload::text) <= 16384)
);
CREATE INDEX stripe_events_received_idx ON public.stripe_events (received_at);

ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;
-- Service-role only. Zero policies.
GRANT ALL ON TABLE public.stripe_events TO service_role;

COMMENT ON TABLE public.stripe_events IS
  'Stripe webhook DEDUP LEDGER (PK event_id ⇒ exactly-once across retries). Stores the type + a '
  'minimal {object_id} pointer, NOT the full event — full forensics live in the Stripe dashboard. Service-role only.';

-- ── 2. stripe_customers — per-user subscription state ──────────────────────
CREATE TABLE public.stripe_customers (
  user_id              uuid        PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  stripe_customer_id   text        UNIQUE NOT NULL,
  subscription_id      text,
  price_id             text,
  tier                 profile_tier,
  status               text,
  current_period_start timestamptz,
  current_period_end   timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stripe_customers_sub_idx ON public.stripe_customers (subscription_id)
  WHERE subscription_id IS NOT NULL;
CREATE INDEX stripe_customers_lapse_idx ON public.stripe_customers (current_period_end)
  WHERE current_period_end IS NOT NULL;

ALTER TABLE public.stripe_customers ENABLE ROW LEVEL SECURITY;
-- Service-role only. Zero policies. (The client never reads this directly; the
-- balance/meter path reads it server-side via the secdef readers.)
GRANT ALL ON TABLE public.stripe_customers TO service_role;

COMMENT ON TABLE public.stripe_customers IS
  'Per-user Stripe subscription state. price_id+tier map each SKU to its tier; '
  'current_period_start drives the paid monthly-allowance boundary (monthly_window_start). Service-role only.';

-- ── 3. tier_default_voice_caps — paid tiers gain a binding MONTHLY cap ─────
-- premium/boardroom: daily = monthly (uncapped days), weekly NULL, monthly binds.
-- free: UNCHANGED (300/900/NULL) — the free monthly model is a separate follow-up.
CREATE OR REPLACE FUNCTION public.tier_default_voice_caps(p_tier profile_tier)
RETURNS TABLE (daily int, weekly int, monthly int)
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
BEGIN
  IF p_tier = 'free' THEN
    RETURN QUERY SELECT 300, 900, NULL::int;           -- unchanged (5min/day + 15min/week)
  ELSIF p_tier = 'premium' THEN
    RETURN QUERY SELECT 6600, NULL::int, 6600;         -- Evangelist: 110min/mo, uncapped days
  ELSIF p_tier = 'boardroom' THEN
    RETURN QUERY SELECT 48000, NULL::int, 48000;       -- Boardroom: 800min/mo, uncapped days
  ELSE
    RAISE EXCEPTION 'tier_default_voice_caps: unhandled profile_tier value % — update this function before adding new enum variants', p_tier
      USING ERRCODE = '22023';
  END IF;
END;$$;

COMMENT ON FUNCTION public.tier_default_voice_caps(profile_tier) IS
  'Tier → (daily, weekly, monthly) cap defaults (avatar-talk seconds). Phase 6: paid tiers gain a '
  'binding monthly cap — premium 6600/NULL/6600, boardroom 48000/NULL/48000; free unchanged 300/900/NULL. '
  'Single source of truth. NULL = no cap. RAISES on unknown enum variant.';

-- ── 4. Backfill un-customized PAID profiles to the new tier defaults ───────
-- Conservative: only touch rows still at the OLD tier defaults (preserves any
-- admin-customized caps). Mirrors the 20260510000001 gated-backfill discipline.
-- Free is intentionally NOT backfilled (unchanged this migration).
-- PREMIUM: old default daily=3600 → 6600 daily + 6600 monthly (weekly already NULL).
UPDATE public.profiles
   SET voice_daily_cap_seconds   = 6600,
       voice_monthly_cap_seconds = 6600
 WHERE tier = 'premium'
   AND voice_daily_cap_seconds = 3600
   AND voice_monthly_cap_seconds IS NULL;
-- BOARDROOM: old default daily=14400 → 48000 daily + 48000 monthly.
UPDATE public.profiles
   SET voice_daily_cap_seconds   = 48000,
       voice_monthly_cap_seconds = 48000
 WHERE tier = 'boardroom'
   AND voice_daily_cap_seconds = 14400
   AND voice_monthly_cap_seconds IS NULL;

-- C4: re-mirror today's daily_quotas.daily_limit_s for already-paid users so the
-- 150% COGS fuse is not anchored to the stale (pre-Phase-6) cap — a live boardroom
-- session spanning the deploy would otherwise hard-kill at 14400×1.5 mid-call. Skip
-- latched rows (admin clears those); the latch trigger won't retro-fire because
-- seconds_used is unchanged (it only latches on usage GROWTH, 20260510000001 §3).
UPDATE public.daily_quotas dq
   SET daily_limit_s = p.voice_daily_cap_seconds
  FROM public.profiles p
 WHERE dq.user_id = p.id
   AND p.tier IN ('premium', 'boardroom')
   AND dq.daily_limit_s <> p.voice_daily_cap_seconds
   AND dq.kill_switch_fired_at IS NULL;

-- ── 5. set_profile_tier_from_subscription — the webhook's tier flip ────────
-- Service-role only (no admin auth — the webhook is the caller). Writes tier +
-- tier-default caps. CRITICALLY does NOT block on an active session (tier is
-- snapshotted at session-open, so a live session keeps its tier and the new cap
-- applies on the next open) — unlike admin_set_profile_tier, which blocks. A
-- subscription event must never fail because the user happens to be mid-call.
CREATE FUNCTION public.set_profile_tier_from_subscription(
  p_user_id  uuid,
  p_new_tier profile_tier
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
  v_old_tier profile_tier;
  v_tz       text;
  v_qdate    date;
  v_caps     record;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'set_profile_tier_from_subscription is service-role only' USING ERRCODE = '42501';
  END IF;

  SELECT tier, COALESCE(timezone, 'UTC') INTO v_old_tier, v_tz
    FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF v_old_tier IS NULL THEN
    RAISE EXCEPTION 'profile not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT daily, weekly, monthly INTO v_caps FROM public.tier_default_voice_caps(p_new_tier);

  UPDATE public.profiles
     SET tier                      = p_new_tier,
         voice_daily_cap_seconds   = v_caps.daily,
         voice_weekly_cap_seconds  = v_caps.weekly,
         voice_monthly_cap_seconds = v_caps.monthly
   WHERE id = p_user_id;

  -- Mirror today's daily_quotas limit (preserve seconds_used; the latch trigger
  -- only re-fires on usage growth, so RAISING the cap here cannot retro-latch).
  v_qdate := (now() AT TIME ZONE v_tz)::date;
  UPDATE public.daily_quotas
     SET tier_snapshot = p_new_tier, daily_limit_s = v_caps.daily
   WHERE user_id = p_user_id AND quota_date = v_qdate;
END;$$;

REVOKE EXECUTE ON FUNCTION public.set_profile_tier_from_subscription(uuid, profile_tier)
  FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.set_profile_tier_from_subscription(uuid, profile_tier)
  TO service_role;

COMMENT ON FUNCTION public.set_profile_tier_from_subscription(uuid, profile_tier) IS
  'Webhook tier flip (service-role only). Sets tier + tier-default caps; does NOT block on an '
  'active session (sub events must not fail mid-call). The stripe_events row is the audit trail.';

-- ── 6. monthly_window_start — prefer the active billing period ─────────────
-- An active subscriber meters against their billing anniversary (avoids the
-- signup-month double-dip on thin margins); free/lapsed/lagging-webhook → calendar
-- month. Signature + grants preserved (CREATE OR REPLACE). Still SECURITY INVOKER:
-- only called from inside the SECURITY DEFINER readers (which run as the owner and
-- can read stripe_customers) or by service_role directly.
CREATE OR REPLACE FUNCTION public.monthly_window_start(p_user_id uuid)
RETURNS date
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_tz           text;
  v_period_start timestamptz;
BEGIN
  SELECT COALESCE(timezone, 'UTC') INTO v_tz FROM public.profiles WHERE id = p_user_id;
  IF v_tz IS NULL THEN v_tz := 'UTC'; END IF;

  -- Entitled = active / trialing / past_due (past_due is the dunning grace window).
  -- NO `current_period_end > now()` guard (audit C3): during renewal-webhook lag the
  -- period the user is INSIDE must stay keyed to its billing-anniversary start, never
  -- fall back to calendar month — a fallback re-keys voice_usage_monthly to a fresh
  -- 0-used row and re-GRANTS the whole monthly allowance (a direct COGS leak). A
  -- genuinely-lapsed sub is caught by the reconcile cron (status/tier → free), after
  -- which this falls back to calendar month correctly.
  SELECT current_period_start INTO v_period_start
    FROM public.stripe_customers
   WHERE user_id = p_user_id
     AND status IN ('active', 'trialing', 'past_due')
     AND current_period_start IS NOT NULL;
  IF v_period_start IS NOT NULL THEN
    RETURN (v_period_start AT TIME ZONE v_tz)::date;
  END IF;

  RETURN date_trunc('month', (now() AT TIME ZONE v_tz))::date;
END;$$;

COMMENT ON FUNCTION public.monthly_window_start(uuid) IS
  'THE shared monthly-window boundary. Prefers an active stripe_customers.current_period_start '
  '(billing anniversary), else calendar month (user tz). Every monthly reader MUST call this.';

-- ── 7. voice_usage_ticket_check — intentionally NOT modified (audit C2) ────
-- An earlier draft re-pointed its monthly boundary at monthly_window_start. But
-- ticket_check sums voice_usage_DAILY while the live meter (voice_balance_check)
-- reads the period-keyed voice_usage_MONTHLY — re-pointing only the boundary makes
-- the two monthly numbers DIVERGE. ticket_check is ALSO dead in the live open path
-- (the route gates on voice_balance_check; only a comment references ticket_check),
-- so there is nothing to fix here. We leave it EXACTLY as 20260428000002 defined
-- it; the authoritative billing-period enforcement lives in voice_balance_check.

-- ── 8. Cron maintenance: lapse reconcile + event GC ────────────────────────
-- Lapse safety net (covers a missed customer.subscription.deleted): any paid user
-- whose stored period ended AND whose sub is not active → flip to free (reusing
-- set_profile_tier_from_subscription so caps reset identically). Earned wallet
-- minutes persist (they're not the allowance).
CREATE FUNCTION public.stripe_subscription_reconcile()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
  r          record;
  v_n        int := 0;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'stripe_subscription_reconcile is service-role only' USING ERRCODE = '42501';
  END IF;

  -- LAPSE: a paid user who is no longer entitled → free. Either a terminal/absent
  -- status, or a STALE 'active' whose period ended well past a renewal window (a
  -- missed customer.subscription.deleted). past_due is NOT lapsed (dunning grace).
  FOR r IN
    SELECT p.id
      FROM public.profiles p
      JOIN public.stripe_customers sc ON sc.user_id = p.id
     WHERE p.tier IN ('premium', 'boardroom')
       AND ( sc.status IS NULL
             OR sc.status NOT IN ('active', 'trialing', 'past_due')
             OR (sc.status = 'active' AND sc.current_period_end IS NOT NULL
                 AND sc.current_period_end < now() - interval '2 days') )
  LOOP
    PERFORM public.set_profile_tier_from_subscription(r.id, 'free');
    v_n := v_n + 1;
  END LOOP;

  -- RE-ASSERT (audit C5/M6/M7): an ENTITLED paid sub whose profiles.tier drifted
  -- from the stored tier — a crash between the webhook's customer-upsert and the
  -- tier-flip, an invoice.paid that didn't re-flip, or a past_due recovery — gets
  -- its tier re-applied. Excludes the stale-active rows the lapse pass just handled.
  FOR r IN
    SELECT p.id, sc.tier AS want_tier
      FROM public.profiles p
      JOIN public.stripe_customers sc ON sc.user_id = p.id
     WHERE sc.tier IN ('premium', 'boardroom')
       AND sc.status IN ('active', 'trialing', 'past_due')
       AND NOT (sc.current_period_end IS NOT NULL AND sc.current_period_end < now() - interval '2 days')
       AND p.tier IS DISTINCT FROM sc.tier
  LOOP
    PERFORM public.set_profile_tier_from_subscription(r.id, r.want_tier);
    v_n := v_n + 1;
  END LOOP;

  RETURN v_n;
END;$$;

REVOKE EXECUTE ON FUNCTION public.stripe_subscription_reconcile() FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.stripe_subscription_reconcile() TO service_role;

CREATE FUNCTION public.stripe_events_purge(p_older_than_days int DEFAULT 30)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
  v_n        int;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'stripe_events_purge is service-role only' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.stripe_events
   WHERE received_at < now() - make_interval(days => GREATEST(p_older_than_days, 3));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;$$;

REVOKE EXECUTE ON FUNCTION public.stripe_events_purge(int) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.stripe_events_purge(int) TO service_role;

COMMENT ON FUNCTION public.stripe_subscription_reconcile() IS
  'Daily lapse safety net: flips paid users whose billing period ended + sub not active → free. Service-role only.';
COMMENT ON FUNCTION public.stripe_events_purge(int) IS
  'GC: deletes stripe_events older than p_older_than_days (floored at 3d retention). Service-role only.';

COMMIT;
