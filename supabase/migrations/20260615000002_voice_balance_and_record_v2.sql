-- 20260615000002 — Growth & Minutes Economy, Phase 1b: balance + per-turn draw
--
-- Plan: docs/_planning/GROWTH_MINUTES_ECONOMY_PLAN.md §3.
-- Depends on 20260615000001 (wallet columns + minute_grants).
--
-- Pieces:
--   * voice_usage_monthly        — O(1) per-turn monthly counter (R4-C2/C3),
--                                  period-keyed so it is billing-period-aware
--   * monthly_window_start(uid)  — THE one shared monthly-boundary helper that
--                                  every monthly reader calls (R4-C4/M6). Phase 1
--                                  returns the calendar month; Phase 6 (Stripe)
--                                  CREATE OR REPLACEs it to prefer an active sub's
--                                  billing anniversary. Signature is stable across
--                                  the swap so callers never change.
--   * voice_balance_check(uid)   — the unified balance read used by the open gate,
--                                  the meter, and (Phase 2) the soft gate
--   * voice_usage_record_v2(...) — race-safe per-turn counter update across
--                                  daily+weekly+MONTHLY with wallet overflow draw
--   * voice_fuse_anchor_apply()  — raise today's 150%-fuse anchor to the session's
--                                  real entitlement, bounded by the absolute COGS
--                                  ceiling (R2-C1)
--
-- METERING UNIT (verified R4): avatar-talk seconds — the SAME value the existing
-- voice_usage_* counters already record (assistant/Fish TTS audio). This is a
-- cap-VALUE layer, not a meter change.

BEGIN;

-- ── 1. voice_usage_monthly — O(1) per-turn monthly counter ─────────────────
-- voice_usage_ticket_check (0056) computes monthly as SUM(voice_usage_daily) —
-- fine once per session-open, but (a) the per-turn path can't afford a SUM
-- (R2-M2) and (b) a calendar SUM can't express a paid billing period. This
-- table is keyed by period_start (resolved by monthly_window_start) so it is
-- the free user's calendar month OR the paid user's billing anniversary,
-- uniformly. Mirrors voice_usage_daily's shape.
CREATE TABLE public.voice_usage_monthly (
  user_id      uuid          NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  period_start date          NOT NULL,
  seconds_used numeric(12,4) NOT NULL DEFAULT 0 CHECK (seconds_used >= 0),
  updated_at   timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period_start)
);

ALTER TABLE public.voice_usage_monthly ENABLE ROW LEVEL SECURITY;
-- Service-role only. Zero policies.

GRANT ALL ON TABLE public.voice_usage_monthly TO service_role;

COMMENT ON TABLE public.voice_usage_monthly IS
  'Per-period voice avatar-talk seconds counter, keyed by monthly_window_start(user) '
  '(calendar month for free, billing anniversary for paid). O(1) per-turn upsert. '
  'Binds only when profiles.voice_monthly_cap_seconds IS NOT NULL (paid tiers, Phase 6).';

-- ── 2. monthly_window_start — THE shared monthly-boundary helper ───────────
-- R4-C4/M6: four RPCs (record_v2, voice_balance_check, voice_check_quota_v2,
-- ticket_check) all need "which month are we in?". They MUST agree or the
-- monthly counter drifts / double-counts. One definition, called by all.
--
-- Phase 1: calendar month in the user's timezone.
-- Phase 6: CREATE OR REPLACE → COALESCE(active-sub current_period_start::date,
--          calendar month) so a subscriber meters against their billing
--          anniversary (avoids the signup-month double-dip on thin margins).
-- SECURITY INVOKER: only ever called from inside the SECURITY DEFINER readers
-- below (which run as the table owner and can read profiles); never trusts a
-- caller-supplied result for auth.
CREATE FUNCTION public.monthly_window_start(p_user_id uuid)
RETURNS date
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_tz text;
BEGIN
  SELECT COALESCE(timezone, 'UTC') INTO v_tz FROM public.profiles WHERE id = p_user_id;
  IF v_tz IS NULL THEN v_tz := 'UTC'; END IF;
  RETURN date_trunc('month', (now() AT TIME ZONE v_tz))::date;
