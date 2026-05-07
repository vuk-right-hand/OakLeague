// HeygenBridge — implements AvatarBridge for HeyGen LiveAvatar Lite.
//
// Wire-format reference: docs/_planning/PHASE_0_HEYGEN.md (the curated
// source of truth). Public docs at docs.liveavatar.com lie about success
// codes, status codes, inbound vocabulary, audio chunking, and barge-in.
// Trust this file's behavior + PHASE_0_HEYGEN.md when they conflict.
//
// Transport architecture:
//   * Control:  WebSocket → opts.heygenSessionBoot.wsUrl
//                Outbound: agent.speak / agent.speak_end / agent.interrupt
//                Inbound:  9 types observed in Phase 0 §3 — handled below.
//   * Video/Audio: LiveKit Room → opts.heygenSessionBoot.livekitUrl
//                  Browser SUBSCRIBES only (canPublish:false token).
//                  Tracks dispatched via onVideoTrack / onAudioTrack with
//                  renegotiation re-fire same as Simli.
//   * Keep-alive: SERVER-SIDE (voice-proxy holds the privileged session
//                JWT and fires /v1/sessions/keep-alive every 30s).
//                The bridge does NOT make REST calls.
//   * Stop: SERVER-SIDE on session close. Bridge.close() does NOT call
//           /v1/sessions/stop. The /api/sessions/close route does.
//
// Architecture note — LiveKit token trust model:
// HeyGen-issued `livekit_client_token` is PRIVILEGED (canPublish:true).
// HeyGen does NOT expose a subscribe-only mint, and our LIVEKIT_API_KEY/
// SECRET signs tokens for OUR LiveKit Cloud account — not HeyGen's — so
// re-minting against their room is architecturally impossible. We accept
// the privileged token under the SAME trust model as Simli's compose token:
//   * Same-origin HTTPS delivery (browser memory only; no localStorage).
//   * Tied to session TTL.
//   * This bridge never publishes (no room.localParticipant.publishTrack
//     calls). The publish capability is granted-but-unused.
// We log claim attestation on connect so a regression where publishTrack
// gets accidentally added is visible in the console (non-prod) but does
// NOT throw — Phase 0 confirmed every HeyGen token has canPublish:true.
//
// Follow-up trigger (open work): if HeyGen exposes either
//   (a) a BYO-LiveKit option (customer supplies LIVEKIT_URL + secret, so
//       we can re-mint subscribe-only against our own LiveKit Cloud); OR
//   (b) a server-side subscribe-only token mint endpoint
// then switch to that path. The trust-token model below is acceptable
// because the same posture exists for Simli's compose token, but a
// subscribe-only path is strictly better whenever HeyGen offers it.
//
// Bridge instances are SESSION-SCOPED (audit round 2 / M2 — mirrors Simli
// at simli-bridge.ts:81-87). Pipe-warm rollover MUST construct a fresh
// bridge per session — single-pending-utterance state must NOT bleed
// across rollovers. Caching the bridge instance leaks `interruptInFlight`
// and the chunker carry into the next session.
//
// ── Recording stack lifecycle conventions (mirrors Simli) ─────────────
//   close()  = terminal teardown (this bridge, audio-mixer)
//   cancel() = barge-in. For HeyGen this is NOT drop-and-resume like
//              Simli — server requires interrupt → speak_ended ack →
//              new speak. cancel() sends agent.interrupt and clears
//              the chunker carry; new sendAudio() chunks queue until
//              the in-flight task acks speak_ended.

'use client';

import {
  AVATAR_ERROR_CODES,
  type AvatarBridge,
  type AvatarBridgeHandlers,
  type AvatarError,
  type AvatarOpenOptions,
  type AvatarProvider,
} from './avatar-bridge';

function isAvatarError(e: unknown): e is AvatarError {
  if (!e || typeof e !== 'object') return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && (AVATAR_ERROR_CODES as readonly string[]).includes(code);
}

// PCM16 24kHz mono. 20ms chunk = 24000 samples/s × 0.02s × 2 bytes/sample = 960 bytes.
// Phase 0 §6 — 20ms uniform was empirically the lowest-latency strategy
// (123ms first-frame ack vs 485ms for monolith).
const HEYGEN_CHUNK_BYTES = 960;

