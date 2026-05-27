// CartesiaTTSBridge — Pipeline α' TTS leg (Cartesia Sonic 3 over WS).
//
// Lifecycle: open → turnStart(ctxId) → sendText* → turnEnd → (repeat) → close
// Events:    setup_complete | audio_out | turn_done | error | closed |
//            reconnected
//
// Auth (verified against docs.cartesia.ai 2026-05-02): the Cartesia REST API
// uses `Authorization: Bearer ${key}` (e.g. /voices/clone, DELETE /voices/{id}
// — see route.ts + voice-delete-worker.js). The WebSocket endpoint uses
// `X-API-Key: ${key}` because browsers can't set headers on WS opens — the
// docs explicitly list the two as separate schemes. Both are correct; this
// comment exists so a future reviewer doesn't "fix" the apparent mismatch.
//
// Wire format (cartesia_version=2026-03-01, JSON-base64 envelopes per
// docs.cartesia.ai/api-reference/tts/websocket — VERIFIED in Phase-0 re-run
// `scripts/cartesia-phase0-rerun.mjs`).
//
//   Outbound first chunk of a turn:
//     { context_id, model_id:'sonic-3', transcript, voice:{mode:'id', id:<voiceId>},
//       output_format:{ container:'raw', encoding:'pcm_s16le', sample_rate:24000 },
//       continue:true }
//   Outbound continuation:
//     { context_id, transcript, continue:true }
//   Outbound manual flush (keeps context OPEN — forces buffered tail out now):
//     { context_id, model_id, transcript:'', voice, output_format, continue:true, flush:true }
//   Outbound final flush (finalizes + CLOSES context):
//     { context_id, transcript:'', continue:false }
//   Outbound cancel:
//     { context_id, cancel:true }
//
//   Inbound chunk:
//     { type:'chunk', data:'<base64-pcm>', context_id, done:false, status_code:206 }
//   Inbound manual-flush ack:
//     { type:'flush_done', done:false, flush_done:true, flush_id, context_id, status_code }
//   Inbound done:
//     { type:'done', done:true, context_id, status_code:206 }
//   Inbound error:
//     { type:'error', error_code, title, message, status_code, context_id }
//
// Strict JSON parse (R3-C4): non-JSON or unknown `type` is treated as a
// protocol violation; the bridge emits error{code:'protocol_violation'}
// and the caller MUST tear down. No raw-binary fallback.
//
// Inbound payload cap: maxPayload: 1 MB (R4-C4). Cartesia-side runaway
// frames close the WS with code 1009 → onclose handler maps to error.
//
// Reconnect (R3-M2 / R4-M2): if the WS closes with no in-flight turn,
// auto-reopen up to 3 times with backoff [200, 500, 1000] ms. If a
// turnStart arrives during the reconnect window, reject synchronously
// with error{code:'tts_reconnecting'} so the proxy can close 4011. A
// mid-turn close stays terminal — Cartesia would re-bill the same
// context_id per Phase-0 cross-check.

import WebSocket from 'ws';
import { EventEmitter } from 'node:events';

const CARTESIA_WSS = 'wss://api.cartesia.ai/tts/websocket';
const CARTESIA_VERSION = '2026-03-01';
const SONIC_MODEL = 'sonic-3';
const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_OPEN_TIMEOUT_MS = 5000;
const INBOUND_MAX_PAYLOAD = 1 * 1024 * 1024;

const RECONNECT_BACKOFFS_MS = [200, 500, 1000];

const KNOWN_INBOUND_TYPES = new Set(['chunk', 'done', 'timestamps', 'error', 'flush_done']);

// Decide whether to emit `generation_config.speed` on the Cartesia message.
// We omit the field for NULL and explicit 1.0 (Cartesia default) — sending
// speed:1.0 is functionally equivalent to omitting but writes a redundant
// control block and couples our wire payload to the Cartesia param shape.
// Keep this function in sync with the equivalent helper in
// src/app/api/creator/voice-preview/route.ts (cross-package import not
// feasible because server/voice-proxy has its own node_modules).
function shouldSendSpeed(v) {
  return typeof v === 'number' && Number.isFinite(v) && v !== 1.0 && v >= 0.6 && v <= 1.5;
}

