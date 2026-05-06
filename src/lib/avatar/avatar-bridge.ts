// AvatarBridge — the single interface Simli and Tavus drivers implement.
// Consumers (Spike B harness, Day-5 production session router) import ONLY
// from this file; no provider SDK types leak past the bridge boundary.
//
// Error taxonomy is ours, not theirs. Bridges MAP provider error shapes onto
// one of the const-union codes below at the bridge edge. Unknown provider
// codes MUST surface as 'other' with the raw shape preserved on cause.raw
// so spike_b_runs.metadata.outcome_raw can recover the original for taxonomy
// gap analysis (see migration 20260422000001, outcome CHECK comment).
//
// SPIKE_B_PLAN.md Rev 5 §Architecture. CLAUDE.md §Provider-Agnostic.
//
// ── Recording stack lifecycle conventions (audit M1, M3, M4 integration) ──
// The React/duet capture stack composes 4 modules: this bridge, audio-mixer,
// composite-canvas, ReactButton + a future recording-controller. Verbs:
//   • close()  = terminal teardown (this bridge, audio-mixer)
//   • stop()   = pausable RAF loop only (composite-canvas)
//   • cancel() = barge-in / clear-buffer; pipe stays warm (this bridge)
//   • dispatch onTap → controller decides ARM vs STOP (ReactButton)
//
// STOP order the controller SHOULD follow (audit C2 integration):
//   1. mediaRecorder.stop()       — finalize the blob first
//   2. compositor.stop()          — stop drawing into a captureStream'd canvas
//   3. mixer.disconnectAvatar()   — preferred BEFORE bridge.close().
//                                    disconnectAvatar() actively inspects
//                                    track.readyState and skips the disconnect
//                                    on a dead track (Safari WebKit bug 217983).
//                                    mixer.close() also wraps every disconnect
//                                    in try/catch for catch-all safety, so an
//                                    inverse order does not crash but loses
//                                    the structured guard.
//   4. bridge.close()             — ends the avatar tracks
//   5. mixer.close()              — releases gain branches (try/catch wrapped)
//   6. permission lib: releaseStream(stream) on caller's getUserMedia stream
//                                    (calls track.stop() on each track)
//   7. audioContext.close()       — caller-owned; lazy-create per ARM, not
//                                    per surface mount (Chrome caps at ~6
//                                    AudioContexts, feed scroll would break).
//
// Track ownership: bridge owns avatar audio/video tracks (LiveKit-derived);
// recording controller owns getUserMedia mic+camera tracks. Mixer & video
// elements are leaf consumers — they never call track.stop().
//
// Permission revoke watcher (audit M4): attachRevokeWatcher binds tracks
// at first-attach. On audio-only fallback retry (camera denied + mic
// granted → second getUserMedia({audio:true})), controller MUST re-attach
// the watcher to the new stream — the original watcher does not see new
// tracks added after binding.

export const AVATAR_ERROR_CODES = [
  'connect_timeout',
  'token_expired',
  'replica_not_ready',
  'rtc_ice_failed',
  'audio_format_rejected',
  'quota_exceeded',
  'replica_not_found',
  'app_message_too_large',
  'session_idle_killed',
  'session_ttl_expired',
  // 'session_killed' is fallback-path-only — production uses preMintedSessionToken
  // and mint 429s surface at /api/sessions/open, not here. Do NOT wire this code
  // into the production error map. (R4-S2, R3-S1)
  'session_killed',
  'other',
] as const;

export type AvatarErrorCode = (typeof AVATAR_ERROR_CODES)[number];

export type AvatarProvider = 'simli' | 'tavus';

