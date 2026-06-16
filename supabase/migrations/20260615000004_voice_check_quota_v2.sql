-- 20260615000004 — Growth & Minutes Economy, Phase 2: answer-end soft gate RPC
--
-- Plan: docs/_planning/GROWTH_MINUTES_ECONOMY_PLAN.md §4.
-- Depends on 20260615000002 (voice_balance_check) + 20260421000003 (voice_check_quota).
--
-- voice_check_quota_v2 is the per-turn gate read for the SOFT gate: it returns
-- everything voice_check_quota does (the System-A 150% fuse fields) PLUS the
-- unified balance so the proxy can deny the NEXT turn GRACEFULLY at 100%
-- exhaustion (control message, WS stays open) instead of only hard-killing at the
-- 150% fuse.
--
-- R1-M2: tier_exhausted MUST be the SAME effective_remaining the open gate uses,
-- not System-A daily seconds_used. We get that by CALLING voice_balance_check
-- (one definition, no drift, R4-C4). It returns BOTH effective_remaining (free +
-- wallet) AND allowance_remaining (free only) so the proxy can pick the right one
-- per GROWTH_LEDGER_ENABLED (co-gated with the wallet draw — C1).
--
-- tier_exhausted = 100% soft signal; over_150_pct / kill_switch_fired_at = the
-- hard signal (unchanged), which always TRUMPS the soft gate in the proxy.

CREATE FUNCTION public.voice_check_quota_v2(p_session_id uuid)
RETURNS TABLE (
  seconds_used         int,
  daily_limit_s        int,
  kill_switch_fired_at timestamptz,
  over_150_pct         boolean,
  remaining_seconds    int,      -- effective_remaining (free allowance + wallet)
  allowance_remaining  int,      -- free pool only (ledger-off soft gate)
  -- S2: the proxy RECOMPUTES exhaustion ledger-aware (remaining_seconds when
  -- GROWTH_LEDGER_ENABLED, else allowance_remaining), so this effective-based
  -- boolean is a convenience, NOT authoritative in ledger-off mode.
  tier_exhausted       boolean,  -- effective_remaining <= 0
  cap_period           text      -- which free cap binds (client reset copy, R4-M5)
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role   text;
  v_user_id    uuid;
  v_started_at timestamptz;
  v_tz         text;
  v_qdate      date;
  v_row        record;
  v_eff        int;
  v_allow      int;
  v_cap        text;
  v_exhausted  boolean;
  v_su         int := 0;
  v_dl         int := 0;
  v_kf         timestamptz := NULL;
  v_o150       boolean := false;
BEGIN
  -- Service-role only (the Fly proxy). Defense-in-depth on top of the REVOKE
  -- footer — this RPC trusts a caller-supplied session_id and reads another
  -- user's balance, exactly the shape of the 2026-06-01 leak.
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'voice_check_quota_v2 is service-role only' USING ERRCODE = '42501';
  END IF;

  SELECT s.user_id, s.started_at, p.timezone
    INTO v_user_id, v_started_at, v_tz
    FROM public.sessions s
    JOIN public.profiles p ON p.id = s.user_id
   WHERE s.id = p_session_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'session % not found', p_session_id USING ERRCODE = '23503';
  END IF;

  -- System-A fuse fields (identical semantics to voice_check_quota). A missing
  -- daily_quotas row is the defensive "first turn proceeds" sentinel (zeros) —
  -- M4: this MATCHES v1 voice_check_quota's zeros-on-NOT-FOUND (not a change). The
  -- P0002-fatal-on-missing-row contract lives in voice_accumulate_seconds at
  -- turn_end, which is untouched; the session-insert trigger always creates the
  -- row first, so this branch is unreachable in normal flow.
  v_qdate := (v_started_at AT TIME ZONE v_tz)::date;
  SELECT q.seconds_used, q.daily_limit_s, q.kill_switch_fired_at
    INTO v_row
    FROM public.daily_quotas q
   WHERE q.user_id = v_user_id AND q.quota_date = v_qdate;
  IF FOUND THEN
    v_su   := v_row.seconds_used;
    v_dl   := v_row.daily_limit_s;
    v_kf   := v_row.kill_switch_fired_at;
    v_o150 := (v_row.seconds_used >= (v_row.daily_limit_s * 3) / 2);
  END IF;

  -- Unified balance — the SAME formula the open gate uses (no drift, R4-C4).
  -- C2: wrap so a balance-read failure does NOT propagate as the daily_quotas-
  -- inconsistency P0002 the proxy treats as a fatal 4006 teardown. voice_balance_
  -- check only RAISES if the profile row is missing — which the session→profile FK
  -- makes unreachable for a live session — but if it ever fails we DEGRADE the
  -- soft gate to inert (huge sentinel remaining ⇒ not exhausted) and let the
  -- System-A 150% fuse remain the hard backstop; the next turn re-reads.
  BEGIN
    SELECT b.effective_remaining, b.allowance_remaining, b.cap_period
      INTO v_eff, v_allow, v_cap
      FROM public.voice_balance_check(v_user_id) b;
    v_exhausted := (v_eff <= 0);
  EXCEPTION WHEN OTHERS THEN
    v_eff := 2147483647; v_allow := 2147483647; v_cap := NULL; v_exhausted := false;
  END;

  RETURN QUERY SELECT v_su, v_dl, v_kf, v_o150, v_eff, v_allow, v_exhausted, v_cap;
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_check_quota_v2(uuid) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.voice_check_quota_v2(uuid) TO service_role;

COMMENT ON FUNCTION public.voice_check_quota_v2(uuid) IS
  'Per-turn gate read for the answer-end soft gate. Returns voice_check_quota''s System-A '
  'fuse fields PLUS the unified balance (effective + allowance + cap_period) via '
  'voice_balance_check. tier_exhausted = 100%% soft signal; over_150_pct/kill_switch = hard '
  '(trumps soft in the proxy). Service-role only.';
