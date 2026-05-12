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

// Brain wire-up (PR-2 / R3 audit M7). Margin between sendClientContent
// (single user-turn prefix_turns seed) and the bridge resolving open(). The proxy
// sends `ready` to the client right after open() resolves; the user's
// first mic-audio frame must NOT race the server-side ingest of the
// seed — auto-VAD would treat mid-prefix audio as a turn boundary and
// the model would respond to a fragment.
//
// Pre-merge spike (scripts/brain-seed-ingest-latency-spike.mjs) measures
// END-TO-END (sendClientContent → first transcript chunk) p99 across
// 1KB/30KB/90KB and recommends margin = worst-p99 + 50ms. 2026-05-09
// run pinned 895ms (1KB p99=845ms + 50ms; 90KB rejected silently —
// hence ENCODED_BYTE_CAP=60KB now). 250 is the in-code placeholder;
// real margin gets set via env BRAIN_SEED_MARGIN_MS_OVERRIDE on Fly.
// CAVEAT: end-to-end includes inference time we don't strictly need to
// wait for — server-side ingest alone is faster. If TTFB tax matters
// more than safety, re-spike measuring "next sessionResumptionUpdate
// after seed" instead and re-pin tighter. Hard ceiling 5000ms.
const BRAIN_SEED_MARGIN_MS = (() => {
  const override = parseInt(process.env.BRAIN_SEED_MARGIN_MS_OVERRIDE || '', 10);
  // PR-2 audit S1: floor at 50ms — 0 guarantees the audio-vs-seed race.
  return Number.isFinite(override) && override >= 50 && override <= 5000 ? override : 250;
})();

// pgvector RAG plan (vector mode). Margin between each sendRealtimeInput({text})
// injection replay on reopen — mirrors BRAIN_SEED_MARGIN_MS pattern, scaled
// down because injection payloads (≤4KB) are much smaller than prefix seeds
// (up to 60KB) and ingest faster. 150ms is the conservative placeholder;
// Spike #6 (brain-injection-replay-margin-spike.mjs) pins via the override.
export const BRAIN_REOPEN_INJECTION_MARGIN_MS = (() => {
  const override = parseInt(process.env.BRAIN_REOPEN_INJECTION_MARGIN_MS_OVERRIDE || '', 10);
  return Number.isFinite(override) && override >= 50 && override <= 2000 ? override : 150;
})();

// Ring buffer cap for replay-on-reopen state.
export const INJECTION_HISTORY_K = 5;
export const INJECTION_MAX_BYTES = 4096;

// R3-C4 — per-turn transcript cap. Chosen so the worst-case Cartesia bill
// per turn (4000 chars × CARTESIA_USD_PER_CHAR ceiling) stays bounded AND
// the per-turn second sum (input + cartesia_audio_seconds) stays under the
// voice_accumulate_seconds 3600 oob ceiling under realistic conditions.
// R4-C2: this constant is load-bearing for the kill-switch — if you bump
// it, re-derive the second-equivalent ceiling and tighten R4-C2 mapping.
export const OUTPUT_TRANSCRIPT_MAX_CHARS = 4000;