END;$$;

REVOKE EXECUTE ON FUNCTION public.monthly_window_start(uuid) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.monthly_window_start(uuid) TO service_role;

COMMENT ON FUNCTION public.monthly_window_start(uuid) IS
  'THE shared monthly-window boundary. Phase 1: calendar month (user tz). Phase 6 '
  'CREATE OR REPLACEs to prefer an active stripe_customers.current_period_start. Every '
  'monthly reader MUST call this — do not re-derive the boundary inline (R4-C4/M6).';

-- ── 3. voice_balance_check — the unified balance read ──────────────────────
-- effective_remaining = free_avail_now + wallet_remaining, where
--   free_avail_now = max(0, min(daily_cap_eff − daily_used,
--                               weekly_cap − weekly_used,    [if weekly_cap not null]
--                               monthly_cap − monthly_used)) [if monthly_cap not null]
--   daily_cap_eff  = daily_cap + recruiter_bonus_daily_seconds   (daily side only)
--   wallet_remaining = max(0, wallet_active_seconds − wallet_spent_seconds)
-- FLOOR semantics on *_used match voice_usage_ticket_check exactly (R1-S7) so the
-- open gate and the meter never disagree by a second.
-- cap_period = which enabled free cap has the SMALLEST headroom (drives reset copy,
-- R4-M5 — a monthly-capped user must not be told "resets in 24h").
CREATE FUNCTION public.voice_balance_check(p_user_id uuid)
RETURNS TABLE (
  effective_remaining   int,
  remaining_seconds     int,      -- alias of effective_remaining (open-gate 429 body back-compat)
  allowance_remaining   int,      -- free_avail_now
  wallet_remaining      int,
  recruiter_bonus       int,
  daily_used            numeric,
  daily_cap             int,      -- base cap (NOT incl. recruiter)
  daily_cap_eff         int,      -- daily_cap + recruiter (drives the fuse anchor)
  weekly_used           numeric,
  weekly_cap            int,
  monthly_used          numeric,
  monthly_cap           int,
  wallet_active_seconds bigint,
  wallet_spent_seconds  bigint,
  cap_period            text,     -- 'daily'|'weekly'|'monthly' (smallest free headroom)
  supporter_active      boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role     text;
  v_tz           text;
  v_tier         profile_tier;
  v_day          date;
  v_week_mon     date;
  v_mstart       date;
  v_daily_cap    int;
  v_weekly_cap   int;
  v_monthly_cap  int;
  v_recruiter    int;
  v_wallet_act   bigint;
  v_wallet_spent bigint;
  v_daily_used   numeric;
  v_weekly_used  numeric;
  v_monthly_used numeric;
  v_daily_cap_eff int;
  v_free         int;
  v_cap_period   text;
  v_head         int;
  v_wallet_rem   int;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
      RAISE EXCEPTION 'caller cannot read balance for another user' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Qualify every column with the table alias: the RETURNS TABLE OUT columns
  -- wallet_active_seconds / wallet_spent_seconds are in-scope plpgsql variables
  -- and would otherwise make the unqualified table-column reference ambiguous.
  SELECT COALESCE(p.timezone, 'UTC'), p.tier,
         p.voice_daily_cap_seconds, p.voice_weekly_cap_seconds, p.voice_monthly_cap_seconds,
         p.recruiter_bonus_daily_seconds, p.wallet_active_seconds, p.wallet_spent_seconds
    INTO v_tz, v_tier,
         v_daily_cap, v_weekly_cap, v_monthly_cap,
         v_recruiter, v_wallet_act, v_wallet_spent
    FROM public.profiles p
   WHERE p.id = p_user_id;
  IF v_daily_cap IS NULL THEN
    RAISE EXCEPTION 'user % not found', p_user_id USING ERRCODE = 'P0002';
  END IF;

  v_day      := (now() AT TIME ZONE v_tz)::date;
  v_week_mon := date_trunc('week', v_day)::date;
  v_mstart   := public.monthly_window_start(p_user_id);

  SELECT COALESCE(seconds_used, 0) INTO v_daily_used
    FROM public.voice_usage_daily WHERE user_id = p_user_id AND day = v_day;
  v_daily_used := COALESCE(v_daily_used, 0);

  SELECT COALESCE(seconds_used, 0) INTO v_weekly_used
    FROM public.voice_usage_weekly WHERE user_id = p_user_id AND iso_week_mon = v_week_mon;
  v_weekly_used := COALESCE(v_weekly_used, 0);

  SELECT COALESCE(seconds_used, 0) INTO v_monthly_used
    FROM public.voice_usage_monthly WHERE user_id = p_user_id AND period_start = v_mstart;
  v_monthly_used := COALESCE(v_monthly_used, 0);

  v_daily_cap_eff := v_daily_cap + COALESCE(v_recruiter, 0);

  -- free_avail = min headroom across enabled caps; cap_period = the binding one.
  v_free       := GREATEST(0, v_daily_cap_eff - FLOOR(v_daily_used)::int);
  v_cap_period := 'daily';
  IF v_weekly_cap IS NOT NULL THEN
    v_head := GREATEST(0, v_weekly_cap - FLOOR(v_weekly_used)::int);
    IF v_head < v_free THEN v_free := v_head; v_cap_period := 'weekly'; END IF;
  END IF;
  IF v_monthly_cap IS NOT NULL THEN
    v_head := GREATEST(0, v_monthly_cap - FLOOR(v_monthly_used)::int);
    IF v_head < v_free THEN v_free := v_head; v_cap_period := 'monthly'; END IF;
  END IF;

  v_wallet_rem := GREATEST(0, v_wallet_act - v_wallet_spent)::int;

  RETURN QUERY SELECT
    (v_free + v_wallet_rem),                 -- effective_remaining
    (v_free + v_wallet_rem),                 -- remaining_seconds (alias)
    v_free,                                  -- allowance_remaining
    v_wallet_rem,                            -- wallet_remaining
    COALESCE(v_recruiter, 0),                -- recruiter_bonus
    v_daily_used, v_daily_cap, v_daily_cap_eff,
    v_weekly_used, v_weekly_cap,
    v_monthly_used, v_monthly_cap,
    v_wallet_act, v_wallet_spent,
    v_cap_period,
    (v_tier <> 'free');                      -- supporter_active (Phase 6 refines via stripe_customers)
END;$$;

-- R1-S3: service-role ONLY. The always-on meter route calls this server-side as
-- service-role for the caller's own getCallerUserId(). We do NOT grant authenticated
-- (a caller-supplied-id balance oracle = the exact shape of the 2026-06-01 leak).
REVOKE EXECUTE ON FUNCTION public.voice_balance_check(uuid) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.voice_balance_check(uuid) TO service_role;

COMMENT ON FUNCTION public.voice_balance_check(uuid) IS
  'Unified minutes balance: effective_remaining = free_allowance + wallet. Used by the '
  'session-open 429 gate, the meter route, and (Phase 2) the soft gate. Service-role only.';

-- ── 4. voice_usage_record_v2 — race-safe per-turn draw (daily+weekly+monthly) ──
-- Drop-in successor to voice_usage_record (same args + return) called by the Fly
-- proxy at turn-end. Adds the monthly counter and the wallet overflow draw. The
-- whole block runs inside the exactly-once voice_usage_turns claim so a proxy
-- retry never double-counts OR double-draws.
--
-- Overflow (the slice of this turn beyond the free pool) is computed from the
-- RETURNING of each row-locked counter upsert (the *_before values), which is
-- what makes it race-safe (R1-C3.2): two concurrent turns each see their own
-- post-locked total, never a stale pre-read.
CREATE FUNCTION public.voice_usage_record_v2(
  p_user_id          uuid,
  p_session_id       uuid,
  p_turn_number      int,
  p_seconds          numeric,
  p_turn_started_at  timestamptz DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role     text;
  v_tz           text;
  v_anchor_ts    timestamptz;
  v_day          date;
  v_week_mon     date;
  v_mstart       date;
  v_rowcount     int := 0;
  v_new_daily    numeric;
  v_new_weekly   numeric;
  v_new_monthly  numeric;
  v_daily_before numeric;
  v_weekly_before numeric;
  v_monthly_before numeric;
  v_daily_cap    int;
  v_weekly_cap   int;
  v_monthly_cap  int;
  v_recruiter    int;
  v_daily_cap_eff numeric;
  v_free_avail   numeric;
  v_overflow     numeric;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
      RAISE EXCEPTION 'caller cannot record voice usage for another user' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_turn_number IS NULL OR p_turn_number <= 0 THEN
    RAISE EXCEPTION 'turn_number must be positive' USING ERRCODE = '22003';
  END IF;
  IF p_seconds IS NULL OR p_seconds < 0 OR p_seconds > 3600 THEN
    RAISE EXCEPTION 'seconds out of range [0, 3600]' USING ERRCODE = '22003';
  END IF;

  SELECT COALESCE(timezone, 'UTC') INTO v_tz FROM public.profiles WHERE id = p_user_id;
  IF v_tz IS NULL THEN v_tz := 'UTC'; END IF;

  v_anchor_ts := COALESCE(p_turn_started_at, now());
  v_day       := (v_anchor_ts AT TIME ZONE v_tz)::date;
  v_week_mon  := date_trunc('week', v_day)::date;
  v_mstart    := public.monthly_window_start(p_user_id);

  -- Claim the turn (exactly-once). Counters touched ONLY if we claimed it.
  INSERT INTO public.voice_usage_turns
    (user_id, session_id, turn_number, seconds_used, day, iso_week_mon, recorded_at)
  VALUES
    (p_user_id, p_session_id, p_turn_number, p_seconds, v_day, v_week_mon, now())
  ON CONFLICT (user_id, session_id, turn_number) DO NOTHING;
  GET DIAGNOSTICS v_rowcount = ROW_COUNT;
  IF v_rowcount = 0 THEN
    RETURN false;
  END IF;

  -- Row-locked upserts; *_before from RETURNING is race-safe.
  INSERT INTO public.voice_usage_daily (user_id, day, seconds_used, updated_at)
  VALUES (p_user_id, v_day, p_seconds, now())
  ON CONFLICT (user_id, day) DO UPDATE
    SET seconds_used = voice_usage_daily.seconds_used + EXCLUDED.seconds_used, updated_at = now()
  RETURNING seconds_used INTO v_new_daily;

  INSERT INTO public.voice_usage_weekly (user_id, iso_week_mon, seconds_used, updated_at)
  VALUES (p_user_id, v_week_mon, p_seconds, now())
  ON CONFLICT (user_id, iso_week_mon) DO UPDATE
    SET seconds_used = voice_usage_weekly.seconds_used + EXCLUDED.seconds_used, updated_at = now()
  RETURNING seconds_used INTO v_new_weekly;

  INSERT INTO public.voice_usage_monthly (user_id, period_start, seconds_used, updated_at)
  VALUES (p_user_id, v_mstart, p_seconds, now())
  ON CONFLICT (user_id, period_start) DO UPDATE
    SET seconds_used = voice_usage_monthly.seconds_used + EXCLUDED.seconds_used, updated_at = now()
  RETURNING seconds_used INTO v_new_monthly;

  v_daily_before   := v_new_daily   - p_seconds;
  v_weekly_before  := v_new_weekly  - p_seconds;
  v_monthly_before := v_new_monthly - p_seconds;

  -- FOR SHARE: pin the caps for this turn so a concurrent admin cap change can't
  -- make the overflow math read a cap that disagrees with the row-locked counters (M7).
  SELECT voice_daily_cap_seconds, voice_weekly_cap_seconds, voice_monthly_cap_seconds,
         recruiter_bonus_daily_seconds
    INTO v_daily_cap, v_weekly_cap, v_monthly_cap, v_recruiter
    FROM public.profiles WHERE id = p_user_id FOR SHARE;

  v_daily_cap_eff := v_daily_cap + COALESCE(v_recruiter, 0);
  -- Headroom in the FREE pool BEFORE this turn; NULL cap = 'infinity' (no bind).
  -- FLOOR the pre-turn used values to match voice_balance_check's FLOOR(used)
  -- semantics EXACTLY (M1) — the open gate and this per-turn meter must never
  -- disagree by a sub-second (CLAUDE.md). Recruiter is on the DAILY term only
  -- (weekly/monthly use raw caps by design, S4). NULL weekly/monthly never binds,
  -- so a weekly- or monthly-binding free pool correctly draws the wallet.
  v_free_avail := GREATEST(0, LEAST(
      v_daily_cap_eff                              - FLOOR(v_daily_before),
      COALESCE(v_weekly_cap,  'infinity'::numeric) - FLOOR(v_weekly_before),
      COALESCE(v_monthly_cap, 'infinity'::numeric) - FLOOR(v_monthly_before)));
  v_overflow := GREATEST(0, p_seconds - v_free_avail);

  IF v_overflow > 0 THEN
    -- Draw the overflow from the wallet, CLAMPED so wallet_spent can never exceed
    -- wallet_active (preserves the Phase-7 invariant wallet_spent ≤ Σ granted, even
    -- if a free user with no wallet overshoots via the answer-finish soft gate).
    -- Single row-locked UPDATE = race-safe. The clamp can under-bill by the
    -- in-flight overshoot ONLY at wallet exhaustion; turns within a session are
    -- sequential and there is one active session per user (sessions_one_active_
    -- per_user), so a same-user concurrent over-draw can't occur in practice, and
    -- the gate blocks the NEXT session once the wallet reaches 0.
    UPDATE public.profiles
       SET wallet_spent_seconds = LEAST(wallet_active_seconds,
                                        wallet_spent_seconds + CEIL(v_overflow)::bigint)
     WHERE id = p_user_id;
  END IF;

  RETURN true;
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_usage_record_v2(uuid, uuid, int, numeric, timestamptz)
  FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.voice_usage_record_v2(uuid, uuid, int, numeric, timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.voice_usage_record_v2(uuid, uuid, int, numeric, timestamptz) IS
  'Exactly-once per-turn counter update across daily+weekly+monthly with wallet overflow '
  'draw. Successor to voice_usage_record. Returns true if counters incremented, false if '
  'the turn was already recorded (proxy retry → no double draw).';

-- ── 5. voice_fuse_anchor_apply — scale the 150% COGS fuse to real entitlement ──
-- R2-C1: System A's 150% kill switch (daily_quotas.daily_limit_s) is a runaway-COGS
-- backstop, NOT a tier enforcer (System B's soft gate owns that at 100%). Anchored
-- to the base cap it would hard-kill a wallet/paid user at 150% of free (450s). At
-- session-open/rollover the route raises today's daily_limit_s to the session's real
-- entitlement (daily_cap_eff + wallet_remaining), bounded by the absolute ceiling.
-- GREATEST(existing, …) so a same-day grant only ever RAISES it; seconds_used is
-- untouched so the latch trigger's `NEW.seconds_used > OLD.seconds_used` guard means
-- this can't retro-latch.
CREATE FUNCTION public.voice_fuse_anchor_apply(p_user_id uuid, p_anchor_seconds int)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
  v_tz       text;
  v_qdate    date;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'voice_fuse_anchor_apply is service-role only' USING ERRCODE = '42501';
  END IF;
  IF p_anchor_seconds IS NULL OR p_anchor_seconds < 0 THEN
    RETURN; -- nothing to raise
  END IF;

  SELECT COALESCE(timezone, 'UTC') INTO v_tz FROM public.profiles WHERE id = p_user_id;
  v_qdate := (now() AT TIME ZONE COALESCE(v_tz, 'UTC'))::date;

  UPDATE public.daily_quotas
     SET daily_limit_s = GREATEST(daily_limit_s, p_anchor_seconds)
   WHERE user_id = p_user_id
     AND quota_date = v_qdate
     AND kill_switch_fired_at IS NULL;
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_fuse_anchor_apply(uuid, int) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.voice_fuse_anchor_apply(uuid, int) TO service_role;

COMMENT ON FUNCTION public.voice_fuse_anchor_apply(uuid, int) IS
  'Raise today''s daily_quotas.daily_limit_s (the 150%% COGS fuse anchor) to a session''s '
  'real entitlement (caller passes min(daily_cap_eff + wallet_remaining, absolute ceiling)). '
  'GREATEST-only, skips latched rows, never touches seconds_used. Service-role only.';

COMMIT;
