// TavusBridge — premium/boardroom-tier primary. Implements AvatarBridge.
//
// Transport: daily-js joins a Tavus `conversation_url`. Conversation created
// server-side with `pipeline_mode='echo'` so Tavus plays back exactly the
// audio we send. Per-replica model is Phoenix-4 (Gaussian-diffusion,
// sub-600ms, active-listening). No Tavus LLM / no Tavus TTS in our setup.
//
// Dependency: `@daily-co/daily-js` (`npm i @daily-co/daily-js`) before Phase 1
// smoke. Dynamic-imported for the same reason as simli-client.
//
// Audio ingest path: canonical vs. `sendAppMessage` is resolved in Phase 0.
// Current default: publish a local audio track built from the PCM16 stream
// (worklet resamples 16k→24k and pumps an MSE SourceBuffer is too much; we
// instead construct a MediaStreamTrack from a MediaStreamTrackGenerator when
// available, falling back to sendAppMessage). Phase 0 finding flips which
// path is live.
//
// Error taxonomy map:
//   Conversation create 401/403 → 'token_expired'
//   Conversation create 404     → 'replica_not_found'
//   Conversation create 409     → 'replica_not_ready'
//   Conversation create 429     → 'quota_exceeded'
//   daily-js 'error' event      → 'rtc_ice_failed'
//   daily-js 'left-meeting' after TTL → 'session_ttl_expired'
//   daily-js 'app-message' > limit → 'app_message_too_large'
//   Other                       → 'other' (raw preserved)

'use client';

import type {
  AvatarBridge,
  AvatarBridgeHandlers,
  AvatarError,
  AvatarOpenOptions,
  AvatarProvider,
} from './avatar-bridge';

type DailyCallLike = {
  join(args: { url: string }): Promise<unknown>;
  leave(): Promise<void>;
  destroy(): Promise<void> | void;
  on(event: string, cb: (evt: unknown) => void): DailyCallLike;
  sendAppMessage(msg: unknown, to?: string): void;
  startCustomTrack?(args: { track: MediaStreamTrack; trackName?: string }): Promise<unknown>;
};

type DailyModule = {
  default?: { createCallObject: (cfg?: unknown) => DailyCallLike };
  createCallObject?: (cfg?: unknown) => DailyCallLike;
};

export type TavusSessionBoot = {
  provider: 'tavus';
  conversation_id: string;
  conversation_url: string; // scoped to max_call_duration TTL
  expires_at: string;
};

