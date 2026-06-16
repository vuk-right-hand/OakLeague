// Pure decision function for the per-turn quota gate. Extracted from
// index.js so it can be unit-tested without stubbing supabase or env.
//
// Inputs:
//   rpc: { row, error, fatal? }  — result of voice_check_quota RPC.
//                                  row is either the returned record or null;
//                                  error is truthy on any RPC or parse failure;
//                                  fatal is true when the RPC raised P0002
//                                  (missing daily_quotas row — quota-state
//                                  inconsistency; caller must teardown with
//                                  WS close 4006, same as turn_end path).
//   priorCache: { healthy, graceUsed } | undefined
//
// Returns:
//   { gate: { ok, reason, fatal? }, nextCache: { healthy, graceUsed } }
//
// Rules (audit C4 + B1):
//   • RPC fatal (P0002) → deny + fatal flag, regardless of cache.
//   • RPC success → cache snapshot, gate on (fired || over150). When softGateEnabled
//     and NOT hard-killed, deny SOFTLY at 100% exhaustion (Phase 2) — the proxy keeps
//     the WS open and tells the client to upsell. HARD (fired/over150) always trumps.
//   • RPC failure + prior healthy snapshot → trust snapshot (fail-closed when bad).
//   • RPC failure + no prior snapshot → exactly one cold-start grace turn,
//     then deny until recovery.
//
// softGateEnabled gates the Phase-2 soft branch (GROWTH_SOFT_GATE_ENABLED). ledgerOn
// (GROWTH_LEDGER_ENABLED) picks effective (free + wallet) vs allowance (free only) for
// the exhaustion test, co-gated with the proxy's wallet DRAW so we never deny a wallet
// user whose wallet isn't being drawn, nor admit one whose wallet IS (C1). The soft
// exhaustion IS cached (audit C3) — but it's only CONSULTED on the degraded (RPC-error)
// path, to fail CLOSED on a known-exhausted user instead of granting free turns during
// a brownout. A successful RPC always uses the fresh read, so a grant that just landed
// is reflected immediately; the cache never fail-closes past a real grant.

export function decideQuotaGate({ rpc, priorCache, softGateEnabled = false, ledgerOn = false }) {
  const prior = priorCache ?? { healthy: null, graceUsed: false };

  // B1: fatal RPC error trumps everything. Do not consult cache, do not grant
  // grace — the database says daily_quotas is gone; the only safe move is to
  // tear down the session with the distinct WS code.
  if (rpc.fatal) {
    return {
      gate: { ok: false, fatal: true, reason: 'quota_state_inconsistent' },
      nextCache: prior,
    };
  }

  if (!rpc.error && rpc.row) {
    const fired = !!rpc.row.kill_switch_fired_at;
    const over150 = !!rpc.row.over_150_pct;
    const hard = fired || over150;

    // Soft-exhaustion signal (Phase 2): exhausted at 100% but not hard-killed.
    // Only meaningful when softGateEnabled and the RPC carried a balance
    // (voice_check_quota_v2) — v1 rows have no remaining fields, so it's inert
    // without the flag + the _v2 RPC.
    let softExhausted = false;
    let softRemaining = 0;
    let softCapPeriod = null;
    if (softGateEnabled && !hard) {
      const remaining = ledgerOn
        ? Number(rpc.row.remaining_seconds)
        : Number(rpc.row.allowance_remaining);
      if (Number.isFinite(remaining) && remaining <= 0) {
        softExhausted = true;
        softRemaining = Math.max(0, Math.floor(remaining));
        softCapPeriod = rpc.row.cap_period ?? null;
      }
    }
    // C3 — cache the soft-exhaustion state too, so the degraded (RPC-error) path
    // can fail CLOSED on a known-exhausted user instead of granting free turns.
    const nextCache = {
      healthy: { fired, over150, softExhausted, softRemaining, softCapPeriod },
      graceUsed: prior.graceUsed,
    };

    if (hard) {
      return { gate: { ok: false, reason: 'kill_switch_fired' }, nextCache };
    }
    if (softExhausted) {
      return {
        gate: { ok: false, soft: true, reason: 'tier_exhausted', remaining_seconds: softRemaining, cap_period: softCapPeriod },
        nextCache,
      };
    }
    return { gate: { ok: true, reason: '' }, nextCache };
  }

  // Degraded RPC path.
  if (prior.healthy) {
    const { fired, over150, softExhausted, softRemaining, softCapPeriod } = prior.healthy;
    if (fired || over150) {
      return { gate: { ok: false, reason: 'kill_switch_fired' }, nextCache: prior };
    }
    // C3 — fail CLOSED on a known-exhausted user during an RPC brownout: do NOT
    // grant free unmetered turns. Freshness only matters in the un-exhausting
    // direction (a grant just landed), and a user who bought minutes re-opens /
    // retries, which re-reads — we never fail-closed PAST a real grant.
    if (softExhausted) {
      return {
        gate: { ok: false, soft: true, reason: 'tier_exhausted', remaining_seconds: softRemaining ?? 0, cap_period: softCapPeriod ?? null },
        nextCache: prior,
      };
    }
    return { gate: { ok: true, reason: 'quota_check_degraded' }, nextCache: prior };
  }

  if (!prior.graceUsed) {
    return {
      gate: { ok: true, reason: 'cold_start_grace' },
      nextCache: { healthy: null, graceUsed: true },
    };
  }

  return {
    gate: { ok: false, reason: 'quota_check_unavailable' },
    nextCache: prior,
  };
}
