// SIMLI_WIREUP §B1 / R3-C3 — typed WebSocket client for the Fly voice proxy.
//
// Wraps the /voice/spike-a binary-frame contract (server/voice-proxy/index.js).
// The brain WS transport for use-session-pipe.ts.
//
// Wire contract (mirrors proxy ws.on('message')):
//   client → proxy:
//     binary  = PCM16 LE 16k mono mic frame
//     text    = control JSON: { type:'turn_start' | 'turn_end' | 'cancel' }
//   proxy → client:
//     binary  = audio_out PCM frame (sample rate per session — for cutover
//               this is 16k, ready to feed SimliBridge.sendAudio directly)
//     text    = ready / error / warning / tts_reconnected / tts_reconnecting
//
// Overlap swap (R3-C3): swapTo(newTicket) opens a NEW WS, then drains the
// OLD WS for ≤2s as read-only-no-send. Mic frames go to the NEW WS only
// from the moment newWs is open. Audio_out frames from BOTH WSs are routed
// to the consumer's onAudioOut handler — Simli's chunker tolerates the
// brief overlap. After 2s the old WS is force-closed.

'use client';

const OVERLAP_DRAIN_MS = 2000;

export type ProxyClientHandlers = {
  onReady?: (msg: { sessionId: string; useTtsLayer: boolean; build: string }) => void;
  onAudioOut?: (bytes: ArrayBuffer) => void;
  onError?: (code: string, detail?: string) => void;
  onWarning?: (code: string) => void;
  // Growth & Minutes Economy Phase 2 — answer-end soft gate. The user hit 100%
  // of their minutes mid-session; the proxy denied the NEXT turn GRACEFULLY (WS
  // stays open) and the server owns the idle kill. NOT an error — the client
  // stops the mic and shows an in-session upsell.
  onTierExhausted?: (remainingSeconds: number, capPeriod: string | null, walletExhausted: boolean, trip: string | null) => void;
  onTtsReconnecting?: () => void;
  onTtsReconnected?: () => void;
  // FISH_AUDIO_PHASE_1 §6 round-3 C4 (code audit M4) — Fish→Cartesia
  // auto-fallback mid-session swap. Info-level event; no toast or error
  // overlay. The session-client surfaces a subtle "Switching voice…"
  // badge so the avatar lipsync doesn't freeze mid-mouth-open during the
  // ~200-1000ms cartesia cold-open. No reciprocal "switched" event today
  // — the next `audio_out` from the sidecar IS the resumed-synthesis
  // signal; the banner clears on the next `tts_audio_done`.
  onTtsProviderSwitching?: (from: string, to: string) => void;
  onClose?: (code: number, reason: string, wasClean: boolean) => void;
  // Server-emitted brain turn boundary. Used by the HeyGen bridge path
  // to dispatch commitUtterance() at end-of-turn — without it the
  // server silently drops the next utterance (Phase 0 §7).
  // Simli/Tavus consumers can ignore.
  onTurnComplete?: () => void;
  // Per-utterance "deep answer done" (2026-05-25). Fired by the proxy the moment
  // a turn's TEXT finishes streaming to TTS. NOTE (2026-05-27 v2): this is NOT
  // end-of-audio — Cartesia keeps synthesizing for 20-40s after on long answers.
  // No longer used for the tail-flush (that caused mid-answer stutter); kept for
  // observability only. The real end-of-audio flush is onTtsAudioDone.
  onDeepAnswerDone?: () => void;
  // True end-of-audio for a turn (2026-05-27 v2). Fired by the proxy on
  // Cartesia's real `done` (context-gated to the live turn). The consumer
  // flushes the avatar tail-carry ONCE here — replaces the old repeated
  // 200ms-gap tail-flush that injected silence mid-answer (the stutter).
  onTtsAudioDone?: () => void;
};

export type ProxyClientOpenArgs = {
  proxyUrl: string;       // e.g. wss://oakleague-voice-proxy.fly.dev
  ticket: string;
  modelWire: string;      // e.g. 'gemini-3.1-flash-live-preview'
};

