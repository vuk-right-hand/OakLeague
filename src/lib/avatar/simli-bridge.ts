// SimliBridge — free-tier primary. Implements AvatarBridge.
//
// Transport: simli-client v3 SDK + a server-minted compose token.
// Token mint happens in `/api/spike-b/session` (admin-gated + same-origin);
// bridge never sees SIMLI_API_KEY. See SPIKE_B_PLAN.md §Security review.
//
// SDK v3 API (breaking change from v2):
//   - No Initialize() method. Constructor takes all config.
//   - Two transports: "livekit" (no ICE servers needed) and "p2p" (ICE required).
//   - We use "livekit" transport to avoid exposing ICE server fetch to the client.
//   - Session token minted via POST /compose/token (not /startAudioToVideoSession).
//   - Auth via x-simli-api-key header (not body apiKey).
//   - Events: 'start' (connected), 'stop', 'error', 'startup_error'.
//   - close() renamed to stop() and is now async (we call fire-and-forget).
//
// Audio contract: caller sends PCM16 LE mono @ 16kHz. Bridge passes through
// unchanged. Phase 2 tests two chunk sizes (6000B=187ms, 1920B=60ms).
//
// Error taxonomy map (provider surface → our codes):
//   Token mint 401/403          → 'token_expired'
//   Token mint 404 (replica)    → 'replica_not_found'
//   Token mint 409 (not ready)  → 'replica_not_ready'
//   Token mint other 4xx/5xx    → 'connect_timeout'
//   SDK 'error' / 'startup_error' event → 'rtc_ice_failed' / 'connect_timeout'
//   Anything else               → 'other' (raw preserved on cause.raw)

'use client';

import type {
  AvatarBridge,
  AvatarBridgeHandlers,
  AvatarError,
  AvatarOpenOptions,
  AvatarProvider,
} from './avatar-bridge';

