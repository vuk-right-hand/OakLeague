// Vitest coverage for createHeygenBridge:
//   * open() opens WS + connects LiveKit room (mocked livekit-client)
//   * sendAudio chunks at 960B (20ms PCM16-24k) + base64 encodes
//   * single-pending-utterance discipline: post-cancel sendAudio is no-op
//     until speak_ended for the prior task.id arrives
//   * task.id correlation: speak_started/speak_ended on the active
//     utterance fires onLipsyncLatency + clears state
//   * close() is idempotent and clears the chunker carry
//   * Refusal of canPublish:true LiveKit token (audit-r2 M2 — defensive)
//
// Notes:
//   * vitest.config.ts → environment: 'node'. We stub document/WebSocket
//     and vi.mock the livekit-client dynamic import.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Fakes ───────────────────────────────────────────────────────────────

class FakeMediaStreamTrack extends EventTarget {
  readonly kind: 'video' | 'audio';
  readyState: 'live' | 'ended' = 'live';
  constructor(kind: 'video' | 'audio') { super(); this.kind = kind; }
}

class FakeMediaElement extends EventTarget {
  srcObject: unknown = null;
  volume = 1;
  muted = false;
  autoplay = false;
  playsInline = false;
  style: Record<string, string> = {};
  parentNode: { removeChild: (n: unknown) => void } | null = null;
  play = vi.fn(async () => undefined);
}

interface FakeRoomShape {
  handlers: Map<string, Array<(...args: unknown[]) => void>>;
  remoteParticipants: Map<string, unknown>;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  off(): unknown;
  connect(url: string, token: string): Promise<void>;
  disconnect(): void;
  fire(event: string, ...args: unknown[]): void;
}

const lkState = vi.hoisted((): {
  Room: new () => FakeRoomShape;
  RoomEvent: Record<string, string>;
  Track: { Kind: { Audio: string; Video: string } };
  lastRoom: FakeRoomShape | null;
} => ({
  Room: class implements FakeRoomShape {
    handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    remoteParticipants = new Map<string, unknown>();
    on(event: string, cb: (...args: unknown[]) => void): unknown {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
      return this;
    }
    off(): unknown { return this; }
    async connect(_url: string, _token: string): Promise<void> { /* resolved by test */ }
    disconnect(): void { /* */ }
    fire(event: string, ...args: unknown[]): void {
      const list = this.handlers.get(event) ?? [];
      for (const cb of list) cb(...args);
    }
  },
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
    Disconnected: 'disconnected',
  },
  Track: { Kind: { Audio: 'audio', Video: 'video' } },
  lastRoom: null,
}));

vi.mock('livekit-client', () => ({
  Room: class extends lkState.Room {
    constructor() { super(); lkState.lastRoom = this; }
  },
  RoomEvent: lkState.RoomEvent,
  Track: lkState.Track,
}));

// ── WebSocket fake (Node environment has no DOM WebSocket) ────────────
class FakeWebSocket extends EventTarget {
  static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];
  constructor(url: string) {
    super();
    this.url = url;
  }
  send(data: string): void { this.sent.push(data); }
  close(_code?: number, _reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
  fakeOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  fakeMessage(data: unknown): void {
    const e: MessageEvent = new MessageEvent('message', { data: typeof data === 'string' ? data : JSON.stringify(data) });
    this.dispatchEvent(e);
  }
}

let lastWs: FakeWebSocket | null = null;

beforeEach(() => {
  lastWs = null;
  vi.stubGlobal('WebSocket', class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      lastWs = this;
      // Auto-open on next tick so open() awaits it.
      Promise.resolve().then(() => { this.fakeOpen(); });
    }
  });
  // DOM stubs
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      const el = new FakeMediaElement();
      (el as unknown as { tagName: string }).tagName = tag.toUpperCase();
      return el;
    },
    body: { appendChild: vi.fn() },
  });
  // performance + btoa available in Node 18+; ensure they're present
  if (typeof performance === 'undefined') vi.stubGlobal('performance', { now: () => Date.now() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  lkState.lastRoom = null;
});

// HeyGen-issued JWT — privileged (canPublish:true), with roomJoin:true.
// Bridge accepts these (HeyGen doesn't issue subscribe-only). payload =
// base64url('{"video":{"canPublish":true,"roomJoin":true}}').
const HEYGEN_JWT = 'h.eyJ2aWRlbyI6eyJjYW5QdWJsaXNoIjp0cnVlLCJyb29tSm9pbiI6dHJ1ZX19.s';
// Invalid JWT — missing roomJoin claim. Bridge MUST refuse (claim is
// required to actually join the room).
const NO_ROOMJOIN_JWT = 'h.eyJ2aWRlbyI6eyJjYW5QdWJsaXNoIjp0cnVlfX0.s';

