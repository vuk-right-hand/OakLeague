// FishTTSBridge — Pipeline α' TTS leg (Fish Audio s2-pro over WebSocket).
//
// FISH_AUDIO_PHASE_1 §5. Mirrors CartesiaTTSBridge's public interface so the
// orchestrator can swap providers via voice_tickets.tts_provider at
// session-open. KEY DIFFERENCES from cartesia-bridge.js:
//   1. PER-TURN WebSocket lifecycle. Fish has no protocol-level cancel and
//      no reconnect/resume token. Each turn = new WS open + start + text* +
//      stop + close. cartesia is the opposite (one long-lived WS, contexts
//      multiplex via context_id).
//   2. MessagePack envelopes both directions (not JSON). The byteOffset-aware
//      decode pattern is load-bearing: Node's Buffer can have a non-zero
//      byteOffset under TCP fragmentation, and passing the raw Buffer to
//      msgpack.decode() silently reads garbage. Wrapping via
//      `new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)` is the
//      verified-correct shape (see @msgpack/msgpack#212).
//   3. `perMessageDeflate: false`. DEFLATE corrupts msgpack envelopes —
//      Fish's docs are explicit, and Phase 0.5 wire spike confirmed.
//   4. `flush()` is a NO-OP CONSTANT (audit C4 round 2 / plan v4 §5 #4).
//      Phase 0.5 #4 verified that Fish's flush DOES trigger synth on a held
//      buffer, but coupling to Fish's flush semantics would re-introduce the
//      Cartesia-context-coupling shape we just fixed (e5cf446). Stays no-op
//      in Phase 1; separate followup PR may enable if useful.
//   5. `ttsFinalizeTimeoutMs = 34000` per Phase 0.5 #6 measurement
//      (stop → finish ≈ 16.8s at 45.5s of audio; doubled with floor 30s).
//   6. Speculative `prewarmTurn()` is MANDATORY per Phase 0.5 #2 (reopen p99
//      = 1229ms vs cartesia ~90ms). Caller opens WS at user-turn-start to
//      mask the latency against brain processing time.
//   7. Inbound PCM is 16kHz mono (not 24kHz like cartesia). mimeType is
//      `audio/pcm;rate=16000`. No resampler needed — verified Phase 0.5 #1.
//   8. Auto-fallback emission (audit round 3 C4). On WS open failure or
//      pre-first-audio error, the bridge emits a `fallback_required` event
//      so the orchestrator can re-dispatch the SAME turn to cartesia-bridge.
//      Once first audio has flowed, no fallback — voice-mid-turn-switch is
//      worse than silence. NOTE: speculative prewarm + fallback are
//      implemented in a follow-up commit; this scaffold lands the
//      per-turn lifecycle + msgpack + event taxonomy first.
//
// Wire protocol (verified Phase 0.5 spike 2026-06-05 + docs.fish.audio):
//
//   Connection: wss://api.fish.audio/v1/tts/live
//   Headers:    Authorization: Bearer <FISH_API_KEY>
//               model: s2-pro
//   Encoding:   @msgpack/msgpack v3 (both directions)
//
//   Client → Server (all msgpack-encoded):
//     start:  { event:'start', request:{ reference_id, format:'pcm',
//                sample_rate:16000, latency:'low',
//                temperature:0.7, top_p:0.7 } }
//     text:   { event:'text', text:'…' }
//     flush:  { event:'flush' }   (NO-OP in Phase 1)
//     stop:   { event:'stop' }
//
//   Server → Client (all msgpack-encoded):
//     audio:  { event:'audio', audio:<Uint8Array of PCM 16k mono LE> }
//     finish: { event:'finish', reason:'stop'|'error', message?:string }
//
// Close-code taxonomy (proxy layer maps these — orchestrator owns which
// close-code rides which bridge error; the bridge only emits semantic
// `error.code` strings):
//   4009 cartesia_no_voice   — bridge emits 'tts_synthesis_error'; orchestrator
//                              maps to 4009 when service='fish' too (the
//                              service column in cogs_log distinguishes
//                              providers, not the close code)
//   4010 model_not_compatible (cartesia + 2.5-native-audio) — N/A for fish
//   4011 tts_reconnecting    — N/A for fish (no reconnect; per-turn WS)
//   4012 backpressure        — applies to USER WS, not fish WS

import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { encode, decode } from '@msgpack/msgpack';

const FISH_WSS = 'wss://api.fish.audio/v1/tts/live';
const DEFAULT_MODEL = 's2-pro';
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_OPEN_TIMEOUT_MS = 5000;
const DEFAULT_FINALIZE_TIMEOUT_MS = 34000; // Phase 0.5 #6
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TOP_P = 0.7;
const DEFAULT_PREWARM_IDLE_TIMEOUT_MS = 25000; // Audit round 3 C2 — orphan-prewarm self-close.
// Audit round 3 C-R2-2 — Gemini's `outputTranscription.text` chunks are
// frequently 1-5 chars. Per-chunk flush at that cadence yields 50+ fps of
// msgpack frames. Phase 0.5 used batched text, not measured at Gemini's real
// streaming rate. Leading-edge flush + cooldown bounds the flush rate to
// ~1 per debounce window while preserving first-audio latency (the FIRST
// sendText still flushes immediately).
const DEFAULT_FLUSH_DEBOUNCE_MS = 150;
const INBOUND_MAX_PAYLOAD = 1024 * 1024;       // Audit round 3 S2 — 1 MB.

