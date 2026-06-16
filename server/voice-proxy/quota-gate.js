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
// is reflected on the NEXT read.
//
// TANDEM AUDIT M2 — in-session soft-gate recovery is RE-ENTRY-ONLY by design (plan
// §12.7: buy = redirect + re-open; "memory makes it continuous"). When the soft gate
// fires, the client disables the mic and the upsell's buy CTA navigates away (unmounts
// /s/[id]). So a grant landing mid-overlay is NOT picked up by a live re-read — there
// is no live turn_start to re-read. The freshness above matters for the RE-OPENED
// session's first read, not an in-place resume. Don't add live-recovery logic here on
// the assumption the cache enables it; it doesn't.

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

    // Soft-exhaustion signal (Phase 2): graceful 100% denial, distinct from the
    // 150% hard fuse. Only meaningful when softGateEnabled and the RPC carried a
    // balance (voice_check_quota_v2) — v1 rows lack the fields, so it's inert
    // without the flag + the _v2 RPC. TWO independent triggers, EITHER fires it:
    //   • System B (effective/allowance <= 0): the avatar-talk entitlement is
    //     spent — the primary, common trigger.
    //   • System A (seconds_used >= daily_limit_s, i.e. 100% of the fuse anchor):
    //     TANDEM AUDIT C1. daily_quotas counts mic+assistant seconds while System
    //     B counts assistant-only, so a chatty user can drive System A to the HARD
    //     150% line before System B reaches 100%. The route anchored the fuse a
    //     mic-turn (VOICE_FUSE_MIC_HEADROOM) above the entitlement, so tripping the
    //     SOFT gate at System-A 100% GUARANTEES the graceful upsell always precedes
    //     the jarring hard kill, for ANY mic:assistant ratio — not just statistically.
    let softExhausted = false;
    let softRemaining = 0;
    let softCapPeriod = null;
    let softWalletExhausted = false;
    let softTrip = null;
    if (softGateEnabled && !hard) {
      const remaining = ledgerOn
        ? Number(rpc.row.remaining_seconds)
        : Number(rpc.row.allowance_remaining);
      const systemBExhausted = Number.isFinite(remaining) && remaining <= 0;
      const usedA = Number(rpc.row.seconds_used);
      const limitA = Number(rpc.row.daily_limit_s);
      const systemAExhausted = Number.isFinite(usedA) && Number.isFinite(limitA)
        && limitA > 0 && usedA >= limitA;
      if (systemBExhausted || systemAExhausted) {
        softExhausted = true;
        // Report System-B remaining when IT triggered; when only the System-A COGS
        // line tripped (a rambler nominally still has assistant-seconds), report 0 —
        // for upsell purposes they're out for the period.
        softRemaining = systemBExhausted ? Math.max(0, Math.floor(remaining)) : 0;
        softCapPeriod = rpc.row.cap_period ?? null;
        // C4 — did the user spend a durable wallet (purchased/earned minutes)? Only
        // meaningful when the proxy is DRAWING the wallet (ledgerOn). Drives the
        // overlay's buy-vs-wait copy: a drained wallet does NOT refresh by waiting.
        softWalletExhausted = ledgerOn && !!rpc.row.had_wallet;
        // M-A — WHICH meter tripped, for telemetry. 'systemA' = the mic+assistant
        // COGS line cut a user who still has assistant-second entitlement (a rambler;
        // a paid one is getting short-changed — this is the rate to watch). 'systemB'
        // = genuine entitlement exhaustion. Without this the two are indistinguishable
        // in the tier_exhausted event.
        softTrip = systemBExhausted ? (systemAExhausted ? 'both' : 'systemB') : 'systemA';
      }
    }
    // C3 — cache the soft-exhaustion state too, so the degraded (RPC-error) path
    // can fail CLOSED on a known-exhausted user instead of granting free turns.
    const nextCache = {
      healthy: { fired, over150, softExhausted, softRemaining, softCapPeriod, softWalletExhausted, softTrip },
      graceUsed: prior.graceUsed,
    };

    if (hard) {
      return { gate: { ok: false, reason: 'kill_switch_fired' }, nextCache };
    }
    if (softExhausted) {
      return {
        gate: { ok: false, soft: true, reason: 'tier_exhausted', remaining_seconds: softRemaining, cap_period: softCapPeriod, wallet_exhausted: softWalletExhausted, trip: softTrip },
        nextCache,
      };
    }
    return { gate: { ok: true, reason: '' }, nextCache };
  }

  // Degraded RPC path.
  if (prior.healthy) {
    const { fired, over150, softExhausted, softRemaining, softCapPeriod, softWalletExhausted, softTrip } = prior.healthy;
    if (fired || over150) {
      return { gate: { ok: false, reason: 'kill_switch_fired' }, nextCache: prior };
    }
    // C3 — fail CLOSED on a known-exhausted user during an RPC brownout: do NOT
    // grant free unmetered turns. Freshness only matters in the un-exhausting
    // direction (a grant just landed), and a user who bought minutes re-opens /
    // retries, which re-reads — we never fail-closed PAST a real grant. The healthy
    // cache always populates these fields, so the `??` defaults are belt-and-braces.
    if (softExhausted) {
      return {
        gate: { ok: false, soft: true, reason: 'tier_exhausted', remaining_seconds: softRemaining ?? 0, cap_period: softCapPeriod ?? null, wallet_exhausted: softWalletExhausted ?? false, trip: softTrip ?? null },
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
