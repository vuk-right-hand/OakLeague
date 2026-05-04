// GeminiBridge — implements AudioBridge (src/lib/voice/audio-bridge.ts)
// against @google/genai Live. Auto-VAD as of 2026-05-02 (manual-VAD
// regressed mid-turn-2 upstream).
//
// Lifecycle: open → turnStart → sendAudio* → turnEnd → (repeat) → close
// Events: setup_complete | audio_out | output_transcription_chunk |
//         transcript_runaway | turn_complete | interrupted | error | closed
//
// Pipeline α' upgrade (Cartesia wire-up plan):
//   - `enableOutputTranscription:true` adds outputAudioTranscription:{} to
//     live.connect.config; on each serverContent.outputTranscription.text
//     chunk, emits `output_transcription_chunk` and accumulates into
//     `_currentTurnOutputTranscript` (capped at 4000 chars per R3-C4).
//   - `discardAudioOut:true` skips the base64 decode + audio_out emission
//     entirely (R3-S3) — α' doesn't ship Gemini's audio anywhere.
//   - turnEnd's metrics include `outputTranscript`.

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

// R3-C4 — per-turn transcript cap. Chosen so the worst-case Cartesia bill
// per turn (4000 chars × CARTESIA_USD_PER_CHAR ceiling) stays bounded AND
// the per-turn second sum (input + cartesia_audio_seconds) stays under the
// voice_accumulate_seconds 3600 oob ceiling under realistic conditions.
// R4-C2: this constant is load-bearing for the kill-switch — if you bump
// it, re-derive the second-equivalent ceiling and tighten R4-C2 mapping.
export const OUTPUT_TRANSCRIPT_MAX_CHARS = 4000;