export type AvatarOpenOptions = {
  // Opaque replica identifier. Both providers use opaque strings, not uuids.
  replicaId: string;
  // Simli-only: chunk size in bytes for the harness dual-size measurement
  // (6000B @187ms vs 1920B @60ms). TavusBridge ignores.
  simliChunkBytes?: 6000 | 1920;
  // AbortSignal — if aborted during open(), bridge must cancel in-flight
  // HTTP calls and reject with { code: 'connect_timeout' } or propagate the
  // AbortError cause. open() is the only async boundary that takes a signal;
  // sendAudio/cancel/close are synchronous or fire-and-forget.
  signal?: AbortSignal;
  // DOM media elements for bridges that populate them directly (Simli via
  // LiveKit). If provided they MUST already be in the DOM — the bridge will
  // not call appendChild. If omitted, SimliBridge creates elements and appends
  // them to body so loadedmetadata fires; caller is responsible for display.
  videoEl?: HTMLVideoElement;
  audioEl?: HTMLAudioElement;
  // Pre-minted Simli compose token from /api/sessions/open envelope. When
  // present, SimliBridge SKIPS the /api/spike-b/session fetch (R3-C2/P0-5).
  // Ignored by TavusBridge.
  preMintedSessionToken?: string;
};

export type AvatarError = {
  code: AvatarErrorCode;
  // Human-readable, safe to display in admin UI. NEVER contains tokens or URLs.
  message: string;
  // Whether the failure is recoverable by the caller (e.g. re-open). Currently
  // advisory — Spike B harness does not auto-retry; Day-5 production router may.
  recoverable: boolean;
  // Original provider error surface, preserved for 'other'-taxonomy analysis.
  // Bridges MUST set raw.provider and raw.shape when mapping to 'other'.
  // Never write raw.* directly to Sentry — Sentry scrub does not cover it.
  cause?: { provider: AvatarProvider; raw: unknown };
};

// Event callbacks. Bridges invoke onReady exactly once (after handshake),
// onError zero or one time (terminal), and onFirstAudioSent once when the
// first sendAudio() call is dispatched to the provider (t1 capture point).
// After onError the bridge is dead — callers must create a new instance.
//
// Track callbacks (onVideoTrack / onAudioTrack) fire on the INITIAL track
// AND again on every LiveKit renegotiation (ICE restart, WiFi↔LTE handoff,
// simulcast layer change). Consumers MUST handle re-fire — e.g. recording
// controller swaps the source ref in its compositor and re-mixes the audio
// graph. The previous track instance becomes obsolete; subscribe to its
// 'ended' event to detect the swap from the consumer side too.
//
// IMPORTANT: video and audio re-fires are NOT atomic. A joint renegotiation
// surfaces as two sequential calls (onVideoTrack, then onAudioTrack) within
// the same microtask group. A naive "rebuild MediaRecorder on track change"
// will rebuild twice. Coalesce on the consumer side (e.g. defer rebuild via
// queueMicrotask).
// (Plan §25.5 — R4 §6 LiveKit renegotiation handler.)
export type AvatarBridgeHandlers = {
  onReady?: () => void;
  onVideoTrack?: (track: MediaStreamTrack) => void;
  // Audio track from the provider's LiveKit/WebRTC pipe. Fires on initial
  // track and on every renegotiation. Harness uses it to mix video+audio
  // into a single MediaRecorder stream for rater clips.
  onAudioTrack?: (track: MediaStreamTrack) => void;
  onError?: (err: AvatarError) => void;
  // Fires exactly once: the first time sendAudio() actually dispatches a chunk.
  // Used by the spike harness to capture t1 (t0→t1 = buffering, t1→t2 = handshake).
  onFirstAudioSent?: () => void;
  // Fires once: ms elapsed from first sendAudio() dispatch (t1) to first
  // provider video frame arriving (via loadedmetadata / srcObject populated).
  // Production session client logs this to PostHog as `simli_lipsync_latency_ms`.
  onLipsyncLatency?: (ms: number) => void;
  // R3-Missing-4 — video frame health. Polled at 5s cadence via
  // HTMLVideoElement.getVideoPlaybackQuality(). droppedVideoFrames /
  // totalVideoFrames are monotonic so the consumer should diff vs the
  // prior sample to compute interval-rate. Consumer flushes p50/p95
  // ratio as PostHog event simli_video_stats every 30s.
  onVideoStats?: (stats: { droppedFrames: number; totalFrames: number; sampledAtMs: number }) => void;
  // R3-M3 — minute-level reconciliation. Fired exactly once on close()
  // with the wall-clock seconds the bridge was open. Consumer POSTs to
  // /api/sessions/simli-accrual which writes the cogs_log row with
  // operation simli.video_minutes_bridge_close (R4-M3 — distinct from
  // the reaper-derived row so the aggregator can MAX(bridge_close,
  // reaper) per session and never sum).
  onMinuteAccrual?: (seconds: number) => void;
};

