// HUME_TTS_PLAN §8 audit M1 — shared registry of fatal session end_reasons.
//
// Imported by:
//   * scripts/hume-burnin-monitor.mjs (red-flag detection on burn-in)
//   * fatal-end-reasons.test.js (drift guard — scrapes index.js for new
//     teardown() strings and ensures none escape the registry)
//
// When the proxy adds a new fatal `teardown('<reason>')` call, add it here
// AND update the burn-in monitor's expectations. The test will fail if a
// fatal-looking teardown string appears in index.js without being listed.

export const FATAL_END_REASONS = Object.freeze([
  'tts_failed',
  'tts_open_failed',
  'cartesia_no_voice',
  'tts_no_voice_hume',
  'tts_no_voice_cartesia',
  'quota_state_inconsistent',
  'brain_unset_with_tts',
  'hume_per_turn_cap_exceeded',
  'bridge_open_failed',
  'cogs_misconfig',
  // Non-fatal-by-spec but worth surfacing to operators during burn-in:
  'voice_id_lookup_failed',
  'cartesia_open_failed', // legacy name; kept for back-compat with older sessions rows
  'bridge_reopen_failed',
  'heartbeat_timeout',
  'tts_turn_start_failed',
  // DECOUPLED_BRAIN_PLAN P1-5.2 — the decoupled orchestrator's
  // misconfigured-fatal latch (cogs pricing/env missing): closeWs 1011.
  // A red-flag burn-in signal — a decoupled session should NEVER end
  // this way in steady state.
  'decoupled_misconfigured',
  // DECOUPLED_BRAIN_PLAN P1-6 (audit) — the proactive D-GoAway reopen
  // failed: the session is genuinely past the cap and unrecoverable
  // (the reactive 1000-close fallback cannot help) → closeWs 1011. Rare
  // but fatal; the burn-in monitor watches its rate (a spike ⇒ Gemini
  // resumption-handle rejection regression).
  'go_away_reopen_failed',
]);

export const FATAL_END_REASONS_SET = new Set(FATAL_END_REASONS);

// Audit M6 (unit-wide, 2026-05-13) — template-literal teardown reasons
// interpolate the TTS provider into the string. These are fatal but vary
// by provider; the burn-in monitor + drift-guard test recognize them via
// prefix match.
export const FATAL_END_REASON_PREFIXES = Object.freeze([
  'brain_unset_with_',
  'tts_no_voice_',
]);

// isRedEndReason(reason) — true when the reason should be flagged as a
// fatal red flag during burn-in. Checks both the exact-match set AND the
// prefix list above.
export function isRedEndReason(reason) {
  if (FATAL_END_REASONS_SET.has(reason)) return true;
  for (const p of FATAL_END_REASON_PREFIXES) {
    if (typeof reason === 'string' && reason.startsWith(p)) return true;
  }
  return false;
}
