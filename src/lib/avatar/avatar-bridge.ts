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
// onVideoTrack zero or one time (some failures happen before a track exists),
// onError zero or one time (terminal), and onFirstAudioSent once when the
// first sendAudio() call is dispatched to the provider (t1 capture point).
// After onError the bridge is dead — callers must create a new instance.
export type AvatarBridgeHandlers = {
  onReady?: () => void;
  onVideoTrack?: (track: MediaStreamTrack) => void;
  onError?: (err: AvatarError) => void;
  // Fires exactly once: the first time sendAudio() actually dispatches a chunk.
  // Used by the spike harness to capture t1 (t0→t1 = buffering, t1→t2 = handshake).
  onFirstAudioSent?: () => void;
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
}

// Factory type for each provider. Phase 1 harness instantiates these directly;
// Day-5 production router calls resolveAvatarProvider(tier) → pick factory.
export type AvatarBridgeFactory = (handlers: AvatarBridgeHandlers) => AvatarBridge;