export function createTavusBridge(handlers: AvatarBridgeHandlers): AvatarBridge {
  const provider: AvatarProvider = 'tavus';

  let call: DailyCallLike | null = null;
  let closed = false;
  let ready = false;
  let firstAudioFired = false;
  // Custom audio track generator — populated when the platform supports it.
  // We keep a reference so sendAudio() can write PCM16 frames into it.
  let audioWriter: WritableStreamDefaultWriter<AudioData> | null = null;

  function fail(err: AvatarError): void {
    if (closed) return;
    closed = true;
    try { handlers.onError?.(err); } catch { /* swallow */ }
    try { audioWriter?.close(); } catch { /* already closed */ }
    try { call?.destroy(); } catch { /* already destroyed */ }
    audioWriter = null;
    call = null;
  }

  async function open(opts: AvatarOpenOptions): Promise<void> {
    if (closed) throw new Error('TavusBridge: open() called after close()');
    if (opts.signal?.aborted) {
      const e: AvatarError = { code: 'connect_timeout', message: 'aborted before open', recoverable: false };
      fail(e); throw e;
    }

    let boot: TavusSessionBoot;
    try {
      const res = await fetch('/api/spike-b/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        signal: opts.signal,
        body: JSON.stringify({ provider: 'tavus', replica_id: opts.replicaId }),
      });
      if (!res.ok) {
        const code =
          res.status === 429 ? 'quota_exceeded' :
          res.status === 401 || res.status === 403 ? 'token_expired' :
          res.status === 404 ? 'replica_not_found' :
          res.status === 409 ? 'replica_not_ready' : 'connect_timeout';
        const err: AvatarError = { code, message: `tavus session mint ${res.status}`, recoverable: false };
        fail(err); throw err;
      }
      boot = (await res.json()) as TavusSessionBoot;
    } catch (e) {
      if ((e as AvatarError).code) throw e;
      const err: AvatarError = {
        code: 'connect_timeout',
        message: 'tavus session mint network error',
        recoverable: true,
        cause: { provider, raw: e },
      };
      fail(err); throw err;
    }

    let mod: DailyModule;
    try {
      mod = (await import('@daily-co/daily-js')) as unknown as DailyModule;
    } catch (e) {
      const err: AvatarError = {
        code: 'connect_timeout',
        message: '@daily-co/daily-js not installed — run `npm i @daily-co/daily-js`',
        recoverable: false,
        cause: { provider, raw: e },
      };
      fail(err); throw err;
    }

    const createCallObject = mod.default?.createCallObject ?? mod.createCallObject;
    if (!createCallObject) {
      const err: AvatarError = {
        code: 'other',
        message: 'daily-js createCallObject not found on module',
        recoverable: false,
        cause: { provider, raw: Object.keys(mod) },
      };
      fail(err); throw err;
    }

    try {
      call = createCallObject({ audioSource: false, videoSource: false });
    } catch (e) {
      const err: AvatarError = {
        code: 'other',
        message: 'daily-js createCallObject threw',
        recoverable: false,
        cause: { provider, raw: e },
      };
      fail(err); throw err;
    }

    call
      .on('track-started', (evt: unknown) => {
        // Remote video track from Tavus replica.
        const e = evt as { track?: MediaStreamTrack; participant?: { local?: boolean } };
        if (e.track?.kind === 'video' && !e.participant?.local) {
          handlers.onVideoTrack?.(e.track);
          if (!ready && !closed) {
            ready = true;
            handlers.onReady?.();
          }
        }
      })
      .on('error', (raw: unknown) => {
        fail({ code: 'rtc_ice_failed', message: 'daily error', recoverable: true, cause: { provider, raw } });
      })
      .on('left-meeting', () => {
        // Leaving after TTL exhaustion vs. explicit close() — if we are not
        // already closed, treat as TTL expiration.
        if (!closed) fail({ code: 'session_ttl_expired', message: 'daily left-meeting', recoverable: false });
      });

    try {
      await call.join({ url: boot.conversation_url });
    } catch (e) {
      const err: AvatarError = {
        code: 'rtc_ice_failed',
        message: 'daily join failed',
        recoverable: true,
        cause: { provider, raw: e },
      };
      fail(err); throw err;
    }

    // Try to stand up a custom audio track via MediaStreamTrackGenerator.
    // Availability: Chrome/Edge 94+, not Safari. On Safari we fall back to
    // sendAppMessage() in sendAudio() — Phase 0 resolves which path is live.
    type MSTGCtor = new (init: { kind: 'audio' }) => MediaStreamTrack & { writable: WritableStream<AudioData> };
    const MSTG = (globalThis as unknown as { MediaStreamTrackGenerator?: MSTGCtor }).MediaStreamTrackGenerator;
    if (MSTG && call.startCustomTrack) {
      try {
        const gen = new MSTG({ kind: 'audio' });
        audioWriter = gen.writable.getWriter();
        await call.startCustomTrack({ track: gen, trackName: 'echo-in' });
      } catch {
        audioWriter = null;
      }
    }
  }

  function sendAudio(pcm16le16k: ArrayBuffer): void {
    if (!call || closed) return;
    if (!firstAudioFired) {
      firstAudioFired = true;
      try { handlers.onFirstAudioSent?.(); } catch { /* callback threw */ }
    }
    if (audioWriter) {
      try {
        const AudioDataCtor = (globalThis as unknown as { AudioData?: new (init: unknown) => AudioData }).AudioData;
        if (!AudioDataCtor) throw new Error('AudioData unavailable');
        const frame = new AudioDataCtor({
          format: 's16',
          sampleRate: 16000,
          numberOfFrames: pcm16le16k.byteLength / 2,
          numberOfChannels: 1,
          timestamp: performance.now() * 1000,
          data: pcm16le16k,
        });
        void audioWriter.write(frame);
      } catch (e) {
        fail({
          code: 'audio_format_rejected',
          message: 'tavus audio writer rejected frame',
          recoverable: false,
          cause: { provider, raw: e },
        });
      }
      return;
    }
    // Fallback: sendAppMessage. Daily caps app-message payload at ~4KB.
    if (pcm16le16k.byteLength > 4000) {
      fail({
        code: 'app_message_too_large',
        message: `chunk ${pcm16le16k.byteLength}B exceeds app-message cap`,
        recoverable: false,
      });
      return;
    }
    try {
      // Loop-based encode avoids call-stack overflow from spread on large arrays.
      const bytes = new Uint8Array(pcm16le16k);
      let raw = '';
      for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
      call.sendAppMessage({ type: 'audio', pcm16_16k_b64: btoa(raw) });
    } catch (e) {
      fail({
        code: 'audio_format_rejected',
        message: 'daily sendAppMessage threw',
        recoverable: false,
        cause: { provider, raw: e },
      });
    }
  }

  function cancel(): void {
    if (!call || closed) return;
    // Echo mode has no LLM/TTS of its own to interrupt; the signal is to flush
    // any queued audio frames client-side. We stop writing new frames via the
    // writer and let the in-flight playback finish (no-op for Tavus).
    try { call.sendAppMessage({ type: 'interrupt' }); } catch { /* best-effort */ }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    try { audioWriter?.close(); } catch { /* already closed */ }
    audioWriter = null;
    try { call?.leave(); } catch { /* best-effort */ }
    try { call?.destroy(); } catch { /* already destroyed */ }
    call = null;
  }

  return { provider, open, sendAudio, cancel, close };
}