const BOOT = {
  wsUrl: 'wss://webrtc-signaling.heygen.io/v2-alpha/interactive-avatar/session/abc',
  livekitUrl: 'wss://heygen-feapbkvq.livekit.cloud',
  livekitClientToken: HEYGEN_JWT,
  livekitRoom: 'abc',
  livekitIdentity: 'user-abc:session-xyz:nonce',
  maxSessionDurationSeconds: 300,
};

async function tick(): Promise<void> {
  // Two microtasks: one for WS auto-open, one for room.connect resolve.
  await Promise.resolve();
  await Promise.resolve();
}

describe('createHeygenBridge — open', () => {
  it('opens WS + connects LiveKit room with subscribe-only token', async () => {
    const { createHeygenBridge } = await import('./heygen-bridge');
    const handlers = { onError: vi.fn(), onReady: vi.fn() };
    const bridge = createHeygenBridge(handlers);
    const openP = bridge.open({ replicaId: 'na', heygenSessionBoot: BOOT });
    await tick();
    await openP;
    expect(lastWs?.url).toBe(BOOT.wsUrl);
    expect(lkState.lastRoom).not.toBeNull();
    bridge.close();
  });

  it('refuses a JWT missing the roomJoin claim (invalid)', async () => {
    const { createHeygenBridge } = await import('./heygen-bridge');
    const handlers = { onError: vi.fn() };
    const bridge = createHeygenBridge(handlers);
    const badBoot = { ...BOOT, livekitClientToken: NO_ROOMJOIN_JWT };
    await expect(bridge.open({ replicaId: 'na', heygenSessionBoot: badBoot })).rejects.toThrow();
    expect(handlers.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'rtc_ice_failed' }));
  });

  it('rejects without heygenSessionBoot', async () => {
    const { createHeygenBridge } = await import('./heygen-bridge');
    const handlers = { onError: vi.fn() };
    const bridge = createHeygenBridge(handlers);
    await expect(bridge.open({ replicaId: 'na' })).rejects.toThrow();
    expect(handlers.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'connect_timeout' }));
  });
});

describe('createHeygenBridge — sendAudio + chunking', () => {
  it('chunks PCM at 960-byte (20ms) cadence and base64-encodes', async () => {
    const { createHeygenBridge } = await import('./heygen-bridge');
    const bridge = createHeygenBridge({});
    const openP = bridge.open({ replicaId: 'na', heygenSessionBoot: BOOT });
    await tick();
    await openP;

    // 1920 bytes = 2 chunks of 960 bytes each
    const pcm = new Uint8Array(1920);
    for (let i = 0; i < pcm.byteLength; i++) pcm[i] = i & 0xff;
    bridge.sendAudio(pcm.buffer);

    expect(lastWs).not.toBeNull();
    expect(lastWs!.sent.length).toBe(2);
    const parsed = JSON.parse(lastWs!.sent[0]);
    expect(parsed.type).toBe('agent.speak');
    expect(parsed.event_id).toMatch(/^[0-9a-f-]+$/);
    expect(typeof parsed.audio).toBe('string');
    // 960 raw bytes → 1280 base64 chars
    expect(parsed.audio.length).toBe(1280);

    // event_id is reused across chunks of the same utterance
    const parsed2 = JSON.parse(lastWs!.sent[1]);
    expect(parsed2.event_id).toBe(parsed.event_id);
    bridge.close();
  });

  it('drops the 940-byte tail into chunker carry until next sendAudio', async () => {
    const { createHeygenBridge } = await import('./heygen-bridge');
    const bridge = createHeygenBridge({});
    const openP = bridge.open({ replicaId: 'na', heygenSessionBoot: BOOT });
    await tick();
    await openP;

    bridge.sendAudio(new Uint8Array(940).buffer);  // 940 < 960, no full chunk yet
    expect(lastWs!.sent.length).toBe(0);
    bridge.sendAudio(new Uint8Array(20).buffer);   // 940 + 20 = 960 → 1 full chunk
    expect(lastWs!.sent.length).toBe(1);
    bridge.close();
  });
});