// Audit round 3 C4 + round-2 M-R2-3 — `Authorization: Bearer <FISH_API_KEY>`
// rides the WS open. The `ws` lib's open-failure errors can include the
// request headers in inspectable fields (Sentry's default JSON serializer
// enumerates them). Sanitize any error message before emitting it on our
// `error` channel so a 401 stack never leaks the bearer.
//
// Charset widened from `[A-Za-z0-9._-]+` to `[^\s"',}]+` so the helper also
// scrubs base64-shaped tokens (`+/=`) — Cartesia / future-provider tokens
// could ride the same emit paths via Promise.all error bundling.
const BEARER_REDACT_RE = /(Bearer\s+)[^\s"',}]+/gi;
const AUTH_HEADER_REDACT_RE = /(authorization["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi;
function sanitizeMessage(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(BEARER_REDACT_RE, '$1<redacted>')
    .replace(AUTH_HEADER_REDACT_RE, '$1<redacted>');
}

// ── Pricing fail-closed (plan §5 #5 / audit round 1 C4) ──────────────────
//
// FISH_USD_PER_CHAR + FISH_QUOTED_AT must be Fly secrets validated at
// proxy boot when fish is in the per-creator routing set. Same pattern as
// HUME_USD_PER_CHAR / HUME_QUOTED_AT — no code default, ever (silent
// $0-bill would corrupt cogs).
//
// QUOTED_AT enforces YYYY-MM-DD parity with cartesia/hume so post-hoc
// reconciliation when Fish rotates their rate card stays trivial.
const FISH_QUOTED_AT_RE = /^\d{4}-\d{2}-\d{2}$/;

// Per-creator playback speed via prosody.speed in the start envelope.
//
// Range: `[0.6, 1.5]` — IDENTICAL to cartesia-bridge's window AND to the
// `creators.tts_speed` DB CHECK in migration 20260511000006. Fish wire
// actually accepts [0.5, 2.0], but the bridge is pinned to the DB range so
// a future column widening forces BOTH bridges to update together
// (CLAUDE.md schema-blast-radius rule). Audit M1 (2026-06-09): the
// previous version of this guard accepted the wider Fish range as
// "defense-in-depth," which was actually drift waiting to happen —
// same creator speed would work on Fish but null-out on cartesia fallback.
//
// Omit policy mirrors cartesia-bridge's shouldSendSpeed(): 1.0 (or null) →
// omit the `prosody` field entirely. Sending speed:1.0 is functionally
// equivalent to omitting but couples us to Fish's exact param naming —
// keep wire payloads minimal so a future Fish rename is a one-line bridge
// change, not a behavior change for the no-op default.
//
// Exported so tests assert the predicate directly (parity with
// assertFishPricing / sanitizeForTts).
export function shouldSendSpeed(v) {
  return typeof v === 'number' && Number.isFinite(v) && v !== 1.0 && v >= 0.6 && v <= 1.5;
}

/**
 * Per-turn / lazy path. THROWS on misconfig — proxy-handlers catches per
 * session and maps to a clean 1011 cogs_misconfig close. NEVER process.exit
 * here: a single misconfigured env at runtime must fail one session, not
 * crash the Fly VM and drop every concurrent user mid-turn on a crash-loop.
 */
export function assertFishPricing({ env = process.env } = {}) {
  const raw = env.FISH_USD_PER_CHAR;
  const quotedAt = env.FISH_QUOTED_AT;
  const n = raw != null ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `FISH_USD_PER_CHAR missing or non-finite-positive (got ${JSON.stringify(raw)}). Refusing — silent $0 billing would corrupt cogs.`,
    );
  }
  if (!quotedAt || typeof quotedAt !== 'string' || !FISH_QUOTED_AT_RE.test(quotedAt)) {
    throw new Error(
      `FISH_QUOTED_AT must be a YYYY-MM-DD date string (got ${JSON.stringify(quotedAt)}; audit trail required).`,
    );
  }
  return { usdPerChar: n, quotedAt };
}

/**
 * Boot-path wrapper. Returns the same shape as assertFishPricing on success,
 * but on failure logs FATAL + calls exit(1) instead of throwing.
 *
 * Audit round 1 C4 (warn-not-exit conditional): the orchestrator's
 * `_fishPricingPrimeForBoot` wrapper in proxy-handlers can OPTIONALLY swap
 * the `exit` callback for a no-op + setProbeFailed flag, so a fleet that
 * has fish defined but no creator using it doesn't crash on missing FISH_*
 * env. Default behavior (no exit override) is hard-exit, matching hume.
 *
 * NEVER call off the boot path — use assertFishPricing() per-turn.
 */
export function validateFishPricingOrExit({
  env = process.env,
  exit = (n) => process.exit(n),
  log = console.error,
} = {}) {
  try {
    return assertFishPricing({ env });
  } catch (e) {
    log(`[fish-bridge] FATAL: ${e.message} Refusing to boot.`);
    return exit(1);
  }
}

// Decode a msgpack-encoded WS frame. Buffers received from Node's `ws`
// library have an underlying ArrayBuffer that may include earlier traffic
// — passing the Buffer raw to msgpack.decode() works in many cases but
// silently mis-reads on TCP fragmentation. Always wrap via the explicit
// byteOffset/byteLength shape (@msgpack/msgpack issue #212).
function decodeMsgpackFrame(buf) {
  const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return decode(view);
}

// Strip markdown syntax characters before handing text to TTS.
//
// Why this exists: fish s2-pro VOCALIZES asterisks. A brain answer
// containing `**important**` or `*disastrous*` was rendered with the
// asterisks audibly mispronounced as something like "asterous" during
// localhost dogfood (2026-06-09). Cartesia silently swallows the same
// characters today; running the sanitizer in the cartesia path is a
// no-op for plain text and prevents a future provider-tolerance
// regression — and saves the asterisk-chars from being billed.
//
// PRIMARY CALL SITE IS UPSTREAM (`ttsSendText` in proxy index.js), not
// inside the bridge. The bridge keeps its own idempotent sanitize pass
// as defense-in-depth for any future direct caller, but the orchestrator
// already filters chunks before they reach the wire — that's where the
// chunk → buffer-append → fallback-replay invariants live.
//
// Audit C2/C4 (2026-06-09): the previous version of this sanitizer
// stripped `^#{1,6}\s+` headers and all `[...]` content. Headers were
// dropped because a brain answer like "# is the comment character in
// Python" had its `#` silently eaten. Bare-bracket strip was dropped
// because per-chunk regex on Gemini's 1-5-char transcript chunks can't
// reliably match `[text](url)` link spans, AND legitimate parentheticals
// like "the formula is [x squared + y squared]" lose semantics. We
// accept the rare `[1]` citation getting vocalized — a far smaller bug
// than mid-sentence content loss.
//
// Streaming limitation that REMAINS: a `[text](url)` markdown link split
// across chunks (`[text](htt` + `p://...)`) won't match the link regex.
// Cross-chunk markdown links are vanishingly rare in voice-mode brain
// output (Gemini knows it's speaking aloud) — ACCEPTED for v1.
//
// Order matters: link-rewrite BEFORE asterisk-strip so the link's
// inner text survives. Asterisks BEFORE backticks BEFORE strikethrough
// so a malformed `**\`code\`**` collapses to `code` cleanly. The order
// is invariant — if you reorder, run all sanitizer tests.
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\([^)]+\)/g;
const MARKDOWN_ASTERISK_RE = /\*+/g;
const MARKDOWN_BACKTICK_RE = /`+/g;
const MARKDOWN_STRIKE_RE = /~~/g;
export function sanitizeForTts(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(MARKDOWN_LINK_RE, '$1')
    .replace(MARKDOWN_ASTERISK_RE, '')
    .replace(MARKDOWN_BACKTICK_RE, '')
    .replace(MARKDOWN_STRIKE_RE, '');
}

export class FishTTSBridge extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey                 Fish Audio Bearer token.
   * @param {string} opts.voiceId                Fish reference_id (creator clone).
   * @param {string} [opts.model='s2-pro']
   * @param {number} [opts.sampleRate=16000]
   * @param {number} [opts.temperature=0.7]
   * @param {number} [opts.topP=0.7]
   * @param {number} [opts.openTimeoutMs=5000]
   * @param {number} [opts.finalizeTimeoutMs=34000]  Phase 0.5 #6.
   */
  constructor({
    apiKey,
    voiceId,
    pricing,
    model = DEFAULT_MODEL,
    sampleRate = DEFAULT_SAMPLE_RATE,
    temperature = DEFAULT_TEMPERATURE,
    topP = DEFAULT_TOP_P,
    // Per-creator playback speed. NULL/1.0 → omit `prosody` entirely
    // (Fish default). See shouldSendSpeed() above for omit policy.
    ttsSpeed = null,
    openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS,
    finalizeTimeoutMs = DEFAULT_FINALIZE_TIMEOUT_MS,
    // Audit round 3 C1 — Phase 0.5 #4 measured "audio bytes BEFORE flush = 0":
    // Fish only synthesizes on flush or stop. With flushPerChunk=true,
    // sendText fires a leading-edge flush + a cooldown debounce so audio
    // streams chunk-by-chunk WITHOUT a per-frame flush storm. Default ON.
    // Public flush(expectedContextId) remains a no-op per plan v4 §5 #4.
    flushPerChunk = true,
    // Audit round 3 C-R2-2 — cooldown between flush events. Leading-edge
    // flush on the first sendText preserves first-audio latency; subsequent
    // flushes coalesce to ~1 per debounce window. Set to 0 to disable
    // (one flush per sendText — testing/special-case only).
    flushDebounceMs = DEFAULT_FLUSH_DEBOUNCE_MS,
    // Audit round 3 C2 — orphan-prewarm self-close. If turnStart never arrives
    // (e.g., user bails mid-thought), the prewarmed WS self-closes after this
    // idle window. Set generous enough to cover normal brain time + barge-in
    // grace, tight enough to bound Fish concurrency burn on a leaked turn:
    // ~25s covers Brain p99 (~12-15s) + barge-in grace.
    prewarmIdleTimeoutMs = DEFAULT_PREWARM_IDLE_TIMEOUT_MS,
  } = {}) {
    super();
    if (!apiKey) throw new Error('FISH_API_KEY missing');
    if (!voiceId) throw new Error('voiceId missing');
    // Pricing fail-closed (parity with hume-bridge audit C3): pricing must
    // be validated at proxy boot and threaded through to the bridge
    // constructor. Bridge re-asserts shape so a future direct caller
    // can't bypass validateFishPricingOrExit().
    //
    // Audit round 3 M4 — currently a contract assertion only. The orchestrator
    // owns COGS attribution (logTurnCogs in proxy-handlers.js reads its own
    // singleton via getFishPricing()). _pricing is stored for future use
    // (e.g., a per-turn char cap matching Hume's HUME_CHARS_PER_TURN_HARD_CAP)
    // and to make the "boot validated my env" guarantee inspectable.
    if (!pricing || typeof pricing !== 'object'
        || !Number.isFinite(pricing.usdPerChar) || pricing.usdPerChar <= 0
        || typeof pricing.quotedAt !== 'string' || pricing.quotedAt.length === 0) {
      throw new Error('FISH_PRICING_NOT_VALIDATED — caller must pass pricing:{usdPerChar:number>0, quotedAt:string} from validateFishPricingOrExit()');
    }
    this._pricing = { usdPerChar: pricing.usdPerChar, quotedAt: pricing.quotedAt };
    this._apiKey = apiKey;
    this._voiceId = voiceId;
    this._model = model;
    this._sampleRate = sampleRate;
    this._temperature = temperature;
    this._topP = topP;
    // Coerce strings (supabase-js returns numeric columns as strings; the
    // proxy already coerces at the boundary but defense-in-depth here so a
    // future direct caller can't bypass the omit policy). Range pinned to
    // `creators.tts_speed` DB CHECK [0.6, 1.5] (cartesia parity, audit M1).
    const speedNum = typeof ttsSpeed === 'number'
      ? ttsSpeed
      : (ttsSpeed != null ? Number(ttsSpeed) : NaN);
    this._ttsSpeed = (Number.isFinite(speedNum) && speedNum >= 0.6 && speedNum <= 1.5)
      ? speedNum
      : null;
    this._openTimeoutMs = openTimeoutMs;
    this._finalizeTimeoutMs = finalizeTimeoutMs;
    // Coerce to a strict boolean — accept any truthy/falsy input but the
    // stored field is canonical for predicate use.
    this._flushPerChunk = flushPerChunk !== false;
    this._flushDebounceMs = Number.isFinite(flushDebounceMs) && flushDebounceMs >= 0
      ? flushDebounceMs : DEFAULT_FLUSH_DEBOUNCE_MS;
    this._prewarmIdleTimeoutMs = prewarmIdleTimeoutMs;
    // Audit round 3 C-R2-2 — flush cooldown state.
    // _flushCooldownTimer: setTimeout handle while in cooldown.
    // _flushPending: true if sendText was called during cooldown (a tail
    //   flush will fire when cooldown expires to drain any buffered text).
    this._flushCooldownTimer = null;
    this._flushPending = false;

    this._ws = null;
    this._closed = false;
    this._currentContextId = null;
    this._turnDead = false;
    // Audit round 3 M2 — _cancelled gates fallback_required emission across
    // BOTH the _onClose AND finish:error paths so cancel-then-finish:error
    // and cancel-then-WS-close behave consistently. cancel() sets it; the
    // next turnStart() resets it.
    this._cancelled = false;
    // Audit round 3 C5 — set on any inbound `finish` event. Gates audio_out
    // emission in _onMessage so late chunks (Fish protocol doesn't promise
    // finish is terminal) cannot drain into the next turn's stream.
    this._turnFinished = false;
    this._charsThisTurn = 0;
    this._audioBytesThisTurn = 0;
    this._lastChunkAtMs = 0;
    this._sentStart = false;
    this._sentFirstChunkOfTurn = false;
    this._firstAudioReceived = false;
    // _currentTurnTextSample is bounded to 500 chars for diagnostic logging
    // ONLY — the orchestrator owns the canonical text buffer (audit round 3
    // M1). Do NOT use textSample for fallback re-dispatch; use the
    // orchestrator's own copy of the text that was streamed to sendText().
    this._currentTurnTextSample = '';
    // Speculative pre-open state (Phase 0.5 #2 — reopen p99 = 1229ms).
    this._prewarmPromise = null;
    this._prewarmContextId = null;
    // Audit round 3 C2 — idle-cancel timer for prewarmed-but-not-started WS.
    this._prewarmIdleTimer = null;
  }

  /**
   * No-op for fish. The bridge is logically "open" without any WS connected
   * — the WS lifecycle is per-turn. Cartesia parity callers that always
   * invoke open() before turnStart() get a successful resolve. Use
   * prewarmTurn() to overlap WS open with brain processing.
   *
   * Audit round 3 S4 — emits `setup_complete` for orchestrator parity with
   * cartesia, but on fish this fires synchronously without a WS being open
   * yet (the event name is a parity-with-cartesia signal, not "the wire
   * is hot"). Use the `prewarm_ok` event to know "wire is hot" on fish.
   */
  async open() {
    if (this._closed) throw new Error('bridge_closed');
    this.emit('event', { kind: 'setup_complete', at: Date.now() });
  }

  /**
   * Speculative pre-open. Phase 0.5 #2 measured Fish TTFA p99 = 1229ms vs
   * cartesia's ~90ms — the orchestrator MUST overlap WS open with brain
   * processing to mask the latency. prewarmTurn fires the WS open in the
   * background; turnStart() later awaits the same promise before sending
   * the start frame.
   *
   * Fire-and-forget at the call site. The synchronous body does NOT throw.
   * BUT: the internal `_prewarmPromise` IS rejectable on cancel/open-failure;
   * callers MUST NOT capture this promise (cancel() attaches its own
   * swallow-catch — round 2 C-R2-1). Observe outcomes via `prewarm_ok`
   * (success) and `fallback_required.code='prewarm_open_failed'` (failure)
   * events instead.
   *
   * Idempotent — calling prewarmTurn twice is a no-op for the second
   * call. Calling after a prior prewarm whose WS already opened is also
   * a no-op (the WS is still warm).
   *
   * @param {string} contextId  For observability only — Fish's wire has
   *   no per-message context, so a mismatched contextId at turnStart is
   *   non-fatal (we just use the warm WS regardless).
   */
  prewarmTurn(contextId) {
    if (this._closed) return;
    if (this._ws) return;
    if (this._prewarmPromise) return;
    this._prewarmContextId = typeof contextId === 'string' ? contextId : null;
    // Audit round 3 C2 — arm the idle-cancel timer. If turnStart doesn't
    // arrive within _prewarmIdleTimeoutMs, self-close so we don't leak a
    // Fish concurrency slot on a turn the user bailed on.
    this._armPrewarmIdleTimer();
    this._prewarmPromise = this._openWsOnly().then(
      () => {
        // Audit round 3 C2 — caller (cancel/close) may have run between
        // open kickoff and resolution. If we're now cancelled/closed, the
        // resolved WS is orphan — close it immediately and don't emit
        // prewarm_ok (it would be a lie + spurious orchestrator signal).
        if (this._closed || this._cancelled) {
          this._closeCurrentWs(1000, 'prewarm_orphan_cleanup');
          return;
        }
        // Audit round 3 M5 — observable success signal so the orchestrator
        // can make a smarter routing decision before paying the brain cost.
        this.emit('event', {
          kind: 'prewarm_ok',
          contextId: this._prewarmContextId,
        });
      },
      (e) => {
        // Audit round 3 C3 — short-circuit on cancel/close so an
        // intentionally-aborted prewarm doesn't emit fallback_required and
        // make the orchestrator dispatch a turn the user already interrupted.
        if (this._closed || this._cancelled || this._turnDead) {
          throw e;
        }
        // Audit round 3 C-R2-3 — emit ONE event per failure path. Dropped the
        // `prewarm_failed` emission that was here in round-1 M5: an
        // orchestrator subscribing to BOTH `prewarm_failed` and
        // `fallback_required` for the same underlying failure would
        // double-dispatch to cartesia. `fallback_required` is the canonical
        // "switch to cartesia" signal; its `code='prewarm_open_failed'` is
        // enough discriminator for the orchestrator to also short-circuit
        // brain spend (no separate prewarm_failed needed).
        const safeMsg = sanitizeMessage(e?.message || 'fish_ws_open_failed');
        this.emit('event', {
          kind: 'fallback_required',
          code: 'prewarm_open_failed',
          message: safeMsg,
          contextId: this._prewarmContextId,
        });
        throw e;
      },
    );
  }

  _armPrewarmIdleTimer() {
    if (this._prewarmIdleTimer) return;
    this._prewarmIdleTimer = setTimeout(() => {
      // Self-close + clear state. Don't emit fallback_required — orchestrator
      // chose not to consume this prewarm, so there's no turn to fallback.
      this._prewarmIdleTimer = null;
      if (this._ws && !this._sentStart) {
        this._closeCurrentWs(1000, 'prewarm_idle_timeout');
      }
      this._prewarmPromise = null;
      this._prewarmContextId = null;
    }, this._prewarmIdleTimeoutMs);
    // Don't keep the event loop alive on the idle timer; if the proxy
    // intends to exit, this orphan WS isn't worth blocking shutdown for.
    if (typeof this._prewarmIdleTimer.unref === 'function') {
      this._prewarmIdleTimer.unref();
    }
  }

  _clearPrewarmIdleTimer() {
    if (this._prewarmIdleTimer) {
      clearTimeout(this._prewarmIdleTimer);
      this._prewarmIdleTimer = null;
    }
  }

  /**
   * Marks the start of a Fish turn. Awaits any in-flight prewarm, opens
   * a fresh WS if no prewarm happened (or the prewarm failed), then
   * sends the `start` envelope with voice + format. Resolves when start
   * is on the wire; rejects on WS open timeout / failure.
   *
   * Async because Fish's per-turn WS lifecycle differs from cartesia's
   * session-long WS — there's no avoiding a network round-trip on the
   * first turn (mitigated by prewarmTurn()).
   *
   * @param {string} contextId  `<sessionId>:<turnNumber>` for
   *   orchestrator parity with cartesia. Fish wire format has no
   *   per-message context; we keep it for observability + barge-in.
   */
  async turnStart(contextId) {
    if (this._closed) throw new Error('bridge_closed');
    if (!contextId || typeof contextId !== 'string') throw new Error('bad_context_id');
    // Allow turnStart on a prewarmed (but not-yet-started) WS. Block
    // turnStart on an actually-active turn (sentStart=true means we
    // already sent a start envelope on this WS).
    if (this._sentStart) throw new Error('turnStart_while_active');

    // Audit round 3 C2 — turnStart consumed the prewarm; cancel its idle
    // self-close timer before it fires.
    this._clearPrewarmIdleTimer();

    this._currentContextId = contextId;
    this._turnDead = false;
    // Audit round 3 M2 / C5 — reset per-turn gates so a previously-cancelled
    // or previously-finished bridge can take a fresh turn.
    this._cancelled = false;
    this._turnFinished = false;
    this._charsThisTurn = 0;
    this._audioBytesThisTurn = 0;
    this._lastChunkAtMs = 0;
    this._sentFirstChunkOfTurn = false;
    this._firstAudioReceived = false;
    this._currentTurnTextSample = '';

    // Await in-flight prewarm if any. On prewarm failure, the catch
    // above already cleared _ws AND emitted fallback_required — fall
    // through to a fresh open here.
    if (this._prewarmPromise) {
      try {
        await this._prewarmPromise;
      } catch {
        // already handled in prewarmTurn's catch
      }
      this._prewarmPromise = null;
      this._prewarmContextId = null;
    }

    if (!this._ws) {
      try {
        await this._openWsOnly();
      } catch (e) {
        // Open failed during turnStart — emit fallback_required AND
        // rethrow so the caller's await rejects.
        //
        // Audit round 3 M-R2-4 — wrap the rethrow in a fresh Error with a
        // sanitized message. The original `e` might quote the
        // Authorization header (some ws lib failure modes do); a caller
        // that runs `captureException(e)` would otherwise leak the
        // bearer via e.stack/e.message verbatim.
        const safeMsg = sanitizeMessage(e?.message || 'fish_ws_open_failed');
        this.emit('event', {
          kind: 'fallback_required',
          code: 'open_failed',
          message: safeMsg,
          contextId,
        });
        throw new Error(safeMsg);
      }
    }

    this._sendStart();
    this._sentStart = true;
  }

  /**
   * Opens the WS only — does NOT send the start frame. Wires up event
   * handlers (message/close/error) so chunks arriving before the start
   * frame is sent (shouldn't happen, but defensive) are at least logged.
   */
  async _openWsOnly() {
    const ws = new WebSocket(FISH_WSS, {
      headers: {
        Authorization: `Bearer ${this._apiKey}`,
        model: this._model,
      },
      maxPayload: INBOUND_MAX_PAYLOAD,
      perMessageDeflate: false,
    });
    this._ws = ws;
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        try { ws.terminate(); } catch {}
        this._ws = null;
        reject(new Error('fish_open_timeout'));
      }, this._openTimeoutMs);
      ws.once('open', () => {
        clearTimeout(to);
        ws.on('message', (data, isBinary) => this._onMessage(data, isBinary));
        ws.on('close', (code, reason) => this._onClose(code, reason));
        ws.on('error', (e) => this._onError(e));
        resolve();
      });
      ws.once('error', (e) => {
        clearTimeout(to);
        this._ws = null;
        // Audit round 3 M-R2-4 — sanitize the rejected message so any
        // downstream `captureException` / log line never sees the
        // bearer that the `ws` lib might have quoted in 401 errors.
        reject(new Error(sanitizeMessage(e?.message || 'fish_ws_error')));
      });
    });
    // Audit round 3 C2 + round-2 M-R2-1 — this post-await check only fires
    // on the cancel-AFTER-successful-open race (open resolved, then cancel
    // ran microseconds later but before this code). The cancel-DURING-
    // CONNECTING path is handled implicitly: cancel's ws.close on a
    // CONNECTING socket fires the `ws.once('error')` reject above, which
    // propagates through the await and skips this code. Either way the
    // result is the same: _ws gets nulled and Fish doesn't have a leaked
    // open WS that nothing is consuming.
    if (this._closed || this._cancelled || this._turnDead || this._ws !== ws) {
      try { ws.close(1000, 'open_after_cancel'); } catch {}
      if (this._ws === ws) this._ws = null;
      throw new Error('fish_open_aborted_by_cancel');
    }
  }

  /**
   * Sends the `start` envelope on an already-open WS. Fish accepts
   * streamed text immediately after start (no setup_complete equivalent).
   */
  _sendStart() {
    // Field-shape verified against fish-audio-ws-spike.mjs Phase 0.5 #1 which
    // confirmed PCM @ 16k accepted by Fish. The spike INCLUDES `text: ''` in
    // the start envelope; omitting it caused Fish to close the WS pre-first-
    // audio (observed 2026-06-09 during localhost dogfood). The empty string
    // is a no-op synthesis trigger; actual text streams via subsequent
    // `text` events.
    //
    // Audit M5 (2026-06-09): build the request via a single object literal
    // with conditional spread, so a future optional field (e.g. `controls:
    // {...}`) lands as its OWN spread and never accidentally co-mounts on
    // the `prosody` predicate.
    const sendSpeed = shouldSendSpeed(this._ttsSpeed);
    const request = {
      text: '',
      reference_id: this._voiceId,
      format: 'pcm',
      sample_rate: this._sampleRate,
      latency: 'low',
      temperature: this._temperature,
      top_p: this._topP,
      ...(sendSpeed ? { prosody: { speed: this._ttsSpeed } } : {}),
    };
    // Audit M7 — observability for a "creator set speed=1.15 but doesn't
    // sound different" triage call. One line so a future Sentry/grep
    // confirms the bridge actually sent the prosody field.
    this.emit('event', {
      kind: 'tts_config',
      prosody: sendSpeed ? { speed: this._ttsSpeed } : null,
      contextId: this._currentContextId,
    });
    this._sendEvent({ event: 'start', request });
  }

  /**
   * Streams a transcript chunk on the open WS.
   *
   * Audit round 3 C1 — Phase 0.5 #4 measured Fish as a buffer-until-flush
   * architecture. Without flush, audio bytes pre-stop = 0 and the entire
   * turn dumps after `stop` (no streaming TTS).
   *
   * Audit round 3 C-R2-2 — but per-chunk flush at Gemini's 1-5 char chunk
   * cadence yields 50+ fps of msgpack frames, an untested-at-cadence frame
   * rate that could trip Fish's rate-limiting. Leading-edge flush + cooldown
   * (`_flushDebounceMs`) bounds flush rate to ~1 per cooldown window while
   * preserving first-audio latency: the FIRST sendText flushes immediately,
   * subsequent sendTexts during cooldown coalesce into a single tail flush.
   */
  sendText(text) {
    if (!text) return;
    if (this._closed || this._turnDead) return;
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    if (!this._currentContextId) throw new Error('sendText before turnStart');
    if (!this._sentStart) throw new Error('sendText before start');

    // Markdown sanitize before billing chars or sending on the wire. See
    // sanitizeForTts comment for rationale (asterisks/brackets get vocalized
    // by s2-pro otherwise — observed "asterous" mispronunciation on
    // localhost dogfood 2026-06-09). A chunk that's PURELY markdown
    // syntax (e.g. a lone `**`) sanitizes to empty string; bail without
    // billing or sending — no-op msgpack frames are wasted bandwidth.
    const sanitized = sanitizeForTts(text);
    if (!sanitized) return;

    // Audit round 3 S6 — set `_sentFirstChunkOfTurn` AFTER the send so a
    // ws.send throw (caught in _sendEvent and re-emitted as connection_lost)
    // doesn't leave the flag set with no text actually on the wire.
    if (this._currentTurnTextSample.length < 500) {
      this._currentTurnTextSample = (this._currentTurnTextSample + sanitized).slice(0, 500);
    }
    this._sendEvent({ event: 'text', text: sanitized });
    // Bill SANITIZED length, not raw — markdown chars Fish never sees
    // shouldn't show up as billable in cogs (we're not paying for an
    // asterisk we stripped).
    this._charsThisTurn += sanitized.length;
    this._sentFirstChunkOfTurn = true;
    if (!this._flushPerChunk) return;
    this._scheduleFlush();
  }

  /**
   * Audit round 3 C-R2-2 — leading-edge flush + trailing-edge coalesce.
   * If no cooldown is active: flush now and arm a cooldown timer.
   * If cooldown is active: mark _flushPending so the timer fires a tail flush.
   */
  _scheduleFlush() {
    if (this._flushDebounceMs === 0) {
      // Debounce disabled — flush every sendText (test/special-case mode).
      this._sendEvent({ event: 'flush' });
      return;
    }
    if (this._flushCooldownTimer) {
      this._flushPending = true;
      return;
    }
    this._sendEvent({ event: 'flush' });
    this._flushCooldownTimer = setTimeout(() => {
      this._flushCooldownTimer = null;
      if (
        this._flushPending
        && this._ws
        && this._ws.readyState === WebSocket.OPEN
        && !this._closed
        && !this._turnDead
        && !this._turnFinished
      ) {
        this._sendEvent({ event: 'flush' });
      }
      this._flushPending = false;
    }, this._flushDebounceMs);
    if (typeof this._flushCooldownTimer.unref === 'function') {
      this._flushCooldownTimer.unref();
    }
  }

  _clearFlushCooldown() {
    if (this._flushCooldownTimer) {
      clearTimeout(this._flushCooldownTimer);
      this._flushCooldownTimer = null;
    }
    this._flushPending = false;
  }

  /**
   * Explicit caller-facing flush. NO-OP for fish.
   *
   * Plan v4 §5 #4 / round 1 C4: stays no-op so a Cartesia-context-coupled
   * orchestrator pattern doesn't drag back the cutoff bug e5cf446 fixed.
   * sendText's internal leading-edge flush + cooldown debounce is what
   * drives streaming TTS on fish — see _scheduleFlush.
   *
   * @param {string} [_expectedContextId]  Parameter exists for parity
   *   with CartesiaTTSBridge.flush(contextId); fish ignores it because
   *   Fish's wire has no per-message context.
   */
  // eslint-disable-next-line no-unused-vars
  flush(_expectedContextId) {
    return;
  }

  /**
   * Sends final `stop` and awaits `finish`. Resolves with per-turn metrics.
   * On timeout/error/close before finish, resolves with `partial:true` so
   * the caller can still write Gemini cogs legs (parity with cartesia).
   * Closes the per-turn WS regardless of outcome.
   */
  async turnEnd({ timeoutMs = this._finalizeTimeoutMs } = {}) {
    const partialResult = () => ({
      characters: this._charsThisTurn,
      audioBytes: this._audioBytesThisTurn,
      audioSeconds: this._audioBytesThisTurn / (this._sampleRate * 2),
      partial: true,
    });
    // Audit round 3 M3 — turnEnd called without prior turnStart (e.g.
    // orchestrator error path that bails after prewarm). Clean up the
    // orphan prewarm so a leaked Fish concurrency slot doesn't sit until
    // the idle timer fires.
    if (!this._currentContextId && (this._prewarmPromise || this._ws)) {
      this._clearPrewarmIdleTimer();
      this._clearFlushCooldown();
      // Audit round 3 C-R2-1 — swallow-catch.
      if (this._prewarmPromise) {
        this._prewarmPromise.catch(() => {});
      }
      this._prewarmPromise = null;
      this._prewarmContextId = null;
      this._closeCurrentWs(1000, 'turnEnd_without_turnStart');
      return { characters: 0, audioBytes: 0, audioSeconds: 0, partial: false };
    }
    if (this._closed || this._turnDead) return partialResult();
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return partialResult();
    if (!this._currentContextId) return { characters: 0, audioBytes: 0, audioSeconds: 0, partial: false };

    if (!this._sentFirstChunkOfTurn) {
      // No text was sent this turn — close the WS without billing.
      this._closeCurrentWs(1000, 'no_text_sent');
      this._currentContextId = null;
      return { characters: 0, audioBytes: 0, audioSeconds: 0, partial: false };
    }

    this._sendEvent({ event: 'stop' });

    const ctxId = this._currentContextId;
    return new Promise((resolve) => {
      const to = setTimeout(() => {
        cleanup();
        // Force-close the WS so a hung Fish server doesn't leave a
        // dangling connection. Resolve partial so cogs still land.
        this._closeCurrentWs(1000, 'finalize_timeout');
        resolve(partialResult());
      }, timeoutMs);
      const handler = (e) => {
        if (e.kind === 'turn_done' && e.contextId === ctxId) {
          cleanup();
          this._closeCurrentWs(1000, 'turn_done');
          resolve({
            characters: this._charsThisTurn,
            audioBytes: this._audioBytesThisTurn,
            audioSeconds: this._audioBytesThisTurn / (this._sampleRate * 2),
            partial: false,
          });
        } else if (e.kind === 'error') {
          cleanup();
          this._closeCurrentWs(1000, 'turn_error');
          resolve(partialResult());
        } else if (e.kind === 'closed') {
          cleanup();
          resolve(partialResult());
        }
      };
      const cleanup = () => {
        clearTimeout(to);
        this.off('event', handler);
        if (this._currentContextId === ctxId) this._currentContextId = null;
      };
      this.on('event', handler);
    });
  }

  /** Wall-clock of the last audio chunk this turn, 0 if none. */
  getLastChunkAt() {
    return this._lastChunkAtMs;
  }

  /**
   * Barge-in. Fish has no protocol-level cancel — close the WS. Subsequent
   * sendText/turnEnd is a no-op via _turnDead.
   *
   * Audit round 3 C2 / C3 / M2 — also clears prewarm state so:
   *   * An opened-but-unused prewarmed WS doesn't leak a Fish concurrency slot.
   *   * The prewarm's catch handler doesn't emit a spurious fallback_required
   *     for a turn the user already cancelled (gated on _cancelled).
   *   * _cancelled is set so finish:error / _onClose paths also skip fallback.
   */
  cancel() {
    // FISH_AUDIO_PHASE_1 §6 round-3 C4 — Fish localhost-dogfood findings
    // (2026-06-09). The browser session-pipe sends `{type:'cancel'}` BEFORE
    // every `{type:'turn_start'}` as a defensive "stop any prior synth"
    // pattern. That's harmless for cartesia/hume (session-long WS; cancel
    // just emits a cancel-context message). It's CATASTROPHIC for Fish
    // (per-turn WS) — the original cancel() unconditionally closed the
    // prewarmed-but-unused WS, then the racing turn_start handler set
    // _currentContextId AND reset _cancelled, so the WS's async `close`
    // event then read _cancelled=false + _currentContextId=set and wrongly
    // emitted fallback_required.
    //
    // Fix: cancel is a NO-OP when there is no active synth (no `start`
    // envelope has been sent on the current WS). The prewarmed WS stays
    // warm for the upcoming turn_start. An active turn (sentStart=true)
    // still closes the WS — that's the actual barge-in case where the
    // user wants synth to stop.
    if (!this._sentStart) {
      // No active synth — nothing to cancel. Leave _cancelled false so
      // turn_start doesn't have to flip it back; leave _currentContextId
      // null (already is). Leave prewarm state intact. Idempotent for
      // multiple consecutive cancels during prewarm.
      return;
    }
    this._cancelled = true;
    this._turnDead = true;
    this._currentContextId = null;
    this._clearPrewarmIdleTimer();
    this._clearFlushCooldown();
    // Audit round 3 M-R2-6 — zero turn metrics so a callerEnd after cancel
    // can't accidentally bill the cancelled turn via turnEnd's partialResult.
    // Defense in depth — the orchestrator's policy is "no COGS for
    // cancelled turns" but the bridge should not depend on policy.
    this._charsThisTurn = 0;
    this._audioBytesThisTurn = 0;
    this._sentFirstChunkOfTurn = false;
    this._firstAudioReceived = false;
    this._currentTurnTextSample = '';
    // Audit round 3 C-R2-1 — attach a swallow-catch BEFORE nulling the
    // promise. The prewarm catch handler re-throws on the cancel
    // short-circuit (line ~340), and without a `.catch` consumer that
    // rejection becomes an unhandledRejection at next microtask drain.
    if (this._prewarmPromise) {
      this._prewarmPromise.catch(() => {});
    }
    this._prewarmPromise = null;
    this._prewarmContextId = null;
    if (this._closed) return;
    this._closeCurrentWs(1000, 'barge_cancel');
  }

  // Dual API (parity with cartesia-bridge): on(fn) subscribes to the
  // bridge's 'event' channel and returns an unsubscribe function;
  // on(eventName, fn) is the standard EventEmitter path.
  on(listener) {
    if (typeof listener === 'function') {
      super.on('event', listener);
      return () => super.off('event', listener);
    }
    return super.on(listener, arguments[1]);
  }

  off(listener, fn) {
    if (typeof listener === 'function') {
      super.off('event', listener);
      return;
    }
    super.off(listener, fn);
  }

  /**
   * Idempotent. Closes any in-flight per-turn WS AND any prewarmed
   * WS that's still in the open-handshake (audit round 3 C2).
   */
  async close() {
    if (this._closed) return;
    this._closed = true;
    this._clearPrewarmIdleTimer();
    this._clearFlushCooldown();
    // Audit round 3 C-R2-1 — see cancel() comment.
    if (this._prewarmPromise) {
      this._prewarmPromise.catch(() => {});
    }
    this._prewarmPromise = null;
    this._prewarmContextId = null;
    this._closeCurrentWs(1000, 'normal_closure');
  }

  // ── Internals ─────────────────────────────────────────────────────────

  _sendEvent(payload) {
    try {
      this._ws.send(encode(payload), { binary: true });
    } catch (e) {
      this._emitError('connection_lost', e?.message || 'ws_send_failed', { fatal: true });
    }
  }

  _closeCurrentWs(code, reason) {
    if (!this._ws) return;
    try { this._ws.close(code, reason); } catch {}
    this._ws = null;
    // _sentStart is bound to the WS lifecycle — closing the WS means the
    // start envelope is no longer in effect. Reset so the next
    // turnStart can send a fresh start on a fresh WS.
    this._sentStart = false;
    // Audit round 3 C-R2-2 — flush cooldown is also bound to the WS.
    // A pending flush against a closed WS would be a no-op (the gate in
    // _scheduleFlush's timer callback checks readyState) but clearing the
    // timer is cleaner and avoids holding the event loop on a doomed flush.
    this._clearFlushCooldown();
  }

  _onMessage(data, isBinary) {
    if (this._closed) return;
    if (!isBinary) {
      this._emitError('protocol_violation', 'text frame on msgpack wire', { fatal: true });
      return;
    }
    let msg;
    try {
      msg = decodeMsgpackFrame(data);
    } catch {
      this._emitError('protocol_violation', 'non-msgpack frame', { fatal: true });
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.event === 'audio') {
      const bytes = msg.audio;
      if (!bytes || !(bytes instanceof Uint8Array)) {
        this._emitError('protocol_violation', 'audio event missing bytes', { fatal: false });
        return;
      }
      // Drop late chunks for a cancelled / dead / finished turn. Audit
      // round 3 C5 — _turnFinished mirrors cartesia's context_id discipline;
      // Fish has no per-message context, so we set _turnFinished on any
      // `finish` event and drop subsequent audio bytes so they can't drain
      // into the next turn's stream.
      if (this._turnDead || this._turnFinished || !this._currentContextId) return;
      this._audioBytesThisTurn += bytes.length;
      this._lastChunkAtMs = Date.now();
      this._firstAudioReceived = true;
      this.emit('event', {
        kind: 'audio_out',
        chunk: { bytes, mimeType: `audio/pcm;rate=${this._sampleRate}` },
        contextId: this._currentContextId,
      });
    } else if (msg.event === 'finish') {
      // Audit round 3 C5 — set BEFORE emitting any downstream events so a
      // re-entrant audio handler (Node's emit is synchronous, but defensive)
      // sees the latched-finished state on its next message.
      this._turnFinished = true;
      if (msg.reason === 'stop') {
        this.emit('event', { kind: 'turn_done', contextId: this._currentContextId });
      } else {
        // reason === 'error' (or any non-stop value)
        const safeMsg = sanitizeMessage(
          typeof msg.message === 'string' ? msg.message : 'fish_finish_error',
        );
        // Audit round 3 C4 / M2 — pre-first-audio failures emit
        // fallback_required so the orchestrator can re-dispatch the SAME
        // turn to cartesia inline. Once first audio has flowed, no
        // fallback (voice-mid-switch is worse UX than the error). Gate ALSO
        // on !_cancelled so a cancel-then-Fish-error path doesn't fire a
        // fallback the orchestrator never asked for.
        if (!this._firstAudioReceived && this._currentContextId && !this._cancelled) {
          this.emit('event', {
            kind: 'fallback_required',
            code: 'finish_error_pre_first_audio',
            message: safeMsg,
            contextId: this._currentContextId,
            textSample: this._currentTurnTextSample,
          });
        }
        this._emitError('tts_synthesis_error', safeMsg, {
          fatal: false,
          textSample: this._currentTurnTextSample,
        });
        this._turnDead = true;
      }
    }
    // Unknown event types — debug-log the event name (NOT the payload, which
    // could carry PII per CLAUDE.md voice-section rules). Don't kill the
    // bridge: Fish may add envelope types in a future API version. Audit
    // round 3 S9 — silent tolerance violated the "don't silently catch in
    // voice connect" rule. Round 2 M-R2-7 — final `else` catches non-string
    // event values too (msgpack permits numeric / null keys) so the policy
    // is "no silent message drops, ever."
    else {
      const evRepr = typeof msg.event === 'string' ? msg.event : String(msg.event);
      // eslint-disable-next-line no-console
      console.debug(`[fish-bridge] unknown event type: ${evRepr}`);
    }
  }

  _onClose(code, reason) {
    const ws = this._ws;
    if (ws) this._ws = null;
    // _sentStart is bound to this WS — clear on close (matches the
    // explicit _closeCurrentWs path). _sentFirstChunkOfTurn /
    // _firstAudioReceived / _currentTurnTextSample are intentionally NOT
    // reset here — they're reset by the next turnStart so post-close
    // diagnostic logging keeps the just-finished turn's stats.
    this._sentStart = false;
    const reasonStr = reason?.toString?.('utf8') ?? '';
    // Audit round 3 C4 / M2 — if the WS closes mid-turn AND no audio chunks
    // arrived yet AND the turn is still active (not finished, not cancelled),
    // emit fallback_required so the orchestrator can re-dispatch to cartesia.
    // Gating on _cancelled (NOT _turnDead) so the cancel-then-finish:error
    // and cancel-then-WS-close paths behave consistently — both skip the
    // fallback emission when the cancel was user-initiated.
    if (
      !this._closed &&
      !this._cancelled &&
      !this._turnFinished &&
      !this._firstAudioReceived &&
      this._currentContextId
    ) {
      this.emit('event', {
        kind: 'fallback_required',
        code: 'ws_closed_pre_first_audio',
        message: sanitizeMessage(`ws closed code=${code} reason=${reasonStr}`),
        contextId: this._currentContextId,
        textSample: this._currentTurnTextSample,
      });
    }
    this.emit('event', {
      kind: 'closed',
      code,
      reason: reasonStr,
    });
  }

  _onError(e) {
    this._emitError('connection_lost', sanitizeMessage(e?.message || 'ws_error'), { fatal: true });
  }

  _emitError(code, message, opts = {}) {
    // Audit round 3 C4 — sanitize the message at the emission boundary so
    // a `ws` library error that quoted the Authorization header (some
    // failure modes do this) never reaches Sentry / log lines verbatim.
    this.emit('event', {
      kind: 'error',
      code,
      message: sanitizeMessage(message),
      contextId: this._currentContextId,
      fatal: opts.fatal === true,
      ...(opts.textSample != null ? { textSample: opts.textSample } : {}),
    });
  }
}
