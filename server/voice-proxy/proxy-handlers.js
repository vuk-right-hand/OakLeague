// Extracted handlers for unit testing — see SPIKE_A_DEFERRED_FIXUP_PLAN.md §1A.0.
//
// Factory pattern: each `makeX` returns a closure over (supabase, env, ...) so
// tests can pass a mock supabase client and inspect calls. The factories also
// own per-session state (cogs failure counter) — tests verify the counter
// trips the WS-close hook after 3 consecutive failures.

import { captureException } from './sentry.js';
import { validateHumePricingOrExit, assertHumePricing } from './hume-bridge.js';
import { validateFishPricingOrExit, assertFishPricing } from './fish-bridge.js';

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
//
// Phase C B4.4 (deferred — needs prod data): the 50 default may be 2× off
// from measured rates. To re-calibrate: SELECT mean(usage_metadata->>'output_tokens'
// / NULLIF(units,0)) FROM cogs_log WHERE service='gemini' AND operation='voice_audio_out_tokens'
// AND metadata->>'fallback_constant_source' = 'default-50' AND created_at > now() - interval '7 days'
// — once ≥100 rows, set GEMINI_TOKENS_PER_SEC_FALLBACK on Fly to the measured
// value and bump GEMINI_TOKENS_PER_SEC_FALLBACK_SOURCE to e.g. 'measured-2026-05-Q2'.
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
// VOICE_TTS_LAYER_ENABLED governs whether the proxy instantiates a
// dedicated TTS bridge (Cartesia or Hume) at session-open — when '0',
// leg-3/leg-4 stay at zero with metadata.cartesia_pending=true (back-compat
// with pre-α' rows).
//
// 2026-05-14 rename: was VOICE_CARTESIA_ENABLED. Old name carries during
// the Fly/Vercel migration window — set the new name on both, then drop
// the old fallback in a follow-up cleanup. `VOICE_CARTESIA_ENABLED` was
// misleading because it really means "α' TTS layer on (Cartesia OR Hume)."
// Audit M1 — `??` only falls through on null/undefined, NOT empty string.
// `fly secrets set VOICE_TTS_LAYER_ENABLED=` (or a templating bug) yields
// "" — which is non-nullish, so `??` would NOT fall back to the legacy
// VOICE_CARTESIA_ENABLED=1 Fly secret, and `"" === '1'` is false → the
// ENTIRE α' TTS layer silently turns off mid-migration-window (every
// session drops to legacy Gemini-audio). Treat the new var as "set" only
// when it's an explicit '1' or '0'; otherwise fall back to legacy.
const _newRaw = process.env.VOICE_TTS_LAYER_ENABLED;
const _legacyCartesiaEnv = process.env.VOICE_CARTESIA_ENABLED;
const _newExplicit = _newRaw === '1' || _newRaw === '0';
export const VOICE_TTS_LAYER_ENABLED = (_newExplicit ? _newRaw : _legacyCartesiaEnv) === '1';
// Alias kept so existing imports compile during the migration; new code
// should import VOICE_TTS_LAYER_ENABLED. Both refer to the SAME value.
export const VOICE_CARTESIA_ENABLED = VOICE_TTS_LAYER_ENABLED;