// How long to wait for `agent.audio_buffer_appended` after sending the
// first chunk of an utterance. If we don't see it, the server probably
// dropped the utterance silently — Phase 0 §7 (silent_drop_no_speak_end).
// Server typically acks in <500ms (123–485ms in Phase 0).
const AUDIO_BUFFER_APPENDED_TIMEOUT_MS = 4000;

// Maximum payload bytes per WS send. Phase 0 docs say ≤1MB. We send
// 960-byte raw chunks (~1280 base64 chars + JSON envelope ≈ 1.4KB) so
// the cap never bites — but we guard anyway.
const MAX_WS_PAYLOAD_BYTES = 800 * 1024;

// SDK_LOG_LEVEL parity with simli-bridge. ERROR (2) in prod, WARN (1) in
// non-prod so unmapped frames leave a console signal.
const LOG_LEVEL = process.env.NODE_ENV === 'production' ? 2 : 1;

type LiveKitModule = {
  Room: new (opts?: unknown) => LiveKitRoom;
  RoomEvent: Record<string, string>;
  Track: { Kind: { Audio: string; Video: string } };
};

type LiveKitRemoteTrack = {
  kind: string;
  mediaStreamTrack: MediaStreamTrack;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
};

type LiveKitParticipant = {
  identity: string;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
};

type LiveKitRoom = {
  on(event: string, cb: (...args: unknown[]) => void): LiveKitRoom;
  off?(event: string, cb: (...args: unknown[]) => void): LiveKitRoom;
  connect(url: string, token: string, opts?: unknown): Promise<void>;
  disconnect(): Promise<void> | void;
  remoteParticipants: Map<string, LiveKitParticipant>;
};