// Minimal surface of simli-client v3 we rely on.
type SimliClientLike = {
  on(event: string, cb: (...args: unknown[]) => void): void;
  off(event: string, cb: (...args: unknown[]) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendAudioData(chunk: Uint8Array): void;
  ClearBuffer(): void;
};

type SimliModule = {
  SimliClient: new (
    session_token: string,
    videoElement: HTMLVideoElement,
    audioElement: HTMLAudioElement,
    iceServers: RTCIceServer[] | null,
    logLevel?: number,
    transport_mode?: string,
  ) => SimliClientLike;
};

// Server response from /api/spike-b/session when provider='simli'.
export type SimliSessionBoot = {
  provider: 'simli';
  session_token: string;
  expires_at: string;
};

export function createSimliBridge(handlers: AvatarBridgeHandlers): AvatarBridge {
  const provider: AvatarProvider = 'simli';

  let client: SimliClientLike | null = null;
  let videoEl: HTMLVideoElement | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let ownedVideoEl = false; // true if we created it (must remove from DOM on close)
  let ownedAudioEl = false;
  let closed = false;
  let ready = false;
  let firstAudioFired = false;

  function detachOwnedElements(): void {
    if (ownedVideoEl && videoEl?.parentNode) videoEl.parentNode.removeChild(videoEl);
    if (ownedAudioEl && audioEl?.parentNode) audioEl.parentNode.removeChild(audioEl);
    ownedVideoEl = false;
    ownedAudioEl = false;
  }

  function fail(err: AvatarError): void {
    if (closed) return;
    closed = true;
    try { handlers.onError?.(err); } catch { /* callback threw, swallow */ }
    try { void client?.stop(); } catch { /* SDK already torn down */ }
    detachOwnedElements();
    client = null;
  }

  async function open(opts: AvatarOpenOptions): Promise<void> {
    if (closed) throw new Error('SimliBridge: open() called after close()');
    if (opts.signal?.aborted) {
      const e: AvatarError = { code: 'connect_timeout', message: 'aborted before open', recoverable: false };
      fail(e); throw e;
    }

    // Mint session token via our server. The route enforces the kill-switch.
    let boot: SimliSessionBoot;
    try {
      const res = await fetch('/api/spike-b/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        signal: opts.signal,
        body: JSON.stringify({ provider: 'simli', replica_id: opts.replicaId }),
      });
      if (!res.ok) {
        const code =
          res.status === 429 ? 'quota_exceeded' :
          res.status === 401 || res.status === 403 ? 'token_expired' :
          res.status === 404 ? 'replica_not_found' :
          res.status === 409 ? 'replica_not_ready' : 'connect_timeout';
        const err: AvatarError = { code, message: `simli session mint ${res.status}`, recoverable: false };
        fail(err); throw err;
      }
      boot = (await res.json()) as SimliSessionBoot;
    } catch (e) {
      if ((e as AvatarError).code) throw e;
      const err: AvatarError = {
        code: 'connect_timeout',
        message: 'simli session mint network error',
        recoverable: true,
        cause: { provider, raw: e },
      };
      fail(err); throw err;
    }

    // Dynamic import so TS compilation does not require simli-client installed.
    let mod: SimliModule;
    try {
      mod = (await import('simli-client')) as unknown as SimliModule;
    } catch (e) {
      const err: AvatarError = {
        code: 'connect_timeout',
        message: 'simli-client module not installed — run `npm i simli-client`',
        recoverable: false,
        cause: { provider, raw: e },
      };
      fail(err); throw err;
    }

    if (typeof document === 'undefined') {
      const err: AvatarError = { code: 'connect_timeout', message: 'SimliBridge requires a DOM', recoverable: false };
      fail(err); throw err;
    }

    // Use caller-provided DOM elements (already in DOM → loadedmetadata fires).
    // If omitted, create our own and inject into body so the browser processes
    // the MediaStream and fires loadedmetadata. detachOwnedElements() cleans up.
    if (opts.videoEl) {
      videoEl = opts.videoEl;
    } else {
      videoEl = document.createElement('video');
      videoEl.playsInline = true;
      videoEl.muted = true;
      Object.assign(videoEl.style, {
        position: 'fixed', opacity: '0', width: '1px', height: '1px',
        pointerEvents: 'none', top: '0', left: '0',
      });
      document.body.appendChild(videoEl);
      ownedVideoEl = true;
    }
    if (opts.audioEl) {
      audioEl = opts.audioEl;
    } else {
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
      ownedAudioEl = true;
    }

    // v3: constructor takes all config. "livekit" transport = no ICE servers needed.
    // LogLevel 2 = ERROR only — suppresses SDK debug noise in console.
    try {
      client = new mod.SimliClient(
        boot.session_token,
        videoEl,
        audioEl,
        null,       // iceServers — not needed for livekit transport
        2,          // LogLevel.ERROR
        'livekit',
      );
    } catch (e) {
      const err: AvatarError = {
        code: 'connect_timeout',
        message: `SimliClient constructor threw: ${(e as Error).message ?? String(e)}`,
        recoverable: false,
        cause: { provider, raw: e },
      };
      fail(err); throw err;
    }

    // Wire SDK error events before start() so failures during handshake are caught.
    client.on('error', (raw: unknown) => {
      fail({ code: 'rtc_ice_failed', message: 'simli error', recoverable: true, cause: { provider, raw } });
    });
    client.on('startup_error', (raw: unknown) => {
      fail({ code: 'connect_timeout', message: 'simli startup_error', recoverable: false, cause: { provider, raw } });
    });
    client.on('stop', () => {
      if (!closed) fail({ code: 'session_ttl_expired', message: 'simli session stopped', recoverable: false });
    });

    // Video track arrives asynchronously via LiveKit after start() resolves.
    // Use loadedmetadata on the videoEl the SDK populates. srcObject is set
    // by the SDK (works on Safari); captureStream() is the Chrome fallback.
    videoEl.addEventListener('loadedmetadata', () => {
      if (ready || closed) return;
      ready = true;
      try {
        const stream =
          videoEl!.srcObject instanceof MediaStream
            ? videoEl!.srcObject
            : (videoEl as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream?.();
        const track = stream?.getVideoTracks()[0] ?? null;
        if (track) handlers.onVideoTrack?.(track);
      } catch { /* no track available */ }
    }, { once: true });

    // Audio track — same pattern. The SDK sets audioEl.srcObject via LiveKit.
    // Harness uses it to combine video+audio into a MediaRecorder stream.
    audioEl.addEventListener('loadedmetadata', () => {
      if (closed) return;
      try {
        const stream = audioEl!.srcObject instanceof MediaStream ? audioEl!.srcObject : null;
        const track = stream?.getAudioTracks()[0] ?? null;
        if (track) handlers.onAudioTrack?.(track);
      } catch { /* no audio track */ }
    }, { once: true });

    try {
      await client.start();
    } catch (e) {
      const err: AvatarError = {
        code: 'connect_timeout',
        message: `simli start() failed: ${(e as Error).message ?? String(e)}`,
        recoverable: true,
        cause: { provider, raw: e },
      };
      fail(err); throw err;
    }

    // start() resolving means the session is established and ready for audio.
    if (!closed) {
      handlers.onReady?.();
    }
  }

  function sendAudio(pcm16le16k: ArrayBuffer): void {
    if (!client || !ready || closed) return;
    if (!firstAudioFired) {
      firstAudioFired = true;
      try { handlers.onFirstAudioSent?.(); } catch { /* callback threw */ }
    }
    try {
      client.sendAudioData(new Uint8Array(pcm16le16k));
    } catch (e) {
      fail({
        code: 'audio_format_rejected',
        message: 'simli rejected audio chunk',
        recoverable: false,
        cause: { provider, raw: e },
      });
    }
  }

  function cancel(): void {
    if (!client || closed) return;
    try { client.ClearBuffer(); } catch { /* SDK tolerates repeated clears */ }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    try { void client?.stop(); } catch { /* already stopped */ }
    detachOwnedElements();
    client = null;
    videoEl = null;
    audioEl = null;
  }

  return { provider, open, sendAudio, cancel, close };
}
