// GeminiBridge — implements AudioBridge (src/lib/voice/audio-bridge.ts)
// against @google/genai Live. Manual-VAD (activityStart/End) for deterministic
// TTFA measurement per plan Decision 7.
//
// Lifecycle: open → turnStart → sendAudio* → turnEnd → (repeat) → close
// Events: setup_complete | audio_out | turn_complete | interrupted | error | closed
//
// Phase 0 verified both models on v1alpha via single GoogleGenAI client —
// no need for per-apiVersion singletons.

import { GoogleGenAI, Modality } from '@google/genai';
import { EventEmitter } from 'node:events';

let _client = null;
function client(apiKey) {
  if (!_client) {
    _client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
  }
  return _client;
}

const DEFAULT_SYSTEM = 'You are a helpful mentor. Answer in one concise sentence.';

export class GeminiBridge extends EventEmitter {
  constructor({ apiKey }) {
    super();
    if (!apiKey) throw new Error('GEMINI_API_KEY missing');
    this._apiKey = apiKey;
    this._session = null;
    this._inputBytes = 0;
    this._outputBytes = 0;
    this._currentTurnOutputBytes = 0;
    this._setupCompleteAt = null;
    this._closed = false;
    // usageMetadata capture (M8). Gemini Live emits usageMetadata on server
    // messages where `promptTokenCount` is the CUMULATIVE count of the entire
    // conversation history up to that message (not a per-message delta).
    // Summing across messages within a turn inflates prompt tokens N× —
    // Round-2 audit C3. Capture the last-seen value instead; downstream
    // subtracts prior-turn cumulative to derive this turn's prompt delta if
    // it ever needs per-turn attribution (Day 8). For Spike-A we just emit
    // the raw last-seen metadata.
    this._currentTurnUsage = null;
  }

  async open({ model, sessionId, systemInstruction }) {
    const ai = client(this._apiKey);
    this._sessionId = sessionId;
    this._model = model;

    this._session = await ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: systemInstruction || DEFAULT_SYSTEM,
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      },
      callbacks: {
        onopen: () => {},
        onmessage: (m) => this._onMessage(m),
        onerror: (ev) => this.emit('event', {
          kind: 'error', at: Date.now(), message: ev?.message || 'ws_error', fatal: true,
        }),
        onclose: (ev) => {
          this._closed = true;
          this.emit('event', { kind: 'closed', at: Date.now(), code: ev?.code, reason: ev?.reason });
        },
      },
    });

    // Setup-complete is asynchronous — wait up to 10s.
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('setup_complete_timeout')), 10_000);
      const h = (e) => {
        if (e.kind === 'setup_complete') { clearTimeout(to); this.off('event', h); resolve(); }
        if (e.kind === 'error' && e.fatal) { clearTimeout(to); this.off('event', h); reject(new Error(e.message)); }
      };
      this.on('event', h);
    });
  }

  _onMessage(m) {
    if (m.setupComplete) {
      this._setupCompleteAt = Date.now();
      this.emit('event', { kind: 'setup_complete', at: this._setupCompleteAt });
      return;
    }
    const parts = m?.serverContent?.modelTurn?.parts ?? [];
    for (const p of parts) {
      const mime = p?.inlineData?.mimeType || '';
      const b64 = p?.inlineData?.data || '';
      if (mime.startsWith('audio/pcm') && b64) {
        const bytes = Buffer.from(b64, 'base64');
        this._outputBytes += bytes.length;
        this._currentTurnOutputBytes += bytes.length;
        this.emit('event', {
          kind: 'audio_out', at: Date.now(), chunk: { bytes, mimeType: mime },
        });
      }
    }
    if (m?.usageMetadata) {
      // Overwrite, don't sum — see constructor comment re: cumulative semantics.
      const um = m.usageMetadata;
      this._currentTurnUsage = {
        promptTokenCount:   typeof um.promptTokenCount   === 'number' ? um.promptTokenCount   : null,
        responseTokenCount: typeof um.responseTokenCount === 'number' ? um.responseTokenCount : null,
        totalTokenCount:    typeof um.totalTokenCount    === 'number' ? um.totalTokenCount    : null,
      };
    }
    if (m?.serverContent?.interrupted) {
      this.emit('event', { kind: 'interrupted', at: Date.now() });
    }
    if (m?.serverContent?.turnComplete) {
      this.emit('event', { kind: 'turn_complete', at: Date.now() });
    }
  }

  turnStart() {
    if (!this._session || this._closed) throw new Error('bridge_not_open');
    this._currentTurnOutputBytes = 0;
    this._currentTurnInputBytes = 0;
    this._currentTurnUsage = null;
    this._session.sendRealtimeInput({ activityStart: {} });
  }

  sendAudio({ bytes, mimeType }) {
    if (!this._session || this._closed) throw new Error('bridge_not_open');
    this._inputBytes += bytes.length;
    this._currentTurnInputBytes += bytes.length;
    const b64 = Buffer.from(bytes).toString('base64');
    this._session.sendRealtimeInput({
      audio: { data: b64, mimeType: mimeType || 'audio/pcm;rate=16000' },
    });
  }

  /** Signals activityEnd, resolves on next turn_complete with per-turn metrics. */
  async turnEnd({ timeoutMs = 30_000 } = {}) {
    if (!this._session || this._closed) throw new Error('bridge_not_open');
    this._session.sendRealtimeInput({ activityEnd: {} });

    await new Promise((resolve, reject) => {
      const to = setTimeout(() => { this.off('event', h); reject(new Error('turn_complete_timeout')); }, timeoutMs);
      const h = (e) => {
        if (e.kind === 'turn_complete') { clearTimeout(to); this.off('event', h); resolve(); }
        if (e.kind === 'error' && e.fatal) { clearTimeout(to); this.off('event', h); reject(new Error(e.message)); }
        if (e.kind === 'closed') { clearTimeout(to); this.off('event', h); reject(new Error('ws_closed_mid_turn')); }
      };
      this.on('event', h);
    });

    // 16kHz 16bit mono → 1 sec = 32000 bytes. TTS output from Gemini is 24kHz
    // (per SDK docs) → 1 sec = 48000 bytes. We approximate: treat output as
    // 24kHz mono 16bit → seconds = bytes / 48000. If wrong, cogs off by ≤10%;
    // Day 5 measurement harness will empirically derive the rate.
    //
    // usageMetadata is the server-authoritative token count. When present,
    // proxy prefers it for COGS pricing (Day 8 switch to token-based). For
    // now we emit both and let downstream decide.
    return {
      inputSeconds: this._currentTurnInputBytes / 32000,
      outputSeconds: this._currentTurnOutputBytes / 48000,
      usageMetadata: this._currentTurnUsage, // null if none observed
    };
  }

  cancel() {
    // Gemini Live has no explicit cancel; the server auto-cancels when we
    // start a new activity. For barge-in we rely on client-side duck + next
    // activityStart pre-empting the current turn.
    // Phase 3 will validate empirically whether we need a richer cancel path.
  }

  on(listener) {
    if (typeof listener === 'function') {
      super.on('event', listener);
      return () => super.off('event', listener);
    }
    // Allow EventEmitter.on(event, fn) for internal use
    return super.on(listener, arguments[1]);
  }

  off(listener, fn) {
    if (typeof listener === 'function') {
      super.off('event', listener);
      return;
    }
    super.off(listener, fn);
  }

  async close() {
    if (this._closed) return;
    try { this._session?.close(); } catch {}
    this._closed = true;
  }

  totals() {
    return { inputBytes: this._inputBytes, outputBytes: this._outputBytes };
  }
}