export class GeminiBridge extends EventEmitter {
  constructor({
    apiKey,
    enableOutputTranscription = false,
    discardAudioOut = false,
    // pgvector RAG plan (vector mode). When true, adds inputAudioTranscription:{}
    // to live.connect.config so we receive serverContent.inputTranscription.text
    // at end-of-utterance. Emits `input_transcription` events with the
    // per-turn audio duration so the proxy heuristic can detect Gemini's
    // ~100-chunk truncation (R3 M2 fix).
    enableInputTranscription = false,
  } = {}) {
    super();
    if (!apiKey) throw new Error('GEMINI_API_KEY missing');
    this._apiKey = apiKey;
    this._enableOutputTranscription = !!enableOutputTranscription;
    this._discardAudioOut = !!discardAudioOut;
    this._enableInputTranscription = !!enableInputTranscription;
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
    // Phase 0.5 (2026-05-07). sessionResume handle for js-genai#707 reopens.
    // Gemini Live emits `sessionResumptionUpdate.newHandle` periodically;
    // we keep only the freshest. On reopen() we pass the handle in
    // `sessionResumption.handle` so Google replays the conversation
    // history server-side. Without this, every post-turn 1000-close
    // reopen drops context — avatar forgets what the user just said,
    // which is fatal UX for a mentorship product. Stored only in memory:
    // resumability across explicit user-close is intentionally OUT of
    // scope (different teardown path). Memory-only also means a proxy
    // crash drops the handle, which is fine — fresh session starts clean.
    this._sessionResumeHandle = null;
    // Brain wire-up (PR-2 / R3 audit M5). Number of times we've
    // re-seeded `brainPrefix` via sendClientContent — increments on
    // every successful (re)connect that has a non-empty brainPrefix.
    // Always-replay is intentional (R2 C3): the bridge cannot
    // distinguish "valid resume — server has history" from "handle
    // silently rejected — server is fresh", so we re-seed every time
    // and accept the duplicate-history token cost on valid resumes.
    // The brain_prefix_reseeded PostHog event at session-end makes the
    // cost operator-visible.
    this._seedReplayCount = 0;
    this._lastSeedByteSize = 0;
    // pgvector RAG plan (vector mode). Ring buffer of last K injection
    // envelopes for replay-on-reopen (R1 C3 fix). Each entry is the literal
    // text string passed to sendRealtimeInput({ text }). Bounded at K=5
    // entries × 4KB max = 20KB replay traffic per reopen — well under the
    // 60KB seed ceiling.
    this._injectionHistory = [];
    this._injectionReplayCount = 0;
    // Per-turn input duration tracking (R3 M2). Bridge already tracks
    // _currentTurnInputBytes via sendAudio; we surface it in the
    // input_transcription event payload so truncationSuspected has a real
    // denominator (audioSeconds = bytes / (16000 * 2) at 16kHz s16le).
    this._currentTurnInputBytes = 0;
    // R3 M1 — same-envelope ordering safety. Stash the latest
    // inputTranscription text seen inside the current turn; if turn_complete
    // arrives in the same envelope, we ensure input_transcription emits
    // before turn_complete (already true given the iteration order in
    // _onMessage, but tracking explicitly so a future refactor can't
    // silently reorder).
    this._pendingInputTranscriptionThisTurn = null;
  }

  // Brain wire-up (PR-2). Surface seed-replay metrics to the proxy at
  // session-end so brain_prefix_reseeded PostHog event can carry them.
  getSeedMetrics() {
    return {
      replayCount: this._seedReplayCount,
      lastByteSize: this._lastSeedByteSize,
    };
  }

