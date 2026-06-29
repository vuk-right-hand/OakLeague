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
-- R1-M2: the soft-gate exhaustion test MUST use the SAME effective_remaining the
-- open gate uses, not System-A daily seconds_used. We get that by CALLING
-- voice_balance_check (one definition, no drift, R4-C4). It returns BOTH
-- effective_remaining (free + wallet) AND allowance_remaining (free only) so the
-- PROXY can pick the right one per GROWTH_LEDGER_ENABLED (co-gated with the wallet
-- draw — C1). The proxy (decideQuotaGate) owns the exhaustion DECISION; this RPC
-- just hands it the raw numbers (S2 — no authoritative boolean returned).
--
-- This RPC also returns the System-A fuse fields (seconds_used, daily_limit_s) so
-- the proxy can trip the SOFT gate at System-A 100% as well (TANDEM AUDIT C1):
-- daily_quotas counts mic+assistant seconds while the balance counts assistant-only,
-- so the proxy must see BOTH meters to guarantee the graceful 100% upsell precedes
-- the 150% hard kill for any mic:assistant ratio. over_150_pct / kill_switch_fired_at
-- = the hard signal (unchanged), which always TRUMPS the soft gate in the proxy.

CREATE FUNCTION public.voice_check_quota_v2(p_session_id uuid)
RETURNS TABLE (
  seconds_used         int,
  daily_limit_s        int,
  kill_switch_fired_at timestamptz,
  over_150_pct         boolean,
  remaining_seconds    int,      -- effective_remaining (free allowance + wallet)
  allowance_remaining  int,      -- free pool only (ledger-off soft gate)
  -- TANDEM AUDIT S2: the old `tier_exhausted` boolean was DEAD — the proxy always
  -- RECOMPUTES exhaustion ledger-aware (remaining_seconds when GROWTH_LEDGER_ENABLED,
  -- else allowance_remaining) AND now also at System-A 100% (C1), so a single
  -- effective-based boolean was a footgun (disagreed with the gate in ledger-off
  -- mode). Replaced with had_wallet, which the proxy CAN'T derive from the other
  -- fields and which drives the C4 buy-vs-wait copy.
  had_wallet           boolean,  -- C4: user has a durable wallet (active>0) this read
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
  v_wallet_act bigint := 0;
  v_had_wallet boolean := false;
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
    SELECT b.effective_remaining, b.allowance_remaining, b.cap_period, b.wallet_active_seconds
      INTO v_eff, v_allow, v_cap, v_wallet_act
      FROM public.voice_balance_check(v_user_id) b;
    v_had_wallet := (COALESCE(v_wallet_act, 0) > 0);
  EXCEPTION WHEN OTHERS THEN
    -- TANDEM AUDIT M6: do NOT degrade SILENTLY. Degrading the soft gate to inert
    -- (huge sentinel ⇒ never exhausted) means the 100% paid boundary stops being
    -- enforced while voice_usage_record_v2 keeps draining the wallet — the wrong
    -- direction to fail for a money gate. voice_balance_check only RAISEs on a
    -- missing profile (FK-unreachable for a live session), so this should never
    -- fire; if it does, RAISE WARNING surfaces it in the Postgres/Supabase logs.
    -- The System-A 150% fuse remains the hard backstop; the next turn re-reads.
    RAISE WARNING 'voice_check_quota_v2: voice_balance_check failed for %, soft gate degraded to inert (SQLSTATE %)', v_user_id, SQLSTATE;
    -- M-E: had_wallet := false here is a known, accepted copy imperfection — if the
    -- balance read throws for a real wallet user AND the proxy's System-A trip fires
    -- the same turn, the overlay would show "wait" not "buy". This is FK-unreachable
    -- for a live session (voice_balance_check only RAISEs on a missing profile), so
    -- it's defense-in-depth, not a live bug; the huge sentinel keeps the gate inert.
    v_eff := 2147483647; v_allow := 2147483647; v_cap := NULL; v_had_wallet := false;
  END;

  RETURN QUERY SELECT v_su, v_dl, v_kf, v_o150, v_eff, v_allow, v_had_wallet, v_cap;
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_check_quota_v2(uuid) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.voice_check_quota_v2(uuid) TO service_role;

COMMENT ON FUNCTION public.voice_check_quota_v2(uuid) IS
  'Per-turn gate read for the answer-end soft gate. Returns voice_check_quota''s System-A '
  'fuse fields (seconds_used, daily_limit_s — proxy trips soft at System-A 100% per C1) '
  'PLUS the unified balance (effective + allowance + cap_period + had_wallet) via '
  'voice_balance_check. The PROXY recomputes exhaustion ledger-aware (no returned boolean, '
  'S2); over_150_pct/kill_switch = hard (trumps soft). Service-role only.';
