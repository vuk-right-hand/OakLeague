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
//   • RPC success → cache snapshot, gate on (fired || over150).
//   • RPC failure + prior healthy snapshot → trust snapshot (fail-closed when bad).
//   • RPC failure + no prior snapshot → exactly one cold-start grace turn,
//     then deny until recovery.

export function decideQuotaGate({ rpc, priorCache }) {
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
    return {
      gate: {
        ok: !(fired || over150),
        reason: (fired || over150) ? 'kill_switch_fired' : '',
      },
      nextCache: { healthy: { fired, over150 }, graceUsed: prior.graceUsed },
    };
  }

  // Degraded RPC path.
  if (prior.healthy) {
    const { fired, over150 } = prior.healthy;
    return {
      gate: {
        ok: !(fired || over150),
        reason: (fired || over150) ? 'kill_switch_fired' : 'quota_check_degraded',
      },
      nextCache: prior,
    };
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
