// use-session-pipe — wires the pure reducer to Simli + Gemini + mic capture.
//
// Flow at the hook level:
//   1. Caller already POSTed /api/sessions/open; hands us the envelope.
//   2. Hook opens SimliBridge (pre-minted token path — R3-C2/P0-5) in parallel
//      with Gemini GoogleGenAI.live.connect.
//   3. Both pipes hit 'ready' → reducer flips to 'ready'; UI enables mic.
//   4. press-and-hold mic → activityStart + stream worklet frames → activityEnd.
//   5. Gemini onmessage audio part → base64 → PCM16 bytes → simliBridge.sendAudio.
//   6. Gemini interrupted → simliBridge.cancel() (pipe stays warm — R2-M4).
//   7. Heartbeat every 20s → /api/sessions/heartbeat; 410 → fatal_error.
//   8. visibilitychange → reducer; effect POSTs pause/resume.
//   9. Ticker: at maxSessionSeconds → POST /api/sessions/rollover; replace tokens.
//
// Tokens never enter React state. They live on a ref. PostHog captures go
// through captureSafe (R3-S2).

'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';
import * as Sentry from '@sentry/nextjs';
import { createSimliBridge } from '@/lib/avatar/simli-bridge';
import { createHeygenBridge } from '@/lib/avatar/heygen-bridge';
import type { AvatarBridge, AvatarBridgeHandlers, AvatarOpenOptions, AvatarError } from '@/lib/avatar/avatar-bridge';
import { captureSafe } from '@/lib/posthog-safe-capture';
import { createProxyClient, type ProxyClient } from '@/lib/voice/proxy-client';

