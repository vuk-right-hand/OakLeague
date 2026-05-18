// HumeTTSBridge — Pipeline α' TTS leg (Hume Octave 2 over WS).
//
// Mirrors CartesiaTTSBridge interface so the proxy can swap providers behind
// a single VOICE_TTS_PROVIDER flag (CLAUDE.md provider-agnostic mandate).
//
// Lifecycle: open → turnStart(ctxId) → sendText* → turnEnd → (repeat) → close
// Events:    setup_complete | audio_out | turn_done | error | closed |
//            reconnected
//
// Auth (Phase-0 verified 2026-05-13): Hume's WS endpoint accepts auth ONLY
// as `api_key=<key>` query param — no header path exists. This is the C1
// secrets-handling risk: the URL string ends up in error messages / stack
// traces / breadcrumbs whenever `ws` raises. All log/Sentry paths must use
// urlScrubbed() — never the raw URL. The Sentry scrub at sentry.js redacts
// `api_key=` everywhere it walks the event tree.
//
// Audit M5 — `HUME_SECRET_KEY` is INTENTIONALLY NOT USED by this bridge.
// Hume's `/oauth2-cc/token` access-token (client-credentials) flow exists
// and would allow a header-based auth (no key in URL), but we do not
// implement it: the api_key query-param path is what Phase-0 verified and
// what production runs. Do NOT "wire up the secret" without migrating the
// entire auth path to the token flow + re-verifying — a half-migration
// breaks the working api_key path. The secret should be removed from
// .env.local / Fly / Vercel (dead secret = needless leak surface). The
// api-key-in-URL → access-token migration is a tracked security follow-up,
// not a silent in-place change.
//
// Wire format (Hume TTS stream input, version=2 Octave 2 pinned, verified
// via Phase-0 + Hume Python SDK source 2026-05-13):
//
//   URL: wss://api.hume.ai/v0/tts/stream/input?
//          api_key=<key>
//          &version=2                      ← Octave 2 model pin (founder call)
//          &instant_mode=true              ← ultra-low latency
//          &strip_headers=true             ← per-chunk no headers
//          &format_type=pcm                ← s16le PCM
//          &no_binary=true                 ← base64 JSON envelopes (not binary frames)
//          &sample_rate=<rate>             ← undocumented but works (Phase-0)
//
//   Outbound (publish to stream):
//     { text, voice:{id:<voiceId>, provider:'CUSTOM_VOICE'},
//       speed?, trailing_silence?, description?, flush?, close? }
//   Outbound flush (end-of-turn):
//     { flush:true }                       ← forces generation of buffered text
//
//   Inbound chunk (no_binary=true → SnippetAudioChunk as JSON):
//     { type:'audio', audio:'<base64-pcm>', audio_format:'pcm',
//       chunk_index, generation_id, snippet_id, is_last_chunk,
//       request_id, text, transcribed_text?, utterance_index? }
//     ⚠️ `text` field = avatar-spoken transcript fragment. NEVER log raw.
//     CI grep enforces: no JSON.stringify(msg), no console.*(msg).
//   Inbound error:
//     { type:'error', code:'E0101', slug:'payload_parse', message, request_id }
//
// Cancellation (Phase-0 verified): Hume does NOT honor mid-stream cancel
// within 200ms. All three strategies tested (flush:false / close:true /
// abrupt-ws-close) leak 6–14 chunks after cancel. Bridge strategy is
// FILTER-BY-GENERATION-ID: track which `generation_id`s have been cancelled,
// drop inbound chunks whose generation_id is in the cancel set.
//
// Bad voice id (Phase-0): WS closes with code 1000 + empty reason, NO error
// envelope. Detection heuristic: `_chunksReceivedThisTurn === 0` AND
// `_msSinceFirstSend > 1500` AND close code 1000 within 5s of open →
// bad_voice_id (fatal).
//
// Octave 2 caveats: `description` (acting instructions) is currently INERT
// on Octave 2 — Hume docs say "coming soon." We persist + send the field
// today for forward-compat; voice production isn't affected. `model_version`
// is the user-facing knob: '2' default (founder-tested), '1' for older
// model with working acting-direction, 'default' for Hume auto-route.

import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { scrubUrl } from './sentry.js';

const HUME_WS_BASE = 'wss://api.hume.ai/v0/tts/stream/input';
const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_OPEN_TIMEOUT_MS = 5000;
const INBOUND_MAX_PAYLOAD = 1 * 1024 * 1024;

// Coupled to migration 20260520000003 cogs_insert_turn_voice_v2 p_tts_characters
// CHECK upper bound. If you bump one, bump the other. Plan §3.3 / Vuk-M3.
export const HUME_CHARS_PER_TURN_HARD_CAP = 100000;

// Bad-voice-id detection threshold (Phase-0): if WS closes with code 1000
// and zero chunks have arrived AND we've been sending text for at least
// 1.5s, the voice id is the most likely culprit. Below 1.5s, a close-1000
// could be a transient transport hiccup or admin-side WS shutdown.
const BAD_VOICE_ID_DETECTION_MS = 1500;

// Audit M1 fix: cap _cancelledGenerationIds Set growth. Phase-0 measured
// 6–14 chunks then quiet, but didn't verify that is_last_chunk:true ALWAYS
// arrives for cancelled generations. Without an upper bound, a Hume bug or
// transport loss could grow the set forever. FIFO-evict oldest on overflow.
//
// Audit S6 — quantify "realistic". A cancel == one barge-in (user
// interrupts the avatar). 1 barge-in adds 1 gen-id; the gen-id is evicted
// when that generation's is_last_chunk:true arrives (~300–425ms later,
// Phase-0), so the LIVE set size is the number of barge-ins whose leaked
// tails are still draining concurrently — realistically 1–2, not 64. The
// 64 cap only matters in the pathological case where is_last_chunk is
// NEVER delivered for many cancelled generations (Hume bug / transport
// loss). Even a frustrated user mashing barge-in in a 15-min session
// produces well under 64 *concurrently-undrained* generations because
// each drains in <0.5s. FIFO-evicting the oldest under that pathology can
// at worst un-cancel a generation that has been leaking for >64 cancels —
// acceptable: that generation is ~tens of seconds stale and its audio is
// already irrelevant. Low risk, documented.
const MAX_CANCELLED_GEN_IDS = 64;

const RECONNECT_BACKOFFS_MS = [200, 500, 1000];