export interface AvatarBridge {
  readonly provider: AvatarProvider;

  // Opens transport. Resolves when the provider has accepted the session and
  // is ready to receive audio. Rejects with AvatarError on any failure path.
  // After resolve, onReady handler fires; after onVideoTrack fires, the caller
  // may attach the track to a <video>.
  open(opts: AvatarOpenOptions): Promise<void>;

  // Push one chunk of PCM16 LE mono @ 16kHz. Bridges are responsible for any
  // provider-specific reframing (Tavus path is currently WS-less echo; Simli
  // path sends via the Simli JS SDK). MUST NOT block the caller — if the
  // provider is not ready, drop the chunk and surface via onError if chronic.
  sendAudio(pcm16le16k: ArrayBuffer): void;

  // Barge-in: signal the provider to stop any in-flight TTS playback. Simli
  // sends SKIP on the control WS; Tavus uses conversation.interrupt via daily.
  // Pipe stays warm — do NOT close the connection here.
  cancel(): void;

  // Tear down. Idempotent. Safe to call multiple times. Closes the RTC peer
  // connection and any associated control channels.
  close(): void;

  // Returns the currently-active video + audio tracks if the session is past
  // first-track arrival, else null. Allows late subscribers (e.g. recording
  // controller spawned mid-session: user enters Ask → starts conversing →
  // THEN taps React) to pick up tracks without waiting on an event re-fire.
  // Returned MediaStreamTrack instances are the same as those most recently
  // dispatched via onVideoTrack/onAudioTrack. After a renegotiation the cache
  // updates to the new track; the prior instance is dead (track.readyState='ended').
  //
  // IMPORTANT — cross-provider semantics differ on track liveness (audit
  // M2 integration). Simli holds the previous LIVE track until a new live
  // track replaces it (refreshVideoTrack filters readyState==='live').
  // Tavus's daily-js cache survives across renegotiation but does NOT
  // invalidate on `track-stopped`, so a brief mid-reneg gap can return a
  // track in 'ended' state. Consumers MUST check `track.readyState ===
  // 'live'` before piping into AudioMixer / MediaRecorder, regardless of
  // tier. The recording-controller is the canonical place for that check.
  getCurrentTracks(): { video: MediaStreamTrack | null; audio: MediaStreamTrack | null };

  // R2-C4 / R3-M2 — full re-bind of video element source. Used by the
  // reconnect overlay's tap handler on iOS where simply calling
  // videoEl.play() on an existing srcObject won't re-trigger autoplay
  // policy evaluation. Bridge does:
  //   videoEl.srcObject = null; videoEl.srcObject = currentStream;
  //   await videoEl.play();
  // Caller MUST invoke this from within a fresh user-activation gesture
  // (overlay tap). No-op if the bridge is closed or has no live track.
  rebindMediaSource(): Promise<void>;

  // Runtime audible-output toggle. When false, bridge ensures the provider's
  // <audio> element is silenced so the consumer's AudioContext destination
  // is the only audible path (avoids double-route echo during recording).
  // Idempotent. Default true. Implemented via audioEl.volume rather than
  // audioEl.muted: WebKit drops the underlying track on muted=true mid-WebRTC
  // (verified in spike #3); volume=0 is the safe alternative.
  setLocalPlayback(audible: boolean): void;
}

// Factory type for each provider. Phase 1 harness instantiates these directly;
// Day-5 production router calls resolveAvatarProvider(tier) → pick factory.
export type AvatarBridgeFactory = (handlers: AvatarBridgeHandlers) => AvatarBridge;