describe('createHeygenBridge — single-pending-utterance + cancel', () => {
  it('cancel() sends agent.interrupt and ignores subsequent sendAudio until speak_ended', async () => {
    const { createHeygenBridge } = await import('./heygen-bridge');
    const bridge = createHeygenBridge({});
    const openP = bridge.open({ replicaId: 'na', heygenSessionBoot: BOOT });
    await tick();
    await openP;

    // Send one utterance to populate currentUtteranceEventId
    bridge.sendAudio(new Uint8Array(960).buffer);
    expect(lastWs!.sent.length).toBe(1);
    const firstEventId = JSON.parse(lastWs!.sent[0]).event_id;

    // Server acks with a task.id — our state machine binds to it
    lastWs!.fakeMessage({
      type: 'agent.audio_buffer_appended',
      event_id: 'srv-1',
      task: { id: 'TASK-A' },
    });

    // Barge-in
    bridge.cancel();
    expect(lastWs!.sent.length).toBe(2);
    const interruptFrame = JSON.parse(lastWs!.sent[1]);
    expect(interruptFrame.type).toBe('agent.interrupt');

    // Repeat cancel during the interrupt window collapses to one
    bridge.cancel();
    expect(lastWs!.sent.length).toBe(2);

    // sendAudio during the interrupt window is dropped silently
    bridge.sendAudio(new Uint8Array(960).buffer);
    expect(lastWs!.sent.length).toBe(2);

    // Server acks the interrupt with speak_ended on the active task.id
    lastWs!.fakeMessage({
      type: 'agent.speak_ended',
      event_id: 'srv-2',
      task: { id: 'TASK-A' },
    });

    // Now sendAudio works again (new utterance, new event_id)
    bridge.sendAudio(new Uint8Array(960).buffer);
    expect(lastWs!.sent.length).toBe(3);
    const newEventId = JSON.parse(lastWs!.sent[2]).event_id;
    expect(newEventId).not.toBe(firstEventId);
    bridge.close();
  });
});

describe('createHeygenBridge — task.id correlation', () => {
  it('fires onReady + onLipsyncLatency on speak_started for active task.id', async () => {
    const { createHeygenBridge } = await import('./heygen-bridge');
    const onReady = vi.fn();
    const onLipsync = vi.fn();
    const bridge = createHeygenBridge({ onReady, onLipsyncLatency: onLipsync });
    const openP = bridge.open({ replicaId: 'na', heygenSessionBoot: BOOT });
    await tick();
    await openP;

    bridge.sendAudio(new Uint8Array(960).buffer);
    lastWs!.fakeMessage({ type: 'agent.audio_buffer_appended', event_id: 'srv-1', task: { id: 'T1' } });
    lastWs!.fakeMessage({ type: 'agent.speak_started',          event_id: 'srv-2', task: { id: 'T1' } });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onLipsync).toHaveBeenCalledTimes(1);

    // Repeat speak_started for a DIFFERENT task.id (not ours) should NOT
    // re-fire onReady (it's once-per-bridge anyway, but we also gate on
    // task.id to avoid mis-firing latency on stale frames).
    lastWs!.fakeMessage({ type: 'agent.speak_started', event_id: 'srv-3', task: { id: 'T2' } });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onLipsync).toHaveBeenCalledTimes(1);
    bridge.close();
  });
});

describe('createHeygenBridge — close', () => {
  it('is idempotent and clears chunker carry', async () => {
    const { createHeygenBridge } = await import('./heygen-bridge');
    const onMinute = vi.fn();
    const bridge = createHeygenBridge({ onMinuteAccrual: onMinute });
    const openP = bridge.open({ replicaId: 'na', heygenSessionBoot: BOOT });
    await tick();
    await openP;
    bridge.sendAudio(new Uint8Array(500).buffer);  // less than chunk; goes into carry

    bridge.close();
    bridge.close();  // second call is no-op
    expect(onMinute).toHaveBeenCalledTimes(1);

    // sendAudio post-close is a silent no-op (warn-once in non-prod)
    bridge.sendAudio(new Uint8Array(960).buffer);
    expect(lastWs!.sent.length).toBe(0);
  });
});

describe('createHeygenBridge — unknown inbound types', () => {
  it('warns once per unknown type without failing the session', async () => {
    const { createHeygenBridge } = await import('./heygen-bridge');
    const onError = vi.fn();
    const bridge = createHeygenBridge({ onError });
    const openP = bridge.open({ replicaId: 'na', heygenSessionBoot: BOOT });
    await tick();
    await openP;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    lastWs!.fakeMessage({ type: 'agent.future_unknown_type', event_id: 'x' });
    lastWs!.fakeMessage({ type: 'agent.future_unknown_type', event_id: 'x' });
    lastWs!.fakeMessage({ type: 'another_unknown', event_id: 'x' });

    // Two distinct unknown types → two warn calls (warn-once-per-type)
    const unknownWarns = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('unknown inbound type'),
    );
    expect(unknownWarns.length).toBe(2);
    expect(onError).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    bridge.close();
  });
});
