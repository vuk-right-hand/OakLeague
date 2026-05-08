-- 20260510000001 — unify voice caps to profiles.voice_daily_cap_seconds
--
-- THE DRIFT (verified by Phase C audit, 2026-05-08):
--
-- Two parallel quota systems with disagreeing defaults shipped over April:
--
--   System A — daily_quotas + sessions_enforce_tier_and_kill_switch (0017)
--              + voice_check_quota / voice_accumulate_seconds (0042)
--   * Hardcoded plpgsql CASE: free=600, premium=3600, boardroom=14400.
--   * Sessions trigger CLOBBERED daily_quotas.daily_limit_s on every
--     session-insert with the hardcoded value, overwriting any manual
--     UPDATE (the bug Vuk hit repeatedly the week of 2026-05-08).
--   * 150% kill-switch latch fired at 150% of the hardcoded value, not
--     the user's actual cap.
--
--   System B — profiles.voice_daily_cap_seconds + voice_usage_daily/weekly
--              + voice_usage_ticket_check (0056) + admin_set_user_voice_caps
--   * Column defaults: daily=300 (5min), weekly=900 (15min), monthly=NULL.
--   * Voice ticket pre-mint check at /api/sessions/open (rewire PR-1).
--   * Disagreed with System A's hardcoded values for every non-free tier.
--
-- AFTER THIS MIGRATION:
--   * profiles.voice_daily_cap_seconds is the single source of truth.
--   * Sessions trigger READS the profile cap; daily_quotas.daily_limit_s
--     mirrors it on every upsert. No more clobber.
--   * admin_set_profile_tier writes the profile cap (using tier defaults
--     via the new helper) in addition to flipping tier — preserves the
--     "tier = minutes/day dial" semantic.
--   * 150% kill-switch fires at 150% of the user's actual cap, not the
--     tier-mapped hardcoded value.
--
-- BACKFILL POLICY:
--   * Profiles where voice_daily_cap_seconds is still at column-default 300
--     get bumped to tier defaults. Free users stay at 300 (no-op).
--   * Profiles where the column has been admin-set away from 300 are
--     LEFT ALONE — admin's custom value wins.
--   * Weekly: backfilled to tier default ONLY when the existing value is
--     900 (column default). NULL-set values preserved.
--   * Monthly: never backfilled — column default is NULL today and there
--     are no tier defaults to inject.

BEGIN;

-- ── 1. Helper: single source of tier → cap defaults ────────────────────────
-- Returns (daily, weekly, monthly). NULL on weekly/monthly = "no cap".
-- Free has a weekly cap (binge-flatten funnel lever, CLAUDE.md). Paid tiers
-- have no weekly/monthly caps by default; admin sets paid-tier monthly
-- explicitly via admin_set_user_voice_caps.
--
-- plpgsql + STABLE (not SQL/IMMUTABLE) on purpose. Audit C3: a SQL function
-- with CASE/no-ELSE silently returns NULL for an unknown enum variant,
-- which then violates downstream NOT NULL constraints with an opaque 23502.
-- Adding a new profile_tier value before updating this helper now fails
-- loud with a named exception. STABLE rather than IMMUTABLE because
-- "adding an enum value" technically invalidates the IMMUTABLE contract
-- and could leave stale cached plans pointing at the old value set.

CREATE FUNCTION public.tier_default_voice_caps(p_tier profile_tier)
RETURNS TABLE (daily int, weekly int, monthly int)
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
BEGIN
  IF p_tier = 'free' THEN
    RETURN QUERY SELECT 300, 900, NULL::int;
  ELSIF p_tier = 'premium' THEN
    RETURN QUERY SELECT 3600, NULL::int, NULL::int;
  ELSIF p_tier = 'boardroom' THEN
    RETURN QUERY SELECT 14400, NULL::int, NULL::int;
  ELSE
    RAISE EXCEPTION 'tier_default_voice_caps: unhandled profile_tier value % — update this function before adding new enum variants', p_tier
      USING ERRCODE = '22023';
  END IF;
END;$$;

REVOKE ALL ON FUNCTION public.tier_default_voice_caps(profile_tier) FROM public;
GRANT EXECUTE ON FUNCTION public.tier_default_voice_caps(profile_tier)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.tier_default_voice_caps(profile_tier) IS
  'Tier → (daily, weekly, monthly) cap defaults in seconds. Single source of truth — used by backfill, by admin_set_profile_tier, and by future tier-default-applying code paths. NULL = no cap. Update tier defaults by editing this function only. RAISES on unknown enum variant (audit C3).';

