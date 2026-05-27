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

import {
  AVATAR_ERROR_CODES,
  type AvatarBridge,
  type AvatarBridgeHandlers,
  type AvatarError,
  type AvatarOpenOptions,
  type AvatarProvider,
} from './avatar-bridge';

// Discriminate "this is one of our AvatarErrors" from "this is a DOMException
// or other native error that happens to carry a `.code` field" (audit M3 —
// AbortError.code === 20 would otherwise sneak through the prior `e.code`
// truthy check and mask the connect_timeout map).
function isAvatarError(e: unknown): e is AvatarError {
  if (!e || typeof e !== 'object') return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && (AVATAR_ERROR_CODES as readonly string[]).includes(code);
}

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

// Module-scope so production-build const-folding kicks in (audit S
// integration). LogLevel: ERROR (2) in prod — suppresses SDK debug noise.
// WARN (1) in non-prod so a Spike-B-style 502 path that doesn't map
// cleanly to our event taxonomy still leaves a console signal.
const SDK_LOG_LEVEL: number = process.env.NODE_ENV === 'production' ? 2 : 1;

// Bridge instances are SESSION-SCOPED (audit M5 integration). The
// recording controller MUST create a fresh bridge per voice session and
// call close() on session end. Caching across re-arms or replica swaps
// would: (a) make the per-instance warn-once flags lose signal after the
// first use, (b) leak the closed-state guard checks, (c) break track
// caching since SDK closure resets DOM element bindings.
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
  let firstAudioAtMs = 0;
  let lipsyncLatencyFired = false;
  // R3-M3 — minute-accrual reconciliation. Set on first successful start();
  // wall-clock seconds(now() - openedAtMs) is sent via onMinuteAccrual on close().
  let openedAtMs = 0;
  let minuteAccrualFired = false;
  // R3-Missing-4 — video stats poll handle. Cleared on close.
  let videoStatsTimer: ReturnType<typeof setInterval> | null = null;
  // R3-C1 — ring-buffer chunker enforcing Simli's 6000-byte cadence. Cartesia
  // emits arbitrary-sized PCM frames; flushing per Cartesia chunk = drift.
  // Buffer accumulates incoming bytes; flush in 6000-byte chunks; carry the
  // remainder for the next sendAudio call. cancel()/close() drop the carry
  // (do NOT flush partial — would leak prior turn into next).
  const SIMLI_CHUNK_BYTES = 6000;
  let chunkerBuf = new Uint8Array(0);
  // commitUtterance (2026-05-25): the chunker carries the final <6000-byte
  // (~≤187ms) remainder for the NEXT sendAudio call. At a turn boundary there is
  // no next call, so the last syllable/word sat stranded in the carry → the
  // avatar "cut off mid-word" at the end of every answer. The caller invokes
  // commitUtterance() at the true turn-audio boundary (driven by the proxy's
  // per-utterance "deep answer done" signal, NOT the +6–20s-late Gemini
  // turn_complete) to flush that tail. cancel()/close() still DROP the carry
  // (barge/teardown — flushing there would bleed a dead turn into the next).

  // Track cache for late subscribers + renegotiation re-fire (Plan §23.4, §25.5).
  // Updated by refreshVideoTrack / refreshAudioTrack on initial loadedmetadata
  // AND on every MediaStream 'addtrack' / track 'ended' (LiveKit ICE restart,
  // WiFi↔LTE handoff, simulcast layer change). Consumers MUST handle re-fire.
  let currentVideoTrack: MediaStreamTrack | null = null;
  let currentAudioTrack: MediaStreamTrack | null = null;
  // Bound stream refs + listeners — kept so we can detach when the SDK swaps
  // srcObject to a new MediaStream on reconnect (audit C1/C2). Without this,
  // the addtrack listener stays on the OLD stream and the new one is silent.
  let videoStreamBound: MediaStream | null = null;
  let audioStreamBound: MediaStream | null = null;
  let intentionalClose = false;

  // setLocalPlayback state. Default true (audible). When false, the consumer's
  // AudioContext is the audible path and audioEl is silenced via volume=0.
  // We use volume rather than muted because WebKit drops the underlying track
  // on muted=true mid-WebRTC (verified spike #3).
  let localPlaybackAudible = true;
  function applyLocalPlayback(): void {
    if (audioEl) audioEl.volume = localPlaybackAudible ? 1 : 0;
  }

  // Rebind the addtrack listener if the SDK swapped srcObject to a new
  // MediaStream. Idempotent — same stream is a no-op.
  function rebindVideoStream(stream: MediaStream | null): void {
    if (videoStreamBound === stream) return;
    if (videoStreamBound) videoStreamBound.removeEventListener('addtrack', refreshVideoTrack);
    videoStreamBound = stream;
    if (stream) stream.addEventListener('addtrack', refreshVideoTrack);
  }
  function rebindAudioStream(stream: MediaStream | null): void {
    if (audioStreamBound === stream) return;
    if (audioStreamBound) audioStreamBound.removeEventListener('addtrack', refreshAudioTrack);
    audioStreamBound = stream;
    if (stream) stream.addEventListener('addtrack', refreshAudioTrack);
  }

  function readVideoStream(): MediaStream | null {
    if (!videoEl) return null;
    if (videoEl.srcObject instanceof MediaStream) return videoEl.srcObject;
    const cs = (videoEl as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream?.();
    return cs ?? null;
  }

  function refreshVideoTrack(): void {
    if (closed || !videoEl) return;
    let stream = readVideoStream();
    // Cross-element fallback (audit M2): only when our own srcObject is
    // truly absent — some LiveKit setups put both tracks on a single
    // MediaStream the SDK assigns to one element while leaving the other
    // null. Falling back when the primary stream merely has no LIVE video
    // would let stale streams shadow real renegotiation events.
    if (!stream && audioEl?.srcObject instanceof MediaStream) {
      stream = audioEl.srcObject;
    }
    rebindVideoStream(stream);
    const track = stream?.getVideoTracks().find((t) => t.readyState === 'live') ?? null;
    if (!track || track === currentVideoTrack) return;
    currentVideoTrack = track;
    track.addEventListener('ended', refreshVideoTrack, { once: true });
    // R2-C4 — iOS WebKit re-evaluates autoplay against the current
    // user-activation on every track rebind (ICE restart, WiFi↔LTE
    // handoff, simulcast layer change). Activation may have expired;
    // try play() and rely on the consumer's video_autoplay_lost watcher
    // (R4-YC-Day) to surface the failure if rejected. Optional-chain the
    // call so an environment without HTMLVideoElement.play (test fake)
    // is a no-op rather than a TypeError.
    try {
      const p = (videoEl as HTMLVideoElement & { play?: () => Promise<void> }).play?.();
      if (p && typeof p.catch === 'function') p.catch(() => { /* watcher catches */ });
    } catch { /* SSR / non-browser env */ }
    try { handlers.onVideoTrack?.(track); } catch { /* callback threw */ }
  }

  function refreshAudioTrack(): void {
    if (closed || !audioEl) return;
    let stream = audioEl.srcObject instanceof MediaStream ? audioEl.srcObject : null;
    if (!stream && videoEl?.srcObject instanceof MediaStream) {
      stream = videoEl.srcObject;
    }
    rebindAudioStream(stream);
    const track = stream?.getAudioTracks().find((t) => t.readyState === 'live') ?? null;
    if (!track || track === currentAudioTrack) return;
    currentAudioTrack = track;
    track.addEventListener('ended', refreshAudioTrack, { once: true });
    try { handlers.onAudioTrack?.(track); } catch { /* callback threw */ }
  }

  function detachOwnedElements(): void {
    if (ownedVideoEl && videoEl?.parentNode) videoEl.parentNode.removeChild(videoEl);
    if (ownedAudioEl && audioEl?.parentNode) audioEl.parentNode.removeChild(audioEl);
    ownedVideoEl = false;
    ownedAudioEl = false;
  }

  function fail(err: AvatarError): void {
    if (closed) return;
    intentionalClose = true;
    closed = true;
    try { handlers.onError?.(err); } catch { /* callback threw, swallow */ }
    try { void client?.stop(); } catch { /* SDK already torn down */ }
    rebindVideoStream(null);
    rebindAudioStream(null);
    detachOwnedElements();
    client = null;
  }

  async function open(opts: AvatarOpenOptions): Promise<void> {
    if (closed) throw new Error('SimliBridge: open() called after close()');
    if (opts.signal?.aborted) {
      const e: AvatarError = { code: 'connect_timeout', message: 'aborted before open', recoverable: false };
      fail(e); throw e;
    }

    // Production path: session token was pre-minted by /api/sessions/open and
    // passed down. Fallback path (Spike-B harness): mint via /api/spike-b/session.
    //
    // Error-mapping: the fallback path can surface upstream 429 (our own
    // kill-switch fired — 'session_killed') distinct from Simli's own 429
    // rate-limit ('quota_exceeded'). Production never hits this branch —
    // kill-switch 429s surface at /api/sessions/open and never reach here.
    let sessionToken: string;
    if (opts.preMintedSessionToken) {
      sessionToken = opts.preMintedSessionToken;
    } else {
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
        if (isAvatarError(e)) throw e;
        const err: AvatarError = {
          code: 'connect_timeout',
          message: 'simli session mint network error',
          recoverable: true,
          cause: { provider, raw: e },
        };
        fail(err); throw err;
      }
      sessionToken = boot.session_token;
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
    // Apply pre-open setLocalPlayback() immediately (audit M1) to shrink the
    // window where audioEl exists at default volume after the caller opted out.
    applyLocalPlayback();

    // v3: constructor takes all config. "livekit" transport = no ICE servers needed.
    try {
      client = new mod.SimliClient(
        sessionToken,
        videoEl,
        audioEl,
        null,           // iceServers — not needed for livekit transport
        SDK_LOG_LEVEL,
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
      console.log('[AD] simli EVENT=error', raw); // ⚠️ TEMP AUDIODIAG — DELETE later
      fail({ code: 'rtc_ice_failed', message: 'simli error', recoverable: true, cause: { provider, raw } });
    });
    client.on('startup_error', (raw: unknown) => {
      console.log('[AD] simli EVENT=startup_error', raw); // ⚠️ TEMP AUDIODIAG — DELETE later
      fail({ code: 'connect_timeout', message: 'simli startup_error', recoverable: false, cause: { provider, raw } });
    });
    client.on('stop', () => {
      console.log(`[AD] simli EVENT=stop (closed=${closed} intentionalClose=${intentionalClose})`); // ⚠️ TEMP AUDIODIAG — DELETE later
      // intentionalClose flag (audit M6): differentiates our own close() —
      // which calls client.stop() and may fire 'stop' synchronously back at
      // us — from a TTL/session-ended event we should surface as an error.
      if (!closed && !intentionalClose) {
        fail({ code: 'session_ttl_expired', message: 'simli session stopped', recoverable: false });
      }
    });

    // Video track arrives asynchronously via LiveKit after start() resolves.
    // loadedmetadata is NOT {once:true} (audit C1) — when the SDK swaps
    // srcObject to a new MediaStream on reconnect, the element fires another
    // loadedmetadata which we must process to rebind addtrack.
    videoEl.addEventListener('loadedmetadata', () => {
      if (closed) return;
      const firstReady = !ready;
      ready = true;
      refreshVideoTrack();
      // Also drive audio refresh from the video metadata path (audit M5):
      // Safari is unreliable about firing loadedmetadata on audio elements
      // when the underlying stream's video track populates first. Without
      // this, currentAudioTrack can stay null indefinitely.
      refreshAudioTrack();
      if (firstReady && !lipsyncLatencyFired && firstAudioAtMs > 0) {
        lipsyncLatencyFired = true;
        const ms = Math.max(0, Math.round(performance.now() - firstAudioAtMs));
        try { handlers.onLipsyncLatency?.(ms); } catch { /* callback threw */ }
      }
    });

    audioEl.addEventListener('loadedmetadata', () => {
      if (closed) return;
      refreshAudioTrack();
    });

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
      openedAtMs = Date.now();
      // R3-Missing-4 — kick off video-stats poll. 5s cadence; consumer
      // diffs vs prior sample for interval-rate. Pause is implicit via
      // the closed/!videoEl guards.
      videoStatsTimer = setInterval(() => {
        if (closed || !videoEl) return;
        const v = videoEl as HTMLVideoElement & { getVideoPlaybackQuality?: () => { droppedVideoFrames: number; totalVideoFrames: number } };
        const q = v.getVideoPlaybackQuality?.();
        if (!q) return; // Safari < 17 etc.
        try {
          handlers.onVideoStats?.({
            droppedFrames: q.droppedVideoFrames,
            totalFrames: q.totalVideoFrames,
            sampledAtMs: Date.now(),
          });
        } catch { /* callback threw */ }
      }, 5000);
      handlers.onReady?.();
    }
  }

  let warnedSendAudioPostClose = false;
  // Flush the parked carry remainder as ONE Simli frame, zero-padded to the
  // 6000-byte cadence the SDK expects. Carry is always <6000B (sendAudio drains
  // every full chunk), so the pad is ≤187ms of trailing PCM silence — a natural
  // beat after the final word, not a glitch. No-op if nothing is parked or the
  // bridge is gone. Called at the turn-audio boundary by the consumer (driven
  // by the proxy's per-utterance "deep answer done" signal).
  function commitUtterance(): void {
    if (closed || !client || !ready || chunkerBuf.byteLength === 0) return;
    // ⚠️ TEMP AUDIODIAG — DELETE later. Tail actually flushed (real bytes +
    // silence pad). carry small = a sub-word tail; this is the last audio Simli
    // gets for the turn.
    console.log(`[AD] simli.commitUtterance flush carryBytes=${chunkerBuf.byteLength} (padded→${SIMLI_CHUNK_BYTES})`);
    const padded = new Uint8Array(SIMLI_CHUNK_BYTES);
    padded.set(chunkerBuf, 0);
    chunkerBuf = new Uint8Array(0);
    try {
      client.sendAudioData(padded);
    } catch (e) {
      // Audit C3 — NON-FATAL. The tail is the least-important audio in the turn;
      // a rejected tail frame degrades to the pre-fix cut-off-last-word, which
      // must NEVER tear down a live, working session (the main sendAudio loop's
      // fail() is correct for a real mid-stream chunk; this is not that).
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.warn('[simli-bridge] commitUtterance tail-flush rejected — dropping tail (non-fatal)', e);
      }
    }
  }

  function sendAudio(pcm16le16k: ArrayBuffer): void {
    // Audit C4 (integration): silent no-op masked a real bug surface — a
    // controller that re-uses a closed bridge ships zero lipsync latency
    // telemetry from that point forward with no signal. Warn once per
    // bridge instance in non-prod so the regression is visible.
    if (closed) {
      if (!warnedSendAudioPostClose && process.env.NODE_ENV !== 'production') {
        warnedSendAudioPostClose = true;
        console.warn('[simli-bridge] sendAudio called after close() — controller bug, dropping audio');
      }
      return;
    }
    if (!client || !ready) return;
    if (!firstAudioFired) {
      firstAudioFired = true;
      firstAudioAtMs = performance.now();
      try { handlers.onFirstAudioSent?.(); } catch { /* callback threw */ }
      // Edge case: video loadedmetadata may have already fired BEFORE first
      // audio was dispatched (pipe-warm scenario post-rollover). If ready is
      // already true, emit latency immediately (≈0ms is valid data).
      if (ready && !lipsyncLatencyFired) {
        lipsyncLatencyFired = true;
        try { handlers.onLipsyncLatency?.(0); } catch { /* callback threw */ }
      }
    }
    // R3-C1 — ring-buffer chunker. Cartesia emits arbitrary-sized PCM
    // frames; Simli wants ~6000-byte cadence (187.5ms @ 16k). Mismatched
    // cadence = lipsync drift indistinguishable from the original bug.
    const incoming = new Uint8Array(pcm16le16k);
    if (incoming.byteLength === 0) return;
    const merged = new Uint8Array(chunkerBuf.byteLength + incoming.byteLength);
    merged.set(chunkerBuf, 0);
    merged.set(incoming, chunkerBuf.byteLength);
    let offset = 0;
    while (merged.byteLength - offset >= SIMLI_CHUNK_BYTES) {
      const slice = merged.subarray(offset, offset + SIMLI_CHUNK_BYTES);
      try {
        client.sendAudioData(slice);
      } catch (e) {
        fail({
          code: 'audio_format_rejected',
          message: 'simli rejected audio chunk',
          recoverable: false,
          cause: { provider, raw: e },
        });
        return;
      }
      offset += SIMLI_CHUNK_BYTES;
    }
    // Carry remainder for next call. Slice (not subarray) to detach from
    // `merged` so `merged` can be GC'd.
    chunkerBuf = offset < merged.byteLength
      ? merged.slice(offset)
      : new Uint8Array(0);
  }

  function cancel(): void {
    if (!client || closed) return;
    // R3-C1 — drop the chunker carry so a barge-in doesn't bleed prior-turn
    // audio into the next turn's first 6000 bytes (and so a commitUtterance
    // racing a barge finds nothing to flush).
    chunkerBuf = new Uint8Array(0);
    try { client.ClearBuffer(); } catch { /* SDK tolerates repeated clears */ }
  }

  // R2-C4 / R3-M2 — full re-bind of video element source. Used by the
  // reconnect overlay's tap handler to acquire a fresh user-activation
  // for autoplay on iOS WebKit (calling play() on the existing srcObject
  // doesn't re-evaluate autoplay policy — only a fresh srcObject does).
  // Caller MUST invoke from within a user gesture handler.
  async function rebindMediaSource(): Promise<void> {
    if (closed || !videoEl) return;
    const stream = readVideoStream();
    if (!stream) return;
    try {
      videoEl.srcObject = null;
      videoEl.srcObject = stream;
      const p = (videoEl as HTMLVideoElement & { play?: () => Promise<void> }).play?.();
      if (p) await p;
    } catch {
      // Play rejection bubbles to the consumer via the
      // video_autoplay_lost reconnect overlay (R4-M5).
    }
  }

  function close(): void {
    if (closed) return;
    intentionalClose = true;
    closed = true;
    // R3-Missing-4 — stop the video-stats poll.
    if (videoStatsTimer !== null) {
      clearInterval(videoStatsTimer);
      videoStatsTimer = null;
    }
    // R3-M3 — emit minute accrual exactly once. Fire BEFORE we tear
    // down — consumer reads it synchronously and POSTs server-side.
    // openedAtMs == 0 means start() never resolved; nothing to bill.
    if (!minuteAccrualFired && openedAtMs > 0) {
      minuteAccrualFired = true;
      const seconds = Math.max(0, (Date.now() - openedAtMs) / 1000);
      try { handlers.onMinuteAccrual?.(seconds); } catch { /* callback threw */ }
    }
    try { void client?.stop(); } catch { /* already stopped */ }
    // Detach addtrack listeners before nulling stream refs (audit M4 leak fix).
    rebindVideoStream(null);
    rebindAudioStream(null);
    detachOwnedElements();
    chunkerBuf = new Uint8Array(0);
    client = null;
    videoEl = null;
    audioEl = null;
    currentVideoTrack = null;
    currentAudioTrack = null;
  }

  function getCurrentTracks(): { video: MediaStreamTrack | null; audio: MediaStreamTrack | null } {
    return { video: currentVideoTrack, audio: currentAudioTrack };
  }

  function setLocalPlayback(audible: boolean): void {
    localPlaybackAudible = audible;
    applyLocalPlayback();
  }

  return { provider, open, sendAudio, commitUtterance, cancel, close, getCurrentTracks, setLocalPlayback, rebindMediaSource };
}
