// Extracted handlers for unit testing — see SPIKE_A_DEFERRED_FIXUP_PLAN.md §1A.0.
//
// Factory pattern: each `makeX` returns a closure over (supabase, env, ...) so
// tests can pass a mock supabase client and inspect calls. The factories also
// own per-session state (cogs failure counter) — tests verify the counter
// trips the WS-close hook after 3 consecutive failures.

import { captureException } from './sentry.js';

// ── Pricing constants (Pipeline α' COGS) ────────────────────────────────────
//
// QUOTED_AT = 2026-04-30 — Gemini 3.1 Flash Live preview rate card.
// Source: https://ai.google.dev/pricing (verified 2026-04-30):
//   audio input:  $3.00/1M tokens OR $0.005/min  →  per-sec: 0.005/60
//   audio output: $12.00/1M tokens OR $0.018/min →  per-token: 12.00 / 1e6 = 0.000012
//                                                   per-sec fallback: 0.018/60
//
// Verify on every model bump. Env-overrideable so a rate-card change is a
// config update, not a code change.
export const PRICING_QUOTED_AT = '2026-04-30';
export const GEMINI_INPUT_USD_PER_SEC           = Number(process.env.GEMINI_INPUT_USD_PER_SEC           ?? 0.005 / 60);
export const GEMINI_OUTPUT_USD_PER_TOKEN        = Number(process.env.GEMINI_OUTPUT_USD_PER_TOKEN        ?? 0.000012);
export const GEMINI_OUTPUT_USD_PER_SEC_FALLBACK = Number(process.env.GEMINI_OUTPUT_USD_PER_SEC_FALLBACK ?? 0.018 / 60);
// Empirical mean from Phase 0.1 A3 when ≥100 truth rows; otherwise 50 placeholder.
// `GEMINI_TOKENS_PER_SEC_FALLBACK_SOURCE` is the provenance tag written to
// metadata.fallback_constant_source so the dashboard surfaces the imprecision.
export const GEMINI_TOKENS_PER_SEC_FALLBACK     = Number(process.env.GEMINI_TOKENS_PER_SEC_FALLBACK     ?? 50);
export const GEMINI_TOKENS_PER_SEC_FALLBACK_SOURCE = process.env.GEMINI_TOKENS_PER_SEC_FALLBACK_SOURCE ?? 'default-50';

// ── Cartesia pricing (Pipeline α' leg 3) ─────────────────────────────────
//
// CARTESIA_USD_PER_CHAR + CARTESIA_QUOTED_AT are Fly secrets pasted by Vuk
// from the Cartesia dashboard before merge. NO code default (R3-A11 +
// R4-S3): Number-only-when-finite-and-positive guard, throw at module
// load otherwise. A missed env var must be a hard fail at boot, never a
// silent ship-at-$0.
//
// VOICE_CARTESIA_ENABLED governs whether the proxy instantiates the
// bridge at session-open — when '0', leg-3/leg-4 stay at zero with
// metadata.cartesia_pending=true (back-compat with pre-α' rows).
export const VOICE_CARTESIA_ENABLED = process.env.VOICE_CARTESIA_ENABLED === '1';

let _cartesiaUsdPerChar = null;
let _cartesiaQuotedAt = null;
export function getCartesiaPricing() {
  if (_cartesiaUsdPerChar !== null) {
    return { usdPerChar: _cartesiaUsdPerChar, quotedAt: _cartesiaQuotedAt };
  }
  if (!VOICE_CARTESIA_ENABLED) {
    // Cartesia disabled: no need to validate the constants.
    _cartesiaUsdPerChar = 0;
    _cartesiaQuotedAt = '';
    return { usdPerChar: 0, quotedAt: '' };
  }
  const raw = Number(process.env.CARTESIA_USD_PER_CHAR);
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error(
      'CARTESIA_USD_PER_CHAR must be a positive finite number when VOICE_CARTESIA_ENABLED=1 (R4-S3 fail-closed)',
    );
  }
  const quoted = String(process.env.CARTESIA_QUOTED_AT || '').trim();
  if (!quoted || !/^\d{4}-\d{2}-\d{2}$/.test(quoted)) {
    throw new Error(
      'CARTESIA_QUOTED_AT must be a YYYY-MM-DD date string when VOICE_CARTESIA_ENABLED=1',
    );
  }
  _cartesiaUsdPerChar = raw;
  _cartesiaQuotedAt = quoted;
  return { usdPerChar: raw, quotedAt: quoted };
}

// ── Reaper cadence ──────────────────────────────────────────────────────────
//
// 20s cadence + 60s RPC-default threshold = max ghost life ~80s. Threshold
// stays at 60s; see plan §1B for the structural justification (proxy-self-
// close-at-90s + boot-time runReaper handle proxy-crash recovery).
export const REAPER_CADENCE_MS = 20_000;