-- ── 2. Backfill existing profiles ─────────────────────────────────────────
-- Bumps premium/boardroom users currently at column-default 300 to their
-- tier defaults. Free users stay at 300 (their tier default — no-op).
-- Skips any profile that has a non-default daily value (admin-customized).
--
-- Audit C2 fix: weekly nullification is GATED on weekly = 900 (column
-- default). An admin-customized weekly value (e.g., a boardroom user with
-- voice_daily_cap_seconds=300 default but voice_weekly_cap_seconds=7200
-- explicitly set) is preserved. Two separate UPDATEs for clarity.
-- Monthly is never touched — column default is NULL today and there are
-- no tier defaults to inject.
--
-- Inline CASE rather than UPDATE..FROM tier_default_voice_caps() because
-- UPDATE..FROM with a function on the target column requires LATERAL +
-- a CTE wrapper. Inline CASE is a one-shot mirror of the helper for
-- this migration only; the helper remains the single source going forward.

UPDATE public.profiles
   SET voice_daily_cap_seconds = CASE tier
         WHEN 'premium'   THEN 3600
         WHEN 'boardroom' THEN 14400
       END
 WHERE voice_daily_cap_seconds = 300
   AND tier <> 'free';

UPDATE public.profiles
   SET voice_weekly_cap_seconds = NULL
 WHERE voice_weekly_cap_seconds = 900
   AND tier <> 'free';

-- ── 3. Fix latch trigger: require usage growth ────────────────────────────
-- Audit C1 fix. The OLD latch trigger fired whenever NEW.seconds_used
-- crossed the 150% threshold, INCLUDING via UPDATEs that lowered
-- daily_limit_s while seconds_used stayed flat. After this migration's
-- daily_limit_s mirror (next section), an existing free user with
-- daily_limit_s=600, seconds_used=500 (well under 600*1.5=900 → not
-- latched today) would have daily_limit_s mirror to 300 on their next
-- session-open, instantly retro-latching them at 500 >= 300*1.5=450.
--
-- The latch represents "user accumulated 150% of their cap during a day"
-- — that's an abuse / runaway signal anchored to USAGE, not to cap
-- changes. Adding `NEW.seconds_used > OLD.seconds_used` to the predicate
-- means a downward cap adjustment (or cap mirror in this migration) cannot
-- retro-latch. The next turn that actually adds usage will latch correctly
-- if the user is still over the new threshold.

CREATE OR REPLACE FUNCTION public.daily_quotas_latch_kill_switch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR OLD.kill_switch_fired_at IS NULL)
     AND NEW.seconds_used >= (NEW.daily_limit_s * 3) / 2
     AND (TG_OP = 'INSERT' OR NEW.seconds_used > OLD.seconds_used) THEN
    NEW.kill_switch_fired_at := now();
  END IF;
  RETURN NEW;
END;$$;

-- ── 4. Mirror daily_quotas.daily_limit_s to current profile cap ───────────
-- One-shot backfill so existing rows are aligned with the profile column.
-- Skips already-latched rows (R5-S2 — admin clears manually). Latch trigger
-- (just patched above) won't retro-fire because seconds_used is unchanged.
-- After this, the new sessions trigger UPSERT below sees an already-aligned
-- row in steady state.

UPDATE public.daily_quotas q
   SET daily_limit_s = p.voice_daily_cap_seconds,
       tier_snapshot = p.tier
  FROM public.profiles p
 WHERE q.user_id = p.id
   AND q.kill_switch_fired_at IS NULL
   AND q.daily_limit_s IS DISTINCT FROM p.voice_daily_cap_seconds;

-- ── 5. Replace sessions trigger function ──────────────────────────────────
-- Reads profile.voice_daily_cap_seconds instead of hardcoded CASE. The
-- daily_quotas upsert still fires (kill-switch latch lives there); its
-- daily_limit_s now mirrors the profile.

CREATE OR REPLACE FUNCTION public.sessions_enforce_tier_and_kill_switch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tier       profile_tier;
  v_tz         text;
  v_limit_s    int;
  v_local_date date;
  v_latched    boolean;
BEGIN
  SELECT tier, timezone, voice_daily_cap_seconds
    INTO v_tier, v_tz, v_limit_s
    FROM public.profiles WHERE id = NEW.user_id;
  IF v_tier IS NULL THEN
    RAISE EXCEPTION 'sessions.user_id % has no profile', NEW.user_id USING ERRCODE = '23503';
  END IF;
  -- voice_daily_cap_seconds is NOT NULL DEFAULT 300 with CHECK > 0 BETWEEN
  -- 0 AND 86400. A NULL or non-positive value here means schema corruption
  -- — fail loud rather than grant unlimited turns.
  IF v_limit_s IS NULL OR v_limit_s <= 0 THEN
    RAISE EXCEPTION 'sessions.user_id % has invalid voice_daily_cap_seconds=%',
      NEW.user_id, v_limit_s USING ERRCODE = '22003';
  END IF;

  -- Snapshot tier onto the session row.
  NEW.tier_at_session := v_tier;

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

  -- Upsert today's quota row. ON CONFLICT skips latched rows (R5-S2).
  -- daily_limit_s is the user's CURRENT profile cap — admin can change
  -- the cap mid-day and it takes effect on the user's next session-open.
  INSERT INTO public.daily_quotas (user_id, quota_date, tier_snapshot, daily_limit_s)
  VALUES (NEW.user_id, v_local_date, v_tier, v_limit_s)
  ON CONFLICT (user_id, quota_date)
  DO UPDATE SET
    daily_limit_s = EXCLUDED.daily_limit_s,
    tier_snapshot = EXCLUDED.tier_snapshot
  WHERE public.daily_quotas.kill_switch_fired_at IS NULL;

  RETURN NEW;
