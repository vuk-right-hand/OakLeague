// use-session-pipe — wires the pure reducer to the avatar bridge + the
// Fly voice proxy + mic capture.
//
// Flow at the hook level:
//   1. Caller already POSTed /api/sessions/open; hands us the envelope.
//   2. Hook opens the avatar bridge (Simli/HeyGen, pre-minted) in parallel
//      with the Fly proxy WS (which fronts Gemini Live + Cartesia TTS).
//   3. Both pipes hit 'ready' → reducer flips to 'ready'; UI enables mic.
//   4. press-and-hold mic → turn_start → stream worklet frames → turn_end.
//   5. Proxy onAudioOut PCM bytes → bridge.sendAudio (cloned-voice TTS).
//   6. Proxy onError(barge_in) → bridge.cancel() (pipe stays warm).
//   7. Heartbeat every 20s → /api/sessions/heartbeat; 410 → fatal_error.
//   8. visibilitychange → reducer; effect POSTs pause/resume.
//   9. Ticker: at maxSessionSeconds → POST /api/sessions/rollover; overlap-
//      swap proxy WS via ProxyClient.swapTo.
//
// Tickets never enter React state. They live on a ref. PostHog captures go
// through captureSafe (R3-S2).
//
// PR-2 (use-session-pipe rewire) deleted the legacy direct-Gemini path
// previously gated on NEXT_PUBLIC_VOICE_PROXY_PATH — the proxy WS is now
// the only path, the envelope no longer carries gemini.token, and the
// reducer's brain-side action kinds are renamed from gemini_* to brain_*
// / tts_* / turn_complete / barge_in.

'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import { createSimliBridge } from '@/lib/avatar/simli-bridge';
import { createHeygenBridge } from '@/lib/avatar/heygen-bridge';
import type { AvatarBridge, AvatarBridgeHandlers, AvatarOpenOptions, AvatarError } from '@/lib/avatar/avatar-bridge';
import { captureSafe } from '@/lib/posthog-safe-capture';
import { createProxyClient, type ProxyClient } from '@/lib/voice/proxy-client';
import {
  initialState,
  reduce,
  type Action,
  type SessionState,
} from './session-reducer';

// Envelope shape returned by POST /api/sessions/open and /api/sessions/rollover.
// Re-export the wire types from the shared single-source-of-truth module
// (final-audit S1). Existing imports of `OpenEnvelope` from this file
// keep working — see src/lib/avatar/avatar-envelope.ts.
import type { AvatarEnvelope, OpenEnvelope } from '@/lib/avatar/avatar-envelope';
export type { AvatarEnvelope, OpenEnvelope };

export type UseSessionPipeArgs = {
  envelope: OpenEnvelope;
  creatorId: string;
  hookId: string;
  systemInstruction?: string;
  // Dev-only: client-side shortcut for the 15-min rollover flow. Reads
  // NEXT_PUBLIC_GEMINI_SESSION_CAP_S from window.__next env at mount; server
  // remains authoritative via envelope.max_session_s. (R3-S4)
  rolloverOverrideSeconds?: number;
};

const HEARTBEAT_MS = 20_000;
// Rate-limit-floor on the server is 10s; we poll at 20s to stay well clear.

// Provider-aware bridge factory + open-opts builder (post-build audit C1).
// Returns a bridge instance plus the AvatarOpenOptions that bridge.open()
// needs. Caller wires DOM elements + provider-specific session boot info.
function buildBridge(
  envelope: OpenEnvelope,
  handlers: AvatarBridgeHandlers,
  videoEl: HTMLVideoElement | null,
  audioEl: HTMLAudioElement | null,
): { bridge: AvatarBridge; openOpts: AvatarOpenOptions } | null {
  if (!envelope.avatar) return null;
  const av = envelope.avatar;
  const baseOpts: AvatarOpenOptions = {
    replicaId: av.face_id,
    videoEl: videoEl ?? undefined,
    audioEl: audioEl ?? undefined,
  };
  if (av.provider === 'heygen') {
    return {
      bridge: createHeygenBridge(handlers),
      openOpts: { ...baseOpts, heygenSessionBoot: av.heygen_session_boot },
    };
  }
  // simli or tavus
  return {
    bridge: createSimliBridge(handlers),
    openOpts: { ...baseOpts, preMintedSessionToken: av.session_token },
  };
}

const AUDIO_CONTEXT_RESUME_VERIFY_MS = 300;
// iOS WebKit: verify AudioContext.state === 'running' 300ms after resume()
// (R3-M4 — visibilitychange is not a user gesture).


export type PipeHandle = {
  state: SessionState;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  // 2026-05-13 — single source of truth for "is the mic physically capturing
  // and forwarding audio to the proxy right now". The button MUST read this,
  // not `phase === 'listening'`, because the reducer's phase is server-driven
  // (it transitions out of 'listening' on tts_audio_chunk when Gemini's auto-
  // VAD ends the user's turn) while micActive reflects actual track state.
  // These can diverge; micActive is what the button needs.
  micActive: boolean;
  startMic: () => void;
  stopMic: () => void;
  endSession: (reason: 'user_ended' | 'client_error') => Promise<void>;
  // Manual retry after reconnecting-overlay click (provides user gesture to
  // unlock AudioContext on iOS).
  retryAfterGesture: () => Promise<void>;
  // R4-YC-Day — session-client's 1Hz black-square watcher fires this when
  // videoEl.paused && srcObject != null for ≥2s. Reducer flips to
  // 'reconnecting' so the existing tap-to-resume overlay surfaces.
  notifyVideoAutoplayLost: () => void;
  lipsyncLatencyMs: number | null;
  /** Day 3 — accessors for the recording controller's askDeps. Returns null
   *  when the underlying ref is not yet populated (mic not started, bridge
   *  pre-open, or post-endSession). The recording controller is expected to
   *  read these only at ARM time (user-gesture chain — mic is necessarily
   *  started and bridge is open by then). The track-update subscription
   *  re-fires on LiveKit renegotiation and on initial bridge open. */
  getAudioContext: () => AudioContext | null;
  getMicStream: () => MediaStream | null;
  getBridge: () => AvatarBridge | null;
  /** Subscribe to track replacements. Pass `{ replayInitial: false }` (Day 3
   *  audit C2/C3) when the caller has ALREADY consumed the current tracks
   *  via getBridge().getCurrentTracks() — otherwise the synchronous replay
   *  on subscribe will fire `removeTrack(t); addTrack(t)` on a stream that
   *  was just initialized with that exact track, briefly orphaning the only
   *  frame source for the hidden-video element (Safari renders a black frame). */
  subscribeBridgeTrackUpdates: (
    cb: (tracks: { video: MediaStreamTrack | null; audio: MediaStreamTrack | null }) => void,
    opts?: { replayInitial?: boolean },
  ) => () => void;
};