// ── Failure-counter knobs ───────────────────────────────────────────────────
//
// Close WS after N consecutive cogs RPC failures on the same session. A
// success resets the counter to 0; idle turns don't increment.
export const COGS_RPC_CONSECUTIVE_FAILURE_LIMIT = 3;

// `COGS_RPC_BYPASS_UNTIL` env var — incident-response escape hatch. When set
// to an ISO timestamp in the future, the failure counter is suppressed (errors
// still log to Sentry, but the WS stays open). Documented in
// .claude_learnings.md as a Supabase-brownout mitigation. Read fresh on each
// turn so flipping the var takes effect without a redeploy.
function bypassActive() {
  const until = process.env.COGS_RPC_BYPASS_UNTIL;
  if (!until) return false;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > Date.now();
}

// ── makeLogTurnCogs ─────────────────────────────────────────────────────────
//
// Factory returning the per-session-aware logTurnCogs handler. The factory
// owns the consecutive-failure Map<sessionId, count>; on the Nth consecutive
// failure for a session, it invokes onConsecutiveFailure(sessionId), which
// the caller (index.js) wires to closeWs(ws, 1011, 'cogs_rpc_failed').
//
// onConsecutiveFailure may be undefined in tests that only want to inspect
// RPC calls.
export function makeLogTurnCogs({ supabase, env = 'spike_a', onConsecutiveFailure } = {}) {
  if (!supabase) throw new Error('makeLogTurnCogs: supabase required');

  // sessionId → consecutive-failure count.
  const failures = new Map();

  function recordSuccess(sessionId) {
    failures.delete(sessionId);
  }

  function recordFailure(sessionId) {
    if (bypassActive()) return; // brownout escape hatch
    const next = (failures.get(sessionId) ?? 0) + 1;
    failures.set(sessionId, next);
    if (next >= COGS_RPC_CONSECUTIVE_FAILURE_LIMIT && typeof onConsecutiveFailure === 'function') {
      try { onConsecutiveFailure(sessionId); } catch (e) {
        console.error('[onConsecutiveFailure]', e);
        captureException(e, { op: 'onConsecutiveFailure', sessionId });
      }
    }
  }

  // Public for tests; production code shouldn't read this.
  function _consecutiveFailures(sessionId) {
    return failures.get(sessionId) ?? 0;
  }

  // payload = {
  //   userId, sessionId, turnNumber,
  //   inputSeconds, outputSeconds, usageMetadata,
  //   cartesia?: { characters, audioBytes, audioSeconds, partial }
  // }
  // When `cartesia` is present, legs 3+4 are written with real values and
  // metadata.cartesia_pending is dropped (replaced with cartesia_quoted_at +
  // optional cartesia_partial). When absent, the legacy zeros + pending flag
  // are written so dashboards keep the "α' not yet wired" bucket meaningful.
  async function logTurnCogs(payload) {
    const {
      userId, sessionId, turnNumber,
      inputSeconds = 0, outputSeconds = 0, usageMetadata = null,
      cartesia = null,
    } = payload;

    // Leg 2: tokens-of-truth path vs seconds-derived fallback. The proxy-
    // supplied metadata distinguishes the two; the dashboard's headline cost
    // filters fallback rows. See plan §1A leg mapping.
    const responseTokens =
      usageMetadata && Number.isFinite(usageMetadata.responseTokenCount)
        ? usageMetadata.responseTokenCount
        : null;

    const isFallback = responseTokens === null;
    const audioOutTokens = isFallback
      ? Math.round((outputSeconds || 0) * GEMINI_TOKENS_PER_SEC_FALLBACK)
      : responseTokens;
    const audioOutCost = isFallback
      ? (outputSeconds || 0) * GEMINI_OUTPUT_USD_PER_SEC_FALLBACK
      : responseTokens * GEMINI_OUTPUT_USD_PER_TOKEN;

    // Leg-2 metadata — provenance for dashboard gating.
    //
    // NOTE: migration 0055 merges this `p_metadata` into ALL FOUR leg INSERTs,
    // so every key here lands on legs 1, 2, 3, AND 4. Aggregator gates the
    // fallback-cost bucket on `operation === voice_audio_out_tokens` to keep
    // leg-1 truth-cost out of the fallback bucket — see audit B-1.
    const meta = {
      source: env,
      quoted_at: PRICING_QUOTED_AT,
    };
    if (cartesia) {
      const { quotedAt } = getCartesiaPricing();
      meta.cartesia_quoted_at = quotedAt;
      if (cartesia.partial) meta.cartesia_partial = true;
    } else {
      // Pre-α' rows: keep the deferral flag for dashboard bucketing.
      meta.cartesia_pending = true;
    }
    if (isFallback) {
      meta.fallback = 'seconds';
      meta.fallback_seconds = outputSeconds;
      meta.fallback_tokens_per_sec = GEMINI_TOKENS_PER_SEC_FALLBACK;
      meta.fallback_constant_source = GEMINI_TOKENS_PER_SEC_FALLBACK_SOURCE;
    }
    // Whitelist usageMetadata fields (audit I-2). Gemini Live's usage shape
    // is small today, but storing the whole provider object means new fields
    // flow into cogs_log unaudited. Pin the contract.
    if (usageMetadata) {
      const u = {};
      if (Number.isFinite(usageMetadata.promptTokenCount))   u.promptTokenCount   = usageMetadata.promptTokenCount;
      if (Number.isFinite(usageMetadata.responseTokenCount)) u.responseTokenCount = usageMetadata.responseTokenCount;
      if (Number.isFinite(usageMetadata.totalTokenCount))    u.totalTokenCount    = usageMetadata.totalTokenCount;
      if (Object.keys(u).length > 0) meta.usage = u;
    }

    const inputCost = (inputSeconds || 0) * GEMINI_INPUT_USD_PER_SEC;

    // Cartesia legs 3 + 4 — populated only when α' is on (caller passed
    // `cartesia`). Cost computed at call-time so the kill-switch at
    // module-load failure (R4-S3) can still fire.
    let cartesiaChars = 0;
    let cartesiaCost = 0;
    let cartesiaAudioSeconds = 0;
    if (cartesia) {
      const { usdPerChar } = getCartesiaPricing();
      cartesiaChars = Math.max(0, Math.round(cartesia.characters || 0));
      cartesiaCost = Number((cartesiaChars * usdPerChar).toFixed(6));
      cartesiaAudioSeconds = Number((cartesia.audioSeconds || 0).toFixed(4));
    }

    try {
      const { error } = await supabase.rpc('cogs_insert_turn_voice', {
        p_user_id: userId,
        p_session_id: sessionId,
        p_turn_number: turnNumber,
        // Leg 1 — Gemini audio-in seconds
        p_gemini_audio_in_seconds: Number((inputSeconds || 0).toFixed(4)),
        p_gemini_audio_in_cost:    Number(inputCost.toFixed(6)),
        // Leg 2 — Gemini audio-out tokens (or seconds-derived fallback)
        p_gemini_audio_out_tokens: audioOutTokens,
        p_gemini_audio_out_cost:   Number(audioOutCost.toFixed(6)),
        // Legs 3 + 4 — Cartesia (zero when α' off / cartesia not passed)
        p_cartesia_characters:     cartesiaChars,
        p_cartesia_cost:           cartesiaCost,
        p_cartesia_audio_seconds:  cartesiaAudioSeconds,
        p_environment: env,
        p_metadata: meta,
      });
      if (error) {
        console.error('[cogs_insert_turn_voice]', error);
        captureException(error, { op: 'cogs_insert_turn_voice', sessionId, userId, turnNumber });
        recordFailure(sessionId);
        return { ok: false };
      }
      recordSuccess(sessionId);
      return { ok: true, fallback: isFallback };
    } catch (e) {
      console.error('[cogs_insert_turn_voice] exception', e);
      captureException(e, { op: 'cogs_insert_turn_voice', sessionId, userId, turnNumber });
      recordFailure(sessionId);
      return { ok: false };
    }
  }

  // Cleanup on session close — caller invokes when WS closes for any reason.
  function dropSession(sessionId) {
    failures.delete(sessionId);
  }

  return { logTurnCogs, dropSession, _consecutiveFailures };
}