END;$$;

-- ── 6. Replace admin_set_profile_tier ─────────────────────────────────────
-- Tier flip now writes the profile cap columns to tier defaults, in addition
-- to flipping tier. Preserves the "tier = dial" semantic — flipping to
-- boardroom resets caps to boardroom defaults. If admin wants a custom
-- value, they call admin_set_user_voice_caps after (or instead).
--
-- Bare UPDATE profiles SET tier = ... does NOT touch caps; only this RPC
-- (and admin_set_user_voice_caps) writes the cap columns. Sessions trigger
-- and admin RPCs are the only quota-touching paths.

CREATE OR REPLACE FUNCTION public.admin_set_profile_tier(
  p_target_user_id uuid,
  p_new_tier       profile_tier
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_admin_id     uuid := auth.uid();
  v_old_tier     profile_tier;
  v_tz           text;
  v_qdate        date;
  v_seconds      int;
  v_caps         record;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_roles
     WHERE user_id = v_admin_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'admin not authorized' USING ERRCODE = '42501';
  END IF;

  -- Lock target row + read tier.
  SELECT tier, timezone INTO v_old_tier, v_tz
    FROM public.profiles WHERE id = p_target_user_id FOR UPDATE;
  IF v_old_tier IS NULL THEN
    RAISE EXCEPTION 'profile not found' USING ERRCODE = 'P0002';
  END IF;

  -- Active session blocks tier flip (mid-session swap forbidden per
  -- CLAUDE.md "tier locked at session-open").
  IF EXISTS (
    SELECT 1 FROM public.sessions
     WHERE user_id = p_target_user_id AND ended_at IS NULL
  ) THEN
    RAISE EXCEPTION 'has_active_session' USING ERRCODE = 'P0004';
  END IF;

  -- Downgrade with logged seconds today: blocked until tomorrow (R2-C2).
  v_qdate := (now() AT TIME ZONE COALESCE(v_tz, 'UTC'))::date;
  SELECT seconds_used INTO v_seconds
    FROM public.daily_quotas
   WHERE user_id = p_target_user_id AND quota_date = v_qdate;
  IF p_new_tier < v_old_tier AND COALESCE(v_seconds, 0) > 0 THEN
    RAISE EXCEPTION 'downgrade_blocked_until_tomorrow' USING ERRCODE = 'P0003';
  END IF;

  -- Apply tier + tier-default caps to profiles. Helper is the single
  -- source of truth for tier→cap mapping.
  SELECT daily, weekly, monthly INTO v_caps
    FROM public.tier_default_voice_caps(p_new_tier);

  UPDATE public.profiles
     SET tier                      = p_new_tier,
         voice_daily_cap_seconds   = v_caps.daily,
         voice_weekly_cap_seconds  = v_caps.weekly,
         voice_monthly_cap_seconds = v_caps.monthly
   WHERE id = p_target_user_id;

  -- Re-apply daily_limit_s on today's quota row if it exists. Preserve
  -- seconds_used (R2-C2). The latch trigger re-checks on UPDATE.
  UPDATE public.daily_quotas
     SET tier_snapshot = p_new_tier,
         daily_limit_s = v_caps.daily
   WHERE user_id = p_target_user_id AND quota_date = v_qdate;

  -- Audit.
  INSERT INTO public.admin_audit_log (admin_user_id, action, target_kind, target_id, before, after)
  VALUES (
    v_admin_id,
    'tier_flip',
    'profile',
    p_target_user_id,
    jsonb_build_object('tier', v_old_tier),
    jsonb_build_object('tier', p_new_tier, 'voice_daily_cap_seconds', v_caps.daily,
                       'voice_weekly_cap_seconds', v_caps.weekly,
                       'voice_monthly_cap_seconds', v_caps.monthly)
  );
END;$$;

REVOKE ALL    ON FUNCTION public.admin_set_profile_tier(uuid, profile_tier) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_set_profile_tier(uuid, profile_tier) TO authenticated;

COMMIT;