export function useSessionPipe(args: UseSessionPipeArgs): PipeHandle {
  const [state, dispatch] = useReducer(reduce, {
    ...initialState,
    sessionId: args.envelope.session_id,
    tier: args.envelope.tier,
    avatarStatus: args.envelope.avatar_status,
    maxSessionSeconds:
      args.rolloverOverrideSeconds && args.rolloverOverrideSeconds > 0
        ? Math.min(args.rolloverOverrideSeconds, args.envelope.max_session_s)
        : args.envelope.max_session_s,
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Refs for things that must not trigger re-renders and must survive
  // reducer updates. Tokens live HERE (never in state).
  const bridgeRef = useRef<AvatarBridge | null>(null);
  // Proxy WS client — owns mic-frame upload + audio_out routing into the
  // bridge. The only brain transport after PR-2.
  const proxyRef = useRef<ProxyClient | null>(null);
  // R3-M7 — t0 for user_perceived_response_ms. Set on mic_stopped (start
  // of "user is waiting for answer"); cleared on first audio_out frame.
  const userPerceivedT0Ref = useRef<number | null>(null);
  // R3-Missing-4 — video stats accumulator. Bridge fires onVideoStats at
  // 5s cadence with monotonic counters; we diff vs prior sample to get
  // interval drop-rate, accumulate ratios, flush p50/p95 every 30s.
  const videoStatsLastRef = useRef<{ dropped: number; total: number } | null>(null);
  const videoStatsRatiosRef = useRef<number[]>([]);
  const videoStatsFlushAtRef = useRef<number>(Date.now());
  // R3-Missing-5 — audio drift accumulator. Compare audio_out byte arrival
  // to wall clock; flush simli_clock_drift_ms every 60s.
  const driftFirstAudioMsRef = useRef<number | null>(null);
  const driftBytesRef = useRef<number>(0);
  const driftFlushAtRef = useRef<number>(Date.now());
  const micStreamRef = useRef<MediaStream | null>(null);
  // Phase 0.5 fix (2026-05-07). Mic-tap button fires multiple pointer
  // events on release: onPointerUp + onPointerLeave + onPointerCancel
  // all call stopMic. Without this latch, each fired turn_end on the
  // proxy WS — Cartesia received doubled turn_ends with mic frames in
  // between, accumulated bad state, and died with "Invalid transcript"
  // by turn 4. Tracks "is the mic currently engaged this turn" so
  // start/stop fire exactly once per press-and-hold cycle.
  const micActiveRef = useRef<boolean>(false);
  // 2026-05-13 — state mirror of micActiveRef. Refs don't trigger re-renders;
  // the button needs a re-rendered value to flip its UI. Updated in lockstep
  // with micActiveRef inside startMic / stopMic / endSession / visibility-
  // hidden — the only four places that mutate mic state. Reading this is
  // the SINGLE source of truth for "should the button show STOP".
  const [micActive, setMicActive] = useState<boolean>(false);
  // 2026-05-13 — silence-detection auto-stop. Replaces the dumb 30s hard cap
  // on the MicButton.
  //   * lastVoiceActivityRef: performance.now() of the most recent worklet
  //     `voice_activity` message (RMS ≥ -50 dBFS over a 40ms frame).
  //   * On startMic we seed it with NOW so a user who taps and immediately
  //     goes silent still gets a 7s mic-open window (the silence counter
  //     starts at tap, not at -∞).
  //   * Interval polls every 500ms while micActive=true. Auto-stop fires
  //     when (now - lastVoiceActivity) > VAD_SILENCE_TIMEOUT_MS or
  //     (now - micStartedAt) > VAD_HARD_CEILING_MS (runaway guard for
  //     wedged streams).
  const lastVoiceActivityRef = useRef<number>(0);
  const micStartedAtRef = useRef<number>(0);
  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 2026-05-13 (v2) — gate for `tts_audio_chunk` dispatch. True between
  // `stopMic` (we sent turn_end, expecting model response) and `turn_complete`
  // (server signals response is done). Only audio_out frames inside this
  // window count as "the model is currently speaking" — anything after is
  // Cartesia tail and must not re-flip phase ready→speaking (the ping-pong
  // that left phase stuck at speaking after every turn). Reset on startMic /
  // endSession / visibility-hidden so a stuck flag never blocks the next turn.
  const expectingTtsRef = useRef<boolean>(false);
  // 2026-05-27 (v2) — avatar tail-flush. The Simli chunker carries the final
  // <6000B remainder of a turn's audio; with no "next chunk" to complete a
  // frame, that tail must be flushed explicitly at the TRUE end of the turn's
  // audio. The authoritative end-of-audio signal is the proxy's 'tts_audio_done'
  // (Cartesia's real `done`, context-gated) → flushTail() runs ONCE in
  // onTtsAudioDone; onTurnComplete is the backstop if that signal is lost.
  //
  // This REPLACES the 2026-05-25/26 timer that armed on 'deep_answer_done' and
  // re-armed on every audio_out: deep_answer_done is TEXT-done, not audio-done,
  // so on long answers the 200ms timer fired repeatedly on Cartesia's mid-answer
  // synthesis gaps, padding silence into the stream (the stutter — 11×/answer in
  // the 2026-05-27 capture). No timer now; flush is edge-triggered at the end.
  const flushTail = useCallback(() => {
    // commitUtterance is a no-op on an empty carry (simli-bridge.ts), so a
    // double-fire (tts_audio_done + the onTurnComplete backstop) is harmless.
    try { bridgeRef.current?.commitUtterance?.(); } catch { /* best-effort */ }
  }, []);
  // Forward-ref for stopMic so the silence-timer callback (set up inside
  // startMic) can call stopMic without a temporal-dead-zone issue. The
  // useCallback below assigns into this ref after defining stopMic.
  const stopMicRef = useRef<(() => void) | null>(null);
  // Phase 0.5 (2026-05-07). In-flight getUserMedia promise — used by
  // BOTH the room-mount pre-warm and the lazy startMic path so a fast
  // first-press can't fire a second concurrent permission prompt.
  // Whichever caller hits first creates the promise; the other awaits it.
  const micStreamPromiseRef = useRef<Promise<MediaStream> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  // Wire-form model name passed to ProxyClient.open / swapTo as `modelWire`.
  // The proxy holds the Gemini API key server-side — the client never sees
  // a token after PR-2.
  const modelRef = useRef<string>(args.envelope.voice.model);
  // Simli/Tavus path retains a pre-minted compose token for legacy code
  // paths. HeyGen has its own session_boot envelope and doesn't go through
  // this ref. Discriminate on provider before reading.
  const preMintedSimliRef = useRef<string | null>(
    args.envelope.avatar && (args.envelope.avatar.provider === 'simli' || args.envelope.avatar.provider === 'tavus')
      ? args.envelope.avatar.session_token
      : null,
  );
  const sessionIdRef = useRef<string>(args.envelope.session_id);
  const closedRef = useRef<boolean>(false);
  const rollingOverRef = useRef<boolean>(false);
  const lipsyncLatencyRef = useRef<number | null>(null);
  // Phase C B1.2: enrich session_close with last close code + duration so
  // post-deploy regressions can be split by reason (AC #5: ±10% baseline
  // is meaningless without per-reason breakdown). Stamped at brain_ready
  // so duration_ms measures session-truly-started → close, NOT
  // mount → close — pre-brain-ready failures (proxy connect, voice ticket)
  // report duration_ms=null which the dashboard buckets separately from
  // real session lengths. Wall-clock; clock skew across visibility-change
  // suspends doesn't matter at this granularity.
  const sessionStartedAtRef = useRef<number | null>(null);
  const lastCloseCodeRef = useRef<number | null>(null);
  // Day 3 — track-update subscribers (recording controller subscribes for
  // mid-recording LiveKit renegotiation handling). Plain Set so add/remove
  // is constant-time; subscriber callbacks fire SYNCHRONOUSLY when the bridge
  // re-fires onVideoTrack / onAudioTrack. Both are coalesced via the cached
  // refs below: a joint reneg surfaces as two sequential calls within a
  // microtask group (avatar-bridge.ts §120-125), so we batch the latest known
  // tracks rather than emitting once per track.
  type BridgeTracks = { video: MediaStreamTrack | null; audio: MediaStreamTrack | null };
  const trackSubscribersRef = useRef<Set<(t: BridgeTracks) => void>>(new Set());
  const lastTracksRef = useRef<BridgeTracks>({ video: null, audio: null });
  function broadcastTracks(): void {
    const snapshot = { ...lastTracksRef.current };
    for (const cb of trackSubscribersRef.current) {
      try { cb(snapshot); } catch (e) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[use-session-pipe] track subscriber threw:', e);
        }
      }
    }
  }
  // Playback of Gemini audio chunks via the Web Audio API route goes directly
  // to the Simli bridge — we don't play Gemini audio to the user locally.
  // The avatar speaks.

  function dispatchRef(a: Action) {
    if (closedRef.current && a.kind !== 'closed_ack') return;
    dispatch(a);
  }

  // Phase 0.5 (2026-05-07). Single-flight mic acquisition.
  // The room-mount pre-warm effect AND startMic both call this. First
  // caller fires getUserMedia; subsequent callers await the same promise
  // (no second permission prompt). Returned stream has all tracks
  // disabled so no audio leaks until startMic enables them.
  // Audit C1 / C5 (2026-05-07). True if at least one audio track is live —
  // not muted-by-OS, not ended-by-backgrounding. Used both to gate the
  // cache (a getUserMedia that resolves with already-ended tracks must
  // NOT be cached) and by the visibility handler to detect tracks killed
  // by iOS during long backgrounding.
  function isStreamLive(stream: MediaStream | null): boolean {
    if (!stream) return false;
    return stream.getAudioTracks().some((t) => t.readyState === 'live');
  }

  // Audit C5 (2026-05-07). Tear down the entire mic/audio graph so the next
  // acquireMicStream + acquireAudioGraph builds fresh. Called when the
  // visibility handler detects iOS killed our mic tracks during backgrounding.
  function invalidateAudioGraph(): void {
    try { workletNodeRef.current?.disconnect(); } catch {}
    workletNodeRef.current = null;
    try { micStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    micStreamRef.current = null;
    micStreamPromiseRef.current = null;
    // Don't close audioCtx — it's reusable and iOS limits concurrent
    // contexts. acquireAudioGraph will rebuild source + worklet on top.
  }

  function acquireMicStream(): Promise<MediaStream> {
    if (micStreamRef.current && isStreamLive(micStreamRef.current)) {
      return Promise.resolve(micStreamRef.current);
    }
    // Dead/null cache — clear so the new getUserMedia call wins.
    if (micStreamRef.current) {
      try { micStreamRef.current.getTracks().forEach((t) => t.stop()); } catch {}
      micStreamRef.current = null;
    }
    if (micStreamPromiseRef.current) return micStreamPromiseRef.current;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      return Promise.reject(new Error('mediaDevices_unavailable'));
    }
    const p = navigator.mediaDevices
      .getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      })
      .then((stream) => {
        // Audit C1 (2026-05-07). iOS Safari can resolve getUserMedia with
        // a stream whose tracks are ALREADY ended (page was backgrounded
        // during the permission prompt). Refuse to cache a dead stream
        // — null the promise so the next caller retries fresh.
        if (!isStreamLive(stream)) {
          try { stream.getTracks().forEach((t) => t.stop()); } catch {}
          micStreamPromiseRef.current = null;
          throw new Error('mic_stream_ended_at_acquire');
        }
        // Phase 0.5 (2026-05-07). Tracks stay ENABLED.
        //
        // Earlier this disabled tracks for "no audio leak pre-press." That
        // assumption was wrong AND it broke iOS: WebKit's
        // MediaStreamAudioSourceNode freezes track-enabled state at
        // construction time. If startMic later re-enables the track, the
        // already-built source node never sees the change, the worklet's
        // process() keeps getting empty inputs, no frames ever reach the
        // proxy → "session ended immediately" on iPhone (matches Fly logs:
        // turn_start arrives, no mic.first_frame ever).
        //
        // The "leak" defense was theatre anyway: with no AudioContext +
        // source-node graph yet, the captured audio has no path to anywhere.
        // The real frame-suppression gate is `micActiveRef` inside the
        // worklet's port.onmessage handler.
        micStreamRef.current = stream;
        return stream;
      })
      .catch((e) => {
        // Clear so a future caller can retry (e.g. after the user grants
        // permission via the browser's site settings).
        micStreamPromiseRef.current = null;
        throw e;
      });
    micStreamPromiseRef.current = p;
    return p;
  }

  // Phase 0.5 (2026-05-07). iOS WebKit AVAudioSession-category fix.
  //
  // HeyGen pipes avatar audio over a LiveKit RTC peer connection
  // (heygen-bridge.ts) into <audio>.srcObject. iOS Safari runs everything
  // through AVAudioSession; while WebRTC is playing, the session category
  // is "playback". Creating `new AudioContext()` later forces a flip to
  // "playAndRecord", and on WebKit specifically that flip *interrupts the
  // WebRTC peer's media* — LiveKit fires disconnect → heygen-bridge maps
  // the WS close to `session_ttl_expired` → reducer flips to closed →
  // "session ended immediately on first hold." Reproduced on iOS 17.6.1.
  //
  // The trick: build the AudioContext + worklet + source graph during
  // pre-warm, BEFORE HeyGen's LiveKit room joins. iOS sets
  // playAndRecord up front; HeyGen's later peer connect is born into
  // that category and never gets ripped. Context stays `suspended` —
  // the actual `resume()` happens inside the user-gesture click handler
  // for first hold. No graph mutation on press → no later category flip.
  //
  // Builds are idempotent; subsequent presses skip straight to resume().
  // If pre-warm path fails (e.g., iOS rejects context creation without an
  // active gesture), startMic's catch retries via this same helper from
  // inside the gesture — same code path, recovered.
  async function acquireAudioGraph(stream: MediaStream): Promise<void> {
    if (workletNodeRef.current && audioCtxRef.current) return;
    if (!audioCtxRef.current) {
      const Ctx: typeof AudioContext =
        (window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
          .AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtxRef.current = new Ctx();
    }
    const ctx = audioCtxRef.current;
    if (workletNodeRef.current) return;
    await ctx.audioWorklet.addModule('/worklets/mic-processor.js');
    // Tracks must be enabled BEFORE createMediaStreamSource on iOS WebKit
    // (frozen-at-construction quirk fixed earlier). acquireMicStream
    // already leaves tracks enabled, but cheap to enforce here.
    stream.getTracks().forEach((t) => (t.enabled = true));
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'mic-processor');
    node.port.onmessage = (ev) => {
      const kind = ev.data?.type as string | undefined;
      if (kind === 'voice_activity') {
        // Worklet emits this whenever an outbound frame has RMS ≥ -50 dBFS.
        // Used by the silence-detection auto-stop in stopMic's companion
        // timer. Drop the marker outside an active mic press.
        if (!micActiveRef.current) return;
        lastVoiceActivityRef.current = performance.now();
        return;
      }
      const pcm = ev.data?.pcm as ArrayBuffer | undefined;
      if (!pcm) return;
      // Drop frames whenever the mic isn't logically engaged (between
      // turns the mic is captured but should not feed the proxy).
      if (!micActiveRef.current) return;
      try { proxyRef.current?.sendAudio(pcm); }
      catch { /* WS closed mid-frame — heartbeat / close will reconcile */ }
    };
    src.connect(node);
    // Do NOT connect to ctx.destination — would loop mic back to speakers.
    workletNodeRef.current = node;
  }

  // Phase 0.5 (2026-05-07). Idempotent end-to-end pre-warm.
  //   1. acquireMicStream — popup OS permission prompt, retain MediaStream.
  //   2. acquireAudioGraph — build AudioContext + worklet + source (suspended).
  //   3. ctx.resume() — flip iOS AVAudioSession to playAndRecord NOW.
  //
  // Step 3 is the load-bearing one for iOS: the avatar's LiveKit RTC peer
  // must NOT already be connected when the audio-session category flips,
  // or WebKit interrupts the peer and the session looks "dead on first
  // press." Boot effect awaits this before calling openAvatar().
  //
  // All three steps swallow errors and breadcrumb. Avatar still opens
  // even if pre-warm couldn't fully complete (e.g., user denied mic);
  // startMic's catch-block retries the same code path from inside a
  // gesture handler if needed.
  async function preWarmAudio(): Promise<void> {
    let stream: MediaStream | null = null;
    try {
      stream = await acquireMicStream();
    } catch (e) {
      Sentry.addBreadcrumb({
        category: 'voice',
        level: 'warning',
        message: 'pre-warm getUserMedia rejected',
        data: { error: (e as Error)?.message ?? String(e) },
      });
      return;
    }
    try {
      await acquireAudioGraph(stream);
    } catch (e) {
      Sentry.addBreadcrumb({
        category: 'voice',
        level: 'warning',
        message: 'pre-warm acquireAudioGraph failed',
        data: { error: (e as Error)?.message ?? String(e) },
      });
      return;
    }
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    // Audit M6 (2026-05-07). On iOS, `new AudioContext()` outside a fresh
    // gesture can land in `closed` or `interrupted` state instead of
    // `suspended`. The original early-return on `state !== 'suspended'`
    // silently masked this — pre-warm reported success but AVAudioSession
    // never primed → openAvatar joined into `playback` mode → first Hold
    // ripped the LiveKit peer (the bug we already shipped a fix for).
    // Force-rebuild via the gesture-bound startMic path on this branch.
    if (ctx.state === 'closed' || ctx.state === 'interrupted') {
      Sentry.addBreadcrumb({
        category: 'voice',
        level: 'warning',
        message: 'pre-warm AudioContext landed non-resumable; will rebuild on first hold',
        data: { state: ctx.state },
      });
      audioCtxRef.current = null;
      // workletNode is bound to the dead ctx; null it so acquireAudioGraph
      // rebuilds the entire chain inside startMic's gesture handler.
      try { workletNodeRef.current?.disconnect(); } catch {}
      workletNodeRef.current = null;
      return;
    }
    if (ctx.state !== 'suspended') return; // already 'running'
    try {
      await ctx.resume();
      Sentry.addBreadcrumb({
        category: 'voice',
        level: 'info',
        message: 'audio-context resumed during pre-warm (iOS AVAudioSession primed)',
        data: { state: ctx.state },
      });
    } catch (e) {
      Sentry.addBreadcrumb({
        category: 'voice',
        level: 'warning',
        message: 'pre-warm resume rejected; iOS may rip LiveKit on first hold',
        data: { error: (e as Error)?.message ?? String(e) },
      });
    }
  }

  // R3-Missing-4 — video stats: diff vs prior, accumulate ratios, flush
  // p50/p95 every 30s as PostHog event simli_video_stats.
  function handleVideoStats(s: { droppedFrames: number; totalFrames: number; sampledAtMs: number }): void {
    const prior = videoStatsLastRef.current;
    videoStatsLastRef.current = { dropped: s.droppedFrames, total: s.totalFrames };
    if (prior) {
      const dDropped = Math.max(0, s.droppedFrames - prior.dropped);
      const dTotal = Math.max(0, s.totalFrames - prior.total);
      if (dTotal > 0) {
        videoStatsRatiosRef.current.push(dDropped / dTotal);
      }
    }
    if (s.sampledAtMs - videoStatsFlushAtRef.current >= 30_000) {
      const arr = videoStatsRatiosRef.current.slice().sort((a, b) => a - b);
      if (arr.length > 0) {
        const p = (q: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
        captureSafe('simli_video_stats', {
          session_id: sessionIdRef.current,
          samples: arr.length,
          p50_drop_ratio: p(0.5),
          p95_drop_ratio: p(0.95),
          p99_drop_ratio: p(0.99),
        });
      }
      videoStatsRatiosRef.current = [];
      videoStatsFlushAtRef.current = s.sampledAtMs;
    }
  }

  // R3-M3 — minute accrual POST. Idempotent on the server side.
  function handleMinuteAccrual(seconds: number): void {
    const sid = sessionIdRef.current;
    if (!sid || seconds <= 0) return;
    // Use sendBeacon if available so the call survives page-unload (the
    // primary trigger for close → onMinuteAccrual). Falls back to fetch.
    const body = JSON.stringify({ session_id: sid, seconds });
    try {
      if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
        const blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon('/api/sessions/simli-accrual', blob)) return;
      }
    } catch { /* fall through */ }
    fetch('/api/sessions/simli-accrual', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch((e) => {
      Sentry.captureException(e, { extra: { op: 'simli_accrual_post', session_id: sid } });
    });
  }

  // R3-Missing-5 — drift accumulator. Called on every audio_out arrival
  // from the proxy. Compares samples-arrived (bytes/2/16000 = seconds of
  // audio) to wall-clock elapsed; positive drift = audio piling up faster
  // than wall clock = upstream is producing faster than playback can
  // consume = imminent desync. Negative drift = playback catching up.
  function recordAudioOut(byteLen: number, atMs: number): void {
    if (driftFirstAudioMsRef.current === null) {
      driftFirstAudioMsRef.current = atMs;
    }
    driftBytesRef.current += byteLen;
    if (atMs - driftFlushAtRef.current >= 60_000) {
      const wallMs = atMs - (driftFirstAudioMsRef.current ?? atMs);
      // 16k mono s16le = 32000 bytes/sec
      const audioMs = (driftBytesRef.current / 32000) * 1000;
      const driftMs = Math.round(audioMs - wallMs);
      captureSafe('simli_clock_drift_ms', {
        session_id: sessionIdRef.current,
        drift_ms: driftMs,
        audio_ms: Math.round(audioMs),
        wall_ms: Math.round(wallMs),
      });
      // Drift > 400ms (above Cartesia's own 187.5ms chunk cadence) is
      // the alarm threshold per plan §6 R4-S.
      if (Math.abs(driftMs) > 400) {
        Sentry.captureMessage('simli_clock_drift_high', {
          level: 'warning',
          extra: { session_id: sessionIdRef.current, drift_ms: driftMs },
        });
      }
      driftFlushAtRef.current = atMs;
    }
  }

  // ── Boot: open both pipes in parallel ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    dispatch({ kind: 'boot_started' });

    // Avatar not expected? Mark satisfied.
    if (args.envelope.avatar_status !== 'minted' && args.envelope.avatar_status !== 'pending') {
      dispatch({ kind: 'avatar_not_expected' });
    }

    // 1. Simli bridge — production path: pass preMintedSessionToken. If not
    //    minted server-side, skip entirely (voice-only fallback).
    async function openAvatar(): Promise<void> {
      if (!args.envelope.avatar || args.envelope.avatar_status !== 'minted') {
        return; // voice-only
      }
      const handlers: AvatarBridgeHandlers = {
        onReady: () => {
          if (cancelled) return;
          dispatchRef({ kind: 'avatar_ready' });
          captureSafe('session_ready', { surface: 'avatar', session_id: sessionIdRef.current });
        },
        onError: (err: AvatarError) => {
          if (cancelled) return;
          Sentry.captureException(new Error(`avatar_${err.code}`), {
            extra: { session_id: sessionIdRef.current, err_code: err.code, recoverable: err.recoverable, provider: args.envelope.avatar?.provider },
          });
          // post-build M4: silent_drop_no_speak_end is recoverable — log
          // but don't fail the session (the bridge already chose not to
          // tear down). Future audit: surface a UI banner.
          if (err.recoverable && err.code === 'silent_drop_no_speak_end') return;
          dispatchRef({ kind: 'fatal_error', message: `avatar: ${err.code}` });
        },
        onLipsyncLatency: (ms) => {
          lipsyncLatencyRef.current = ms;
          captureSafe('simli_lipsync_latency_ms', { ms, session_id: sessionIdRef.current });
        },
        onVideoTrack: (t) => { lastTracksRef.current.video = t; broadcastTracks(); },
        onAudioTrack: (t) => { lastTracksRef.current.audio = t; broadcastTracks(); },
        onVideoStats: handleVideoStats,
        onMinuteAccrual: handleMinuteAccrual,
      };
      // Provider-aware factory + opts builder.
      const built = buildBridge(args.envelope, handlers, videoRef.current, audioRef.current);
      if (!built) return;
      // Audit C3 (2026-05-07). Hold the bridge LOCALLY until open()
      // resolves, then publish to the ref. Otherwise: in StrictMode dev
      // (or any rapid sub-1s back-nav in prod), Mount #1 starts the
      // LiveKit RTC connect, gets cancelled mid-await, Mount #2's bridge
      // overwrites the ref → bridge1's connect eventually completes
      // unobserved, the LiveKit room joins with no listener, and the
      // HeyGen session credit + WebRTC peer leak until tab close. By
      // gating on `cancelled` after the await, we explicitly close the
      // orphan and never expose it to the rest of the hook.
      try {
        await built.bridge.open(built.openOpts);
        if (cancelled) {
          try { await built.bridge.close(); } catch { /* */ }
          return;
        }
        bridgeRef.current = built.bridge;
      } catch (e) {
        // open() rejected; ensure no half-connected resources linger.
        try { await built.bridge.close(); } catch { /* */ }
        Sentry.captureException(e, { extra: { session_id: sessionIdRef.current, op: `${args.envelope.avatar?.provider}_open` } });
      }
    }

    // Open the Fly proxy WS — the only brain transport. Voice ticket +
    // proxy_url come from the envelope (minted at /api/sessions/open and
    // required server-side after PR-2).
    async function openProxy(): Promise<void> {
      const proxy = createProxyClient({
        onReady: () => {
          if (cancelled) return;
          // Phase C B1.2: stamp session-truly-started for duration_ms
          // accounting. First-set wins — in a rollover the second proxy
          // reaches onReady but we don't reset (would lie about session
          // length to the user-perceived clock).
          if (sessionStartedAtRef.current === null) {
            sessionStartedAtRef.current = Date.now();
          }
          dispatchRef({ kind: 'brain_ready' });
          captureSafe('session_ready', { surface: 'voice', session_id: sessionIdRef.current });
        },
        onAudioOut: (bytes) => {
          if (cancelled) return;
          recordAudioOut(bytes.byteLength, performance.now());
          // 2026-05-13 (v2) — mic-state firewall. With manual VAD the server
          // never starts speaking while micActive=true; ANY audio_out that
          // arrives during user listening is leftover Cartesia tail from the
          // previous turn (already in the WS buffer when our cancel hit the
          // proxy). Drop it: don't pipe to avatar (avoids "avatar talks over
          // user"), don't dispatch tts_audio_chunk (avoids phase ping-pong
          // ready ↔ speaking that used to leave phase stuck at speaking).
          // Critically: do NOT force-silence the mic — earlier code did, and
          // that race killed turn 2 every time the user tapped fast enough to
          // catch the tail.
          if (micActiveRef.current) return;
          // R3-M7 — first audio_out after mic_stopped is t1 of the
          // user_perceived_response_ms metric.
          if (userPerceivedT0Ref.current !== null) {
            const ms = Math.max(0, Math.round(performance.now() - userPerceivedT0Ref.current));
            userPerceivedT0Ref.current = null;
            captureSafe('user_perceived_response_ms', { ms, session_id: sessionIdRef.current });
          }
          try { bridgeRef.current?.sendAudio(bytes); } catch { /* bridge closed */ }
          // 2026-05-27 (v2) — no per-chunk tail-flush re-arm here anymore. That
          // was the stutter: it fired commitUtterance on Cartesia's mid-answer
          // synthesis gaps. The tail is now flushed ONCE at true end-of-audio
          // (onTtsAudioDone), with onTurnComplete as the backstop.
          // Phase-transition gate (R5-C3 audit). Only dispatch while we're
          // still waiting for the model's response — drop tail chunks that
          // arrive after the server fired turn_complete so phase doesn't
          // flip ready→speaking on stale audio and get stuck there.
          if (expectingTtsRef.current) {
            dispatchRef({ kind: 'tts_audio_chunk' });
          }
        },
        // HeyGen requires explicit speak_end at turn boundary; Simli/Tavus
        // bridges leave commitUtterance undefined (no-op via optional chain).
        // The minor tail of Cartesia PCM frames after this point flows
        // into the next utterance buffer — accepted slop for v1; revisit
        // if turn-boundary lipsync glitches surface in testing.
        //
        // Phase 0.5 fix (2026-05-07): dispatch turn_complete here so the
        // reducer transitions speaking→ready. Without this the proxy path
        // stays stuck at 'speaking' forever after turn 1 — every subsequent
        // startMic took the barge-in branch and fired cancel → turn_start,
        // gluing silent worklet frames + a phantom barge-in onto Gemini's
        // ongoing turn until auto-VAD couldn't recover.
        onTurnComplete: () => {
          // Manual VAD: turn_complete from the server cannot fire while the
          // user is actively listening (server waits for our activityEnd).
          // No mic state touched here — phase-only signal.
          // Close the tts-expecting window so any Cartesia tail chunks that
          // arrive after this point are treated as stale and don't re-flip
          // phase ready→speaking.
          expectingTtsRef.current = false;
          // Backstop tail-flush (2026-05-27 v2): if 'tts_audio_done' was lost
          // (ws drop, Cartesia never emitted `done`), the +6-20s-late
          // turn_complete still flushes the stranded carry. No-op on empty.
          if (!micActiveRef.current) flushTail();
          dispatchRef({ kind: 'turn_complete' });
        },
        // deep_answer_done = TEXT done (NOT audio done). No longer used for the
        // tail-flush (that caused the mid-answer stutter). Kept as a no-op so the
        // proxy message has a defined handler; the real flush is onTtsAudioDone.
        onDeepAnswerDone: () => {},
        // 2026-05-27 (v2) — TRUE end-of-audio (Cartesia's real `done`, proxy
        // context-gated to the live turn). Flush the Simli tail-carry ONCE.
        onTtsAudioDone: () => {
          if (cancelled) return;
          if (micActiveRef.current) return; // user already barged/talking — owns teardown
          flushTail();
        },
        onError: (code, detail) => {
          if (cancelled) return;
          Sentry.captureException(new Error(`proxy_${code}`), {
            extra: { session_id: sessionIdRef.current, detail },
          });
          // Map a few well-known proxy codes to better UX states.
          if (code === 'session_evicted') {
            dispatchRef({ kind: 'fatal_error', message: 'session_evicted' });
          } else {
            dispatchRef({ kind: 'fatal_error', message: `proxy: ${code}` });
          }
        },
        onWarning: (code) => { captureSafe('proxy_warning', { code, session_id: sessionIdRef.current }); },
        onTtsReconnecting: () => {
          // R3-Missing-6 — Cartesia-down state. Avatar stays visible;
          // session-client overlays a "Voice catching up…" banner.
          captureSafe('cartesia_reconnecting', { session_id: sessionIdRef.current });
          dispatchRef({ kind: 'cartesia_reconnecting' });
        },
        onTtsReconnected: () => {
          captureSafe('cartesia_reconnected', { session_id: sessionIdRef.current });
          dispatchRef({ kind: 'cartesia_reconnected' });
        },
        onClose: (code, reason, wasClean) => {
          if (cancelled) return;
          // Phase C B1.3: surface every WS close to PostHog so 4002/4006/
          // 4009/4010/4011/4012 are countable. Pre-rewire we discarded
          // `code` here and only the proxy's `{type:'error',code}` text
          // frames (mid-session) reached Sentry — pre-session and
          // server-initiated closes were silent. Refs feed B1.2's
          // session_close enrichment.
          //
          // Pairing note: a normal session emits one `ws_close` (the
          // proxy WS close) and one `session_close` (endSession() →
          // captureSafe at the end of the hook). Dashboards must join on
          // session_id to dedupe — `ws_close` count > `session_close`
          // count is not a regression.
          //
          // Reason cardinality: WS close reason is technically arbitrary,
          // but the proxy emits a bounded set (server/voice-proxy/index.js
          // header table). Defense-in-depth clamp to 64 chars in case a
          // future provider error path forwards user-derived text.
          lastCloseCodeRef.current = code;
          const safeReason = reason ? String(reason).slice(0, 64) : null;
          captureSafe('ws_close', {
            code,
            reason: safeReason,
            was_clean: wasClean,
            session_id: sessionIdRef.current,
            tier: args.envelope.tier,
          });
          dispatchRef({ kind: 'ws_closed', wasClean });
          if (code === 4002) {
            // session_already_active = R4-C1 eviction by another tab. Fatal.
            dispatchRef({ kind: 'fatal_error', message: 'session_evicted' });
          }
        },
      });
      proxyRef.current = proxy;
      try {
        await proxy.open({
          proxyUrl: args.envelope.proxy_url,
          ticket: args.envelope.voice_ticket.ticket,
          modelWire: modelRef.current,
        });
      } catch (e) {
        Sentry.captureException(e, { extra: { session_id: sessionIdRef.current, op: 'proxy_open' } });
        dispatchRef({ kind: 'fatal_error', message: 'proxy_connect_failed' });
      }
    }

    // Phase 0.5 (2026-05-07). iOS WebKit AVAudioSession sequencing.
    //
    // Order matters: complete mic + AudioContext + ctx.resume() FIRST,
    // then open avatar (LiveKit RTC). The proxy WS opens in parallel —
    // it's pure WebSocket, doesn't touch iOS's audio session.
    //
    // Why: iOS flips its AVAudioSession category from `playback` to
    // `playAndRecord` the instant our AudioContext transitions to
    // `running`. If LiveKit's RTC peer is already connected and playing
    // avatar audio when that flip happens, WebKit interrupts the peer
    // → LiveKit emits disconnect → heygen-bridge maps WS-close to
    // `session_ttl_expired` → "session ended immediately" on first
    // Hold press. By front-loading the audio-session change before any
    // RTC peer exists, HeyGen joins INTO playAndRecord and stays alive.
    //
    // Pre-warm failure (denied permission, iOS rejecting resume w/o
    // gesture, etc.) is non-fatal: avatar still opens, voice-only
    // fallback works, and startMic's lazy path retries on first hold.
    void openProxy();
    void (async () => {
      await preWarmAudio();
      if (cancelled) return;
      void openAvatar();
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally run once per mount — envelope is stable until rollover
    // which handles re-open internally via a dedicated effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (state.phase !== 'ready' && state.phase !== 'listening' && state.phase !== 'speaking') return;
    const t = window.setInterval(async () => {
      try {
        const r = await fetch('/api/sessions/heartbeat', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: sessionIdRef.current }),
        });
        if (r.status === 410) {
          dispatchRef({ kind: 'fatal_error', message: 'session_dead' });
        }
      } catch { /* transient network — next tick retries */ }
    }, HEARTBEAT_MS);
    return () => window.clearInterval(t);
  }, [state.phase]);

  // ── Visibility handling (pause/resume + iOS AudioContext recovery) ─────────
  useEffect(() => {
    function onVisibility() {
      if (document.hidden) {
        // 2026-05-13 (v3) — visibility hidden while mic active. Send turn_end
        // FIRST so the proxy accrues this turn's mic-seconds (R5-C1 audit:
        // a bare `cancel` skips the turn_end branch where voice_usage_record
        // runs — Vuk's iPhone testing would leak un-accrued mic-time on every
        // lock-screen). Follow with `cancel` so Cartesia stops synthesizing
        // a response no one will hear (still paid for Gemini tokens, but
        // saves Cartesia char cost). Order: turn_end → cancel within the
        // same event loop tick — both queue onto the WS in order.
        if (micActiveRef.current) {
          micActiveRef.current = false;
          setMicActive(false);
          expectingTtsRef.current = false;
          if (silenceTimerRef.current) {
            clearInterval(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
          try { proxyRef.current?.sendControl({ type: 'turn_end' }); } catch (e) {
            Sentry.captureException(e, { level: 'warning', extra: { op: 'sendControl_turn_end_visibility', session_id: sessionIdRef.current } });
          }
          try { proxyRef.current?.sendControl({ type: 'cancel' }); } catch (e) {
            Sentry.captureException(e, { level: 'warning', extra: { op: 'sendControl_cancel_visibility', session_id: sessionIdRef.current } });
          }
        }
        // 2026-05-27 (v2) — no pending tail-flush timer to cancel anymore (the
        // flush is edge-triggered at end-of-audio, not a 200ms grace timer).
        dispatchRef({ kind: 'visibility_hidden' });
        // Stop mic frame delivery but keep AudioContext + worklet alive to
        // avoid full re-initialization on resume.
        try { micStreamRef.current?.getTracks().forEach((t) => (t.enabled = false)); } catch {}
        fetch('/api/sessions/pause', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: sessionIdRef.current }),
        }).catch(() => {});
      } else {
        dispatchRef({ kind: 'visibility_visible' });
        // Audit C5 (2026-05-07). iOS Safari ends mic tracks after ~30-60s
        // of backgrounding — `t.enabled = true` won't revive them. Detect
        // the dead state and tear down the audio graph so the next
        // startMic rebuilds fresh against a new getUserMedia. Without
        // this, the user returns from the lock screen, presses Hold,
        // and sees the same "no mic.first_frame ever" failure that the
        // iPhone-cold-start fix addressed — just at a different entry point.
        if (micStreamRef.current && !isStreamLive(micStreamRef.current)) {
          invalidateAudioGraph();
        } else {
          try { micStreamRef.current?.getTracks().forEach((t) => (t.enabled = true)); } catch {}
        }
        fetch('/api/sessions/resume', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: sessionIdRef.current }),
        }).catch(() => {});
        // iOS WebKit: AudioContext stays suspended unless we resume() AND
        // verify state === 'running' 300ms later. visibilitychange is not
        // a user gesture — if verification fails, prompt for one (R3-M4).
        const ctx = audioCtxRef.current;
        if (ctx && ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
          window.setTimeout(() => {
            if (audioCtxRef.current && audioCtxRef.current.state !== 'running') {
              dispatchRef({ kind: 'audio_context_failed' });
            }
          }, AUDIO_CONTEXT_RESUME_VERIFY_MS);
        }
        // PC/WS health check — if either is dead, show reconnect.
        // Gemini SDK does not expose PC; we rely on 'closed' callbacks already
        // firing ws_closed. Same for avatar's RTC: SimliBridge surfaces via
        // onError → fatal_error.
      }
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // POST /api/sessions/rollover. Server is responsible for closing any
  // half-formed new row on its own failure paths (voice-ticket mint or
  // proxy_url misconfig) — round-2 audit M2 ruled out client-side retry
  // because session_rollover's "old row dead" check makes a second
  // rollover always fail with P0006. So this is one shot: success →
  // envelope, failure → dispatch rollover_failed and stop.
  async function postRollover(): Promise<OpenEnvelope | null> {
    const body = JSON.stringify({
      old_session_id: sessionIdRef.current,
      creator_id: args.creatorId,
      hook_id: args.hookId,
      model: modelRef.current,
    });
    let r: Response;
    try {
      r = await fetch('/api/sessions/rollover', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch (e) {
      Sentry.captureException(e, { extra: { op: 'rollover_fetch', session_id: sessionIdRef.current } });
      dispatchRef({ kind: 'rollover_failed', message: 'rollover_network' });
      return null;
    }
    if (!r.ok) {
      dispatchRef({ kind: 'rollover_failed', message: `rollover_${r.status}` });
      return null;
    }
    return (await r.json()) as OpenEnvelope;
  }

  // ── Rollover timer (15-min Gemini cap) ─────────────────────────────────────
  useEffect(() => {
    if (!state.openedAtMs || state.phase === 'closed' || state.phase === 'closing') return;
    const elapsed = Date.now() - state.openedAtMs;
    const remainingMs = Math.max(0, state.maxSessionSeconds * 1000 - elapsed);
    const t = window.setTimeout(() => {
      if (closedRef.current || rollingOverRef.current) return;
      rollingOverRef.current = true;
      dispatchRef({ kind: 'rollover_requested' });
      (async () => {
        try {
          // R1-M5 — pipe-warm rollover. The avatar bridge stays open
          // across the boundary; only the brain/TTS pipe is swapped.
          // ProxyClient.swapTo handles R3-C3 overlap (new WS routes mic
          // immediately, old WS drains read-only ≤2s).
          //
          // Server owns orphan-row cleanup on any failure path inside
          // /api/sessions/rollover (voice-ticket mint, proxy_url
          // unconfigured, etc.) — see route.ts. Client's job is just to
          // dispatch rollover_failed so the reducer terminates cleanly.
          const env = await postRollover();
          if (!env) return; // dispatch already happened in postRollover
          modelRef.current = env.voice.model;
          sessionIdRef.current = env.session_id;
          preMintedSimliRef.current =
            env.avatar && (env.avatar.provider === 'simli' || env.avatar.provider === 'tavus')
              ? env.avatar.session_token
              : null;
          dispatchRef({
            kind: 'rollover_complete',
            newSessionId: env.session_id,
            tier: env.tier,
            avatarStatus: env.avatar_status,
            maxSessionSeconds: env.max_session_s,
          });
          await reopenAfterRollover(env);
        } catch (e) {
          Sentry.captureException(e, { extra: { op: 'rollover', session_id: sessionIdRef.current } });
          dispatchRef({ kind: 'rollover_failed', message: 'rollover_network' });
        } finally {
          rollingOverRef.current = false;
        }
      })();
    }, remainingMs);
    return () => window.clearTimeout(t);
  }, [state.openedAtMs, state.maxSessionSeconds, state.phase, args.creatorId, args.hookId]);

  async function reopenAfterRollover(env: OpenEnvelope): Promise<void> {
    // R1-M5 — pipe-warm. Simli bridge is preserved; only re-mint if it
    // was torn down by an earlier failure path (bridgeRef.current null).
    // The Simli compose token in the new envelope is held in case we
    // need it for a future mid-session re-mint path.
    if (!bridgeRef.current && env.avatar && env.avatar_status === 'minted') {
      const handlers: AvatarBridgeHandlers = {
        onReady: () => dispatchRef({ kind: 'avatar_ready' }),
        onError: (err) => {
          Sentry.captureException(new Error(`avatar_${err.code}`), {
            extra: { session_id: sessionIdRef.current, op: 'rollover_reopen', provider: env.avatar?.provider },
          });
          if (err.recoverable && err.code === 'silent_drop_no_speak_end') return;
          dispatchRef({ kind: 'fatal_error', message: `avatar: ${err.code}` });
        },
        onLipsyncLatency: (ms) => { lipsyncLatencyRef.current = ms; },
        onVideoTrack: (t) => { lastTracksRef.current.video = t; broadcastTracks(); },
        onAudioTrack: (t) => { lastTracksRef.current.audio = t; broadcastTracks(); },
        onVideoStats: handleVideoStats,
        onMinuteAccrual: handleMinuteAccrual,
      };
      const built = buildBridge(env, handlers, videoRef.current, audioRef.current);
      if (built) {
        // Audit C3 (2026-05-07). Same hold-bridge-locally-until-open-
        // resolves pattern as the boot effect. closedRef serves as our
        // cancelled gate here (component unmount path sets it true).
        try {
          await built.bridge.open(built.openOpts);
          if (closedRef.current) {
            try { await built.bridge.close(); } catch { /* */ }
            return;
          }
          bridgeRef.current = built.bridge;
        } catch {
          try { await built.bridge.close(); } catch { /* */ }
          /* onError path already dispatched */
        }
      }
    } else if (!bridgeRef.current) {
      dispatchRef({ kind: 'avatar_not_expected' });
    } else {
      // Bridge already warm; reducer expects avatar_ready re-fire on the
      // new session_id boundary so the readiness gate doesn't deadlock.
      dispatchRef({ kind: 'avatar_ready' });
    }
    // R3-C3 overlap swap. Mic invariant: ProxyClient.swapTo flips `active`
    // to the new socket immediately so future sendAudio calls go to new
    // only; old WS is drained read-only for ≤2s.
    if (proxyRef.current) {
      try {
        await proxyRef.current.swapTo({
          proxyUrl: env.proxy_url,
          ticket: env.voice_ticket.ticket,
          modelWire: env.voice.model,
        });
      } catch (e) {
        Sentry.captureException(e, { extra: { op: 'rollover_proxy_swap', session_id: sessionIdRef.current } });
        dispatchRef({ kind: 'fatal_error', message: 'proxy_swap_failed' });
      }
    }
  }

  // ── Mic ────────────────────────────────────────────────────────────────────
  const startMic = useCallback((): void => {
    // 2026-05-12 diagnostic: Vuk's 2nd dogfood saw audio stop reaching the
    // proxy after a few turns despite the hold button visually working. Log
    // the gate decisions so we can see WHICH guard returned early when the
    // next "stuck" press happens. Cheap (one log per press), kept in prod
    // until root-cause is fixed (then drop the log).
    const micTracks = micStreamRef.current?.getTracks() ?? [];
    const trackStates = micTracks.map((t) => `${t.kind}/${t.readyState}/enabled=${t.enabled}`).join(',');
    console.log(`[startMic] phase=${state.phase} micActive=${micActiveRef.current} ctx=${audioCtxRef.current?.state || 'null'} tracks=[${trackStates}]`);
    if (state.phase !== 'ready' && state.phase !== 'speaking') {
      console.warn(`[startMic] REJECTED phase=${state.phase}`);
      return;
    }
    if (micActiveRef.current) {
      console.warn('[startMic] REJECTED micActive=true (previous press did not clean up)');
      return;
    }
    micActiveRef.current = true;
    setMicActive(true);
    // Reset the tts-expecting gate — any leftover tail audio from a prior
    // turn must not be treated as the current turn's response window.
    expectingTtsRef.current = false;
    // Silence-detection seed: count tap-moment as "voice activity" so the
    // 7s silence window starts from tap, not from -∞. A user who taps and
    // immediately goes silent still gets a 7s mic-open window. The
    // auto-stop ceiling at 120s prevents wedged streams from staying open
    // forever.
    const nowMs = performance.now();
    lastVoiceActivityRef.current = nowMs;
    micStartedAtRef.current = nowMs;
    if (silenceTimerRef.current) clearInterval(silenceTimerRef.current);
    silenceTimerRef.current = setInterval(() => {
      if (!micActiveRef.current) {
        if (silenceTimerRef.current) {
          clearInterval(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
        return;
      }
      const t = performance.now();
      const silenceMs = t - lastVoiceActivityRef.current;
      const elapsedMs = t - micStartedAtRef.current;
      if (silenceMs > 7000 || elapsedMs > 120000) {
        const reason = silenceMs > 7000 ? 'silence' : 'ceiling';
        console.log(`[mic auto-stop] reason=${reason} silence=${silenceMs.toFixed(0)}ms elapsed=${elapsedMs.toFixed(0)}ms`);
        stopMicRef.current?.();
      }
    }, 500);
    dispatchRef({ kind: 'mic_started' });
    // 2026-05-27 (v2) — a new turn (incl. barge) is starting. The prior turn's
    // tail-flush is edge-triggered (no pending timer to cancel). cancel() below
    // drops the Simli carry itself on a barge.
    // Proxy turn boundary + barge-in. A mic-tap while a prior turn is still
    // in progress is a barge-in: cancel the in-flight TTS locally (avatar
    // buffer) and tell the proxy so Cartesia stops synthesizing + the
    // orchestrator aborts its generation.
    //
    // 2026-05-27 — cover BOTH 'speaking' (answer audibly playing) AND 'ready'
    // (answer being generated / streaming to Cartesia but the client hasn't
    // flipped to 'speaking' on first audio yet). Since we now ALWAYS suppress
    // Gemini's spurious `interrupted` in decoupled mode (it was cutting answers
    // mid-word), the client `cancel` is the SOLE barge signal — so it must fire
    // across the whole in-progress window, not just once audio is playing,
    // otherwise a barge in the pre-audio gap would talk over the user until the
    // next transcript supersedes the abandoned turn. 'listening' (user already
    // holding the mic) and terminal phases have no prior turn to cancel.
    //
    // Order matters: on barge-in we cancel the OLD turn FIRST, then start
    // the NEW one. The reverse order (turn_start → cancel) made
    // cartesia.turnStart set a fresh contextId which the immediately-
    // following cancel then cleared, leaving Cartesia with
    // _currentContextId=null. The user's eventual mic-release fired
    // turn_end → cartesia.turnEnd threw 'turnEnd before turnStart' →
    // bridge state poisoned (Phase 0.5 testing 2026-05-07).
    if (state.phase === 'speaking' || state.phase === 'ready') {
      // BARGE cancel: a startMic tap while phase=speaking/ready ClearBuffers
      // Simli (wipes queued audio) so the new question starts clean.
      try { bridgeRef.current?.cancel(); } catch {}
      try { proxyRef.current?.sendControl({ type: 'cancel' }); } catch {}
    }
    try { proxyRef.current?.sendControl({ type: 'turn_start' }); } catch {}
    (async () => {
      try {
        // Pre-warm should have already done acquireMicStream + acquireAudioGraph
        // at room-mount. Both are single-flight + idempotent; calling here
        // recovers any path where pre-warm couldn't run (iOS gesture rejection,
        // permission still pending, etc.).
        const micStream = micStreamRef.current ?? (await acquireMicStream());
        await acquireAudioGraph(micStream);
        const ctx = audioCtxRef.current;
        if (!ctx) throw new Error('audio_ctx_missing_after_acquire');
        // First-press resume() runs INSIDE the click handler's user-gesture
        // window — required by iOS WebKit. Subsequent presses no-op.
        if (ctx.state === 'suspended') await ctx.resume();
        // Tracks should already be enabled (pre-warm leaves them on); cheap
        // to re-assert in case visibility-pause flipped them off.
        micStream.getTracks().forEach((t) => (t.enabled = true));
      } catch (e) {
        Sentry.captureException(e, { extra: { op: 'start_mic', session_id: sessionIdRef.current } });
        dispatchRef({ kind: 'fatal_error', message: 'mic_failed' });
      }
    })();
  }, [state.phase]);

  const stopMic = useCallback((): void => {
    // Phase 0.5 fix (2026-05-07). Original guard was
    //   `if (state.phase !== 'listening') return;`
    // which short-circuited everything when Gemini's server-VAD turn-
    // completed BEFORE the user released the mouse. Phase had already
    // transitioned listening→speaking→ready, so stopMic returned without
    // disabling the mic OR sending turn_end. Always release mic + always
    // fire turn_end (server is idempotent post-cartesia-bridge fix).
    //
    // Idempotency latch: button release fires onPointerUp + onPointerLeave
    // + onPointerCancel — all three call stopMic. Without micActiveRef,
    // the WS got duplicate turn_end messages → Cartesia state poisoned
    // → "Invalid transcript" by turn 4 → session died.
    // 2026-05-12 diagnostic — pair with startMic log.
    const micTracks2 = micStreamRef.current?.getTracks() ?? [];
    const trackStates2 = micTracks2.map((t) => `${t.kind}/${t.readyState}/enabled=${t.enabled}`).join(',');
    console.log(`[stopMic] micActive=${micActiveRef.current} ctx=${audioCtxRef.current?.state || 'null'} tracks=[${trackStates2}]`);
    if (!micActiveRef.current) {
      // Common case: pointerup/cancel firing redundantly. Stay quiet here
      // (already logged the press); only warn if we expected to be active.
      return;
    }
    micActiveRef.current = false;
    setMicActive(false);
    // Open the tts-expecting window — audio_out frames arriving from here
    // until turn_complete are the model's response to this turn and should
    // drive phase ready→speaking. Tail chunks after turn_complete won't,
    // because onTurnComplete closes this gate.
    expectingTtsRef.current = true;
    // Tear down silence-detection timer. Idempotent — guarded by the null check.
    if (silenceTimerRef.current) {
      clearInterval(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    dispatchRef({ kind: 'mic_stopped' });
    // R3-M7 — user_perceived_response_ms t0 = mic-tap-release. Cleared
    // when first proxy audio_out frame arrives.
    userPerceivedT0Ref.current = performance.now();
    try { proxyRef.current?.sendControl({ type: 'turn_end' }); } catch (e) {
      Sentry.captureException(e, { level: 'warning', extra: { op: 'sendControl_turn_end', session_id: sessionIdRef.current } });
    }
    try { micStreamRef.current?.getTracks().forEach((t) => (t.enabled = false)); } catch {}
  }, []);
  // Wire the forward-ref so startMic's silence timer can call stopMic.
  stopMicRef.current = stopMic;

  // 2026-05-13 (v2) — `forceMicSilent` removed. With manual VAD, the server
  // never ends a user turn unilaterally; the only legitimate callers were
  // races on Cartesia tail audio that actively broke turn 2 (the leftover
  // chunk would force-silence the mic the user had just turned on for the
  // next turn). Mic state mutates only in startMic / stopMic / endSession /
  // visibility-hidden — one place each, no defensive divergence.

  // ── End session ────────────────────────────────────────────────────────────
  const endSession = useCallback(async (reason: 'user_ended' | 'client_error') => {
    if (closedRef.current) return;
    closedRef.current = true;
    // R5-M1 audit: if the user hits End while still holding the mic, the
    // proxy never sees a turn_end for the final turn and voice_usage_record
    // never runs for it. Send turn_end FIRST so the in-flight turn closes
    // cleanly and mic-seconds accrue, then `cancel` to abandon the response
    // (we're tearing down anyway). Best-effort: WS may close before the
    // proxy fully processes it, but mostly it's fast enough.
    if (micActiveRef.current) {
      micActiveRef.current = false;
      setMicActive(false);
      expectingTtsRef.current = false;
      if (silenceTimerRef.current) {
        clearInterval(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      try { proxyRef.current?.sendControl({ type: 'turn_end' }); } catch (e) {
        Sentry.captureException(e, { level: 'warning', extra: { op: 'sendControl_turn_end_endSession', session_id: sessionIdRef.current } });
      }
      try { proxyRef.current?.sendControl({ type: 'cancel' }); } catch (e) {
        Sentry.captureException(e, { level: 'warning', extra: { op: 'sendControl_cancel_endSession', session_id: sessionIdRef.current } });
      }
    }
    dispatch({ kind: 'user_close' });
    try { workletNodeRef.current?.port.postMessage({ type: 'stop' }); } catch {}
    try { workletNodeRef.current?.disconnect(); } catch {}
    workletNodeRef.current = null;
    try { micStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    micStreamRef.current = null;
    try { await audioCtxRef.current?.close(); } catch {}
    audioCtxRef.current = null;
    try { proxyRef.current?.close('user_ended'); } catch {}
    proxyRef.current = null;
    // bridge.close() fires onMinuteAccrual → POST /api/sessions/simli-accrual
    // (R3-M3). sendBeacon survives the unmount that follows.
    try { bridgeRef.current?.close(); } catch {}
    bridgeRef.current = null;
    try {
      await fetch('/api/sessions/close', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sessionIdRef.current, end_reason: reason }),
      });
    } catch { /* best-effort — reaper catches orphans */ }
    captureSafe('session_close', {
      end_reason: reason,
      session_id: sessionIdRef.current,
      tier: args.envelope.tier,
      last_close_code: lastCloseCodeRef.current,
      // null when the session never reached brain_ready (proxy connect
      // failed, voice ticket fatal, etc.) — dashboard buckets these
      // separately from real session lengths.
      duration_ms: sessionStartedAtRef.current !== null ? Date.now() - sessionStartedAtRef.current : null,
    });
    dispatch({ kind: 'closed_ack' });
  }, []);

  const notifyVideoAutoplayLost = useCallback((): void => {
    dispatchRef({ kind: 'video_autoplay_lost' });
  }, []);

  // ── Retry after user gesture (for iOS AudioContext + autoplay rebind) ─────
  const retryAfterGesture = useCallback(async () => {
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === 'suspended') {
      try { await ctx.resume(); } catch {}
    }
    // R3-M2 / R4-M5 — fresh user activation (this tap) is the right
    // moment to re-bind the video element source so iOS WebKit re-evaluates
    // autoplay policy. Bridge does srcObject=null; srcObject=stream;
    // await play() inside its rebindMediaSource method.
    try { await bridgeRef.current?.rebindMediaSource(); } catch {}
    // If WS is dead, user must tap to start a new session — we don't silently
    // re-open here (avoids phantom double-sessions on flaky networks).
    // Closing the page and re-opening from the hook invokes the reducer's
    // close path cleanly.
  }, []);

  // Unmount cleanup.
  useEffect(() => {
    // React 18 dev StrictMode double-mounts every effect (setup → cleanup
    // → setup). Without this reset, the StrictMode cleanup latches
    // closedRef.current=true permanently, and every subsequent dispatch
    // (avatar_ready, brain_ready) is silently dropped by dispatchRef →
    // phase never leaves 'opening' → "Connecting…" forever. Production
    // has no double-mount; this is a no-op there.
    closedRef.current = false;
    return () => {
      if (!closedRef.current) {
        closedRef.current = true;
        try { workletNodeRef.current?.port.postMessage({ type: 'stop' }); } catch {}
        try { workletNodeRef.current?.disconnect(); } catch {}
        try { micStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
        try { audioCtxRef.current?.close(); } catch {}
        try { proxyRef.current?.close('unmount'); } catch {}
        try { bridgeRef.current?.close(); } catch {}
        // Audit C2 (2026-05-07). Null the refs AFTER closing. Without this,
        // StrictMode's simulated re-mount sees stale-but-truthy refs and
        // acquireAudioGraph's early-return treats the dead graph as alive,
        // leaving the user with a closed AudioContext and no worklet.
        // Pure dev-mode hygiene — production never re-mounts the same
        // hook instance, so these nulls are no-ops there. Also helps if
        // any future code reads a ref post-cleanup (e.g., logging).
        workletNodeRef.current = null;
        micStreamRef.current = null;
        micStreamPromiseRef.current = null;
        audioCtxRef.current = null;
        proxyRef.current = null;
        bridgeRef.current = null;
        // Best-effort close so we don't orphan the row. beacon-style because
        // the effect cleanup may run during pagehide.
        if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
          try {
            const blob = new Blob(
              [JSON.stringify({ session_id: sessionIdRef.current, end_reason: 'user_ended' })],
              { type: 'application/json' },
            );
            navigator.sendBeacon('/api/sessions/close', blob);
          } catch {}
        }
      }
    };
  }, []);

  // Day 3 — accessor surface for the recording controller. Closures over
  // refs, NOT the values, so a parent re-render carries the freshest pointers.
  const getAudioContext = useCallback((): AudioContext | null => audioCtxRef.current, []);
  const getMicStream = useCallback((): MediaStream | null => micStreamRef.current, []);
  const getBridge = useCallback((): AvatarBridge | null => bridgeRef.current, []);
  const subscribeBridgeTrackUpdates = useCallback(
    (
      cb: (t: { video: MediaStreamTrack | null; audio: MediaStreamTrack | null }) => void,
      opts?: { replayInitial?: boolean },
    ) => {
      trackSubscribersRef.current.add(cb);
      // Replay default ON for backwards compat. Audit C2/C3 Day 3: callers
      // who consumed the initial tracks via getBridge().getCurrentTracks()
      // MUST opt out, otherwise the sync replay re-fires the same track
      // identities and forces a remove/add on a freshly-built stream.
      const shouldReplay = opts?.replayInitial !== false;
      if (shouldReplay && (lastTracksRef.current.video || lastTracksRef.current.audio)) {
        try { cb({ ...lastTracksRef.current }); } catch (e) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn('[use-session-pipe] track subscriber threw on replay:', e);
          }
        }
      }
      return () => { trackSubscribersRef.current.delete(cb); };
    },
    [],
  );

  return {
    state,
    videoRef,
    audioRef,
    micActive,
    startMic,
    stopMic,
    endSession,
    retryAfterGesture,
    notifyVideoAutoplayLost,
    lipsyncLatencyMs: lipsyncLatencyRef.current,
    getAudioContext,
    getMicStream,
    getBridge,
    subscribeBridgeTrackUpdates,
  };
}