export type ProxyClient = {
  /** Open the WS. Resolves on `ready` from the server, rejects on early close. */
  open(args: ProxyClientOpenArgs): Promise<void>;
  /** Send mic PCM16 16k binary frame. No-op when not OPEN. */
  sendAudio(pcm16le16k: ArrayBuffer): void;
  /** Send a control message: turn_start / turn_end / cancel. */
  sendControl(msg: Record<string, unknown>): void;
  /**
   * Overlap-swap to a new ticket (R3-C3). Opens new WS, routes mic to new
   * from t=0, drains old's audio_out for ≤2s, then closes old. Mic invariant:
   * frames go to the NEW socket only — never both. Resolves when new WS
   * receives `ready`.
   */
  swapTo(args: ProxyClientOpenArgs): Promise<void>;
  /** Idempotent close. */
  close(reason?: string): void;
  /** True if the active socket is OPEN. */
  isOpen(): boolean;
};

type Sock = {
  ws: WebSocket;
  readonly: boolean;          // true = drain-only, do NOT send mic / control
};

export function createProxyClient(handlers: ProxyClientHandlers): ProxyClient {
  let active: Sock | null = null;
  let draining: Sock | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function buildUrl(args: ProxyClientOpenArgs): string {
    const u = new URL(args.proxyUrl);
    u.pathname = '/voice/spike-a';
    u.searchParams.set('ticket', args.ticket);
    u.searchParams.set('model', args.modelWire);
    return u.toString();
  }

  function attachListeners(sock: Sock): void {
    const ws = sock.ws;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (ev) => {
      if (closed) return;
      if (typeof ev.data === 'string') {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const type = msg.type as string | undefined;
        if (type === 'ready') {
          handlers.onReady?.({
            sessionId: String(msg.sessionId ?? ''),
            // Accept new key, fall back to legacy `useCartesia` during the
            // Fly migration window — old proxy deploys still emit only the
            // old key. Audit S5 — strict `=== true` (NOT Boolean()): the
            // proxy emits a real JSON boolean; Boolean("false") === true
            // would fail OPEN on a malformed payload. Parity with the safe
            // form in voice-config.ts.
            useTtsLayer: msg.useTtsLayer === true || msg.useCartesia === true,
            build: String(msg.build ?? ''),
          });
        } else if (type === 'error') {
          handlers.onError?.(String(msg.code ?? 'unknown'), msg.detail as string | undefined);
        } else if (type === 'warning') {
          handlers.onWarning?.(String(msg.code ?? 'unknown'));
        } else if (type === 'tier_exhausted') {
          // Audit S3 — clamp a malformed remaining_seconds to a finite 0 rather
          // than letting NaN flow to the reducer / PostHog.
          const rem = Number(msg.remaining_seconds ?? 0);
          handlers.onTierExhausted?.(
            Number.isFinite(rem) ? Math.max(0, Math.floor(rem)) : 0,
            (msg.cap_period as string | null) ?? null,
            msg.wallet_exhausted === true, // C4 — buy-vs-wait copy
            (msg.trip as string | null) ?? null, // M-A — telemetry discriminator
          );
        } else if (type === 'tts_reconnecting') {
          handlers.onTtsReconnecting?.();
        } else if (type === 'tts_reconnected') {
          handlers.onTtsReconnected?.();
        } else if (type === 'tts_provider_switching') {
          // FISH_AUDIO_PHASE_1 §6 round-3 C4 (audit M4) — auto-fallback
          // mid-session swap hint. Defensive on payload shape: missing
          // from/to coerce to 'unknown' so a future proxy variant can't
          // crash the client by omitting either field. Audit M4 (code) —
          // if the proxy ever sends a payload with non-string from/to,
          // surface a Sentry warning so the dashboards see "unknown" as
          // a regression, not a legitimate data point.
          const rawFrom = msg.from;
          const rawTo = msg.to;
          if (typeof rawFrom !== 'string' || typeof rawTo !== 'string') {
            // Lazy-load Sentry to avoid an import cycle in this lib.
            import('@sentry/nextjs').then((Sentry) => {
              Sentry.captureMessage('tts_provider_switching_malformed_payload', {
                level: 'warning',
                extra: { rawFrom: String(rawFrom), rawTo: String(rawTo) },
              });
            }).catch(() => { /* never crash the WS on telemetry import */ });
          }
          handlers.onTtsProviderSwitching?.(
            typeof rawFrom === 'string' ? rawFrom : 'unknown',
            typeof rawTo === 'string' ? rawTo : 'unknown',
          );
        } else if (type === 'turn_complete') {
          handlers.onTurnComplete?.();
        } else if (type === 'deep_answer_done') {
          handlers.onDeepAnswerDone?.();
        } else if (type === 'tts_audio_done') {
          handlers.onTtsAudioDone?.();
        }
        return;
      }
      // Binary = audio_out from Cartesia. Both active and draining sockets
      // forward; Simli chunker dedupes by virtue of feeding sequentially.
      if (ev.data instanceof ArrayBuffer) {
        handlers.onAudioOut?.(ev.data);
      } else if (ev.data && typeof (ev.data as Blob).arrayBuffer === 'function') {
        // Safari may surface Blob even when binaryType=arraybuffer pre-handshake.
        (ev.data as Blob).arrayBuffer().then((buf) => {
          if (!closed) handlers.onAudioOut?.(buf);
        }).catch(() => { /* drop */ });
      }
    });
    ws.addEventListener('close', (ev) => {
      // Only the ACTIVE socket's close drives consumer state. Drain socket
      // closes silently.
      if (sock === active) {
        handlers.onClose?.(ev.code, ev.reason, ev.wasClean);
        active = null;
      } else if (sock === draining) {
        draining = null;
        if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
      }
    });
    ws.addEventListener('error', () => {
      // 'error' is followed by 'close'; let close drive the consumer signal.
    });
  }

  async function openSocket(args: ProxyClientOpenArgs, opts: { readonly: boolean }): Promise<Sock> {
    const url = buildUrl(args);
    const ws = new WebSocket(url);
    const sock: Sock = { ws, readonly: opts.readonly };
    attachListeners(sock);
    return new Promise<Sock>((resolve, reject) => {
      let settled = false;
      const onReadyOnce = (ev: MessageEvent) => {
        if (typeof ev.data !== 'string') return;
        try {
          const msg = JSON.parse(ev.data) as { type?: string };
          if (msg.type === 'ready') {
            settled = true;
            ws.removeEventListener('message', onReadyOnce);
            resolve(sock);
          }
        } catch { /* ignore */ }
      };
      ws.addEventListener('message', onReadyOnce);
      ws.addEventListener('close', (ev) => {
        if (!settled) {
          settled = true;
          reject(new Error(`proxy ws closed ${ev.code} ${ev.reason}`));
        }
      });
      ws.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          reject(new Error('proxy ws error'));
        }
      });
    });
  }

  async function open(args: ProxyClientOpenArgs): Promise<void> {
    if (closed) throw new Error('proxy-client: open() after close()');
    if (active) throw new Error('proxy-client: already open');
    active = await openSocket(args, { readonly: false });
  }

  function sendAudio(pcm16le16k: ArrayBuffer): void {
    if (closed || !active) return;
    if (active.ws.readyState !== WebSocket.OPEN) return;
    try { active.ws.send(pcm16le16k); } catch { /* drop */ }
  }

  function sendControl(msg: Record<string, unknown>): void {
    if (closed || !active) return;
    if (active.ws.readyState !== WebSocket.OPEN) return;
    try { active.ws.send(JSON.stringify(msg)); } catch { /* drop */ }
  }

  async function swapTo(args: ProxyClientOpenArgs): Promise<void> {
    if (closed) throw new Error('proxy-client: swapTo() after close()');
    // R3-C3 — overlap-swap. Open the new socket FIRST so audio_out from
    // the new pipe can start flowing instantly. Mic invariant: as soon as
    // we flip `active` to the new sock, ALL future sendAudio calls go to
    // new. The old sock becomes drain-only (readonly=true).
    const newSock = await openSocket(args, { readonly: false });
    const oldActive = active;
    active = newSock;
    if (oldActive) {
      oldActive.readonly = true;
      draining = oldActive;
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = setTimeout(() => {
        if (draining) {
          try { draining.ws.close(1000, 'overlap_drain_done'); } catch { /* already closed */ }
          draining = null;
        }
        drainTimer = null;
      }, OVERLAP_DRAIN_MS);
    }
  }

  function close(reason?: string): void {
    if (closed) return;
    closed = true;
    const r = (reason ?? 'client_close').slice(0, 60);
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    try { active?.ws.close(1000, r); } catch { /* already */ }
    try { draining?.ws.close(1000, r); } catch { /* already */ }
    active = null;
    draining = null;
  }

  function isOpen(): boolean {
    return !!active && active.ws.readyState === WebSocket.OPEN;
  }

  return { open, sendAudio, sendControl, swapTo, close, isOpen };
}
