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

// ── D-GoAway (DECOUPLED_BRAIN_PLAN P1-6) ────────────────────────────────
//
// Gemini Live sends `serverContent`-sibling `goAway{timeLeft}` ~60s
// BEFORE it terminates the SESSION (doc-verified ai.google.dev/api/live
// + ai.google.dev/gemini-api/docs/live-session, 2026-05-19 — NOT a
// 10-min connection-lifetime warning; it precedes session end by ~60s).
// Ignoring it = the next close arrives as ABORTED mid-turn. Recovery:
// retain the freshest `sessionResumptionUpdate.newHandle` and reconnect
// with it; the resumption token is valid for 2h.
//
// HARD-GATED to `this._decoupled` (audit C1). On the legacy/coupled path
// reopen() re-seeds the persona + up-to-60KB topic-drawer prefix and the
// gemini-3.1-flash-live-preview ~200-token resumption regression is only
// verified safe for the AUDITED reactive 1000-close path — NOT a
// proactive mid-session bounce with a 60KB re-seed. Decoupled STT Live
// carries NO systemInstruction/history → reopen() is the trivial,
// regression-immune case, so the proactive bounce is sound there only.
//
// Strategy (plan §7/§12 D-GoAway): on `goAway`, do NOT reopen
// immediately — defer to the next VAD-silence (`turn_complete`, the
// manual-VAD turn boundary) so the reopen never lands mid-utterance and
// never loses an in-flight input transcript (audit C2). A hard fallback
// timer at `timeLeft − margin` forces the reopen if no turn_complete
// arrives first (a controlled resumption-handle reopen beats a server
// ABORTED) — but it DEFERS while an utterance is in flight (C2).
const GOAWAY_SAFETY_MARGIN_MS = (() => {
  const o = parseInt(process.env.GOAWAY_SAFETY_MARGIN_MS_OVERRIDE || '', 10);
  return Number.isFinite(o) && o >= 250 && o <= 30000 ? o : 2000;
})();
// If timeLeft is absent/unparseable, do NOT trust a large window — assume
// little time and let the next turn_complete (usually within seconds)
// drive the reopen; this is only the fallback-timer seed.
const GOAWAY_FALLBACK_DEFAULT_MS = 8000;

// Audit M3 — sane upper bound on a parsed timeLeft. GoAway precedes
// session end by ~60s; the audio-session cap is 15min. Anything beyond
// 20min is implausible as a *seconds* Duration and almost certainly
// means the SDK surfaced the value in a different unit (e.g. ms). When
// the seconds-assumption yields a value past this, we DON'T trust it —
// fall back to the conservative default so the deferred turn_complete
// path (usually within seconds) drives the reopen, instead of arming an
// effectively-never-firing fallback timer that lets the server ABORT.
// P1-9 real-API gated test empirically pins the true wire form.
const GOAWAY_MAX_PLAUSIBLE_MS = 20 * 60 * 1000;