// Inbound envelope `type` values we expect. Anything else → unknown_envelope_type
// (soft warning, once per session). Hume may add new types in the future.
const KNOWN_INBOUND_TYPES = new Set(['audio', 'error', 'timestamps']);

// Hume error code map. Phase-0 envelope shapes:
//   E0101 / slug=payload_parse → malformed JSON we sent (CLIENT bug,
//     per-turn recoverable: the next turn can ship valid JSON)
// Other observed codes are mapped to 'other' for the proxy's const-union
// taxonomy. Update as new codes surface.
//
// Unit-wide audit M4 fix (2026-05-13): every entry now carries a `fatal`
// flag so the bridge can match Cartesia's per-turn-vs-connection-level
// distinction. Default for unknown codes is `fatal: true` (conservative —
// assume the WS is unusable unless explicitly whitelisted as per-turn).
// This mirrors Cartesia's posture where connection-level errors
// (voice_not_found, model_not_found, rate_limited, unauthorized) tear
// down the bridge and per-turn errors (invalid_input) just kill the turn.
// Audit S10 (unit-wide, 2026-05-13) — only E0101 mapped today. Any unmapped
// code falls through HUME_DEFAULT_ERROR (fatal:true) + emits a one-shot
// `unknown_hume_error_code` warning event so ops can see novel codes and
// add them to this map. Known-future codes to add when observed in prod:
//   * E02xx — rate-limit / concurrent-conn cap → likely fatal:true
//             (bridge unusable until next reconnect)
//   * E04xx — bad_voice_id / voice_not_found    → fatal:true (voice gone
//             upstream; admin needs to re-clone or pin a different id)
//   * E05xx — model_not_available               → fatal:true (env config)
const HUME_ERROR_MAP = {
  E0101: { code: 'protocol_violation', fatal: false },  // payload_parse — our payload, recoverable
};

const HUME_DEFAULT_ERROR = { code: 'other', fatal: true };

// Should we emit `speed` on the Hume publish message?
// Range matches migration 0002 CHECK [0.5, 2.0]. NULL or explicit 1.0 → omit
// (Hume default). Bounds are belt-and-suspenders; DB CHECK is authoritative.
function shouldSendSpeed(v) {
  return typeof v === 'number' && Number.isFinite(v) && v !== 1.0 && v >= 0.5 && v <= 2.0;
}

// Should we emit `trailing_silence`? Plan: send if non-null AND not 0
// (sending 0 is the same as omit and clutters the wire).
function shouldSendTrailingSilence(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 5;
}

// Should we emit `description`? Non-empty string within Hume's 1000-char cap.
function shouldSendDescription(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 1000;
}

// ── 48 kHz → 16 kHz polyphase FIR downsampler ────────────────────────────
//
// Hume Octave 2 ALWAYS emits PCM s16le at 48 kHz; the `sample_rate=` URL
// query parameter is silently ignored (verified 2026-05-14 from chunk-size
// evidence + Pipecat reference impl source: "Hume emits mono PCM at 48 kHz;
// downstream can resample if needed").
//
// Simli (and our spike-a default) expects 16 kHz. Naive 3:1 decimation
// (sample-and-hold) aliases everything above 8 kHz back into the audible
// band — sibilants and hard consonants get noticeably buzzy in A/B.
//
// Solution: pre-decimation low-pass FIR, 33-tap Blackman-windowed sinc,
// cutoff at fs/2/3 = 8 kHz (the post-decimation Nyquist). 33 taps with
// Blackman gives ~74 dB stopband — comfortably below s16le quantization
// noise floor for speech. Pre-computed once at module load.
//
// Cost: 33 mul-add per output sample = ~528 k FLOPs / sec / session at
// 16 kHz output. Trivial on modern CPUs. State (29 prev samples + history
// padding) lives PER BRIDGE INSTANCE so concurrent sessions cannot bleed
// filter memory across each other.

const FIR_TAPS = 33;
const FIR_DECIMATION = 3; // 48 / 16
const FIR_COEFFS = new Float32Array(FIR_TAPS);
{
  const M = FIR_TAPS - 1;
  const center = M / 2; // 16 for 33 taps (integer because TAPS is odd)
  const fc = 0.5 / FIR_DECIMATION; // normalized cutoff (Nyquist=0.5) = 1/6
  let sum = 0;
  for (let k = 0; k < FIR_TAPS; k++) {
    const n = k - center;
    // sinc(2*fc*n) = sin(2π*fc*n) / (π*n)
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    // Blackman window
    const win = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / M) + 0.08 * Math.cos((4 * Math.PI * k) / M);
    FIR_COEFFS[k] = sinc * win;
    sum += FIR_COEFFS[k];
  }
  // Normalize for unity DC gain
  for (let k = 0; k < FIR_TAPS; k++) FIR_COEFFS[k] /= sum;
}

/**
 * Streaming 48 kHz → 16 kHz s16le PCM downsampler.
 *
 * Per-instance so concurrent sessions don't share state. Each call:
 *   1. Concatenate carryover from previous chunk with new input.
 *   2. Convolve with FIR_COEFFS, decimating by FIR_DECIMATION.
 *   3. Save the trailing (FIR_TAPS - 1) input samples as carryover so the
 *      next chunk's filter has the proper history (no boundary glitch).
 *
 * Input/output are little-endian s16 PCM as Node Buffer.
 */