// HUME_TTS_PLAN §6.10 — getHumePricing parallel to getCartesiaPricing.
//
// Audit C2 (unit-wide, 2026-05-13) — single source of truth. Both bridge
// construction (index.js) AND logTurnCogs (this file) read this cached
// value. Earlier draft had a duplicate cache in index.js; the two could
// diverge on a test mock and during a partial pricing rotation.
//
// `_humePricingPrimeForBoot` is called from index.js's `provisionPricing()`
// so the validator runs once at boot, surfacing missing env as a clean
// FATAL before the first session. Lazy `getHumePricing()` is the fallback
// for the C4 "probe-failed-at-boot, deferred" path.
let _humePricing = null;
// Audit C5 — LAZY/runtime path. Called from `logTurnCogs` (per-turn) and
// bridge construction. THROWS on misconfig (never process.exit) so a
// fleet missing HUME_USD_PER_CHAR fails the ONE offending session
// (cogsPromise.catch → 1011 cogs_misconfig close) instead of hard-exiting
// the VM and dropping every concurrent user's WebSocket on a crash-loop.
export function getHumePricing() {
  if (_humePricing != null) return _humePricing;
  _humePricing = assertHumePricing();
  return _humePricing;
}
// Audit C5 — BOOT path only. process.exit on misconfig so a broken fleet
// crash-loops loudly at start. Safe here: no sessions exist yet.
export function _humePricingPrimeForBoot() {
  _humePricing = validateHumePricingOrExit();
  return _humePricing;
}
// Test-only — reset the singleton so per-test env tweaks take effect.
export function _humePricingResetForTests() {
  _humePricing = null;
}

// ── Fish pricing (FISH_AUDIO_PHASE_1 §5 #5 / audit round 1 C4) ───────────
//
// Same dual-path pattern as Hume:
//   * `getFishPricing()` — LAZY path, called from logTurnCogs per-turn.
//     Throws on misconfig (catchable). The caller's cogsPromise.catch maps
//     to a clean per-session 1011 close, NEVER crashes the fleet.
//   * `_fishPricingPrimeForBoot()` — BOOT path, called from index.js
//     provisionPricing(). When `mustValidate` is true (any creator in this
//     fleet may route to fish), validates and process.exits on failure so
//     a broken config crash-loops loudly at start. When `mustValidate` is
//     false (no fish creators), sets a probeFailed flag without exiting —
//     subsequent getFishPricing() calls throw locally to fail one session
//     instead of the whole fleet. Round 2 Small + round 3 S6 conditional.
let _fishPricing = null;
let _fishProbeFailed = false;

export function getFishPricing() {
  if (_fishPricing != null) {
    // Audit round 3 M-R2-5 — once-cached forever (matches Hume / Cartesia
    // house style). But if the env's FISH_QUOTED_AT differs from the
    // cached value, log a one-line warn so a rotation-typo / stale-cache
    // condition surfaces in Fly logs. We do NOT re-read the env (that
    // would break audit trail consistency mid-session); rotation requires
    // a VM restart.
    const envQuoted = process.env.FISH_QUOTED_AT;
    if (envQuoted && envQuoted !== _fishPricing.quotedAt) {
      // eslint-disable-next-line no-console
      console.warn(
        `[fish-bridge] cached pricing quotedAt=${_fishPricing.quotedAt} differs from env=${envQuoted} — rotation requires VM restart`,
      );
    }
    return _fishPricing;
  }
  // Audit round 3 M6 — when the boot probe deferred, RETRY the assertion
  // here rather than caching the failure state. If an admin sets
  // FISH_USD_PER_CHAR via `flyctl secrets set` (which restarts the VM
  // anyway) OR flips a creator to fish via the admin UI (which does NOT
  // restart), a subsequent getFishPricing() call now picks up the fresh
  // env on success. On continued failure, the per-session catch in
  // logTurnCogs still maps to a clean 1011 cogs_misconfig close — only
  // the one offending session fails, never the fleet.
  if (_fishProbeFailed) {
    const r = assertFishPricing(); // throws cleanly on bad env
    _fishPricing = r;
    _fishProbeFailed = false; // recovery point
    return r;
  }
  _fishPricing = assertFishPricing();
  return _fishPricing;
}