// Bridge error code taxonomy. Provider-specific codes map onto these
// const-union strings at the bridge boundary so consumers never see raw
// Cartesia strings.
const CARTESIA_ERROR_MAP = {
  voice_not_found: 'bad_voice_id',
  rate_limited: 'rate_limited',
  model_not_found: 'model_not_found',
  // anything else → 'other'
};

export class CartesiaTTSBridge extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey            Cartesia API key (header auth).
   * @param {string} opts.voiceId           IVC voice id (creator clone).
   * @param {number} [opts.sampleRate=24000]
   * @param {number} [opts.openTimeoutMs=5000]
   * @param {number|null} [opts.ttsSpeed=null]  Cartesia generation_config.speed,
   *   range [0.6, 1.5]. NULL or 1.0 → omit the field (Cartesia default).
   *   Carrying explicit 1.0 = sending speed:1.0 in JSON, which is functionally
   *   equivalent to omitting but bloats wire payload AND couples us to
   *   Cartesia param naming. Omit policy is enforced by shouldSendSpeed().
   *   See migration 20260511000006 column COMMENT for full rationale.
   */
  constructor({ apiKey, voiceId, sampleRate = DEFAULT_SAMPLE_RATE, openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS, ttsSpeed = null } = {}) {
    super();
    if (!apiKey) throw new Error('CARTESIA_API_KEY missing');
    if (!voiceId) throw new Error('voiceId missing');
    this._apiKey = apiKey;
    this._voiceId = voiceId;
    this._sampleRate = sampleRate;
    this._openTimeoutMs = openTimeoutMs;
    // ttsSpeed: number ∈ [0.6, 1.5] OR null. Coerce strings (defense in
    // depth — proxy already does Number() at ticket boundary). Out-of-range
    // values fall back to null (omit) rather than fail the bridge open;
    // creator-side UI clamps and DB CHECK catches before we get here.
    const speedNum = typeof ttsSpeed === 'number'
      ? ttsSpeed
      : (ttsSpeed != null ? Number(ttsSpeed) : NaN);
    this._ttsSpeed = (Number.isFinite(speedNum) && speedNum >= 0.6 && speedNum <= 1.5)
      ? speedNum
      : null;
    this._ws = null;
    this._closed = false;
    this._currentContextId = null;
    this._turnDead = false;
    this._charsThisTurn = 0;
    this._audioBytesThisTurn = 0;
    // P1-10 spurious-barge fix (2026-05-20). Wall-clock of the last
    // audio_out chunk we received from Cartesia. The proxy's `interrupted`
    // handler reads this via getLastChunkAt() to distinguish a real user
    // barge during playback (chunk seen <1s ago) from a spurious Gemini
    // Live interrupted event (Cartesia idle, Gemini's parallel audio-gen
    // timeline is the only thing being "interrupted"). 0 = no chunk yet.
    this._lastChunkAtMs = 0;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this._unknownTypeWarned = false;
    // Sliding-window thrash guard (audit M7): if Cartesia closes idle
    // and successfully reconnects in tight succession, we'd loop forever.
    // Cap successful reconnects at 5 within a 60s window before giving up.
    this._reconnectTimestamps = [];
  }

  /** Opens the WS. Resolves on first successful connect; rejects on timeout. */
  async open() {
    if (this._closed) throw new Error('bridge_closed');
    if (this._ws) throw new Error('bridge_already_open');
    await this._openOnce();
  }

  async _openOnce() {
    const url = `${CARTESIA_WSS}?cartesia_version=${encodeURIComponent(CARTESIA_VERSION)}`;
    const ws = new WebSocket(url, {
      headers: { 'X-API-Key': this._apiKey },
      maxPayload: INBOUND_MAX_PAYLOAD,
      perMessageDeflate: false,
    });
    this._ws = ws;

    await new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        try { ws.terminate(); } catch {}
        reject(new Error('cartesia_open_timeout'));
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
        reject(e);
      });
    });
    // No setup-complete equivalent in the documented Cartesia WS protocol;
    // the WS being open is the signal.
    this.emit('event', { kind: 'setup_complete', at: Date.now() });
  }

  /**
   * Marks the start of a Cartesia turn. context_id format
   * `<sessionId>:<turnNumber>` is the caller's responsibility.
   * R3-M1 / R4-S1: must be called synchronously before sendText.
   */
  turnStart(contextId) {
    if (this._closed) throw new Error('bridge_closed');
    if (!contextId || typeof contextId !== 'string') throw new Error('bad_context_id');
    if (this._reconnecting) {
      // R4-M2: synchronous reject when reconnect is in flight.
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
    this._turnDead = false;
    this._charsThisTurn = 0;
    this._audioBytesThisTurn = 0;
    this._diagDroppedChunks = 0; // ⚠️ TEMP AUDIODIAG — DELETE later
    this._diagDroppedBytes = 0;  // ⚠️ TEMP AUDIODIAG — DELETE later
    // P1-10 audit C1 — reset on turnStart so getLastChunkAt() reflects
    // "last chunk in CURRENT turn", not turn N-1. Without this, the
    // spurious-barge heuristic mis-classifies pre-playback interrupted
    // events on turn N+1 (idleMs measured against turn N's last chunk).
    this._lastChunkAtMs = 0;
    this._sentFirstChunkOfTurn = false;
    // Phase 0.5 (2026-05-07). Capture a bounded sample of what we send so a
    // Cartesia-side "Invalid transcript" rejection lands in logs with the
    // actual offending text (truncated). Without this we have no way to
    // diagnose which character / pattern Cartesia is choking on.
    this._currentTurnTextSample = '';
  }

  /** Streams a transcript chunk. Maintains continue:true. */
  sendText(text) {
    if (!text) return;
    // 2026-05-12 dogfood fix — Cartesia returned "Invalid transcript" on
    // ~3 chunks during the first vector-mode session. Gemini's
    // outputTranscription emits smart-quotes (' ' " "), em-dashes (—),
    // ellipses (…), and other Unicode punctuation that Cartesia's text
    // tokenizer rejects. Normalize to ASCII equivalents so audio synthesis
    // doesn't drop chunks.
    text = text
      .replace(/[‘’‚‛]/g, "'")  // curly single quotes / low-9
      .replace(/[“”„‟]/g, '"')  // curly double quotes / low-9
      .replace(/[–—]/g, '-')              // en-dash, em-dash
      .replace(/…/g, '...')                    // horizontal ellipsis
      .replace(/[ ]/g, ' ');                   // non-breaking space
    if (!text) return;  // post-normalize re-check (defensive)
    if (this._closed || this._turnDead) return;
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    if (!this._currentContextId) throw new Error('sendText before turnStart');

    // 2026-05-04 — Cartesia rejects continuation messages that omit `voice` /
    // `model_id` / `output_format` with "neither embedding nor ID provided".
    // Reference implementation (pipecat) sends the full block on EVERY
    // message, not just the first. We follow that pattern.
    const msg = {
      context_id: this._currentContextId,
      model_id: SONIC_MODEL,
      transcript: text,
      voice: { mode: 'id', id: this._voiceId },
      output_format: {
        container: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: this._sampleRate,
      },
      continue: true,
    };
    // Creator playback-speed knob (migration 20260511000006).
    // generation_config.speed must ride every Cartesia message per the
    // pipecat reference pattern (Cartesia rejects continuation messages
    // that drop the full voice/model_id/output_format block). Same logic
    // applied to turnEnd() below — kept identical via shouldSendSpeed().
    if (shouldSendSpeed(this._ttsSpeed)) {
      msg.generation_config = { speed: this._ttsSpeed };
    }
    this._charsThisTurn += text.length;
    this._sentFirstChunkOfTurn = true;
    if (this._currentTurnTextSample.length < 500) {
      this._currentTurnTextSample = (this._currentTurnTextSample + text).slice(0, 500);
    }
    this._wsSend(msg);
  }

  /**
   * Manual flush — forces Cartesia to synthesize its buffered trailing text
   * NOW, while keeping the context OPEN (continue:true). Mid-word-cutoff fix
   * (2026-05-27). Under continue:true Cartesia holds the final synthesis unit
   * until it has "enough context or the buffer delay elapses" (Cartesia docs),
   * so the last word's audio only streamed when `continue:false` fired at
   * turnEnd. In decoupled mode that terminator is gated behind Gemini Live's
   * `turn_complete` (6-21s late, sometimes absent) → the client's 200ms
   * tail-flush fires first and the trailing word is cut at random. Flushing at
   * deep-answer-done (decoupled from Gemini) streams the tail immediately;
   * turnEnd's continue:false STILL finalizes + bills (synthesizes nothing new).
   *
   * Wire shape (transcript:'' + continue:true + flush:true + full block)
   * VERIFIED on the pinned cartesia_version=2026-03-01 by
   * scripts/cartesia-flush-probe.mjs (flush accepted, flush_done returned,
   * context survives, later continue:false still finalizes). Carries the full
   * voice/model_id/output_format block for the SAME reason as sendText (L233 —
   * Cartesia rejects continuation messages that drop it); do NOT "simplify" it
   * to match Hume's bare {flush:true}.
   *
   * @param {string} [expectedContextId] Audit C3 — the context the CALLER
   *   intends to flush (the turn whose deep answer just finished). onDeepAnswerDone
   *   fires for turn N from the orchestrator; by the time it lands a fast
   *   next-turn turnStart may have swapped _currentContextId to N+1. Flushing
   *   then would force-synthesize the NEW turn's in-flight partial text → cut
   *   the new turn mid-word (the exact bug, re-introduced). No-op on mismatch.
   *
   * No-op (does NOT throw) if the bridge is closed/dead, the WS isn't open,
   * there's no live context, nothing was sent this turn (nothing to force out),
   * or the live context isn't the one the caller meant. Touches neither
   * _charsThisTurn/_currentTurnTextSample (no billable text) nor
   * _currentContextId (context stays open for the later turnEnd).
   */
  flush(expectedContextId) {
    if (this._closed || this._turnDead) return;
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    if (!this._currentContextId) return;
    if (!this._sentFirstChunkOfTurn) return;
    if (expectedContextId != null && expectedContextId !== this._currentContextId) return;
    const msg = {
      context_id: this._currentContextId,
      model_id: SONIC_MODEL,
      transcript: '',
      voice: { mode: 'id', id: this._voiceId },
      output_format: {
        container: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: this._sampleRate,
      },
      continue: true,
      flush: true,
    };
    // Carry speed on the flush too (matches sendText/turnEnd; Cartesia treats
    // the per-message block as authoritative).
    if (shouldSendSpeed(this._ttsSpeed)) {
      msg.generation_config = { speed: this._ttsSpeed };
    }
    this._wsSend(msg);
  }

  /**
   * Sends final continue:false and awaits the matching `done` event.
   * Resolves with per-turn metrics. On timeout/error, resolves with
   * `partial:true` so the caller can still write Gemini cogs legs
   * (R3-C1 / R4-C1 quota-correctness rule).
   *
   * Audit R3-M1 (logic) flagged "cancel-then-turnEnd throws because
   * `_currentContextId` is null"; verified false-positive — the
   * `_turnDead` short-circuit at the top of the function returns
   * partialResult() before reaching the !_currentContextId throw.
   * Sequence: cancel() sets _turnDead=true and nulls _currentContextId,
   * then turnEnd() hits the first `if (this._closed || this._turnDead)`
   * check and bails clean.
   *
   * Phase 0 re-run 2026-05-04: Cartesia emits `done` ~6s after
   * `continue:false` from a cold-connection turn (measured 6072ms).
   * Default timeoutMs=5000 will frequently produce partial:true at
   * session-end teardown — that is expected and handled (Gemini legs
   * still flush correctly). Not on user critical path: contexts only
   * close at session end, never turn-to-turn. Bump timeoutMs only if
   * we need precise Cartesia COGS at session close.
   */
  async turnEnd({ timeoutMs = 5000 } = {}) {
    const partialResult = () => ({
      characters: this._charsThisTurn,
      audioBytes: this._audioBytesThisTurn,
      audioSeconds: this._audioBytesThisTurn / (this._sampleRate * 2),
      partial: true,
    });
    if (this._closed || this._turnDead) return partialResult();
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return partialResult();
    // Defense-in-depth (Phase 0.5 2026-05-07). Previously threw 'turnEnd
    // before turnStart' if a turn_end arrived without a live context — a
    // legitimate state when a prior cancel cleared it. The throw bubbled
    // out of the proxy WS message handler and poisoned subsequent turns
    // (user reported "stopped hearing me after 2-3 messages"). Treat as
    // a no-op partial: zero chars, zero audio, partial=false so cogs
    // still log a clean turn.
    if (!this._currentContextId) return { characters: 0, audioBytes: 0, audioSeconds: 0, partial: false };

    if (this._sentFirstChunkOfTurn) {
      // Match pipecat reference: full block on every message including the
      // empty-transcript terminator.
      const terminator = {
        context_id: this._currentContextId,
        model_id: SONIC_MODEL,
        transcript: '',
        voice: { mode: 'id', id: this._voiceId },
        output_format: {
          container: 'raw',
          encoding: 'pcm_s16le',
          sample_rate: this._sampleRate,
        },
        continue: false,
      };
      // Carry speed on the terminator too (matches sendText pattern;
      // Cartesia treats the per-message block as authoritative).
      if (shouldSendSpeed(this._ttsSpeed)) {
        terminator.generation_config = { speed: this._ttsSpeed };
      }
      this._wsSend(terminator);
    } else {
      // No text was sent this turn (e.g., model produced empty transcript).
      // Skip the synth and resolve immediately as non-partial zero.
      this._currentContextId = null;
      return { characters: 0, audioBytes: 0, audioSeconds: 0, partial: false };
    }

    return new Promise((resolve) => {
      const ctxId = this._currentContextId;
      const to = setTimeout(() => {
        cleanup();
        // R3-C1: never throw — return partial so logTurnCogs always lands.
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
        // 2026-05-27 (v2, audit Attack #3) — only null if it's STILL this turn's
        // context. The finalize await is up to 60s (long-answer cutoff fix); if
        // the user barges to the NEXT turn during that window, turnStart() has
        // already set _currentContextId to N+1. Unconditionally nulling here
        // would wipe N+1's live context → every N+1 chunk hits the ctx-mismatch
        // drop → the new turn is cut mid-word (the exact bug, re-introduced).
        if (this._currentContextId === ctxId) this._currentContextId = null;
      };
      this.on('event', handler);
    });
  }

  /**
   * P1-10 spurious-barge fix (2026-05-20). Wall-clock of the last
   * audio_out chunk received from Cartesia, or 0 if no chunk arrived
   * since open. 2026-05-27: the proxy's `interrupted` handler no longer
   * uses this to DECIDE suppression (decoupled now always-suppresses);
   * it is logged only — `idleMs` small at suppression time = Cartesia was
   * actively playing, i.e. a mid-word cut the old code would have caused.
   */
  getLastChunkAt() {
    return this._lastChunkAtMs;
  }

  /** Barge-in. Synchronous flag set + cancel WS send (R3-M1 / R4-S1).
   *  Nulls `_currentContextId` (L-M1) so a stray `turnEnd` after cancel
   *  doesn't try to flush against a dead context — that path used to
   *  hang for the full 5s timeout window before resolving partial.
   */
  cancel() {
    this._turnDead = true;
    const ctx = this._currentContextId;
    this._currentContextId = null;
    if (this._closed || !ctx) return;
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._wsSend({ context_id: ctx, cancel: true });
  }

  /** Subscribe; returns unsubscribe. */
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
      this._emitError('connection_lost', e?.message || 'ws_send_failed', { fatal: true });
    }
  }

  _onMessage(data, isBinary) {
    // A/B harness audit C1 — capture wire-receive timestamp BEFORE JSON
    // parse + base64 decode so TTFA measurements aren't skewed by per-
    // envelope decoding cost differences between providers.
    const wireRxAtMs = Date.now();
    if (this._closed) return;
    if (isBinary) {
      // R3-C4 strict: docs guarantee JSON envelopes on 2026-03-01.
      this._emitError('protocol_violation', 'binary frame on JSON wire', { fatal: true });
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
      // Cartesia might add new envelope types in the future. Emit a
      // soft-error once per session, but don't kill the bridge on the
      // first sighting — flush_done was added without an SDK bump.
      if (!this._unknownTypeWarned) {
        this._unknownTypeWarned = true;
        this.emit('event', {
          kind: 'error',
          at: Date.now(),
          code: 'unknown_envelope_type',
          message: `unknown type: ${String(t).slice(0, 40)}`,
          fatal: false,
        });
      }
      return;
    }
    if (t === 'chunk') {
      // Drop late-arriving chunks for a cancelled turn (R3-M1 / R4-S1)
      // OR for a turn whose `turnEnd` already resolved partial:true (the
      // ctx was nulled on timeout — chunks for it would otherwise replay
      // out-of-order into the next turn's audio stream).
      if (this._turnDead) {
        // ⚠️ TEMP AUDIODIAG — DELETE later. Audio Cartesia is STILL producing,
        // dropped because the turn was killed (cancel) — quantifies the cut.
        this._diagDroppedChunks = (this._diagDroppedChunks || 0) + 1;
        this._diagDroppedBytes = (this._diagDroppedBytes || 0) + Buffer.from(msg.data || '', 'base64').length;
        if (this._diagDroppedChunks <= 3 || this._diagDroppedChunks % 20 === 0) {
          console.log(`[AUDIODIAG cartesia] DROP (turnDead) chunk#${this._diagDroppedChunks} droppedBytes=${this._diagDroppedBytes} ctx=${msg.context_id}`);
        }
        return;
      }
      if (msg.context_id && msg.context_id !== this._currentContextId) {
        // ⚠️ TEMP AUDIODIAG — DELETE later. THE CUTOFF: turnEnd resolved
        // partial (10s timeout) and nulled _currentContextId, but Cartesia is
        // STILL synthesizing a long answer → these chunks (the tail) are
        // dropped → avatar cuts mid-word. Quantifies the lost audio.
        this._diagDroppedChunks = (this._diagDroppedChunks || 0) + 1;
        this._diagDroppedBytes = (this._diagDroppedBytes || 0) + Buffer.from(msg.data || '', 'base64').length;
        if (this._diagDroppedChunks <= 3 || this._diagDroppedChunks % 20 === 0) {
          console.log(`[AUDIODIAG cartesia] DROP (ctx-mismatch) chunk#${this._diagDroppedChunks} droppedBytes=${this._diagDroppedBytes} (~${(this._diagDroppedBytes / 48000).toFixed(1)}s) msgCtx=${msg.context_id} liveCtx=${this._currentContextId}`);
        }
        return;
      }
      const b64 = msg.data || '';
      if (typeof b64 !== 'string' || b64.length === 0) return;
      const bytes = Buffer.from(b64, 'base64');
      this._audioBytesThisTurn += bytes.length;
      this._lastChunkAtMs = Date.now(); // P1-10 spurious-barge anchor
      this.emit('event', {
        kind: 'audio_out',
        at: Date.now(),
        wireRxAtMs, // C1 audit fix — pre-parse receive timestamp
        chunk: { bytes, mimeType: `audio/pcm;rate=${this._sampleRate}` },
        contextId: msg.context_id,
      });
    } else if (t === 'done') {
      this.emit('event', { kind: 'turn_done', at: Date.now(), contextId: msg.context_id });
    } else if (t === 'error') {
      const cartesiaCode = String(msg.error_code || '').toLowerCase();
      const cartesiaMessage = String(msg.title || msg.message || 'cartesia_error').slice(0, 200);
      const mapped = CARTESIA_ERROR_MAP[cartesiaCode] || 'other';
      // Phase 0.5 (2026-05-07). Cartesia returns errors at TWO scopes:
      //   1. Connection-level (auth, rate-limit, model-not-found, voice-not-found)
      //      — WS may close, session can't proceed → fatal.
      //   2. Context-level (transcript rejected for content reasons,
      //      "Invalid transcript", malformed continuation) — WS stays
      //      open, only THIS turn is dead. Recoverable: kill the turn
      //      locally, let the next turnStart get a fresh context.
      // Without this distinction, a one-off transcript chunk Cartesia
      // doesn't like teardowns the whole proxy WS, which closes HeyGen
      // server-side, which surfaces to the user as a misleading
      // "avatar TTL expired" message (proxy index.js teardown chain).
      const isConnectionLevel =
        cartesiaCode === 'voice_not_found' ||
        cartesiaCode === 'model_not_found' ||
        cartesiaCode === 'rate_limited' ||
        cartesiaCode === 'unauthorized' ||
        cartesiaCode === 'forbidden';
      const fatal = isConnectionLevel;
      // For per-turn rejections: kill the turn locally so subsequent
      // sendText calls no-op and turnEnd resolves clean partial. WS
      // stays open; next turnStart resets _turnDead and gets a fresh
      // context_id (cartesia-bridge.js turnStart).
      if (!fatal) {
        this._turnDead = true;
        this._currentContextId = null;
      }
      this.emit('event', {
        kind: 'error',
        at: Date.now(),
        code: mapped,
        message: cartesiaMessage,
        fatal,
        // Bounded — first 500 chars of what we sent this turn. Exists
        // so ops can see the offending text instead of guessing.
        textSample: this._currentTurnTextSample || '',
      });
    }
    // 'timestamps' and 'flush_done' currently ignored.
  }

  _onError(e) {
    // ws-library transport-level error. Surface as non-fatal; the close
    // event that follows handles teardown semantics.
    this.emit('event', {
      kind: 'error',
      at: Date.now(),
      code: 'connection_lost',
      message: String(e?.message || e || 'ws_error').slice(0, 200),
      fatal: false,
    });
  }

  _onClose(code, reason) {
    if (this._closed) return;
    const inMidTurn = !!this._currentContextId;
    this.emit('event', { kind: 'closed', at: Date.now(), code, reason: String(reason || '').slice(0, 80) });
    this._ws = null;
    if (inMidTurn) {
      // Mid-turn close stays terminal — Cartesia would re-bill on the same
      // context_id per Phase 0 cross-check (R3-M2 / R4-M2).
      this.emit('event', {
        kind: 'error',
        at: Date.now(),
        code: 'connection_lost',
        message: 'cartesia_closed_mid_turn',
        fatal: true,
      });
      return;
    }
    // Idle window: try one auto-reconnect with backoff. Sets a flag so any
    // user turn_start during the gap rejects cleanly.
    this._reconnect();
  }

  async _reconnect() {
    if (this._closed) return;
    if (this._reconnecting) return;
    // Sliding-window thrash guard: prune timestamps older than 60s, then
    // refuse if we already burned 5 successful reconnects in the window.
    const now = Date.now();
    this._reconnectTimestamps = this._reconnectTimestamps.filter((t) => now - t < 60_000);
    if (this._reconnectTimestamps.length >= 5) {
      this.emit('event', {
        kind: 'error',
        at: now,
        code: 'connection_lost',
        message: 'cartesia_reconnect_thrash_window',
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
        this.emit('event', { kind: 'reconnected', at: Date.now() });
        return;
      } catch (e) {
        // Try the next backoff.
      }
    }
    this._reconnecting = false;
    this.emit('event', {
      kind: 'error',
      at: Date.now(),
      code: 'connection_lost',
      message: 'cartesia_reconnect_exhausted',
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