class Hume48to16Resampler {
  constructor() {
    // Carry the trailing (FIR_TAPS - 1) input samples between chunks so
    // the convolution at chunk boundaries has correct history.
    this._carry = new Int16Array(FIR_TAPS - 1); // initialized to zeros
  }
  process(inputBuf) {
    // Audit C1 — DO NOT view `inputBuf.buffer` directly. `Buffer.from(b64,
    // 'base64')` can return a Buffer sliced out of Node's shared 8 KB pool
    // with an ODD `byteOffset`; `new Int16Array(ab, oddOffset, n)` throws
    // RangeError ("start offset must be a multiple of 2"). That would be a
    // non-deterministic, pool-history-dependent crash → intermittent dead
    // air on Hume turns that never reproduces locally. Decode explicitly
    // little-endian (Hume wire format) into a freshly-OWNED Int16Array so
    // alignment + endianness are both guaranteed regardless of host or pool
    // state.
    const inSamples = inputBuf.length >>> 1; // floor — ignore a stray odd byte
    if (inSamples === 0) return Buffer.alloc(0);
    const input = new Int16Array(inSamples);
    for (let i = 0; i < inSamples; i++) {
      input[i] = inputBuf.readInt16LE(i * 2);
    }

    // Combined buffer = carry + input.
    const combined = new Int16Array(this._carry.length + inSamples);
    combined.set(this._carry, 0);
    combined.set(input, this._carry.length);

    // Number of FIR positions that fit fully in combined.
    const validPositions = combined.length - FIR_TAPS + 1;
    if (validPositions <= 0) {
      // Not enough samples yet (only true for absurdly small first chunks);
      // append all of input to carry and emit nothing.
      const grown = new Int16Array(this._carry.length + inSamples);
      grown.set(this._carry);
      grown.set(input, this._carry.length);
      this._carry = grown;
      return Buffer.alloc(0);
    }

    // Number of output samples after decimation.
    const outSamples = Math.floor((validPositions + FIR_DECIMATION - 1) / FIR_DECIMATION);
    const out = new Int16Array(outSamples);
    for (let i = 0; i < outSamples; i++) {
      const baseIdx = i * FIR_DECIMATION;
      let acc = 0;
      for (let k = 0; k < FIR_TAPS; k++) {
        acc += combined[baseIdx + k] * FIR_COEFFS[k];
      }
      // Clamp to s16 range to handle filter overshoot on near-full-scale input.
      const rounded = Math.round(acc);
      out[i] = rounded < -32768 ? -32768 : rounded > 32767 ? 32767 : rounded;
    }

    // Save trailing (FIR_TAPS - 1) input samples for next call's history.
    // `.slice()` on a typed array returns a COPY with its own backing store,
    // so `_carry` never aliases `combined` (which is GC'd next call).
    const carryStart = combined.length - (FIR_TAPS - 1);
    this._carry = combined.slice(carryStart);

    // Audit C2 — `out` is a fresh `new Int16Array(outSamples)`: its own
    // ArrayBuffer, byteOffset 0, exact byteLength. This Buffer view is safe
    // to hand to ws.send()'s async queue (no other code path reuses `out`,
    // and the next process() call allocates a new one). Caller must not
    // mutate or retain it beyond the send.
    return Buffer.from(out.buffer, 0, out.byteLength);
  }
  // No reset()/carry-clear primitive: the resampler is per-bridge-instance
  // (one per WS connection), reconnect deliberately preserves carry for
  // boundary continuity, and close() discards the whole bridge. There is
  // no code path that needs to clear history mid-life. If one ever does,
  // re-add a one-line `reset() { this._carry = new Int16Array(FIR_TAPS-1); }`.
}

// HUME_USD_PER_CHAR / HUME_QUOTED_AT fail-closed validation.
//
// Audit C5 — split into a PURE core that THROWS and a boot wrapper that
// EXITS. The boot path (proxy-handlers.js `_humePricingPrimeForBoot`) wants
// process.exit so a misconfigured fleet crash-loops loudly at start. But
// the LAZY path (`getHumePricing()` called from `logTurnCogs`, per-turn,
// outside the cogs try/catch) must NEVER process.exit — that would kill the
// whole Fly VM and drop every concurrent user's WebSocket mid-turn, on
// repeat. `assertHumePricing()` throws a catchable Error there; the
// existing `cogsPromise.catch` maps it to a clean per-session 1011
// cogs_misconfig close. `process.exit` only ever runs on the boot path.
//
// Audit M3 — HUME_QUOTED_AT now enforces YYYY-MM-DD (parity with
// CARTESIA_QUOTED_AT). A garbage value like "yes" previously passed and
// silently corrupted cogs rate-provenance (the whole point of QUOTED_AT
// is post-hoc reconciliation when a rate card changes).
const HUME_QUOTED_AT_RE = /^\d{4}-\d{2}-\d{2}$/;
export function assertHumePricing({ env = process.env } = {}) {
  const raw = env.HUME_USD_PER_CHAR;
  const quotedAt = env.HUME_QUOTED_AT;
  const n = raw != null ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `HUME_USD_PER_CHAR missing or non-finite-positive (got ${JSON.stringify(raw)}). Refusing — silent $0 billing would corrupt cogs.`,
    );
  }
  if (!quotedAt || typeof quotedAt !== 'string' || !HUME_QUOTED_AT_RE.test(quotedAt)) {
    throw new Error(
      `HUME_QUOTED_AT must be a YYYY-MM-DD date string (got ${JSON.stringify(quotedAt)}; audit trail required).`,
    );
  }
  return { usdPerChar: n, quotedAt };
}

// Boot-only wrapper. Hard-exit on failure so a misconfigured fleet fails
// loud at start instead of silently billing $0/char. NEVER call this off
// the per-turn / lazy path — use assertHumePricing() there.
export function validateHumePricingOrExit({ env = process.env, exit = (n) => process.exit(n), log = console.error } = {}) {
  try {
    return assertHumePricing({ env });
  } catch (e) {
    log(`[hume-bridge] FATAL: ${e.message} Refusing to boot.`);
    return exit(1);
  }
}