export class GeminiBridge extends EventEmitter {
  constructor({ apiKey, enableOutputTranscription = false, discardAudioOut = false } = {}) {
    super();
    if (!apiKey) throw new Error('GEMINI_API_KEY missing');
    this._apiKey = apiKey;
    this._enableOutputTranscription = !!enableOutputTranscription;
    this._discardAudioOut = !!discardAudioOut;
    this._session = null;
    this._inputBytes = 0;
    this._outputBytes = 0;
    this._currentTurnOutputBytes = 0;
    this._currentTurnOutputTranscript = '';
    this._currentTurnRunawayFired = false;
    // 2026-05-04 workaround for js-genai#707: Gemini Live truncates responses
    // and closes the WS with code=1000 WITHOUT sending serverContent.turnComplete.
    // We track whether a turn received any modelTurn / outputTranscription
    // content; if a 1000-close arrives after content, we synthesize a
    // turn_complete event so turnEnd's await resolves cleanly. Remove this
    // when Google fixes the upstream bug (monitor [google-live-workaround]
    // log counter — should drop to 0 after fix).
    this._currentTurnReceivedContent = false;
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

    const config = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: systemInstruction || DEFAULT_SYSTEM,
    };
    if (this._enableOutputTranscription) {
      // Pipeline α': we read serverContent.outputTranscription.text and
      // pipe to Cartesia. Phase 0 (2026-04-22) verified the preview accepts
      // this. discardAudioOut governs whether we still pay the per-chunk
      // base64 decode cost downstream.
      config.outputAudioTranscription = {};
    }
    // Auto-VAD: omit realtimeInputConfig (default = auto-VAD on,
    // endOfSpeechSensitivity = END_SENSITIVITY_HIGH). turnStart is a
    // no-op; turnEnd sends `audioStreamEnd: true`. Switched from manual
    // VAD on 2026-05-02 to bypass the upstream multi-turn regression.
    this._session = await ai.live.connect({
      model,
      config,
      callbacks: {
        onopen: () => {},
        onmessage: (m) => this._onMessage(m),
        onerror: (ev) => this.emit('event', {
          kind: 'error', at: Date.now(), message: ev?.message || 'ws_error', fatal: true,
        }),
        onclose: (ev) => {
          this._closed = true;
          // js-genai#707 workaround: if Gemini sent us content this turn
          // and is now closing normally without a turnComplete, synthesize
          // one so turnEnd resolves. Strict gate: code=1000 + content seen.
          // Any other close path (errors, mid-turn drops with no content)
          // still rejects the awaiting promise as before.
          if (ev?.code === 1000 && this._currentTurnReceivedContent) {
            console.warn(`[google-live-workaround] synthesizing turn_complete on code=1000 close (sessionId=${this._sessionId})`);
            this.emit('event', { kind: 'turn_complete', at: Date.now() });
          }
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
        this._currentTurnReceivedContent = true;
        // R3-S3: when we know nobody downstream consumes the audio bytes
        // (Pipeline α' discards them), skip the base64 decode entirely.
        // Track byte length via `b64.length * 0.75` for the COGS leg-2
        // tokens-fallback math — bytes ≈ ceil(b64Len * 3 / 4).
        if (this._discardAudioOut) {
          const approxBytes = Math.floor(b64.length * 0.75);
          this._outputBytes += approxBytes;
          this._currentTurnOutputBytes += approxBytes;
        } else {
          const bytes = Buffer.from(b64, 'base64');
          this._outputBytes += bytes.length;
          this._currentTurnOutputBytes += bytes.length;
          this.emit('event', {
            kind: 'audio_out', at: Date.now(), chunk: { bytes, mimeType: mime },
          });
        }
      }
    }
    // R3-C4 — outputTranscription chunks (Pipeline α'). Cap at
    // OUTPUT_TRANSCRIPT_MAX_CHARS per turn; emit transcript_runaway once
    // and stop forwarding for the rest of the turn.
    const otText = m?.serverContent?.outputTranscription?.text;
    if (typeof otText === 'string' && otText.length > 0 && this._enableOutputTranscription) {
      this._currentTurnReceivedContent = true;
      const remaining = OUTPUT_TRANSCRIPT_MAX_CHARS - this._currentTurnOutputTranscript.length;
      if (remaining > 0) {
        const slice = otText.length <= remaining ? otText : otText.slice(0, remaining);
        this._currentTurnOutputTranscript += slice;
        this.emit('event', { kind: 'output_transcription_chunk', at: Date.now(), text: slice });
        if (this._currentTurnOutputTranscript.length >= OUTPUT_TRANSCRIPT_MAX_CHARS && !this._currentTurnRunawayFired) {
          this._currentTurnRunawayFired = true;
          this.emit('event', {
            kind: 'transcript_runaway',
            at: Date.now(),
            characterCount: this._currentTurnOutputTranscript.length,
          });
        }
      } else if (!this._currentTurnRunawayFired) {
        this._currentTurnRunawayFired = true;
        this.emit('event', {
          kind: 'transcript_runaway',
          at: Date.now(),
          characterCount: this._currentTurnOutputTranscript.length,
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
      this._currentTurnReceivedContent = false;
      this.emit('event', { kind: 'turn_complete', at: Date.now() });
    }
  }

  turnStart() {
    if (!this._session || this._closed) throw new Error('bridge_not_open');
    this._currentTurnOutputBytes = 0;
    this._currentTurnInputBytes = 0;
    this._currentTurnUsage = null;
    this._currentTurnOutputTranscript = '';
    this._currentTurnRunawayFired = false;
    this._currentTurnReceivedContent = false;
    // Auto-VAD: no activityStart signal — Gemini infers turn boundaries
    // from audio content. Sending activityStart with auto-VAD on is a
    // protocol error and trips the upstream multi-turn-2 close-mid-turn
    // regression (forum: discuss.ai.google.dev/t/142838).
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

  /** Signals end of client audio stream, resolves on next turn_complete with
   *  per-turn metrics. In auto-VAD mode the explicit signal is `audioStreamEnd`
   *  (the auto-VAD equivalent of manual-VAD's `activityEnd`). Per Live API
   *  reference: "Indicates that the audio stream has ended … should only be
   *  sent when automatic activity detection is enabled (which is the default)
   *  … client can reopen the stream by sending subsequent audio messages."
   *  https://ai.google.dev/api/live#RealtimeInputConfig */
  async turnEnd({ timeoutMs = 30_000 } = {}) {
    if (!this._session || this._closed) throw new Error('bridge_not_open');
    this._session.sendRealtimeInput({ audioStreamEnd: true });

    await new Promise((resolve, reject) => {
      const to = setTimeout(() => { this.off('event', h); reject(new Error('turn_complete_timeout')); }, timeoutMs);
      const h = (e) => {
        if (e.kind === 'turn_complete') { clearTimeout(to); this.off('event', h); resolve(); }
        if (e.kind === 'error' && e.fatal) { clearTimeout(to); this.off('event', h); reject(new Error(e.message)); }
        if (e.kind === 'closed') {
          clearTimeout(to); this.off('event', h);
          // Surface Google's close code + reason — without these we can't tell
          // a Gemini-side regression from a config mismatch from a TLS drop.
          reject(new Error(`ws_closed_mid_turn code=${e.code ?? 'none'} reason=${e.reason || 'none'}`));
        }
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
      // Pipeline α' (R3-C4): empty string when bridge opened without
      // enableOutputTranscription. Caller (proxy) feeds this into Cartesia.
      outputTranscript: this._currentTurnOutputTranscript,
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