/**
 * Boot-time pricing primer. `mustValidate` controls fail-mode:
 *
 *   mustValidate=true  → hard process.exit on misconfig (like Hume). Used
 *     when the fleet's env or any creator's tts_provider says fish is
 *     active. Broken config crash-loops loudly at start.
 *
 *   mustValidate=false → warn-don't-exit. The fleet may not have any fish
 *     creators today; we don't want to crash the whole VM on a missing
 *     env var that no session will ever read. Sets _fishProbeFailed so
 *     subsequent getFishPricing() calls throw a per-session error if a
 *     fish creator suddenly appears.
 *
 * @param {object} opts
 * @param {boolean} opts.mustValidate
 * @returns {{usdPerChar:number, quotedAt:string} | null}
 */
export function _fishPricingPrimeForBoot({ mustValidate = false } = {}) {
  if (mustValidate) {
    _fishPricing = validateFishPricingOrExit();
    _fishProbeFailed = false;
    return _fishPricing;
  }
  try {
    _fishPricing = assertFishPricing();
    _fishProbeFailed = false;
    return _fishPricing;
  } catch (e) {
    _fishPricing = null;
    _fishProbeFailed = true;
    // Audit round 3 S10 — wording: the prime didn't actually probe the
    // creator set, only the env. State that plainly so a future on-caller
    // doesn't conflate "no fish creators" with "FISH_USD_PER_CHAR unset."
    // eslint-disable-next-line no-console
    console.warn(
      `[fish-bridge] WARN at boot: ${e.message} FISH_USD_PER_CHAR was missing/invalid at boot — continuing without fish pricing primed. The next getFishPricing() call retries the assertion (audit M6 in-process recovery); on continued failure the per-session catch maps to a 1011 cogs_misconfig close.`,
    );
    return null;
  }
}

// Test-only — reset the singleton + probeFailed flag.
export function _fishPricingResetForTests() {
  _fishPricing = null;
  _fishProbeFailed = false;
}