export class HumeTTSBridge extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey            Hume API key (becomes api_key= query param).
   * @param {string} opts.voiceId           Hume voice UUID (creator clone).
   * @param {string} [opts.voiceName]       Hume voice name (informational; not sent on synth — Hume DELETE keys by name).
   * @param {number} [opts.sampleRate=24000]
   * @param {number} [opts.openTimeoutMs=5000]
   * @param {number|null} [opts.ttsSpeed=null]            From creators.hume_tts_speed, range [0.5, 2.0]. NULL/1.0 → omit.
   * @param {number|null} [opts.trailingSilence=null]     From creators.hume_trailing_silence, range [0, 5]. NULL/0 → omit.
   * @param {string|null} [opts.description=null]         From creators.hume_voice_description, ≤1000 chars. Inert on Octave 2 today; persisted for forward-compat.
   * @param {string} [opts.modelVersion='2']              From creators.hume_model_version: '1' | '2' | 'default'. Drives `version=` query param.
   * @param {{usdPerChar:number, quotedAt:string}} opts.pricing  REQUIRED. Caller MUST validate via validateHumePricingOrExit() at boot.
   *   The bridge re-asserts the shape at construct time so direct callers
   *   (burn-in scripts, future agents) cannot bypass CLAUDE.md's
   *   "pricing fail-closed" mandate.
   */
  constructor({
    apiKey,
    voiceId,
    voiceName = null,
    sampleRate: _ignoredSampleRate = DEFAULT_SAMPLE_RATE,
    // DIAGNOSTIC 2026-05-14 — Hume Octave 2 silently ignores the
    // `sample_rate=` query param and always returns 48kHz s16le PCM,
    // regardless of what we ask. Hardcode 48000 here to match the wire
    // reality. Caller's `sampleRate` arg is ignored. Proper fix is
    // either (a) downsample 48k→16k in this bridge so Simli still works,
    // or (b) find the right knob in Hume to request 16k natively.
    openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS,
    ttsSpeed = null,
    trailingSilence = null,
    description = null,
    modelVersion = '2',
    pricing = null,
  } = {}) {
    super();
    if (!apiKey) throw new Error('HUME_API_KEY missing');
    if (!voiceId) throw new Error('voiceId missing');
    if (modelVersion !== '1' && modelVersion !== '2' && modelVersion !== 'default') {
      throw new Error(`bad modelVersion: ${modelVersion} (allowed: 1|2|default)`);
    }
    // Audit C3 fix (2026-05-13): pricing must be validated at proxy boot
    // and threaded through to the bridge constructor. Bridge re-asserts so
    // a future direct caller can't bypass validateHumePricingOrExit().
    if (!pricing || typeof pricing !== 'object'
        || !Number.isFinite(pricing.usdPerChar) || pricing.usdPerChar <= 0
        || typeof pricing.quotedAt !== 'string' || pricing.quotedAt.length === 0) {
      throw new Error('HUME_PRICING_NOT_VALIDATED — caller must pass pricing:{usdPerChar:number>0, quotedAt:string} from validateHumePricingOrExit()');
    }
    this._pricing = { usdPerChar: pricing.usdPerChar, quotedAt: pricing.quotedAt };
    this._apiKey = apiKey;
    this._voiceId = voiceId;
    this._voiceName = voiceName;
    // Hume Octave 2 emits 48 kHz s16le PCM unconditionally (verified
    // 2026-05-14 — Pipecat ref impl + chunk-size evidence). The bridge
    // resamples to 16 kHz for downstream consumers (Simli requires 16 k;
    // for non-Simli paths the browser AudioContext handles any rate, so
    // 16 k is fine there too — uniform output is simpler than branching).
    // Caller's `sampleRate` is ignored — kept on the API for back-compat
    // with the original constructor signature; warn loudly if non-16k.
    if (_ignoredSampleRate !== 16000) {
      // eslint-disable-next-line no-console
      console.warn(`[hume-bridge] sampleRate=${_ignoredSampleRate} requested but bridge always emits 16000 (Hume native 48 kHz, resampled in-bridge).`);
    }
    this._sampleRate = 16000;     // declared rate (downstream contract); fixed.
    this._humeNativeRate = 48000; // Hume Octave 2 native, non-configurable
    this._resampler = new Hume48to16Resampler();
    this._openTimeoutMs = openTimeoutMs;
    this._modelVersion = modelVersion;
    // Coerce + clamp per-creator params (defense-in-depth; DB CHECK is authoritative).
    const speedNum = typeof ttsSpeed === 'number' ? ttsSpeed : (ttsSpeed != null ? Number(ttsSpeed) : NaN);
    this._ttsSpeed = (Number.isFinite(speedNum) && speedNum >= 0.5 && speedNum <= 2.0) ? speedNum : null;
    const silenceNum = typeof trailingSilence === 'number' ? trailingSilence : (trailingSilence != null ? Number(trailingSilence) : NaN);
    this._trailingSilence = (Number.isFinite(silenceNum) && silenceNum >= 0 && silenceNum <= 5) ? silenceNum : null;
    this._description = (typeof description === 'string' && description.length > 0 && description.length <= 1000) ? description : null;
    this._ws = null;
    this._closed = false;
    this._currentContextId = null;     // our internal turn id (sessionId:turn)
    this._currentGenerationId = null;  // Hume-assigned generation_id (latched on first chunk)
    this._cancelledGenerationIds = new Set();
    this._turnDead = false;
    // Audit M6 — set by cancel() when barge-in fires BEFORE the first audio
    // chunk (so generation_id is still unknown). While true, _onMessage
    // drops EVERY audio chunk AND latches each observed generation_id into
    // _cancelledGenerationIds, so leaked chunks stay filtered even after the
    // next turnStart clears this flag. Closes the race where un-latched
    // leaked chunks bleed into the next turn's audio stream.
    this._pendingCancelDropAll = false;
    this._charsThisTurn = 0;
    this._audioBytesThisTurn = 0;
    this._chunksReceivedThisTurn = 0;
    this._firstSendAtMs = 0;
    this._sentFirstChunkOfTurn = false;
    // Unit-wide audit S3 (2026-05-13): declare here so grep finds it.
    // Set in turnStart (reset per turn) and read in sendText to latch
    // the one-shot cap-exceeded emit.
    this._charCapEmittedThisTurn = false;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this._reconnectTimestamps = [];
    this._unknownTypeWarned = false;
    // Audit small fix (2026-05-13): one-shot Sentry warning per unmapped
    // Hume error code. HUME_ERROR_MAP defaults unknown codes to
    // {code:'other', fatal:true}; this latch lets ops catch the first
    // novel code so the map can be updated.
    this._unknownErrorCodesWarned = new Set();
    this._wsOpenedAtMs = 0;
    // Bounded sample of what we sent — for diagnostics on Hume-side rejects.
    // Same pattern as cartesia-bridge.js _currentTurnTextSample. 500 char cap.
    this._currentTurnTextSample = '';
  }

  _buildUrl() {
    // Audit M7 fix (2026-05-13): array + filter + join so an omitted version
    // param doesn't insert an empty segment (which would break `?&...` URL
    // parsing if anyone moves api_key elsewhere). URL-shape stays stable
    // through future reorders.
    const params = [
      `api_key=${encodeURIComponent(this._apiKey)}`,
      this._modelVersion !== 'default' ? `version=${encodeURIComponent(this._modelVersion)}` : null,
      'instant_mode=true',
      'strip_headers=true',
      'format_type=pcm',
      'no_binary=true',
      `sample_rate=${encodeURIComponent(this._sampleRate)}`,
    ].filter(Boolean);
    return `${HUME_WS_BASE}?${params.join('&')}`;
  }

  /** Returns the URL with api_key redacted. Use this in ALL logs / events. */
  _urlScrubbed() {
    return scrubUrl(this._buildUrl());
  }

  /** Opens the WS. Resolves on first successful connect; rejects on timeout. */
  async open() {
    if (this._closed) throw new Error('bridge_closed');
    if (this._ws) throw new Error('bridge_already_open');
    await this._openOnce();
  }

  async _openOnce() {
    const url = this._buildUrl();
    const ws = new WebSocket(url, {
      maxPayload: INBOUND_MAX_PAYLOAD,
      perMessageDeflate: false,
    });
    // Audit C1 fix (2026-05-13): do NOT assign this._ws until open resolves.
    // If the ws-library raises synchronously during construction (DNS, URL
    // parse), the broken ws would otherwise linger as this._ws and the
    // reconnect loop would leak listeners overwriting it next iteration.
    this._wsOpenedAtMs = 0;

    await new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        try { ws.terminate(); } catch {}
        reject(new Error('hume_open_timeout'));
      }, this._openTimeoutMs);
      // Audit C2 fix (2026-05-13): capture the error handler so we can
      // remove it after open resolves. The previous version left it bound
      // as an orphan once-listener — on every reconnect this leaked a
      // listener that no-op'd on subsequent post-open errors, eventually
      // tripping Node's MaxListenersExceededWarning at 11 reconnects.
      const onOpenError = (e) => {
        clearTimeout(to);
        // The error message from `ws` may include the URL. Scrub before reject
        // so any caller that captures e.message into Sentry / logs is safe.
        const msg = String(e?.message || e || 'hume_open_failed');
        const scrubbed = scrubUrl(msg);
        const wrapped = new Error(scrubbed);
        wrapped.code = e?.code;
        reject(wrapped);
      };
      ws.once('error', onOpenError);
      ws.once('open', () => {
        clearTimeout(to);
        ws.removeListener('error', onOpenError);
        this._ws = ws;
        this._wsOpenedAtMs = Date.now();
        ws.on('message', (data, isBinary) => this._onMessage(data, isBinary));
        ws.on('close', (code, reason) => this._onClose(code, reason));
        ws.on('error', (e) => this._onError(e));
        resolve();
      });
    });
    this.emit('event', { kind: 'setup_complete', at: Date.now() });
  }

  /**
   * Marks the start of a Hume turn. contextId format `<sessionId>:<turnNumber>`
   * is the caller's responsibility. Per CLAUDE.md, must be called synchronously
   * before sendText.
   */
  turnStart(contextId) {
    if (this._closed) throw new Error('bridge_closed');
    if (!contextId || typeof contextId !== 'string') throw new Error('bad_context_id');
    if (this._reconnecting) {
      const err = new Error('tts_reconnecting');
      err.code = 'tts_reconnecting';
      throw err;
    }
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      const err = new Error('bridge_not_open');
      err.code = 'bridge_not_open';
      throw err;
    }
    this._currentContextId = contextId;
    this._currentGenerationId = null;
    this._turnDead = false;
    this._charsThisTurn = 0;
    this._audioBytesThisTurn = 0;
    this._chunksReceivedThisTurn = 0;
    this._firstSendAtMs = 0;
    this._sentFirstChunkOfTurn = false;
    this._charCapEmittedThisTurn = false;
    // Audit M6 — re-arm: stop the drop-all window. Any leaked chunks from
    // the pre-genid-cancelled turn had their gen-id latched into
    // _cancelledGenerationIds during the window, so they stay filtered by
    // the gen-id check even now that drop-all is off.
    this._pendingCancelDropAll = false;
    // Audit M2 — do NOT reset the FIR carry per turn. Resetting zeroes the
    // 32-sample history, so the first output samples of EVERY turn are
    // convolved against silence → a ~0.33ms attenuated onset ramp ("fade-in"
    // on the first phoneme) on every single utterance. The disease it would
    // cure is negligible: the only cross-turn bleed is ≤32 input samples
    // (~0.66ms @ 48k → ~0.2ms post-decimation) of the PREVIOUS turn's tail,
    // which is Hume's baked trailing-silence anyway — inaudible. Keeping the
    // carry across turns is the higher-fidelity choice and matters for the
    // Cartesia-vs-Hume A/B. The resampler has no carry-clear method at all
    // (per-bridge-instance; reconnect preserves carry by design) — there is
    // intentionally nothing to call here.
    this._currentTurnTextSample = '';
  }

  /** Streams a transcript chunk. */
  sendText(text) {
    if (!text) return;
    // Same Unicode normalization as Cartesia path — Gemini's
    // outputTranscription emits curly quotes, em-dashes, etc. Hume's
    // tokenizer probably handles them, but normalizing keeps the wire
    // payload identical across providers so cogs row counts match.
    text = text
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/…/g, '...')
      .replace(/[ ]/g, ' ');
    // Audit S3 — deliberately DO NOT trim-drop all-whitespace chunks here.
    // Gemini streams outputTranscription as fragments; a chunk that is
    // just a space (or NBSP→space) is the legitimate word separator
    // between "wordA" and "wordB". Dropping it would concatenate them
    // ("wordAwordB"). The ≤1 wasted billed char on the rare pure-NBSP
    // fragment is the correct trade vs. mangled word boundaries. Only the
    // truly-empty `''` case is dropped (the !text guards above/here).
    if (!text) return;
    if (this._closed || this._turnDead) return;
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    if (!this._currentContextId) throw new Error('sendText before turnStart');

    // Hard cap (Vuk-M3 / migration 0003 RPC cap): refuse to extend past the
    // per-turn char limit. Audit M5 fix (2026-05-13): silently swallowing
    // was hiding upstream runaway (Gemini regression → 200k-char transcript
    // → bridge synth half, drops rest, no signal). Emit a one-shot error
    // (latched) so the proxy can WS-close 4012/backpressure. Subsequent
    // text in the same turn is dropped without re-emitting to avoid
    // spamming errors.
    const remaining = HUME_CHARS_PER_TURN_HARD_CAP - this._charsThisTurn;
    if (remaining <= 0) {
      if (!this._charCapEmittedThisTurn) {
        this._charCapEmittedThisTurn = true;
        this.emit('event', {
          kind: 'error',
          at: Date.now(),
          code: 'protocol_violation',
          message: `hume_per_turn_cap_exceeded (${HUME_CHARS_PER_TURN_HARD_CAP})`,
          fatal: false,
        });
      }
      return;
    }
    if (text.length > remaining) {
      // Partial truncate — fill the remaining budget and emit the cap event
      // once. The truncated text is still synthesized so the user hears the
      // intelligible portion; proxy decides what to do with the cap signal.
      text = text.slice(0, remaining);
      if (!this._charCapEmittedThisTurn) {
        this._charCapEmittedThisTurn = true;
        this.emit('event', {
          kind: 'error',
          at: Date.now(),
          code: 'protocol_violation',
          message: `hume_per_turn_cap_exceeded (${HUME_CHARS_PER_TURN_HARD_CAP})`,
          fatal: false,
        });
      }
    }

    const msg = {
      text,
      voice: { id: this._voiceId, provider: 'CUSTOM_VOICE' },
    };
    if (shouldSendSpeed(this._ttsSpeed)) msg.speed = this._ttsSpeed;
    if (shouldSendTrailingSilence(this._trailingSilence)) msg.trailing_silence = this._trailingSilence;
    if (shouldSendDescription(this._description)) msg.description = this._description;

    this._charsThisTurn += text.length;
    this._sentFirstChunkOfTurn = true;
    if (this._firstSendAtMs === 0) this._firstSendAtMs = Date.now();
    if (this._currentTurnTextSample.length < 500) {
      this._currentTurnTextSample = (this._currentTurnTextSample + text).slice(0, 500);
    }
    this._wsSend(msg);
  }

  /**
   * Sends `{flush:true}` and awaits the matching `is_last_chunk:true`.
   * Resolves with per-turn metrics. On timeout/error, resolves with
   * `partial:true` so the caller can still write Gemini cogs legs.
   */
  async turnEnd({ timeoutMs = 5000 } = {}) {
    // Audit S1 — INVARIANT: `_audioBytesThisTurn` is POST-FIR-downsample
    // byte count and `_sampleRate` is the POST-downsample 16000. Both moved
    // together when C1's resampler landed; `bytes / (16000 * 2)` is the
    // correct wall-clock seconds. Do NOT change one without the other, and
    // do NOT switch this back to a pre-downsample (48k) byte count — that
    // would 3× the reported seconds and break cogs/quota accounting.
    const partialResult = () => ({
      characters: this._charsThisTurn,
      audioBytes: this._audioBytesThisTurn,
      audioSeconds: this._audioBytesThisTurn / (this._sampleRate * 2),
      partial: true,
    });
    if (this._closed || this._turnDead) return partialResult();
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return partialResult();
    if (!this._currentContextId) {
      return { characters: 0, audioBytes: 0, audioSeconds: 0, partial: false };
    }

    if (!this._sentFirstChunkOfTurn) {
      // No text was sent this turn (empty model output). Skip synth, resolve
      // immediately as non-partial zero — matches cartesia-bridge semantics.
      this._currentContextId = null;
      return { characters: 0, audioBytes: 0, audioSeconds: 0, partial: false };
    }

    return new Promise((resolve) => {
      const ctxId = this._currentContextId;
      const to = setTimeout(() => {
        cleanup();
        resolve(partialResult());
      }, timeoutMs);
      const handler = (e) => {
        if (e.kind === 'turn_done' && e.contextId === ctxId) {
          cleanup();
          resolve({
            characters: this._charsThisTurn,
            audioBytes: this._audioBytesThisTurn,
            audioSeconds: this._audioBytesThisTurn / (this._sampleRate * 2),
            partial: false,
          });
        } else if (e.kind === 'error') {
          cleanup();
          resolve(partialResult());
        } else if (e.kind === 'closed') {
          cleanup();
          resolve(partialResult());
        }
      };
      const cleanup = () => {
        clearTimeout(to);
        this.off('event', handler);
        this._currentContextId = null;
      };
      // Audit M6 fix (2026-05-13): register the handler BEFORE sending the
      // flush. If is_last_chunk:true arrives in the same microtask (fast
      // network or synchronous test stub), the previous ordering missed it.
      this.on('event', handler);
      this._wsSend({ flush: true });
    });
  }

  /**
   * Barge-in. Hume does NOT honor mid-stream cancel within 200ms (Phase-0
   * verified: all 3 strategies leak 6–14 chunks for ~300–425ms post-cancel).
   * Strategy: latch the current generation_id into the cancel set so inbound
   * chunks for it get dropped on receipt. The Hume side continues to
   * produce audio (and bill characters); the bridge filters it from
   * audio_out events. Wasted chars are tracked via `_charsThisTurn` and
   * surface in the cogs row — caller can attribute via metadata.
   */
  cancel() {
    this._turnDead = true;
    if (this._currentGenerationId) {
      // Audit M1 fix (2026-05-13): FIFO-evict oldest if at cap. Set
      // iteration order is insertion order so .values().next() gives the
      // oldest entry.
      if (this._cancelledGenerationIds.size >= MAX_CANCELLED_GEN_IDS) {
        const oldest = this._cancelledGenerationIds.values().next().value;
        if (oldest) this._cancelledGenerationIds.delete(oldest);
      }
      this._cancelledGenerationIds.add(this._currentGenerationId);
    } else {
      // Audit M6 — barge-in BEFORE the first chunk of this turn arrived, so
      // the generation_id is unknown and can't be added to the cancel set.
      // Without this, _turnDead alone gates the leaked chunks — but the
      // next turnStart resets _turnDead=false, and the still-in-flight
      // leaked chunks (gen-id never cancelled) would emit INTO the new
      // turn's audio (user hears the interrupted answer over the new one).
      // Drop-all + latch every gen-id seen until the next turnStart.
      this._pendingCancelDropAll = true;
    }
    this._currentContextId = null;
    this._currentGenerationId = null;
    if (this._closed) return;
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    // We don't bother sending {close:true} or {flush:false} — Phase-0
    // verified none of them stop production within 200ms. Filter-only is
    // simpler and produces deterministic behavior across all three failed
    // strategies. The Hume WS stays open for the next turn.
  }

  /** Subscribe; returns unsubscribe. Cartesia-style on('event', handler). */
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

  /** Idempotent. */
  async close() {
    if (this._closed) return;
    this._closed = true;
    try { this._ws?.close(1000, 'normal_closure'); } catch {}
    this._ws = null;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  _wsSend(obj) {
    try {
      this._ws.send(JSON.stringify(obj));
    } catch (e) {
      // Audit S19 (unit-wide) — defense logging for the rare JSON.stringify
      // failure. The proxy normalizes Unicode upstream so stringify should
      // never throw, but logging the text-length at failure lets ops
      // correlate "weird input → reject" when it does happen. e.message
      // may include URL — scrub before surfacing.
      const textLen = typeof obj?.text === 'string' ? obj.text.length : -1;
      // eslint-disable-next-line no-console
      console.error(`[hume-bridge] _wsSend serialization failed: textLen=${textLen} err=${e?.message}`);
      this._emitError('connection_lost', scrubUrl(e?.message || 'ws_send_failed'), { fatal: true });
    }
  }

  _onMessage(data, isBinary) {
    // A/B harness audit C1 — capture wire-receive timestamp BEFORE JSON
    // parse + base64 decode so TTFA measurements aren't skewed by per-
    // envelope decoding cost differences between providers.
    const wireRxAtMs = Date.now();
    if (this._closed) return;
    if (isBinary) {
      // We pass no_binary=true so audio comes as base64 string in JSON. Any
      // binary frame is a protocol violation.
      this._emitError('protocol_violation', 'binary frame on JSON wire (no_binary=true requested)', { fatal: true });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      this._emitError('protocol_violation', 'non-json frame', { fatal: true });
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const t = msg.type;
    if (!t || !KNOWN_INBOUND_TYPES.has(t)) {
      if (!this._unknownTypeWarned) {
        this._unknownTypeWarned = true;
        this.emit('event', {
          kind: 'error',
          at: Date.now(),
          code: 'unknown_envelope_type',
          // Only the type field is logged — never the full msg (Vuk-C2 leak channel).
          message: `unknown type: ${String(t).slice(0, 40)}`,
          fatal: false,
        });
      }
      return;
    }
    if (t === 'audio') {
      // Latch generation_id on the first chunk of a turn so cancel() can
      // reference it. Hume re-uses generation_id across chunks of the same
      // synthesis burst.
      const genId = msg.generation_id || null;
      if (!this._currentGenerationId && genId) {
        this._currentGenerationId = genId;
      }
      // Audit M6 — barge-in-before-first-chunk window. cancel() set this
      // because it had no gen-id to latch. Drop every chunk here AND latch
      // each gen-id we now see into the cancel set, so once the next
      // turnStart clears this flag the leaked chunks are STILL filtered by
      // the gen-id check below (the cancel set survives turnStart). In
      // practice every leaked chunk (~300–425ms post-cancel, Phase-0)
      // arrives long before the next turn produces audio (full STT→LLM→TTS
      // pipeline), so the cancelled gen-id is always latched in-window.
      if (this._pendingCancelDropAll) {
        if (genId && !this._cancelledGenerationIds.has(genId)) {
          if (this._cancelledGenerationIds.size >= MAX_CANCELLED_GEN_IDS) {
            const oldest = this._cancelledGenerationIds.values().next().value;
            if (oldest) this._cancelledGenerationIds.delete(oldest);
          }
          this._cancelledGenerationIds.add(genId);
        }
        return; // drop — this chunk belongs to the cancelled (pre-genid) turn
      }
      // Filter-by-generation_id cancellation (Phase-0 mandated).
      if (genId && this._cancelledGenerationIds.has(genId)) {
        // Still count the chunk for char-billing audit (`_charsThisTurn`
        // already counted at sendText) — we just don't pipe audio out.
        if (msg.is_last_chunk) {
          // Treat the last-chunk arrival of a cancelled generation as the
          // signal to evict it from the cancel set; the caller will start
          // a new generation on the next turnStart.
          this._cancelledGenerationIds.delete(genId);
        }
        return;
      }
      if (this._turnDead) return;
      const audioB64 = msg.audio || '';
      if (typeof audioB64 !== 'string' || audioB64.length === 0) {
        // Empty chunk — could be is_last_chunk:true with no trailing audio.
        if (msg.is_last_chunk) {
          this.emit('event', { kind: 'turn_done', at: Date.now(), contextId: this._currentContextId, generationId: genId });
        }
        return;
      }
      const rawBytes = Buffer.from(audioB64, 'base64');
      // 48 kHz → declared rate. Identity passthrough when null (declared
      // rate already matches Hume native), otherwise FIR-filtered decimate.
      const bytes = this._resampler ? this._resampler.process(rawBytes) : rawBytes;
      this._audioBytesThisTurn += bytes.length;
      this._chunksReceivedThisTurn += 1;
      this.emit('event', {
        kind: 'audio_out',
        at: Date.now(),
        wireRxAtMs, // C1 audit fix — pre-parse receive timestamp
        chunk: { bytes, mimeType: `audio/pcm;rate=${this._sampleRate}` },
        contextId: this._currentContextId,
        generationId: genId,
      });
      if (msg.is_last_chunk) {
        this.emit('event', { kind: 'turn_done', at: Date.now(), contextId: this._currentContextId, generationId: genId });
      }
    } else if (t === 'error') {
      const humeCode = String(msg.code || '').toUpperCase();
      const humeSlug = String(msg.slug || '').toLowerCase();
      // Unit-wide audit M4 fix (2026-05-13): per-error mapping carries
      // both the const-union code AND the fatal flag. Unknown codes
      // default to {code:'other', fatal:true} — conservative posture
      // matching Cartesia (assume WS unusable unless explicitly known
      // to be per-turn-recoverable).
      const entry = HUME_ERROR_MAP[humeCode] || HUME_DEFAULT_ERROR;
      const mapped = entry.code;
      const fatal = entry.fatal;
      // Audit small fix — emit a one-shot warning event the first time we
      // see an unmapped Hume error code. The error is still routed via
      // HUME_DEFAULT_ERROR; this just surfaces telemetry so ops can add
      // the code to HUME_ERROR_MAP.
      if (!HUME_ERROR_MAP[humeCode] && humeCode && !this._unknownErrorCodesWarned.has(humeCode)) {
        this._unknownErrorCodesWarned.add(humeCode);
        this.emit('event', {
          kind: 'error',
          at: Date.now(),
          code: 'unknown_hume_error_code',
          message: `hume_unmapped_error_code: ${humeCode}`,
          fatal: false,
          humeMessage: null,
          textSample: '',
          humeCode,
          humeSlug,
        });
      }
      // Audit C4 + unit-wide audit M7 fix (2026-05-13): TWO emission
      // fields. `message` is bridge-controlled, safe to log anywhere.
      // `humeMessage` carries the raw (bounded) Hume payload — denylisted
      // in Sentry TRANSCRIPT_KEYS so it gets redacted before captureException
      // surfaces it. The Sentry denylist match is on the literal key name
      // `humemessage`/`hume_message`, which is why we expose Hume-echo
      // content under THAT key, not the generic `message` field.
      let safeMessage;
      let humeMessageEcho;
      if (mapped === 'protocol_violation') {
        // E0101 / payload_parse — DO NOT surface Hume's verbatim message;
        // Phase-0 confirmed it echoes our outbound payload. Use the literal
        // bridge tag.
        safeMessage = 'hume_payload_parse';
        humeMessageEcho = null;
      } else {
        // Other codes: assume Hume's message may echo client input in
        // future codes (TBD per Hume's roadmap). Bridge-side bounded to
        // 200 chars; Sentry-side denylisted by key name.
        safeMessage = 'hume_other_error';
        humeMessageEcho = String(msg.message || msg.slug || 'hume_error').slice(0, 200);
      }
      if (!fatal) {
        this._turnDead = true;
        this._currentContextId = null;
      }
      this.emit('event', {
        kind: 'error',
        at: Date.now(),
        code: mapped,
        message: safeMessage,
        // Sentry-denylisted key; null on E0101 (bridge sanitized that path
        // entirely). For other codes, holds the bounded Hume verbatim
        // message which the Sentry scrub redacts before captureException.
        humeMessage: humeMessageEcho,
        fatal,
        textSample: this._currentTurnTextSample || '',
        // Bounded — useful for ops to disambiguate Hume code series.
        humeCode: humeCode || null,
        humeSlug: humeSlug || null,
      });
    }
    // 'timestamps' currently ignored (we don't request word/phoneme times in v1).
  }

  _onError(e) {
    // Transport-level. Scrub message — `ws` includes the URL on connect
    // failures, and the URL carries the api_key query param.
    this.emit('event', {
      kind: 'error',
      at: Date.now(),
      code: 'connection_lost',
      message: scrubUrl(String(e?.message || e || 'ws_error')).slice(0, 200),
      fatal: false,
    });
  }

  _onClose(code, reason) {
    if (this._closed) return;
    const inMidTurn = !!this._currentContextId;
    const msSinceFirstSend = this._firstSendAtMs > 0 ? Date.now() - this._firstSendAtMs : 0;
    // Phase-0 bad-voice-id heuristic: close 1000 + zero chunks received +
    // we've been sending text for at least 1.5s = bad voice id.
    // Hume sends NO error envelope for this case — the close is silent.
    //
    // Audit M2 fix (2026-05-13): also require _audioBytesThisTurn === 0.
    // Edge case: a prior turn that ended via `audio:''` is_last_chunk:true
    // emits turn_done without incrementing _chunksReceivedThisTurn (we
    // only count chunks with non-empty audio at line ~526). After turnEnd
    // resolves clean, an idle close 1000 would see chunks=0 + first_send
    // flag still set from the prior turn → false bad_voice_id. Adding the
    // audioBytes guard catches the "prior turn synthesized real audio"
    // case correctly.
    const looksLikeBadVoiceId = (
      code === 1000 &&
      this._chunksReceivedThisTurn === 0 &&
      this._audioBytesThisTurn === 0 &&
      this._sentFirstChunkOfTurn &&
      msSinceFirstSend >= BAD_VOICE_ID_DETECTION_MS
    );
    this._ws = null;
    // Audit Small fix (2026-05-13): emit error BEFORE closed. Previously
    // `closed` fired first, which caused turnEnd's resolve-handler to
    // resolve partial:true on `closed` and detach. The subsequent
    // bad_voice_id error had no listener — the proxy never saw it.
    // Reordered so the fatal signal is delivered first.
    if (looksLikeBadVoiceId) {
      this.emit('event', {
        kind: 'error',
        at: Date.now(),
        code: 'bad_voice_id',
        // The literal voice id is NOT logged here — only its length, so a
        // future agent can disambiguate "empty voiceId" from "valid-shape
        // voiceId Hume rejects." The id itself isn't a secret per se but
        // we don't want it correlating into log search.
        message: `hume_silent_close_voiceid_likely (voiceId_len=${this._voiceId.length} ms_since_first_send=${msSinceFirstSend})`,
        fatal: true,
      });
      this.emit('event', { kind: 'closed', at: Date.now(), code, reason: String(reason || '').slice(0, 80) });
      return;
    }
    if (inMidTurn) {
      this.emit('event', {
        kind: 'error',
        at: Date.now(),
        code: 'connection_lost',
        message: 'hume_closed_mid_turn',
        fatal: true,
      });
      this.emit('event', { kind: 'closed', at: Date.now(), code, reason: String(reason || '').slice(0, 80) });
      return;
    }
    this.emit('event', { kind: 'closed', at: Date.now(), code, reason: String(reason || '').slice(0, 80) });
    this._reconnect();
  }

  async _reconnect() {
    if (this._closed) return;
    if (this._reconnecting) return;
    const now = Date.now();
    this._reconnectTimestamps = this._reconnectTimestamps.filter((t) => now - t < 60_000);
    if (this._reconnectTimestamps.length >= 5) {
      this.emit('event', {
        kind: 'error',
        at: now,
        code: 'connection_lost',
        message: 'hume_reconnect_thrash_window',
        fatal: true,
      });
      return;
    }
    this._reconnecting = true;
    for (const wait of RECONNECT_BACKOFFS_MS) {
      this._reconnectAttempt += 1;
      await new Promise((r) => setTimeout(r, wait));
      if (this._closed) { this._reconnecting = false; return; }
      try {
        await this._openOnce();
        this._reconnecting = false;
        this._reconnectAttempt = 0;
        this._reconnectTimestamps.push(Date.now());
        // Audit M3 fix (2026-05-13): cancel-set lifespan = one WS connection.
        // Clearing on reconnect prevents a stale gen_id from dropping
        // legitimate chunks if Hume ever changes the gen_id scheme. Also
        // reset the unknown-type warn latch so post-reconnect Hume protocol
        // surprises get a fresh single warning.
        this._cancelledGenerationIds.clear();
        this._unknownTypeWarned = false;
        this._unknownErrorCodesWarned.clear();
        this.emit('event', { kind: 'reconnected', at: Date.now() });
        return;
      } catch (e) {
        // Try the next backoff. e.message already scrubbed in _openOnce.
      }
    }
    this._reconnecting = false;
    this.emit('event', {
      kind: 'error',
      at: Date.now(),
      code: 'connection_lost',
      message: 'hume_reconnect_exhausted',
      fatal: true,
    });
  }

  _emitError(code, message, { fatal }) {
    this.emit('event', {
      kind: 'error',
      at: Date.now(),
      code,
      message: String(message).slice(0, 200),
      fatal: !!fatal,
    });
  }
}