  async open({ model, sessionId, systemInstruction, brainPrefix }) {
    // Phase 0.5 fix (2026-05-07). Capture open args so reopen() can
    // re-call with identical params on Google's documented post-turn
    // 1000-close bug (js-genai#707). Without this, after Gemini closes
    // the pipe is dead and turn 2+ silently fail with bridge_not_open.
    // Brain wire-up (PR-2): brainPrefix rides _lastOpenArgs so the
    // existing reopen() path replays it on every connect (R2 C3).
    this._lastOpenArgs = { model, sessionId, systemInstruction, brainPrefix };
    const ai = client(this._apiKey);
    this._sessionId = sessionId;
    this._model = model;

    const config = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: systemInstruction || DEFAULT_SYSTEM,
      // Phase 0.5 (2026-05-07). Opt into session resumption so Gemini
      // emits sessionResumptionUpdate handles. Empty object = "enable;
      // start fresh." When reopen() runs after a js-genai#707 1000-close,
      // we set `handle` to the stored value so the conversation context
      // carries over. Without this opt-in, no handles are emitted at all.
      sessionResumption: this._sessionResumeHandle
        ? { handle: this._sessionResumeHandle }
        : {},
    };
    if (this._enableOutputTranscription) {
      // Pipeline α': we read serverContent.outputTranscription.text and
      // pipe to Cartesia. Phase 0 (2026-04-22) verified the preview accepts
      // this. discardAudioOut governs whether we still pay the per-chunk
      // base64 decode cost downstream.
      config.outputAudioTranscription = {};
    }
    if (this._enableInputTranscription) {
      // pgvector RAG plan (vector mode). Per forum 136977, 3.1 Live delivers
      // inputTranscription as a single chunk at end-of-utterance (regression
      // from 2.5 incremental). Per forum 107385, the path truncates after
      // ~100 chunks for >15s audio — the proxy detects this via
      // truncationSuspected() using the audioSeconds we emit in the event.
      config.inputAudioTranscription = {};
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

    // Brain wire-up (PR-2 + 2026-05-09 spike fix). Seed reference
    // material as a SINGLE user-role Content turn via sendClientContent
    // BEFORE returning from open(). turnComplete:false so the server
    // holds inference until the user's first audio frame triggers
    // auto-VAD turn-end (R2 C2). Pre-spike attempt used paired
    // user/model turns; preview model rejects any model-role turn in
    // sendClientContent (WS 1007 invalid argument). The folded model-
    // ack inside the user turn now carries L3 injection defense. 250ms
    // margin to give the server time to ingest before the proxy signals
    // 'ready' to the client (R3 M7 — pre-merge spike measures p99
    // across payload sizes and pins this constant; 250ms is the
    // placeholder).
    if (Array.isArray(brainPrefix) && brainPrefix.length > 0) {
      try {
        this._session.sendClientContent({
          turns: brainPrefix,
          turnComplete: false,
        });
        this._seedReplayCount += 1;
        try {
          this._lastSeedByteSize = Buffer.byteLength(
            JSON.stringify(brainPrefix), 'utf8',
          );
        } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, BRAIN_SEED_MARGIN_MS));
      } catch (seedErr) {
        // Don't fatal-fail the connect on seed error — degrade to
        // persona-only. The proxy emits a Sentry breadcrumb upstream.
        console.warn(`[gemini-bridge] sendBrainPrefix failed: ${seedErr?.message || seedErr}`);
      }
    }

    // pgvector RAG plan (vector mode) — replay injection history on reopen.
    //
    // R1 C3 + R2 M2 fix: when js-genai#707 fires a 1000-close mid-session
    // and reopen() restarts the bridge, we lose every prior
    // send_realtime_input({text}) injection — even if Gemini accepted our
    // resumption-handle, the docs don't guarantee realtime-input is
    // durable across reopens. Two-step strategy:
    //
    //   1. After setupComplete, wait up to 1500ms for the FIRST
    //      sessionResumptionUpdate post-reopen. If it arrives with
    //      resumable:true, Gemini has the prior context (including any
    //      injections that landed before the close). Skip replay to avoid
    //      polluting the model with duplicate references.
    //   2. If the wait times out OR the update reports not-resumable, replay
    //      the K=5 most recent injections via sendRealtimeInput({text}),
    //      separated by BRAIN_REOPEN_INJECTION_MARGIN_MS.
    //
    // The first open() never has history (initial connect); only reopens do.
    if (this._injectionHistory.length > 0) {
      const resumableDecision = await this._awaitResumptionDecisionForReplay();
      if (resumableDecision !== 'accepted') {
        for (const injectText of this._injectionHistory) {
          try {
            this._session.sendRealtimeInput({ text: injectText });
            this._injectionReplayCount += 1;
            await new Promise((r) => setTimeout(r, BRAIN_REOPEN_INJECTION_MARGIN_MS));
          } catch (e) {
            console.warn(`[gemini-bridge] injection replay failed: ${e?.message || e}`);
            break; // bridge likely closed; abandon replay
          }
        }
      }
    }
  }

  // Resumption-replay decision helper. Returns 'accepted' if a
  // sessionResumptionUpdate with resumable:true arrives within timeout;
  // 'rejected' if resumable:false arrives; 'timeout' otherwise. The proxy
  // logs the outcome via the existing 'closed' / sessionResumptionUpdate
  // pathway, so we don't double-emit here.
  async _awaitResumptionDecisionForReplay(timeoutMs = 1500) {
    return new Promise((resolve) => {
      const start = Date.now();
      // If we never had a stored handle, the open was a cold connect — no
      // server-side history to inherit. Replay outright.
      // (this._sessionResumeHandle is cleared inside reopen() error path;
      // truthy means we passed it in the connect config.)
      if (!this._sessionResumeHandle) {
        resolve('rejected');
        return;
      }
      const to = setTimeout(() => {
        this.off('event', listener);
        resolve('timeout');
      }, timeoutMs);
      const listener = (e) => {
        if (e.kind === '__resumption_update__') {
          if (Date.now() - start > timeoutMs) return;
          clearTimeout(to);
          this.off('event', listener);
          resolve(e.resumable ? 'accepted' : 'rejected');
        }
      };
      this.on('event', listener);
    });
  }

  // pgvector RAG plan (vector mode). Inject a text payload into the live
  // session via sendRealtimeInput({text}). Per Google docs, send_realtime_input
  // is the only mid-session text channel on 3.1 Live (send_client_content is
  // rejected after the first model turn). The proxy calls this between
  // turn_complete and the next user audio frame; the proxy's audio gate
  // guarantees ordering at the boundary.
  injectText(text) {
    if (!this._session || this._closed) {
      const e = new Error('bridge_not_open');
      e.code = 'ERR_BRIDGE_CLOSED';
      throw e;
    }
    if (typeof text !== 'string' || text.length === 0) {
      const e = new Error('invalid_injection_text');
      e.code = 'ERR_BAD_INJECTION';
      throw e;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > INJECTION_MAX_BYTES) {
      const e = new Error(`injection_too_large bytes=${bytes} cap=${INJECTION_MAX_BYTES}`);
      e.code = 'ERR_INJECTION_TOO_LARGE';
      throw e;
    }
    this._session.sendRealtimeInput({ text });
    // Push to ring buffer — drop oldest if at cap.
    this._injectionHistory.push(text);
    while (this._injectionHistory.length > INJECTION_HISTORY_K) {
      this._injectionHistory.shift();
    }
    return { bytes };
  }

  getInjectionMetrics() {
    return {
      historySize: this._injectionHistory.length,
      replayCount: this._injectionReplayCount,
    };
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
    // pgvector RAG plan (vector mode) — inputTranscription event.
    //
    // 3.1 Live emits this once per user-turn at end-of-utterance (regression
    // from 2.5 incremental delivery — forum 136977). Single chunk; for
    // utterances >15s the path silently truncates after ~100 chunks
    // (forum 107385). We surface the per-turn input bytes alongside so the
    // proxy heuristic truncationSuspected() has a real denominator.
    //
    // R3 M1 — emitted BEFORE the turn_complete dispatch below. The iteration
    // here runs strictly before the `if (m?.serverContent?.turnComplete)`
    // block at the end of _onMessage, so within the same envelope the
    // proxy receives input_transcription first then turn_complete. The
    // proxy's turn_complete handler also defers via microtask for belt-
    // and-suspenders against future refactors.
    const itText = m?.serverContent?.inputTranscription?.text;
    if (typeof itText === 'string' && itText.length > 0 && this._enableInputTranscription) {
      // 16kHz s16le mono: 1 second = 32000 bytes.
      const durationSec = this._currentTurnInputBytes / 32000;
      this._pendingInputTranscriptionThisTurn = itText;
      this.emit('event', {
        kind: 'input_transcription',
        at: Date.now(),
        text: itText,
        durationSec,
      });
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
    // Phase 0.5 (2026-05-07). sessionResumptionUpdate. Gemini emits
    // these periodically while the session is alive (typically once
    // per turn after generation completes). `resumable:true` means the
    // handle is safe to use; we keep only the freshest. Stored in
    // memory; survives WS-level reopens (js-genai#707 1000-close →
    // proxy lazy reopen → bridge.reopen() → bridge.open() → new
    // ai.live.connect with this handle), drops on explicit user-close
    // (which is correct — fresh session next time).
    const sru = m?.sessionResumptionUpdate;
    if (sru && typeof sru.newHandle === 'string' && sru.newHandle.length > 0) {
      // The SDK exposes resumable as a hint; default true unless explicitly
      // false. Store regardless — Google's worst case is they reject the
      // handle on reopen, in which case we just start fresh (same as today).
      this._sessionResumeHandle = sru.newHandle;
      // Internal event for _awaitResumptionDecisionForReplay (vector mode).
      // Listener is single-fire; if no one is listening it's a no-op.
      this.emit('event', {
        kind: '__resumption_update__',
        at: Date.now(),
        resumable: sru.resumable !== false, // default true unless explicit false
      });
    }
    if (m?.serverContent?.interrupted) {
      this.emit('event', { kind: 'interrupted', at: Date.now() });
    }
    if (m?.serverContent?.turnComplete) {
      this._currentTurnReceivedContent = false;
      this._pendingInputTranscriptionThisTurn = null;
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
    // Mark user-initiated so reopen() refuses (don't rebuild a closed-on-purpose bridge).
    this._userClosed = true;
    // Audit C4 (2026-05-07). Drop the resumption handle on explicit close
    // so it can never be replayed across a user-driven session boundary.
    this._sessionResumeHandle = null;
  }

  // Re-open after Google's post-turn 1000-close (js-genai#707). Called
  // lazily from the proxy on next turn_start when _closed=true and
  // _userClosed=false. Re-runs ai.live.connect with the original args
  // (which also sets sessionResumption.handle so conversation context
  // carries across the WS bounce — see open()).
  async reopen() {
    if (this._userClosed) throw new Error('bridge_user_closed');
    if (!this._lastOpenArgs) throw new Error('bridge_never_opened');
    if (!this._closed) return; // already open
    this._closed = false;
    this._currentTurnReceivedContent = false;
    this._currentTurnUsage = null;
    try {
      await this.open(this._lastOpenArgs);
    } catch (err) {
      // Audit M5 (2026-05-07). open() failed — restore _closed=true so
      // sendAudio/turnStart correctly report bridge_not_open instead of
      // pretending the bridge is alive against a stale _session ref.
      this._closed = true;
      // Audit C4 (2026-05-07). If Google rejected our resumption handle
      // (replay attack guard, expired, server-side eviction), the same
      // handle WILL keep failing. Drop it so the next reopen attempt
      // starts fresh — losing context is strictly better than an
      // infinite reopen-fail loop.
      this._sessionResumeHandle = null;
      throw err;
    }
  }

  totals() {
    return { inputBytes: this._inputBytes, outputBytes: this._outputBytes };
  }
}