let _cartesiaUsdPerChar = null;
let _cartesiaQuotedAt = null;
export function getCartesiaPricing() {
  if (_cartesiaUsdPerChar !== null) {
    return { usdPerChar: _cartesiaUsdPerChar, quotedAt: _cartesiaQuotedAt };
  }
  if (!VOICE_TTS_LAYER_ENABLED) {
    // Cartesia disabled: no need to validate the constants.
    _cartesiaUsdPerChar = 0;
    _cartesiaQuotedAt = '';
    return { usdPerChar: 0, quotedAt: '' };
  }
  const raw = Number(process.env.CARTESIA_USD_PER_CHAR);
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error(
      'CARTESIA_USD_PER_CHAR must be a positive finite number when VOICE_TTS_LAYER_ENABLED=1 (R4-S3 fail-closed)',
    );
  }
  const quoted = String(process.env.CARTESIA_QUOTED_AT || '').trim();
  if (!quoted || !/^\d{4}-\d{2}-\d{2}$/.test(quoted)) {
    throw new Error(
      'CARTESIA_QUOTED_AT must be a YYYY-MM-DD date string when VOICE_TTS_LAYER_ENABLED=1',
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
  //   ttsProvider: 'cartesia' | 'hume' | 'fish',   // REQUIRED (audit C5)
  //   tts?:      { characters, audioBytes, audioSeconds, partial },
  //   cartesia?: { characters, audioBytes, audioSeconds, partial }   // legacy alias
  // }
  // HUME_TTS_PLAN §6.10 + FISH_AUDIO_PHASE_1 §6: `ttsProvider` + `tts` are the
  // new contract; `cartesia` is kept as a legacy alias for back-compat with
  // pre-§6 callers. When BOTH are present, `tts` wins.
  //
  // FISH_AUDIO_PHASE_1 TS-widening audit C5: `ttsProvider` is now REQUIRED.
  // The prior `= 'cartesia'` destructuring default silently masked any caller
  // that forgot the field, mis-tagging fish/hume sessions as cartesia in cogs.
  // v3's NULL-snapshot guard catches the worst case (session-side mismatch),
  // but defense-in-depth at the function boundary is cheaper than dashboard
  // forensics. Fail loud here when undefined.
  //
  // When `tts` is present, legs 3+4 are written with real values + provider
  // tag in metadata. When absent (α' off), legs 3+4 = 0 with cartesia_pending
  // flag for back-compat dashboards.
  async function logTurnCogs(payload) {
    const {
      userId, sessionId, turnNumber,
      inputSeconds = 0, outputSeconds = 0, usageMetadata = null,
      ttsProvider = 'cartesia',
      // HUME_TTS_PLAN §6.9 / audit-C1 — when the Hume bridge's per-turn
      // hard cap fired during this turn, the proxy sets the latch and
      // passes it here. Tags metadata.tts_cap_exceeded so the §6.12
      // dashboard can surface the (should-be-near-zero) frequency without
      // a second cogs writer racing this one.
      humeCapExceeded = false,
    } = payload;
    // Audit C5 — validate ttsProvider is one of the allowlisted values when
    // present. The default 'cartesia' covers cogs-rpc.test.js's 23 fixtures
    // that intentionally don't pass the field (they test RPC error paths,
    // not provider routing). A non-cartesia/hume/fish value in payload is
    // a real bug — surface loud rather than silently billing as cartesia.
    if (ttsProvider !== 'cartesia' && ttsProvider !== 'hume' && ttsProvider !== 'fish') {
      throw new Error(`logTurnCogs: ttsProvider must be cartesia|hume|fish (got ${String(ttsProvider)})`);
    }
    // Audit S3 (unit-wide) — accept `tts` (new) or `cartesia` (legacy
    // alias for back-compat with pre-§6 callers) in one expression.
    const tts = payload.tts ?? payload.cartesia ?? null;

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
    if (tts) {
      // HUME_TTS_PLAN §6.5 — provider-aware metadata. tts_provider tagged
      // on every cogs row so the aggregator can group by provider without
      // joining sessions. tts_quoted_at carries provider-specific rate
      // provenance; tts_partial flags hangs/timeouts for reconciliation.
      meta.tts_provider = ttsProvider;
      // FISH_AUDIO_PHASE_1 §6 + audit C2 — 3-arm pricing site. Pre-fix
      // binary ternary collapsed `'fish'` to cartesia rate (~$50/M chars)
      // when Fish is ~$15/M, defeating the cost lever AND mis-billing every
      // Fish session in dashboards. Same shape mirrored at the leg-3+4
      // computation below.
      const pricing = ttsProvider === 'hume' ? getHumePricing()
                    : ttsProvider === 'fish' ? getFishPricing()
                    :                          getCartesiaPricing();
      meta.tts_quoted_at = pricing.quotedAt;
      if (tts.partial) meta.tts_partial = true;
      // Back-compat keys retained until dashboards are re-deployed for the
      // §6.12 aggregator rewrite. Cartesia-specific keys only get written
      // when provider=cartesia; otherwise they'd be misleading.
      if (ttsProvider === 'cartesia') {
        meta.cartesia_quoted_at = pricing.quotedAt;
        if (tts.partial) meta.cartesia_partial = true;
      }
      // FISH_AUDIO_PHASE_1 §6 — provider-tagged metadata mirror of the
      // cartesia branch above. Dashboard reads `meta.fish_quoted_at` and
      // `meta.fish_partial` for per-provider provenance/timeout reconciliation.
      if (ttsProvider === 'fish') {
        meta.fish_quoted_at = pricing.quotedAt;
        if (tts.partial) meta.fish_partial = true;
      }
    } else {
      // Pre-α' rows: keep the deferral flag for dashboard bucketing.
      meta.cartesia_pending = true;
      meta.tts_provider = ttsProvider; // still tag the env-resolved default
    }
    if (humeCapExceeded) {
      meta.tts_cap_exceeded = true;
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

    // TTS legs 3 + 4 — populated only when α' is on (caller passed `tts`).
    // Cost computed at call-time so the kill-switch at module-load failure
    // (R4-S3) can still fire. Provider-aware pricing per HUME_TTS_PLAN §6.10.
    let ttsChars = 0;
    let ttsCost = 0;
    let ttsAudioSeconds = 0;
    if (tts) {
      // FISH_AUDIO_PHASE_1 §6 + audit C2 — 3-arm pricing site. Pre-fix
      // binary ternary collapsed `'fish'` to cartesia rate (~$50/M chars)
      // when Fish is ~$15/M, defeating the cost lever AND mis-billing every
      // Fish session in dashboards. Same shape mirrored at the leg-3+4
      // computation below.
      const pricing = ttsProvider === 'hume' ? getHumePricing()
                    : ttsProvider === 'fish' ? getFishPricing()
                    :                          getCartesiaPricing();
      ttsChars = Math.max(0, Math.round(tts.characters || 0));
      ttsCost = Number((ttsChars * pricing.usdPerChar).toFixed(6));
      ttsAudioSeconds = Number((tts.audioSeconds || 0).toFixed(4));
    }

    try {
      // HUME_TTS_PLAN §6.10 — call v2 directly with p_tts_service. The v1
      // shim still works (it forwards with p_tts_service='cartesia') but
      // calling v2 explicitly is the only way Hume cogs lands correctly.
      const { error } = await supabase.rpc('cogs_insert_turn_voice_v2', {
        p_user_id: userId,
        p_session_id: sessionId,
        p_turn_number: turnNumber,
        p_gemini_audio_in_seconds: Number((inputSeconds || 0).toFixed(4)),
        p_gemini_audio_in_cost:    Number(inputCost.toFixed(6)),
        p_gemini_audio_out_tokens: audioOutTokens,
        p_gemini_audio_out_cost:   Number(audioOutCost.toFixed(6)),
        p_tts_service:             ttsProvider,
        p_tts_provider:            ttsProvider,
        p_tts_characters:          ttsChars,
        p_tts_cost:                ttsCost,
        p_tts_audio_seconds:       ttsAudioSeconds,
        p_environment:             env,
        p_metadata:                meta,
      });
      if (error) {
        console.error('[cogs_insert_turn_voice_v2]', error);
        captureException(error, { op: 'cogs_insert_turn_voice_v2', sessionId, userId, turnNumber, ttsProvider });
        recordFailure(sessionId);
        return { ok: false };
      }
      recordSuccess(sessionId);
      return { ok: true, fallback: isFallback };
    } catch (e) {
      console.error('[cogs_insert_turn_voice_v2] exception', e);
      captureException(e, { op: 'cogs_insert_turn_voice_v2', sessionId, userId, turnNumber, ttsProvider });
      recordFailure(sessionId);
      return { ok: false };
    }
  }

  // DECOUPLED_BRAIN_PLAN P1-5.1b — the per-leg token COGS writer for the
  // decoupled brain. ONE call per leg (paraphrase OR deep-answer), at the
  // moment that leg resolves (NOT batched at turn_complete — they finish
  // at different times and each bills-on-barge independently, P0-4a).
  //
  // `leg` is the bridge's terminal `{final,...}` OR its thrown `.partial`
  // (M6). Both carry `operation` + `modelId` + `usdPer*Token` +
  // `*Tokens` + `quotedAt`; `.partial` adds `billed:true` and may have
  // NULL token counts (usageMetadata never arrived before the abort).
  // A billed call MUST be cogs-visible — so on a partial we coerce null
  // tokens → 0, write the row anyway, and flag `billed_partial` so it is
  // a VISIBLE estimate, never a silent gap (kill-switch stays fed).
  // Step-2 (Gemini→Haiku failover) — the valid leg operations. The
  // failover leg ('brain_deep_answer_failover') is the Haiku call that
  // ran when Gemini 503'd; it writes under service='anthropic' so the
  // 150% kill-switch sees the spend AND it never collides with the
  // primary Gemini leg's idempotency slot (migration 20260523000004).
  const BRAIN_LEG_OPERATIONS = new Set([
    'brain_deep_answer',
    'brain_paraphrase',
    'brain_deep_answer_failover',
  ]);
  async function logBrainLeg(payload) {
    const { userId, sessionId, turnNumber, leg } = payload;
    if (!leg || !BRAIN_LEG_OPERATIONS.has(leg.operation)) {
      captureException(new Error('logBrainLeg: missing/invalid leg.operation'), {
        op: 'cogs_insert_brain_leg', sessionId, userId, turnNumber,
        operation: leg && leg.operation,
      });
      recordFailure(sessionId);
      return { ok: false };
    }
    // Step-2 audit C1 — provider attribution travels on the leg. Gemini
    // (primary) legs omit `service` → default 'gemini'; the Haiku failover
    // bridge sets service='anthropic'. Anything outside the two-provider
    // set is a bridge bug — coerce to 'gemini' is WRONG (mis-attributes
    // Haiku spend), so we trust the bridge but the RPC re-guards (22023).
    const service = leg.service === 'anthropic' ? 'anthropic' : 'gemini';
    const isPartial = leg.billed === true;
    const inTok  = Number.isFinite(leg.inputTokens)  ? leg.inputTokens  : 0;
    const outTok = Number.isFinite(leg.outputTokens) ? leg.outputTokens : 0;
    const inCost  = Number((inTok  * (leg.usdPerInputToken  || 0)).toFixed(6));
    const outCost = Number((outTok * (leg.usdPerOutputToken || 0)).toFixed(6));
    const meta = {
      source: env,
      model: leg.modelId || null,
      quoted_at: leg.quotedAt || null,
      // P1-9 whole-build audit C3 — `thoughts_tokens` lands in cogs_log
      // metadata so the PROD_DEPLOY_GATE 1c manual-session checklist
      // has a real datum to read ("thinking-off honored on the live
      // path"). null = SDK didn't surface thoughtsTokenCount (e.g.,
      // model family where the field is absent); 0 = surfaced and
      // honored; >0 = thinking was emitted (M1 (A)-gate red flag).
      thoughts_tokens: Number.isFinite(leg.thoughtsTokens) ? leg.thoughtsTokens : null,
    };
    // A partial with no usage = a billed call we could not size. Flag it
    // so reconciliation can true it up; the row still exists (units/cost
    // 0) rather than vanishing from the kill-switch's view.
    if (isPartial && !Number.isFinite(leg.inputTokens) && !Number.isFinite(leg.outputTokens)) {
      meta.token_estimate_unavailable = true;
    }
    try {
      const { error } = await supabase.rpc('cogs_insert_brain_leg', {
        p_user_id: userId,
        p_session_id: sessionId,
        p_turn_number: turnNumber,
        p_operation: leg.operation,
        p_input_tokens: inTok,
        p_output_tokens: outTok,
        p_input_cost: inCost,
        p_output_cost: outCost,
        p_environment: env,
        p_billed_partial: isPartial,
        p_metadata: meta,
        p_service: service,
      });
      if (error) {
        console.error('[cogs_insert_brain_leg]', error);
        captureException(error, {
          op: 'cogs_insert_brain_leg', sessionId, userId, turnNumber,
          operation: leg.operation, billed_partial: isPartial,
        });
        recordFailure(sessionId);
        return { ok: false };
      }
      recordSuccess(sessionId);
      return { ok: true, billedPartial: isPartial };
    } catch (e) {
      console.error('[cogs_insert_brain_leg] exception', e);
      captureException(e, {
        op: 'cogs_insert_brain_leg', sessionId, userId, turnNumber, operation: leg.operation,
      });
      recordFailure(sessionId);
      return { ok: false };
    }
  }

  // Cleanup on session close — caller invokes when WS closes for any reason.
  function dropSession(sessionId) {
    failures.delete(sessionId);
  }

  return { logTurnCogs, logBrainLeg, dropSession, _consecutiveFailures };
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