// ── makeRunReaper ───────────────────────────────────────────────────────────
//
// Factory returning runReaper() closure. Calls reap_stale_sessions() with NO
// args so the RPC default (60s threshold) governs. Plan §1B: no override.
export function makeRunReaper({ supabase } = {}) {
  if (!supabase) throw new Error('makeRunReaper: supabase required');

  async function runReaper() {
    try {
      const { data, error } = await supabase.rpc('reap_stale_sessions', {});
      if (error) {
        console.error('[reaper]', error);
        captureException(error, { op: 'reaper' });
        return;
      }
      if (data?.length) console.log(`[reaper] closed ${data.length} stale sessions`);
    } catch (e) {
      console.error('[reaper] exception', e);
      captureException(e, { op: 'reaper' });
    }
  }

  return { runReaper };
}

// ── installReaper ───────────────────────────────────────────────────────────
//
// Wires setInterval; returns the interval handle. Tests inspect handle's
// underlying delay (Node `_idleTimeout`) to verify the actual cadence — not
// just the constant. Caller must clearInterval(handle) on shutdown.
export function installReaper({ supabase, intervalMs = REAPER_CADENCE_MS } = {}) {
  const { runReaper } = makeRunReaper({ supabase });
  // Fire once immediately at boot — this is the proxy-crash recovery
  // mechanism (plan §1B I-D fix).
  runReaper().catch((e) => console.error('[reaper-init]', e));
  const handle = setInterval(() => runReaper().catch(() => {}), intervalMs);
  return { handle, runReaper };
}