// timeLeft is a protobuf Duration. Sources diverge on the wire form
// (proto3-JSON canonical = string "3.5s"; raw proto = {seconds,nanos};
// some SDK builds surface a number). Parse ALL three defensively; never
// throw — an unparseable / implausible value falls back to the
// conservative default. A NEGATIVE duration is also treated as
// unparseable (it must NOT collapse to 0 ⇒ immediate mid-utterance
// reopen — audit Small).
export function parseGoAwayTimeLeftMs(timeLeft) {
  if (timeLeft == null) return GOAWAY_FALLBACK_DEFAULT_MS;
  if (typeof timeLeft === 'number' && Number.isFinite(timeLeft)) {
    if (timeLeft < 0) return GOAWAY_FALLBACK_DEFAULT_MS;
    // Duration convention = seconds. If the seconds-assumption produces
    // an implausibly large window the value is not seconds — don't trust.
    const ms = Math.round(timeLeft * 1000);
    return ms > GOAWAY_MAX_PLAUSIBLE_MS ? GOAWAY_FALLBACK_DEFAULT_MS : ms;
  }
  if (typeof timeLeft === 'string') {
    const m = /^(-?\d+(?:\.\d+)?)s?$/.exec(timeLeft.trim());
    if (m) {
      const v = parseFloat(m[1]);
      if (!Number.isFinite(v) || v < 0) return GOAWAY_FALLBACK_DEFAULT_MS;
      const ms = Math.round(v * 1000);
      return ms > GOAWAY_MAX_PLAUSIBLE_MS ? GOAWAY_FALLBACK_DEFAULT_MS : ms;
    }
    return GOAWAY_FALLBACK_DEFAULT_MS;
  }
  if (typeof timeLeft === 'object') {
    // Audit NEW-S2 — a PRESENT but non-finite field is garbage, not a
    // zero. Don't silently drop a bad `seconds` and trust `nanos` alone
    // (that yields a tiny ms ⇒ near-immediate mid-utterance deadline).
    // Unparseable → conservative fallback, per the function contract.
    const secsRaw = timeLeft.seconds;
    const nanosRaw = timeLeft.nanos;
    const secs = Number(secsRaw ?? 0);
    const nanos = Number(nanosRaw ?? 0);
    const secsBad = secsRaw != null && !Number.isFinite(secs);
    const nanosBad = nanosRaw != null && !Number.isFinite(nanos);
    if (!secsBad && !nanosBad && (Number.isFinite(secs) || Number.isFinite(nanos))) {
      const ms = Math.round((Number.isFinite(secs) ? secs : 0) * 1000
        + (Number.isFinite(nanos) ? nanos : 0) / 1e6);
      if (ms < 0) return GOAWAY_FALLBACK_DEFAULT_MS;
      return ms > GOAWAY_MAX_PLAUSIBLE_MS ? GOAWAY_FALLBACK_DEFAULT_MS : ms;
    }
  }
  return GOAWAY_FALLBACK_DEFAULT_MS;
}

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
    // D-GoAway (P1-6, audit C1). The proactive resumption-handle reopen
    // is ONLY safe on the decoupled STT-only path: it carries NO
    // systemInstruction / brainPrefix, so reopen() is the trivial,
    // regression-immune case. On the legacy/coupled path open() re-seeds
    // the creator persona + up-to-60KB topic-drawer prefix on every
    // (re)connect, and the gemini-3.1-flash-live-preview ~200-token
    // resumption regression is only verified safe for the AUDITED
    // reactive js-genai#707 1000-close path — NOT a proactively-induced
    // mid-session bounce with a 60KB re-seed. So D-GoAway is HARD-GATED
    // off unless decoupled: legacy keeps its byte-identical pre-P1-6
    // reactive-only reopen behavior. Default false ⇒ inert in prod
    // (creators.decoupled default false, no route writer yet).
    decoupled = false,
  } = {}) {
    super();
    if (!apiKey) throw new Error('GEMINI_API_KEY missing');
    this._apiKey = apiKey;
    this._enableOutputTranscription = !!enableOutputTranscription;
    this._discardAudioOut = !!discardAudioOut;
    this._enableInputTranscription = !!enableInputTranscription;
    this._decoupled = !!decoupled;
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
    // Audit NEW-S1 — explicit init for consistency with every other
    // lifecycle flag (set true only by close()). Read by _proactiveReopen
    // / _reopenImpl before close() ever runs; `undefined` was falsy-safe
    // but the M5 contract should be self-documenting.
    this._userClosed = false;
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
    // D-GoAway (P1-6). Set when the server sends `goAway`; the reopen is
    // deferred to the next turn_complete (VAD-silence) or, failing that,
    // the hard fallback timer at timeLeft−margin. `_goAwayReopenInFlight`
    // makes the proactive bounce idempotent AND tells onclose to suppress
    // the `closed` event for our OWN intentional close (so the proxy's
    // reactive teardown/lazy-reopen path does not fight it). All inert
    // unless `this._decoupled` (audit C1).
    this._goAwayPending = false;
    this._goAwayTimer = null;
    this._goAwayReopenInFlight = false;
    // Audit C2 — true between turnStart() and the matching turn_complete
    // (manual-VAD utterance window). 3.1 Live emits inputTranscription
    // ONCE at end-of-utterance; force-closing mid-utterance (deadline
    // fallback) destroys the user's entire question on the decoupled
    // path → dead air. The deadline fallback defers while this is true.
    this._utteranceInFlight = false;
    // Audit C2 — bounded re-arm count so a pathological >timeLeft
    // monologue still force-reopens eventually (a controlled reopen that
    // loses one in-flight question still beats an uncontrolled server
    // ABORTED that loses it AND wedges the next turn).
    this._goAwayDeadlineRetries = 0;
    // Audit C3 — monotonically-increasing session generation. The
    // onclose closure captures the gen it was created under; a stale
    // OLD-session close that fires AFTER a newer session exists (the
    // _proactiveReopen fire-and-forget-close → reopen race) is a complete
    // no-op so it cannot clobber `_closed`, emit a phantom `closed`, or
    // tear down a perfectly healthy NEW session. Inert on legacy: the
    // reactive lazy-reopen path is sequential (old session fully closed
    // before reopen is even called) so sessions never overlap → the gen
    // guard never triggers and behavior is byte-identical pre-P1-6.
    this._sessionGen = 0;
    // Audit M1/M2 — reopen() reentrancy coalescing. Both the proactive
    // D-GoAway bounce and the proxy's lazy turn_start reopen can call
    // reopen() concurrently; without coalescing that is two ai.live.connect
    // calls + resumption-handle replay + two live sessions. All callers
    // share the one in-flight reopen promise.
    this._reopenInFlight = null;
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
    // 2026-05-13 — MANUAL VAD. Reversing the 2026-05-02 switch to auto-VAD.
    //
    // The "multi-turn-2 close-mid-turn regression" cited in the prior comment
    // turned out to be a protocol mismatch: sending `activityStart` WHILE
    // auto-VAD was enabled is a protocol error per Gemini Live docs. With
    // auto-VAD properly disabled here, manual signals (`activityStart` /
    // `activityEnd`) are the supported path. No protocol mismatch, no
    // regression.
    //
    // Why manual VAD: tap-to-toggle UX requires the user's tap to be the
    // ONLY source of turn boundaries. With auto-VAD on, Gemini's server-side
    // VAD ends user turns based on silence detection (~1s pause = turn over).
    // That cuts users off mid-thought ("button flipped on its own") AND
    // diverges the local state machine from the server's. Client-owned
    // boundaries fix both at the architectural level.
    //
    // ROLLBACK: delete the realtimeInputConfig block + revert turnStart()
    // to no-op + revert turnEnd() to `audioStreamEnd: true`. One-line env
    // flag could gate this if multi-turn ever genuinely regresses.
    config.realtimeInputConfig = { automaticActivityDetection: { disabled: true } };
    // Audit C3 — the generation this session's callbacks belong to.
    // Captured by the onclose/onerror closures so a stale OLD-session
    // event that fires after a newer session exists is a no-op.
    const myGen = ++this._sessionGen;
    this._session = await ai.live.connect({
      model,
      config,
      callbacks: {
        onopen: () => {},
        onmessage: (m) => this._onMessage(m),
        // Closures capture the generation this session was opened under;
        // the handlers no-op a superseded session (audit C3). Extracted
        // to methods so the close/error race surface is unit-testable
        // without a live ai.live.connect (same DI philosophy as the
        // decoupled orchestrator).
        onerror: (ev) => this._onSessionError(myGen, ev),
        onclose: (ev) => this._onSessionClose(myGen, ev),
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

  // Extracted from open()'s onerror closure (audit C3 — testable seam).
  // `myGen` is the session generation captured at open() time.
  _onSessionError(myGen, ev) {
    // Audit C3 — ignore a superseded session's error.
    if (myGen !== this._sessionGen) return;
    // Audit NEW-M4 — north star: a failure must not reach the user as
    // silence/error if it is recoverable. If a goAway was already
    // pending (we are in the ~60s pre-cap window) and we hold a valid
    // resumption handle, an error here is far more likely the cap
    // arriving early than an unrecoverable fault — prefer the
    // resumption-handle reopen over guaranteeing teardown.
    // _proactiveReopen fails CLEANLY (go_away_reopen:fail → proxy
    // teardown) if the handle is dead, so this is strictly safer than
    // wiping state and tearing down without trying. Decoupled-only
    // (goAway only arms when decoupled) ⇒ legacy path unchanged: it
    // still emits the fatal error exactly as the pre-P1-6 closure did.
    if (this._decoupled && this._goAwayPending && this._sessionResumeHandle
        && !this._userClosed && !this._goAwayReopenInFlight) {
      setImmediate(() => this._proactiveReopen('error'));
      return;
    }
    // Not recoverable (no goAway window / no handle / legacy / already
    // bouncing). A fatal error makes any armed goAway fallback timer
    // moot; clearing it prevents a post-teardown _proactiveReopen
    // against a dead session.
    if (this._goAwayTimer) { clearTimeout(this._goAwayTimer); this._goAwayTimer = null; }
    this._goAwayPending = false;
    this._goAwayDeadlineRetries = 0;
    this.emit('event', {
      kind: 'error', at: Date.now(), message: ev?.message || 'ws_error', fatal: true,
    });
  }

  // Extracted from open()'s onclose closure (audit C3/M2 — testable
  // seam). `myGen` is the session generation captured at open() time.
  _onSessionClose(myGen, ev) {
    // Audit C3 — a stale OLD-session close that arrives AFTER a newer
    // session exists (the _proactiveReopen fire-and-forget close→reopen
    // race) must NOT clobber the live session's `_closed`, synthesize a
    // phantom turn_complete, or emit a `closed` that tears down a
    // healthy NEW session. Hard no-op.
    if (myGen !== this._sessionGen) return;
    this._closed = true;
    // D-GoAway (P1-6): this close is OUR intentional proactive bounce
    // (close→reopen with the resumption handle). Suppress the `closed`
    // event entirely so the proxy's reactive teardown / lazy-reopen path
    // does not fight the bridge's proactive reopen (a non-1000 SDK close
    // code would otherwise tear down a perfectly recoverable user
    // session). The reopen() that follows emits go_away_reopen:ok/fail.
    if (this._goAwayReopenInFlight) return;
    // Audit M2 — this is a REAL upstream close (NOT our suppressed
    // bounce) and the gen guard above proved it is the live session. If
    // a goAway was pending, the proactive timer would ALSO fire
    // _proactiveReopen → two ai.live.connect + handle replay. The
    // connection is already gone; the proactive bounce is moot. Cancel
    // it and let the reactive path (1000 ⇒ proxy lazy reopen on next
    // turn_start; non-1000 ⇒ teardown) own it.
    if (this._goAwayPending || this._goAwayTimer) {
      if (this._goAwayTimer) { clearTimeout(this._goAwayTimer); this._goAwayTimer = null; }
      this._goAwayPending = false;
      this._goAwayDeadlineRetries = 0;
    }
    // js-genai#707 workaround: if Gemini sent us content this turn and
    // is now closing normally without a turnComplete, synthesize one so
    // turnEnd resolves. Strict gate: code=1000 + content seen. Any other
    // close path (errors, mid-turn drops with no content) still rejects
    // the awaiting promise as before.
    if (ev?.code === 1000 && this._currentTurnReceivedContent) {
      console.warn(`[google-live-workaround] synthesizing turn_complete on code=1000 close (sessionId=${this._sessionId})`);
      this.emit('event', { kind: 'turn_complete', at: Date.now() });
    }
    this.emit('event', { kind: 'closed', at: Date.now(), code: ev?.code, reason: ev?.reason });
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
    // D-GoAway (P1-6). The server warns it will soon disconnect. Do NOT
    // reopen now (mid-turn) — arm a hard fallback timer and let the next
    // turn_complete (VAD-silence) drive a clean resumption-handle reopen.
    // Idempotent: a repeated goAway just refreshes the deadline.
    // Audit C1 — HARD-GATED to decoupled: the proactive reopen's safety
    // proof ("no history → regression-immune") only holds on the
    // STT-only path. On legacy this whole block is dead code, so the
    // legacy path is byte-identical to its pre-P1-6 reactive-only reopen.
    if (this._decoupled && m?.goAway && !this._goAwayReopenInFlight) {
      const timeLeftMs = parseGoAwayTimeLeftMs(m.goAway.timeLeft);
      // Audit NEW-M2 — only reset the bounded re-arm counter on the
      // FIRST goAway of a window. A repeated/refreshing goAway (the
      // server re-warns as the cap nears) must NOT reset the 3-retry
      // bound, else a server that re-warns each turn defeats C2's bound
      // entirely and the deadline never force-reopens → server ABORT.
      if (!this._goAwayPending) this._goAwayDeadlineRetries = 0;
      this._goAwayPending = true;
      // Audit NEW-S4 — compute once so the armed delay and the emitted
      // deadlineInMs provably cannot diverge under a future edit.
      const deadlineInMs = Math.max(0, timeLeftMs - GOAWAY_SAFETY_MARGIN_MS);
      this._armGoAwayDeadline(deadlineInMs);
      this.emit('event', { kind: 'go_away', at: Date.now(), timeLeftMs, deadlineInMs });
    }
    if (m?.serverContent?.interrupted) {
      // Audit NEW-M1 — barge-in / supersede ends the utterance WITHOUT a
      // turn_complete (the user moved on). If we leave _utteranceInFlight
      // true, a pending goAway deadline re-arms 3× against a phantom
      // utterance, burning the 6s grace while the real cap elapses →
      // server ABORT (the exact failure C2 exists to prevent). Clear it.
      this._utteranceInFlight = false;
      this.emit('event', { kind: 'interrupted', at: Date.now() });
    }
    if (m?.serverContent?.turnComplete) {
      this._currentTurnReceivedContent = false;
      this._pendingInputTranscriptionThisTurn = null;
      // Audit C2 — utterance window closed; the deadline fallback may
      // now bounce safely (the input transcript for this turn already
      // arrived just before turnComplete in this same envelope).
      this._utteranceInFlight = false;
      this.emit('event', { kind: 'turn_complete', at: Date.now() });
      // D-GoAway (P1-6): turn_complete IS the manual-VAD silence
      // boundary — the safe place to bounce the connection. Defer the
      // reopen a tick so every turn_complete listener (notably the
      // proxy's bridge.turnEnd() await + the decoupled orchestrator's
      // awaitTurnSpoken gate) runs FIRST, then proactively reopen with
      // the resumption handle BEFORE the server ABORTS. Decoupled-gated
      // via the goAway arm above (_goAwayPending only ever set there).
      if (this._goAwayPending && !this._goAwayReopenInFlight) {
        setImmediate(() => this._proactiveReopen('vad_silence'));
      }
    }
  }

  // D-GoAway (P1-6, audit C2/M4). Arm/re-arm the hard fallback timer.
  // NOT unref'd: its on-time firing is the only thing between the user
  // and a server ABORTED when no turn_complete arrives — deprioritizing
  // it under event-loop load is an unforced UX risk. It is short-lived
  // and explicitly cleared on reopen / close / real-close / fresh goAway
  // so it never outlives its purpose.
  _armGoAwayDeadline(delayMs) {
    if (this._goAwayTimer) { clearTimeout(this._goAwayTimer); this._goAwayTimer = null; }
    this._goAwayTimer = setTimeout(() => {
      this._goAwayTimer = null;
      // Audit C2 — NEVER force-close mid-utterance: 3.1 Live emits
      // inputTranscription once at end-of-utterance, so a force-close
      // here destroys the user's entire question (decoupled = no answer,
      // dead air). Re-arm a short grace and let the next turn_complete
      // drive the clean bounce. Bounded: a pathological monologue that
      // outlasts every grace eventually force-reopens — a controlled
      // reopen losing one in-flight question still beats an uncontrolled
      // server ABORTED that loses it AND wedges the next turn.
      if (this._utteranceInFlight && this._goAwayDeadlineRetries < 3) {
        this._goAwayDeadlineRetries += 1;
        this._armGoAwayDeadline(GOAWAY_SAFETY_MARGIN_MS);
        return;
      }
      // No VAD-silence arrived in time. A controlled reopen still beats
      // a server ABORTED.
      this._proactiveReopen('deadline');
    }, delayMs);
  }

  // D-GoAway (P1-6). Close → reopen with the stored resumption handle at
  // a safe boundary. Reuses the existing reopen() machinery; onclose
  // suppresses the `closed` event while `_goAwayReopenInFlight` so the
  // proxy never sees this intentional bounce. Decoupled STT Live has no
  // history/persona → reopen() is the trivial (regression-immune) case.
  async _proactiveReopen(reason) {
    if (this._goAwayReopenInFlight || this._userClosed) return;
    this._goAwayReopenInFlight = true;
    this._goAwayPending = false;
    this._goAwayDeadlineRetries = 0;
    // P1-9 whole-build audit M5 — operator-visible log line for the
    // PROD_DEPLOY_GATE 1c manual session checklist. The structured
    // `event` below is for downstream consumers (orchestrator
    // metrics); this string is for `fly logs` / stderr-tail. Keep the
    // exact wording — the gate doc greps for it.
    console.warn(`[gemini-bridge] proactive D-GoAway reopen (sessionId=${this._sessionId} reason=${reason})`);
    // Audit NEW-M3 — the bounce ends the current utterance window
    // regardless (a retry-3 force-reopen is, by definition, abandoning
    // it). Leaving _utteranceInFlight true would make the NEXT goAway on
    // the resumed session defer 3× against a phantom utterance (NEW-M1
    // again, on the new session). A real new turn sets it true via
    // turnStart().
    this._utteranceInFlight = false;
    if (this._goAwayTimer) { clearTimeout(this._goAwayTimer); this._goAwayTimer = null; }
    this.emit('event', { kind: 'go_away_reopen', at: Date.now(), phase: 'start', reason });
    try {
      try { this._session?.close(); } catch {}
      // onclose may not have run yet (close is async); force `_closed`
      // so reopen() doesn't early-return "already open". Audit C4 — do
      // NOT null `_currentTurnUsage` / `_currentTurnReceivedContent`
      // here: that is the server-authoritative token count for a turn
      // that may still be billing, and nulling it blinds the COGS
      // kill-switch. reopen() (→ via the new session's turnStart) owns
      // resetting that state for the NEXT turn; the bounce must leave
      // the prior turn's billing intact.
      this._closed = true;
      // Audit C3 — the STALE OLD-session onclose is neutralized by the
      // session-generation guard (reopen→open increments _sessionGen so
      // the old closure's captured gen no longer matches). This
      // setImmediate is STILL load-bearing (NEW-S3): it orders the old
      // session's synchronous close-callback portion BEFORE the new
      // connect, so the new session is built against settled state. Do
      // NOT remove it as "dead" — the gen-guard handles staleness, this
      // handles ordering.
      await new Promise((r) => setImmediate(r));
      await this.reopen();
      this.emit('event', { kind: 'go_away_reopen', at: Date.now(), phase: 'ok', reason });
    } catch (e) {
      // Audit M5 — if the user closed mid-bounce, reopen() throws
      // `bridge_user_closed`. That is an EXPECTED abort, not a failure:
      // emit a distinct non-error phase so the proxy does NOT
      // captureException / send upstream_closed / fire a second teardown
      // racing the user-close path's own teardown.
      if (this._userClosed) {
        this.emit('event', {
          kind: 'go_away_reopen', at: Date.now(), phase: 'aborted_user_closed', reason,
        });
      } else {
        // reopen() already dropped the resumption handle on failure. The
        // session is genuinely dead; surface it so the proxy tears down
        // (the reactive 1000-close fallback can't help — past the cap).
        this.emit('event', {
          kind: 'go_away_reopen', at: Date.now(), phase: 'fail',
          reason, message: e?.message || 'reopen_failed',
        });
      }
    } finally {
      // Held TRUE across the entire bounce (old-session close + reopen)
      // so the OLD session's onclose is suppressed (belt to the gen
      // guard's braces); reset only once the NEW session is live (or the
      // bounce failed) — its future onclose must surface normally.
      this._goAwayReopenInFlight = false;
    }
  }

  turnStart() {
    if (!this._session || this._closed) throw new Error('bridge_not_open');
    // Audit C2 — the manual-VAD utterance window opens here and closes
    // on the matching turn_complete. While true, the D-GoAway deadline
    // fallback defers (force-closing now would destroy the in-flight
    // question — 3.1 Live emits inputTranscription once at end-of-turn).
    this._utteranceInFlight = true;
    this._currentTurnOutputBytes = 0;
    this._currentTurnInputBytes = 0;
    this._currentTurnUsage = null;
    this._currentTurnOutputTranscript = '';
    this._currentTurnRunawayFired = false;
    this._currentTurnReceivedContent = false;
    // Manual VAD (2026-05-13): explicit activityStart paired with the
    // automaticActivityDetection.disabled=true config above. Tells Gemini
    // "the user is talking now, do not infer end-of-turn from silence."
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

  /** Signals end of client audio stream (manual VAD = client owns boundaries),
   *  resolves on next turn_complete with per-turn metrics. With
   *  realtimeInputConfig.automaticActivityDetection.disabled=true, the
   *  protocol-correct signal is `activityEnd: {}` (Gemini Live docs).
   *  https://ai.google.dev/api/live#RealtimeInputConfig */
  async turnEnd({ timeoutMs = 30_000 } = {}) {
    if (!this._session || this._closed) throw new Error('bridge_not_open');
    this._session.sendRealtimeInput({ activityEnd: {} });

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
    // Mark user-initiated FIRST so an in-flight D-GoAway proactive
    // reopen aborts: reopen() throws on `_userClosed` and
    // _proactiveReopen's top guard refuses re-entry (don't resurrect a
    // session the user closed mid-bounce). Also kill the goAway fallback
    // timer so it can't fire a reopen after teardown.
    this._userClosed = true;
    if (this._goAwayTimer) { clearTimeout(this._goAwayTimer); this._goAwayTimer = null; }
    this._goAwayPending = false;
    this._goAwayDeadlineRetries = 0;
    this._utteranceInFlight = false;
    if (this._closed) return;
    try { this._session?.close(); } catch {}
    this._closed = true;
    // Audit C4 (2026-05-07). Drop the resumption handle on explicit close
    // so it can never be replayed across a user-driven session boundary.
    this._sessionResumeHandle = null;
  }

  // Re-open after Google's post-turn 1000-close (js-genai#707). Called
  // lazily from the proxy on next turn_start when _closed=true and
  // _userClosed=false. Re-runs ai.live.connect with the original args
  // (which also sets sessionResumption.handle so conversation context
  // carries across the WS bounce — see open()).
  // Audit M1/M2 — reentrancy-coalesced. The proactive D-GoAway bounce
  // and the proxy's lazy turn_start reopen can both call reopen()
  // concurrently while `_closed`; without coalescing that is two
  // ai.live.connect calls + resumption-handle replay + two live
  // sessions. All concurrent callers share the one in-flight promise
  // and observe the same resolution / rejection.
  async reopen() {
    if (this._reopenInFlight) return this._reopenInFlight;
    this._reopenInFlight = this._reopenImpl();
    try { return await this._reopenInFlight; }
    finally { this._reopenInFlight = null; }
  }

  async _reopenImpl() {
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