// SIMLI_WIREUP §7 / R2-C3 — flag-gated cutover. When 1, mic+brain+TTS go
// through the Fly proxy WS (Pipeline α' end-to-end). When unset/0, the
// legacy direct-Gemini path runs (broken-by-design — feeds Gemini stock
// voice into Simli at wrong sample rate — but stable for rollback).
const USE_PROXY_PATH =
  typeof process !== 'undefined' && process.env.NEXT_PUBLIC_VOICE_PROXY_PATH === '1';
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

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export type PipeHandle = {
  state: SessionState;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
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
  const geminiRef = useRef<Session | null>(null);
  // SIMLI_WIREUP — proxy WS client (cutover path). Owns mic-frame upload +
  // audio_out routing into the bridge. Null on flag-off path.
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
  // Phase 0.5 (2026-05-07). In-flight getUserMedia promise — used by
  // BOTH the room-mount pre-warm and the lazy startMic path so a fast
  // first-press can't fire a second concurrent permission prompt.
  // Whichever caller hits first creates the promise; the other awaits it.
  const micStreamPromiseRef = useRef<Promise<MediaStream> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const ephemeralTokenRef = useRef<string>(args.envelope.gemini.token);
  const modelRef = useRef<string>(args.envelope.gemini.model);
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
      const pcm = ev.data?.pcm as ArrayBuffer | undefined;
      if (!pcm) return;
      // Drop frames whenever the mic isn't logically engaged (between
      // turns the mic is captured but should not feed Gemini).
      if (!micActiveRef.current) return;
      if (USE_PROXY_PATH) {
        try { proxyRef.current?.sendAudio(pcm); }
        catch { /* WS closed mid-frame — heartbeat / close will reconcile */ }
        return;
      }
      if (!geminiRef.current) return;
      try {
        geminiRef.current.sendRealtimeInput({
          audio: {
            data: bytesToBase64(new Uint8Array(pcm)),
            mimeType: 'audio/pcm;rate=16000',
          },
        });
      } catch { /* WS closed mid-frame — next visibility tick will reconcile */ }
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

    // 2. Gemini Live WS — @google/genai live.connect.
    async function openGemini(): Promise<void> {
      try {
        const client = new GoogleGenAI({
          apiKey: ephemeralTokenRef.current,
          httpOptions: { apiVersion: 'v1alpha' },
        });
        const session = await client.live.connect({
          model: modelRef.current,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction:
              args.systemInstruction ??
              'You are a helpful mentor. Answer in concise spoken English.',
            // Server-VAD (automatic) — user taps and holds mic, but Gemini
            // decides when they stopped. Simpler than manual VAD in-browser.
            realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
          },
          callbacks: {
            onopen: () => { /* WS open — wait for setupComplete */ },
            onmessage: (m: LiveServerMessage) => {
              if (cancelled) return;
              if (m.setupComplete) {
                dispatchRef({ kind: 'gemini_setup_complete' });
                captureSafe('session_ready', { surface: 'gemini', session_id: sessionIdRef.current });
                return;
              }
              // Interruption: Gemini cancels its in-flight response. We keep
              // the pipe warm: simli.cancel() clears its playback buffer.
              if (m.serverContent?.interrupted) {
                dispatchRef({ kind: 'gemini_interrupted' });
                try { bridgeRef.current?.cancel(); } catch { /* bridge already closed */ }
                captureSafe('barge_in', { session_id: sessionIdRef.current });
              }
              const parts = m.serverContent?.modelTurn?.parts ?? [];
              let gotAudio = false;
              for (const p of parts) {
                if (p.inlineData?.mimeType?.startsWith('audio/pcm') && p.inlineData.data) {
                  gotAudio = true;
                  const bytes = base64ToBytes(p.inlineData.data);
                  try { bridgeRef.current?.sendAudio(bytes.buffer as ArrayBuffer); } catch { /* bridge closed */ }
                }
              }
              if (gotAudio) dispatchRef({ kind: 'gemini_audio_chunk' });
              if (m.serverContent?.turnComplete) {
                // Post-build C2 — HeyGen requires explicit speak_end at
                // turn boundary. Simli/Tavus leave commitUtterance undefined.
                try { bridgeRef.current?.commitUtterance?.(); } catch { /* */ }
                dispatchRef({ kind: 'gemini_turn_complete' });
              }
            },
            onerror: (ev: ErrorEvent) => {
              if (cancelled) return;
              Sentry.captureException(new Error(ev?.message ?? 'gemini_ws_error'), {
                extra: { session_id: sessionIdRef.current },
              });
              dispatchRef({ kind: 'ws_closed', wasClean: false });
            },
            onclose: (ev: CloseEvent) => {
              if (cancelled) return;
              dispatchRef({ kind: 'ws_closed', wasClean: ev.wasClean });
            },
          },
        });
        geminiRef.current = session;
      } catch (e) {
        Sentry.captureException(e, { extra: { session_id: sessionIdRef.current, op: 'gemini_open' } });
        dispatchRef({ kind: 'fatal_error', message: 'gemini_connect_failed' });
      }
    }

    // SIMLI_WIREUP §B4 — flag-gated: cutover opens proxy WS instead of
    // direct-Gemini. Voice ticket + proxy_url come from the envelope
    // (mint at /api/sessions/open).
    async function openProxy(): Promise<void> {
      if (!args.envelope.voice_ticket || !args.envelope.proxy_url) {
        // Cutover requires both. If missing, surface a fatal — flag-on
        // path can't degrade silently to broken-direct-Gemini.
        dispatchRef({ kind: 'fatal_error', message: 'voice_ticket_missing' });
        return;
      }
      const proxy = createProxyClient({
        onReady: () => {
          if (cancelled) return;
          // Proxy ready ≈ Gemini setup-complete in the legacy path; flips
          // the same reducer state.
          dispatchRef({ kind: 'gemini_setup_complete' });
          captureSafe('session_ready', { surface: 'proxy', session_id: sessionIdRef.current });
        },
        onAudioOut: (bytes) => {
          if (cancelled) return;
          recordAudioOut(bytes.byteLength, performance.now());
          // R3-M7 — first audio_out after mic_stopped is t1 of the
          // user_perceived_response_ms metric.
          if (userPerceivedT0Ref.current !== null) {
            const ms = Math.max(0, Math.round(performance.now() - userPerceivedT0Ref.current));
            userPerceivedT0Ref.current = null;
            captureSafe('user_perceived_response_ms', { ms, session_id: sessionIdRef.current });
          }
          try { bridgeRef.current?.sendAudio(bytes); } catch { /* bridge closed */ }
          dispatchRef({ kind: 'gemini_audio_chunk' });
        },
        // Post-build C2 — Gemini turnComplete signals the boundary that
        // HeyGen requires for `agent.speak_end`. Simli/Tavus bridges leave
        // commitUtterance undefined (no-op via optional chaining).
        // The minor tail of Cartesia PCM frames after this point flows
        // into the next utterance buffer — accepted slop for v1; revisit
        // if Phase 0.5 testing shows turn-boundary lipsync glitches.
        //
        // Phase 0.5 fix (2026-05-07): MUST dispatch gemini_turn_complete
        // here so the reducer transitions speaking→ready. Without this
        // the proxy path stays stuck at 'speaking' forever after turn 1
        // — every subsequent startMic took the barge-in branch and fired
        // cancel → turn_start, gluing silent worklet frames + a phantom
        // barge-in onto Gemini's ongoing turn until auto-VAD couldn't
        // recover. Symptom: "avatar can't hear a single word from turn 2."
        // Direct-Gemini path already dispatches this; only proxy path was
        // missing it.
        onTurnComplete: () => {
          try { bridgeRef.current?.commitUtterance?.(); } catch { /* */ }
          dispatchRef({ kind: 'gemini_turn_complete' });
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
        onClose: (code, _reason, wasClean) => {
          if (cancelled) return;
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
    if (USE_PROXY_PATH) {
      void openProxy();
    } else {
      void openGemini();
    }
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
          // R1-M5 — pipe-warm rollover. The Simli bridge stays open
          // across the boundary; only the brain/TTS pipe is swapped.
          // R3-C3 overlap is handled by ProxyClient.swapTo (cutover path)
          // OR by sequential close+reopen on the legacy direct-Gemini path.
          if (!USE_PROXY_PATH) {
            try { geminiRef.current?.close(); } catch {}
            geminiRef.current = null;
          }
          // Bridge is preserved (do NOT close) — that's the whole point
          // of pipe-warm. If a future Simli compose-token expiry forces a
          // mid-session re-mint, that's handled separately (out of scope
          // for this rollover path).
          const r = await fetch('/api/sessions/rollover', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              old_session_id: sessionIdRef.current,
              creator_id: args.creatorId,
              hook_id: args.hookId,
              model: modelRef.current,
            }),
          });
          if (!r.ok) {
            dispatchRef({ kind: 'rollover_failed', message: `rollover_${r.status}` });
            return;
          }
          const env = (await r.json()) as OpenEnvelope;
          // Swap in new tokens + session id on the refs.
          ephemeralTokenRef.current = env.gemini.token;
          modelRef.current = env.gemini.model;
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
          // Re-open both pipes with the new tokens. Inline here so the
          // rollingOverRef gate applies.
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
    // SIMLI_WIREUP §4 / R3-C3 — overlap swap on the proxy path. Mic
    // invariant: ProxyClient.swapTo flips `active` to the new socket
    // immediately so future sendAudio calls go to new only; old WS is
    // drained read-only for ≤2s.
    if (USE_PROXY_PATH) {
      if (!env.voice_ticket || !env.proxy_url) {
        dispatchRef({ kind: 'fatal_error', message: 'rollover_voice_ticket_missing' });
        return;
      }
      if (proxyRef.current) {
        try {
          await proxyRef.current.swapTo({
            proxyUrl: env.proxy_url,
            ticket: env.voice_ticket.ticket,
            modelWire: env.gemini.model,
          });
        } catch (e) {
          Sentry.captureException(e, { extra: { op: 'rollover_proxy_swap', session_id: sessionIdRef.current } });
          dispatchRef({ kind: 'fatal_error', message: 'proxy_swap_failed' });
        }
      }
      return;
    }
    // Gemini re-open (legacy path only)
    try {
      const client = new GoogleGenAI({
        apiKey: env.gemini.token,
        httpOptions: { apiVersion: 'v1alpha' },
      });
      const session = await client.live.connect({
        model: env.gemini.model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction:
            args.systemInstruction ??
            'You are a helpful mentor. Answer in concise spoken English.',
          realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
        },
        callbacks: {
          onopen: () => { /* wait for setupComplete */ },
          onmessage: (m: LiveServerMessage) => {
            if (m.setupComplete) { dispatchRef({ kind: 'gemini_setup_complete' }); return; }
            if (m.serverContent?.interrupted) {
              dispatchRef({ kind: 'gemini_interrupted' });
              try { bridgeRef.current?.cancel(); } catch {}
            }
            const parts = m.serverContent?.modelTurn?.parts ?? [];
            let got = false;
            for (const p of parts) {
              if (p.inlineData?.mimeType?.startsWith('audio/pcm') && p.inlineData.data) {
                got = true;
                const bytes = base64ToBytes(p.inlineData.data);
                try { bridgeRef.current?.sendAudio(bytes.buffer as ArrayBuffer); } catch {}
              }
            }
            if (got) dispatchRef({ kind: 'gemini_audio_chunk' });
            if (m.serverContent?.turnComplete) {
              try { bridgeRef.current?.commitUtterance?.(); } catch { /* */ }
              dispatchRef({ kind: 'gemini_turn_complete' });
            }
          },
          onerror: () => dispatchRef({ kind: 'ws_closed', wasClean: false }),
          onclose: (ev: CloseEvent) => dispatchRef({ kind: 'ws_closed', wasClean: ev.wasClean }),
        },
      });
      geminiRef.current = session;
    } catch (e) {
      Sentry.captureException(e, { extra: { session_id: sessionIdRef.current, op: 'rollover_reopen_gemini' } });
      dispatchRef({ kind: 'fatal_error', message: 'gemini_reopen_failed' });
    }
  }

  // ── Mic ────────────────────────────────────────────────────────────────────
  const startMic = useCallback((): void => {
    if (state.phase !== 'ready' && state.phase !== 'speaking') return;
    if (micActiveRef.current) return; // Already started this press cycle.
    micActiveRef.current = true;
    dispatchRef({ kind: 'mic_started' });
    // SIMLI_WIREUP §B4 — proxy turn boundary + barge-in. mic-tap during
    // 'speaking' is a barge-in: cancel the in-flight TTS playback locally
    // (Simli buffer) and tell proxy so Cartesia stops synthesizing.
    if (USE_PROXY_PATH) {
      // Order matters: on barge-in (mic tap during 'speaking') we must
      // cancel the OLD turn FIRST, then start the NEW one. The original
      // order (turn_start → cancel) made cartesia.turnStart set a fresh
      // contextId which the immediately-following cancel then cleared,
      // leaving Cartesia with _currentContextId=null. The user's eventual
      // mic-release fired turn_end → cartesia.turnEnd threw 'turnEnd
      // before turnStart' → bridge state poisoned → stopped responding
      // after 2-3 turns (Phase 0.5 testing 2026-05-07).
      if (state.phase === 'speaking') {
        try { bridgeRef.current?.cancel(); } catch {}
        try { proxyRef.current?.sendControl({ type: 'cancel' }); } catch {}
      }
      try { proxyRef.current?.sendControl({ type: 'turn_start' }); } catch {}
    }
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
    if (!micActiveRef.current) return;
    micActiveRef.current = false;
    dispatchRef({ kind: 'mic_stopped' });
    // R3-M7 — user_perceived_response_ms t0 = mic-tap-release. Cleared
    // when first proxy audio_out frame arrives.
    userPerceivedT0Ref.current = performance.now();
    if (USE_PROXY_PATH) {
      try { proxyRef.current?.sendControl({ type: 'turn_end' }); } catch {}
    }
    try { micStreamRef.current?.getTracks().forEach((t) => (t.enabled = false)); } catch {}
  }, []);

  // ── End session ────────────────────────────────────────────────────────────
  const endSession = useCallback(async (reason: 'user_ended' | 'client_error') => {
    if (closedRef.current) return;
    closedRef.current = true;
    dispatch({ kind: 'user_close' });
    try { workletNodeRef.current?.port.postMessage({ type: 'stop' }); } catch {}
    try { workletNodeRef.current?.disconnect(); } catch {}
    workletNodeRef.current = null;
    try { micStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    micStreamRef.current = null;
    try { await audioCtxRef.current?.close(); } catch {}
    audioCtxRef.current = null;
    try { geminiRef.current?.close(); } catch {}
    geminiRef.current = null;
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
    captureSafe('session_close', { end_reason: reason, session_id: sessionIdRef.current });
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
    // (avatar_ready, gemini_setup_complete) is silently dropped by
    // dispatchRef → phase never leaves 'opening' → "Connecting…" forever.
    // Production has no double-mount; this is a no-op there.
    closedRef.current = false;
    return () => {
      if (!closedRef.current) {
        closedRef.current = true;
        try { workletNodeRef.current?.port.postMessage({ type: 'stop' }); } catch {}
        try { workletNodeRef.current?.disconnect(); } catch {}
        try { micStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
        try { audioCtxRef.current?.close(); } catch {}
        try { geminiRef.current?.close(); } catch {}
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
        geminiRef.current = null;
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