function uuid4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Decode JWT payload to detect mis-routed privileged tokens (audit-r2 M2).
function jwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    // base64url → base64
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = typeof atob === 'function'
      ? atob(padded)
      : Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function createHeygenBridge(handlers: AvatarBridgeHandlers): AvatarBridge {
  const provider: AvatarProvider = 'heygen';

  // ── Mutable state ───────────────────────────────────────────────────
  let ws: WebSocket | null = null;
  let room: LiveKitRoom | null = null;
  let videoEl: HTMLVideoElement | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let ownedVideoEl = false;
  let ownedAudioEl = false;
  let closed = false;
  let intentionalClose = false;
  let ready = false;
  let openedAtMs = 0;
  let firstAudioFired = false;
  let firstAudioAtMs = 0;
  let lipsyncLatencyFired = false;
  let minuteAccrualFired = false;

  // Track caches + stream binding (mirror Simli's pattern for renegotiation).
  let currentVideoTrack: MediaStreamTrack | null = null;
  let currentAudioTrack: MediaStreamTrack | null = null;
  let currentRoomMediaStream: MediaStream | null = null;

  // Single-pending-utterance state (audit-r2 C5 — collapses repeat-cancels).
  // Phase 0 §7 confirmed: server requires speak_end (or interrupt) before
  // accepting a new utterance. Otherwise the new utterance is silently
  // dropped. We enforce one pending task at a time.
  let currentUtteranceEventId: string | null = null;  // client-side id we sent
  let currentTaskId: string | null = null;             // server-assigned id from audio_buffer_appended
  let interruptInFlight = false;                       // cancel() sent agent.interrupt, awaiting speak_ended
  let chunkerBuf = new Uint8Array(0);                  // PCM carry for the active utterance
  let audioBufferAppendedTimer: ReturnType<typeof setTimeout> | null = null;

  // Per-bridge warn-once flags (audit-r2 M5 — make unknown types visible).
  const warnedUnknownTypes = new Set<string>();

  // setLocalPlayback state. Mirrors Simli — volume not muted (WebKit drops
  // tracks on muted=true mid-WebRTC, spike #3 finding).
  let localPlaybackAudible = true;
  function applyLocalPlayback(): void {
    if (audioEl) audioEl.volume = localPlaybackAudible ? 1 : 0;
  }

  function debug(msg: string, extra?: unknown): void {
    if (LOG_LEVEL <= 1) {
      console.warn(`[heygen-bridge] ${msg}`, extra ?? '');
    }
  }

  function fail(err: AvatarError): void {
    if (closed) return;
    intentionalClose = true;
    closed = true;
    try { handlers.onError?.(err); } catch { /* */ }
    safeCloseWs();
    safeDisconnectRoom();
    detachOwnedElements();
  }

  function safeCloseWs(): void {
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'bridge_closed');
      }
    } catch { /* */ }
    ws = null;
  }

  function safeDisconnectRoom(): void {
    if (!room) return;
    try { void room.disconnect(); } catch { /* */ }
    room = null;
  }

  function detachOwnedElements(): void {
    if (ownedVideoEl && videoEl?.parentNode) videoEl.parentNode.removeChild(videoEl);
    if (ownedAudioEl && audioEl?.parentNode) audioEl.parentNode.removeChild(audioEl);
    ownedVideoEl = false;
    ownedAudioEl = false;
  }

  function rebindMediaStreamFromRoom(stream: MediaStream): void {
    if (closed) return;
    currentRoomMediaStream = stream;
    if (videoEl && videoEl.srcObject !== stream) videoEl.srcObject = stream;
    if (audioEl && audioEl.srcObject !== stream) audioEl.srcObject = stream;
  }

  // ── WebSocket: open + inbound message dispatcher ────────────────────
  function openWs(wsUrl: string, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      let s: WebSocket;
      try {
        s = new WebSocket(wsUrl);
      } catch (e) {
        reject(new Error(`HeygenBridge: WebSocket constructor threw: ${(e as Error).message ?? String(e)}`));
        return;
      }
      ws = s;
      const onAbort = () => {
        try { s.close(1000, 'aborted'); } catch { /* */ }
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      const cleanupOpenListeners = () => {
        s.removeEventListener('open', openHandler);
        s.removeEventListener('error', errorHandler);
      };
      const openHandler = () => {
        cleanupOpenListeners();
        if (signal?.aborted) {
          try { s.close(1000, 'aborted'); } catch { /* */ }
          reject(new Error('aborted'));
          return;
        }
        attachWsHandlers();
        resolve();
      };
      const errorHandler = () => {
        cleanupOpenListeners();
        reject(new Error('ws_open_failed'));
      };
      s.addEventListener('open', openHandler);
      s.addEventListener('error', errorHandler);
    });
  }

  function attachWsHandlers(): void {
    if (!ws) return;
    ws.addEventListener('message', (event) => {
      let frame: Record<string, unknown> | null = null;
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      if (!frame) return;
      handleInbound(frame);
    });
    ws.addEventListener('close', (event) => {
      if (closed) return;
      // Server WS close. Phase 0 §9: server cleanly closes after stop +
      // also after ~120s idle (no warning frame). Either way, surface as
      // a non-recoverable session_ttl_expired so the consumer rebuilds.
      if (!intentionalClose) {
        fail({
          code: 'session_ttl_expired',
          message: `heygen ws closed code=${event.code} reason=${event.reason || '<empty>'}`,
          recoverable: false,
        });
      }
    });
    ws.addEventListener('error', () => {
      if (!closed) {
        fail({
          code: 'rtc_ice_failed',
          message: 'heygen ws error',
          recoverable: true,
        });
      }
    });
  }

  function handleInbound(frame: Record<string, unknown>): void {
    const type = typeof frame.type === 'string' ? frame.type : '<no-type>';
    const taskId = (frame.task as { id?: string } | undefined)?.id ?? null;

    switch (type) {
      case 'session.state_updated': {
        // Phase 0: state="connected" arrives ~immediately on WS open.
        // The Room.connect Promise is what gates open() resolution; this
        // is informational.
        const state = typeof frame.state === 'string' ? frame.state : null;
        debug(`session.state_updated state=${state}`);
        return;
      }
      case 'agent.audio_buffer_appended': {
        // First server ack — captures task.id for correlation.
        if (taskId && currentUtteranceEventId && !currentTaskId) {
          currentTaskId = taskId;
          if (audioBufferAppendedTimer) {
            clearTimeout(audioBufferAppendedTimer);
            audioBufferAppendedTimer = null;
          }
        }
        return;
      }
      case 'agent.audio_buffer_committed':
        // Server has accepted the buffer for synthesis. No bridge action.
        return;
      case 'agent.speak_started': {
        if (!ready && taskId === currentTaskId) {
          ready = true;
          handlers.onReady?.();
        }
        if (!lipsyncLatencyFired && firstAudioAtMs > 0 && taskId === currentTaskId) {
          lipsyncLatencyFired = true;
          const ms = Math.max(0, Math.round(performance.now() - firstAudioAtMs));
          try { handlers.onLipsyncLatency?.(ms); } catch { /* */ }
        }
        return;
      }
      case 'agent.speak_ended': {
        if (taskId && taskId === currentTaskId) {
          // Utterance complete — clear single-pending state.
          currentUtteranceEventId = null;
          currentTaskId = null;
          interruptInFlight = false;
          chunkerBuf = new Uint8Array(0);
        }
        return;
      }
      case 'agent.idle_started':
      case 'agent.idle_ended':
      case 'agent.audio_buffer_cleared':
        // Informational — no consumer-facing action.
        return;
      case 'warning': {
        // Audit-r2 S2 — surface to console (Sentry hookup happens in the
        // consumer's onError handler if it chooses). Don't fail the session.
        debug('heygen warning frame', frame);
        return;
      }
      default: {
        // Audit-r2 M5 — warn-once-per-session per unknown type. Future
        // breaking changes (e.g. new error envelope) become visible
        // within hours instead of weeks.
        if (!warnedUnknownTypes.has(type)) {
          warnedUnknownTypes.add(type);
          debug(`unknown inbound type "${type}" — investigate`, frame);
        }
        return;
      }
    }
  }

  // ── LiveKit Room: connect + subscribe ────────────────────────────────
  async function connectRoom(boot: NonNullable<AvatarOpenOptions['heygenSessionBoot']>): Promise<void> {
    // Telemetry only: log the LiveKit JWT claims attestation. Phase 0
    // confirmed every HeyGen token has canPublish:true (architecturally
    // impossible to re-mint subscribe-only against their instance). If a
    // future regression accidentally calls room.localParticipant.publishTrack,
    // this log is the breadcrumb to find it. Not fatal.
    const claims = jwtClaims(boot.livekitClientToken);
    const video = (claims?.video as { canPublish?: boolean; roomJoin?: boolean } | undefined) ?? null;
    if (video?.roomJoin !== true) {
      throw new Error('HeygenBridge: livekit token missing roomJoin claim — invalid');
    }
    if (LOG_LEVEL <= 1) {
      debug(`livekit token claims: canPublish=${video.canPublish ?? 'n/a'} (publish path unused by bridge)`);
    }

    let mod: LiveKitModule;
    try {
      mod = (await import('livekit-client')) as unknown as LiveKitModule;
    } catch (e) {
      throw new Error(`HeygenBridge: livekit-client import failed: ${(e as Error).message ?? String(e)}`);
    }

    const r = new mod.Room({
      // Adaptive stream lets HeyGen vary resolution by visibility — fine
      // for our use since the avatar is always on screen during a session.
      adaptiveStream: true,
      dynacast: true,
    });
    room = r;

    // Subscribe to remote tracks (HeyGen's avatar participant publishes
    // audio + video into the room).
    r.on(mod.RoomEvent.TrackSubscribed, (...args: unknown[]) => {
      const [track] = args as [LiveKitRemoteTrack, unknown, LiveKitParticipant];
      if (closed) return;
      const mst = track.mediaStreamTrack;
      if (!mst) return;
      // Build/reuse a single MediaStream so video + audio share an element.
      if (!currentRoomMediaStream) {
        currentRoomMediaStream = new MediaStream();
        rebindMediaStreamFromRoom(currentRoomMediaStream);
      }
      try { currentRoomMediaStream.addTrack(mst); } catch { /* */ }

      if (track.kind === mod.Track.Kind.Video) {
        currentVideoTrack = mst;
        try { handlers.onVideoTrack?.(mst); } catch { /* */ }
      } else if (track.kind === mod.Track.Kind.Audio) {
        currentAudioTrack = mst;
        try { handlers.onAudioTrack?.(mst); } catch { /* */ }
      }
    });

    r.on(mod.RoomEvent.TrackUnsubscribed, (...args: unknown[]) => {
      const [track] = args as [LiveKitRemoteTrack];
      if (track.mediaStreamTrack === currentVideoTrack) currentVideoTrack = null;
      if (track.mediaStreamTrack === currentAudioTrack) currentAudioTrack = null;
    });

    r.on(mod.RoomEvent.Disconnected, () => {
      if (closed || intentionalClose) return;
      fail({
        code: 'rtc_ice_failed',
        message: 'livekit room disconnected unexpectedly',
        recoverable: true,
      });
    });

    await r.connect(boot.livekitUrl, boot.livekitClientToken);
  }

  // ── Audio chunker + send ─────────────────────────────────────────────
  function sendChunkedSpeak(eventId: string, slice: Uint8Array): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (slice.byteLength === 0) return;
    const b64 = bufferToBase64(slice);
    const payload = JSON.stringify({
      type: 'agent.speak',
      event_id: eventId,
      audio: b64,
    });
    if (payload.length > MAX_WS_PAYLOAD_BYTES) {
      fail({
        code: 'app_message_too_large',
        message: 'heygen ws payload over cap',
        recoverable: false,
      });
      return;
    }
    ws.send(payload);
  }

  function sendSpeakEnd(eventId: string): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'agent.speak_end', event_id: eventId }));
  }

  function sendInterrupt(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'agent.interrupt', event_id: uuid4() }));
  }

  function bufferToBase64(buf: Uint8Array): string {
    if (typeof btoa === 'function') {
      let s = '';
      for (let i = 0; i < buf.byteLength; i++) s += String.fromCharCode(buf[i]);
      return btoa(s);
    }
    // Node fallback (test env). Buffer ships in Node natively.
    return Buffer.from(buf).toString('base64');
  }

  // ── Public interface ────────────────────────────────────────────────
  let warnedSendAudioPostClose = false;

  async function open(opts: AvatarOpenOptions): Promise<void> {
    if (closed) throw new Error('HeygenBridge: open() called after close()');
    if (opts.signal?.aborted) {
      const e: AvatarError = { code: 'connect_timeout', message: 'aborted before open', recoverable: false };
      fail(e);
      throw e;
    }
    if (!opts.heygenSessionBoot) {
      const e: AvatarError = {
        code: 'connect_timeout',
        message: 'HeygenBridge requires opts.heygenSessionBoot (see /api/sessions/open)',
        recoverable: false,
      };
      fail(e);
      throw e;
    }
    if (typeof document === 'undefined') {
      const e: AvatarError = { code: 'connect_timeout', message: 'HeygenBridge requires a DOM', recoverable: false };
      fail(e);
      throw e;
    }

    // DOM elements (mirror Simli — caller-provided OR bridge-owned).
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
    applyLocalPlayback();

    // Open WS. Open Room concurrently — they're independent transports.
    try {
      await openWs(opts.heygenSessionBoot.wsUrl, opts.signal);
    } catch (e) {
      const err: AvatarError = {
        code: 'connect_timeout',
        message: `heygen ws open failed: ${(e as Error).message ?? String(e)}`,
        recoverable: true,
        cause: { provider, raw: e },
      };
      fail(err);
      throw err;
    }

    try {
      await connectRoom(opts.heygenSessionBoot);
    } catch (e) {
      const err: AvatarError = {
        code: 'rtc_ice_failed',
        message: `heygen livekit room connect failed: ${(e as Error).message ?? String(e)}`,
        recoverable: true,
        cause: { provider, raw: e },
      };
      fail(err);
      throw err;
    }

    if (!closed) {
      openedAtMs = Date.now();
      // Phase 0.5 fix: fire onReady once transport is up (WS open + Room
      // connected). The earlier design waited for `agent.speak_started` to
      // prove the audio path, but HeyGen never speaks until the user does
      // — and the mic UI is gated on phase==='ready'. Result was a deadlock
      // where the bridge waited for HeyGen audio while the user couldn't
      // produce input. Mirror Simli semantics: ready==transport-ready.
      // Idempotent — speak_started's onReady fire is dedup'd by `ready`.
      if (!ready) {
        ready = true;
        try { handlers.onReady?.(); } catch { /* */ }
      }
    }
  }

  function sendAudio(pcm16le24k: ArrayBuffer): void {
    if (closed) {
      if (!warnedSendAudioPostClose && process.env.NODE_ENV !== 'production') {
        warnedSendAudioPostClose = true;
        console.warn('[heygen-bridge] sendAudio called after close() — controller bug, dropping');
      }
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // Single-pending-utterance discipline.
    // (1) If interrupt is in flight, drop incoming audio. The consumer
    //     should wait for speak_ended (which clears interruptInFlight)
    //     before sending more audio. Surfacing this as a no-op rather
    //     than queueing keeps the bridge's invariants simple — consumer
    //     can re-send when ready.
    if (interruptInFlight) return;

    // (2) New utterance: assign a fresh event_id, reset chunker carry,
    //     start the audio_buffer_appended deadline timer.
    if (!currentUtteranceEventId) {
      currentUtteranceEventId = uuid4();
      chunkerBuf = new Uint8Array(0);
      currentTaskId = null;
      if (audioBufferAppendedTimer) clearTimeout(audioBufferAppendedTimer);
      audioBufferAppendedTimer = setTimeout(() => {
        if (closed) return;
        // Phase 0 §7: server silently drops new utterance if prior wasn't
        // ended. Most likely cause: missing the interrupt handshake.
        // Surface as a recoverable warning WITHOUT tearing down — the
        // consumer decides whether to retry / reopen.
        //
        // Final-audit M2 — RESET utterance state when the timer fires so
        // the next sendAudio() arms a fresh timer. Without this reset,
        // currentUtteranceEventId stays non-null and subsequent sendAudio
        // calls skip the timer-arm path → consumer streams PCM into a
        // black hole for the rest of the session with no further warning.
        // The trade-off: a recovery utterance starts on a NEW event_id,
        // and the (presumed-dead) prior task on the server may eventually
        // ack — that ack hits the inbound handler with an unrecognized
        // task.id and is dropped, which is the correct behavior.
        currentUtteranceEventId = null;
        currentTaskId = null;
        chunkerBuf = new Uint8Array(0);
        audioBufferAppendedTimer = null;
        try {
          handlers.onError?.({
            code: 'silent_drop_no_speak_end',
            message: 'no audio_buffer_appended within 4s of agent.speak — possible server-side drop or network glitch (utterance state reset)',
            recoverable: true,
          });
        } catch { /* */ }
      }, AUDIO_BUFFER_APPENDED_TIMEOUT_MS);
    }

    if (!firstAudioFired) {
      firstAudioFired = true;
      firstAudioAtMs = performance.now();
      try { handlers.onFirstAudioSent?.(); } catch { /* */ }
    }

    // Ring-buffer chunker — same pattern as simli-bridge.ts:443-471 but
    // 960-byte cadence (20ms @ 24k, audit-validated as fastest in Phase 0).
    const incoming = new Uint8Array(pcm16le24k);
    if (incoming.byteLength === 0) return;
    const merged = new Uint8Array(chunkerBuf.byteLength + incoming.byteLength);
    merged.set(chunkerBuf, 0);
    merged.set(incoming, chunkerBuf.byteLength);
    let offset = 0;
    while (merged.byteLength - offset >= HEYGEN_CHUNK_BYTES) {
      const slice = merged.subarray(offset, offset + HEYGEN_CHUNK_BYTES);
      sendChunkedSpeak(currentUtteranceEventId, slice);
      offset += HEYGEN_CHUNK_BYTES;
    }
    chunkerBuf = offset < merged.byteLength
      ? merged.slice(offset)
      : new Uint8Array(0);

    // For HeyGen we DO NOT auto-send agent.speak_end on every sendAudio
    // tail — speak_end signals end-of-utterance. Cartesia delivers a final
    // PCM frame followed by a turn boundary; the consumer (recording-
    // controller) must call commitUtterance() on the bridge at the turn
    // boundary. If the consumer never commits, the active utterance hangs
    // — Phase 0 §7 requires explicit speak_end.
  }

  // Consumer signals "this utterance's PCM is fully delivered, send the
  // server-side speak_end now." Required for HeyGen — without it the
  // server keeps buffering and the next sendAudio() will silently drop.
  // (Not part of AvatarBridge today — exposed via the returned object for
  // controllers that explicitly target HeyGen. Consumers writing to the
  // generic interface can also drive turn boundaries via cancel() which
  // implies end-of-utterance via interrupt.)
  function commitUtterance(): void {
    if (closed || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (!currentUtteranceEventId) return;
    // Final-audit M1 — race guard. cancel() set interruptInFlight=true
    // and already cleared the chunker. A turn_complete arriving in the
    // ~ms window between cancel() and the server's speak_ended ack must
    // NOT send agent.speak_end on the same event_id we just interrupted.
    // The server's behavior on interrupt+speak_end-on-same-event is
    // unverified by Phase 0 — fail safe by skipping.
    if (interruptInFlight) return;
    // Flush any pending chunker carry as a final partial chunk.
    if (chunkerBuf.byteLength > 0) {
      sendChunkedSpeak(currentUtteranceEventId, chunkerBuf);
      chunkerBuf = new Uint8Array(0);
    }
    sendSpeakEnd(currentUtteranceEventId);
    // Don't reset currentUtteranceEventId here — the server's
    // agent.speak_ended frame is the canonical clear signal, since the
    // server still needs to render audio after we send speak_end.
  }

  function cancel(): void {
    if (closed) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Single-pending-utterance: collapse repeat-cancels into one
    // pending interrupt (audit-r2 C5).
    if (interruptInFlight) return;
    interruptInFlight = true;
    chunkerBuf = new Uint8Array(0);
    if (audioBufferAppendedTimer) {
      clearTimeout(audioBufferAppendedTimer);
      audioBufferAppendedTimer = null;
    }
    sendInterrupt();
  }

  async function rebindMediaSource(): Promise<void> {
    if (closed || !videoEl || !currentRoomMediaStream) return;
    try {
      videoEl.srcObject = null;
      videoEl.srcObject = currentRoomMediaStream;
      const p = (videoEl as HTMLVideoElement & { play?: () => Promise<void> }).play?.();
      if (p) await p;
    } catch {
      // Surfaces via the consumer's reconnect overlay path.
    }
  }

  function close(): void {
    if (closed) return;
    intentionalClose = true;
    closed = true;
    if (audioBufferAppendedTimer) {
      clearTimeout(audioBufferAppendedTimer);
      audioBufferAppendedTimer = null;
    }
    if (!minuteAccrualFired && openedAtMs > 0) {
      minuteAccrualFired = true;
      const seconds = Math.max(0, (Date.now() - openedAtMs) / 1000);
      try { handlers.onMinuteAccrual?.(seconds); } catch { /* */ }
    }
    safeCloseWs();
    safeDisconnectRoom();
    detachOwnedElements();
    chunkerBuf = new Uint8Array(0);
    currentUtteranceEventId = null;
    currentTaskId = null;
    interruptInFlight = false;
    videoEl = null;
    audioEl = null;
    currentVideoTrack = null;
    currentAudioTrack = null;
    currentRoomMediaStream = null;
  }

  function getCurrentTracks(): { video: MediaStreamTrack | null; audio: MediaStreamTrack | null } {
    return { video: currentVideoTrack, audio: currentAudioTrack };
  }

  function setLocalPlayback(audible: boolean): void {
    localPlaybackAudible = audible;
    applyLocalPlayback();
  }

  // commitUtterance is now part of the AvatarBridge interface as an
  // optional method (post-build audit C2). Consumers (recording-
  // controller) call it at Cartesia turn-boundary frames when
  // bridge.commitUtterance is defined; Simli/Tavus bridges leave it
  // undefined.
  const bridge: AvatarBridge = {
    provider,
    open,
    sendAudio,
    cancel,
    close,
    getCurrentTracks,
    setLocalPlayback,
    rebindMediaSource,
    commitUtterance,
  };
  return bridge;
}
