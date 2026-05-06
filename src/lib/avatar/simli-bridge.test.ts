// Vitest coverage for the simli-bridge refactor (Plan §23.4, §25.5):
//   - getCurrentTracks() returns null pre-track and the cached tracks after.
//   - LiveKit renegotiation (MediaStream addtrack + MediaStreamTrack 'ended')
//     refreshes the cache and re-fires onVideoTrack / onAudioTrack handlers.
//   - setLocalPlayback toggles audioEl.volume (NOT muted — WebKit drops the
//     track on muted=true mid-WebRTC; spike #3 finding).
//   - close() clears the cache and is idempotent.
//
// vitest.config.ts sets `environment: 'node'`. We stub the DOM globals the
// bridge touches (document, HTMLVideoElement, HTMLAudioElement, MediaStream,
// MediaStreamTrack) with EventTarget-based fakes, and vi.mock the simli-client
// dynamic import so open() drives the wiring without a real SDK.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Fakes ───────────────────────────────────────────────────────────────

class FakeMediaStreamTrack extends EventTarget {
  readonly kind: 'video' | 'audio';
  readyState: 'live' | 'ended' = 'live';
  constructor(kind: 'video' | 'audio') { super(); this.kind = kind; }
  end(): void {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

class FakeMediaStream extends EventTarget {
  private videoTracks: FakeMediaStreamTrack[] = [];
  private audioTracks: FakeMediaStreamTrack[] = [];
  getVideoTracks(): FakeMediaStreamTrack[] { return [...this.videoTracks]; }
  getAudioTracks(): FakeMediaStreamTrack[] { return [...this.audioTracks]; }
  getTracks(): FakeMediaStreamTrack[] { return [...this.videoTracks, ...this.audioTracks]; }
  addVideo(t: FakeMediaStreamTrack): void { this.videoTracks.push(t); this.dispatchEvent(new Event('addtrack')); }
  addAudio(t: FakeMediaStreamTrack): void { this.audioTracks.push(t); this.dispatchEvent(new Event('addtrack')); }
  swapVideo(t: FakeMediaStreamTrack): void {
    // Renegotiation pattern A: same stream, prior track ends, new track added.
    this.videoTracks = [t];
    this.dispatchEvent(new Event('addtrack'));
  }
}

class FakeMediaElement extends EventTarget {
  srcObject: FakeMediaStream | null = null;
  volume = 1;
  muted = false;
  autoplay = false;
  playsInline = false;
  style: Record<string, string> = {};
  parentNode: { removeChild: (n: unknown) => void } | null = null;
  fireLoadedMetadata(): void { this.dispatchEvent(new Event('loadedmetadata')); }
}

// vi.hoisted ensures the mock SDK is constructed lazily inside each test;
// otherwise the dynamic import in open() captures the symbol once for the
// whole file and tests interfere.
const sdkState = vi.hoisted(() => ({
  startResolve: null as (() => void) | null,
  startReject: null as ((e: unknown) => void) | null,
  lastClient: null as unknown,
  audioCalls: [] as Uint8Array[],
  clearBufferCalls: 0,
}));

vi.mock('simli-client', () => {
  class FakeSimliClient {
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    constructor(
      _token: string,
      _video: HTMLVideoElement,
      _audio: HTMLAudioElement,
      _ice: unknown,
      _log: unknown,
      _transport: unknown,
    ) {
      sdkState.lastClient = this;
    }
    on(ev: string, cb: (...args: unknown[]) => void): void {
      (this.listeners[ev] ??= []).push(cb);
    }
    off(): void { /* unused */ }
    start(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        sdkState.startResolve = resolve;
        sdkState.startReject = reject;
      });
    }
    stop(): Promise<void> { return Promise.resolve(); }
    sendAudioData(chunk: Uint8Array): void {
      // SIMLI_WIREUP §B5 / R3-C1 — record chunks so the chunker test can
      // assert exact 6000-byte cadence + remainder carry behavior.
      sdkState.audioCalls.push(new Uint8Array(chunk));
    }
    ClearBuffer(): void { sdkState.clearBufferCalls += 1; }
  }
  return { SimliClient: FakeSimliClient };
});

// ── Global stubs ────────────────────────────────────────────────────────

let videoEl: FakeMediaElement;
let audioEl: FakeMediaElement;

function installDom(): void {
  videoEl = new FakeMediaElement();
  audioEl = new FakeMediaElement();
  // Bridge calls document.createElement when no els are passed in opts. We
  // pass elements explicitly so document is only touched for the typeof check.
  Object.defineProperty(globalThis, 'document', {
    value: { /* createElement unused — opts.videoEl/audioEl provided */ },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => 1000 },
    configurable: true,
  });
  // The bridge's `instanceof MediaStream` checks need a constructor that
  // FakeMediaStream descends from. Aliasing globalThis.MediaStream to our
  // fake means `srcObject instanceof MediaStream` is true.
  Object.defineProperty(globalThis, 'MediaStream', { value: FakeMediaStream, configurable: true });
}

function uninstallDom(): void {
  for (const k of ['document', 'performance', 'MediaStream'] as const) {
    Object.defineProperty(globalThis, k, { value: undefined, configurable: true });
  }
}

beforeEach(() => { installDom(); });
afterEach(() => {
  uninstallDom();
  sdkState.startResolve = null;
  sdkState.startReject = null;
  sdkState.lastClient = null;
  sdkState.audioCalls = [];
  sdkState.clearBufferCalls = 0;
  vi.restoreAllMocks();
});

// Helper to drive open() to the post-start ready state with both initial tracks.
async function bootBridge() {
  const { createSimliBridge } = await import('./simli-bridge');
  const onVideoTrack = vi.fn();
  const onAudioTrack = vi.fn();
  const onReady = vi.fn();
  const bridge = createSimliBridge({ onVideoTrack, onAudioTrack, onReady });

  // open() is async; resolve the SDK start() once we've fired loadedmetadata.
  const openPromise = bridge.open({
    replicaId: 'r-test',
    preMintedSessionToken: 'tok-test',
    videoEl: videoEl as unknown as HTMLVideoElement,
    audioEl: audioEl as unknown as HTMLAudioElement,
  });

  // Wait for the dynamic import + constructor + start() invocation.
  // sdkState.startResolve is set inside FakeSimliClient.start(), which open()
  // awaits last. Poll a few microtasks until either it's set or we give up.
  for (let i = 0; i < 50 && !sdkState.startResolve; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }

  // SDK has constructed and start() is pending. Populate tracks + fire metadata.
  const stream = new FakeMediaStream();
  const v0 = new FakeMediaStreamTrack('video');
  const a0 = new FakeMediaStreamTrack('audio');
  stream.addVideo(v0);
  stream.addAudio(a0);
  videoEl.srcObject = stream;
  audioEl.srcObject = stream;
  videoEl.fireLoadedMetadata();
  audioEl.fireLoadedMetadata();

  // Resolve start() so open() returns.
  sdkState.startResolve?.();
  await openPromise;

  return { bridge, stream, v0, a0, onVideoTrack, onAudioTrack, onReady };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('getCurrentTracks', () => {
  it('returns null before tracks arrive', async () => {
    const { createSimliBridge } = await import('./simli-bridge');
    const bridge = createSimliBridge({});
    expect(bridge.getCurrentTracks()).toEqual({ video: null, audio: null });
  });

  it('returns cached tracks after loadedmetadata + start resolves', async () => {
    const { bridge, v0, a0, onVideoTrack, onAudioTrack, onReady } = await bootBridge();
    expect(onReady).toHaveBeenCalledOnce();
    expect(onVideoTrack).toHaveBeenCalledOnce();
    expect(onVideoTrack).toHaveBeenCalledWith(v0);
    expect(onAudioTrack).toHaveBeenCalledOnce();
    expect(onAudioTrack).toHaveBeenCalledWith(a0);
    expect(bridge.getCurrentTracks()).toEqual({ video: v0, audio: a0 });
  });

  it('returns null again after close()', async () => {
    const { bridge } = await bootBridge();
    bridge.close();
    expect(bridge.getCurrentTracks()).toEqual({ video: null, audio: null });
  });
});

describe('renegotiation re-fires track handlers', () => {
  it('swapping the video track ends the old + emits the new', async () => {
    const { bridge, stream, v0, onVideoTrack } = await bootBridge();
    expect(onVideoTrack).toHaveBeenCalledTimes(1);

    // LiveKit ICE restart pattern: prior track ends, new track shows up
    // on the SAME MediaStream via 'addtrack'. Both signals refresh the cache;
    // dedupe means the consumer only sees the new track once.
    const v1 = new FakeMediaStreamTrack('video');
    v0.end();
    stream.swapVideo(v1);

    expect(onVideoTrack).toHaveBeenCalledTimes(2);
    expect(onVideoTrack).toHaveBeenLastCalledWith(v1);
    expect(bridge.getCurrentTracks().video).toBe(v1);
  });

  it('audio track renegotiation refires onAudioTrack', async () => {
    const { bridge, stream, a0, onAudioTrack } = await bootBridge();
    expect(onAudioTrack).toHaveBeenCalledTimes(1);

    const a1 = new FakeMediaStreamTrack('audio');
    a0.end();
    // emulate audioEl getting the new track on the same stream
    (stream as unknown as { audioTracks: FakeMediaStreamTrack[] }).audioTracks = [a1];
    stream.dispatchEvent(new Event('addtrack'));

    expect(onAudioTrack).toHaveBeenCalledTimes(2);
    expect(onAudioTrack).toHaveBeenLastCalledWith(a1);
    expect(bridge.getCurrentTracks().audio).toBe(a1);
  });

  it('addtrack with the same track does NOT re-fire (dedupe)', async () => {
    const { stream, onVideoTrack } = await bootBridge();
    expect(onVideoTrack).toHaveBeenCalledTimes(1);
    // Spurious addtrack with no actual swap — bridge dedupes by identity.
    stream.dispatchEvent(new Event('addtrack'));
    expect(onVideoTrack).toHaveBeenCalledTimes(1);
  });
});

describe('setLocalPlayback', () => {
  it('toggles audioEl.volume between 1 and 0 (not muted — WebKit safe)', async () => {
    const { bridge } = await bootBridge();
    expect(audioEl.volume).toBe(1);
    expect(audioEl.muted).toBe(false);

    bridge.setLocalPlayback(false);
    expect(audioEl.volume).toBe(0);
    // Critical: must not flip muted. Spike #3: WebKit drops the track on
    // muted=true mid-WebRTC, severing the audio path entirely.
    expect(audioEl.muted).toBe(false);

    bridge.setLocalPlayback(true);
    expect(audioEl.volume).toBe(1);
    expect(audioEl.muted).toBe(false);
  });

  it('idempotent under repeated calls', async () => {
    const { bridge } = await bootBridge();
    bridge.setLocalPlayback(false);
    bridge.setLocalPlayback(false);
    bridge.setLocalPlayback(false);
    expect(audioEl.volume).toBe(0);
  });
});

describe('close()', () => {
  it('is idempotent', async () => {
    const { bridge } = await bootBridge();
    bridge.close();
    expect(() => bridge.close()).not.toThrow();
  });

  it('does not throw if setLocalPlayback called after close (audioEl null)', async () => {
    const { bridge } = await bootBridge();
    bridge.close();
    expect(() => bridge.setLocalPlayback(false)).not.toThrow();
  });

  it('sendAudio post-close warns once in non-prod (audit C4 integration)', async () => {
    // NODE_ENV is readonly under @types/node — cast through unknown to flip
    // it for the duration of the test.
    const env = process.env as unknown as { NODE_ENV: string | undefined };
    const origNodeEnv = env.NODE_ENV;
    env.NODE_ENV = 'development';
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { bridge } = await bootBridge();
      bridge.close();
      bridge.sendAudio(new ArrayBuffer(4));
      bridge.sendAudio(new ArrayBuffer(4));
      const warnings = warn.mock.calls.filter((c) =>
        typeof c[0] === 'string' && c[0].includes('sendAudio called after close'),
      );
      expect(warnings.length).toBe(1);
      warn.mockRestore();
    } finally {
      env.NODE_ENV = origNodeEnv;
    }
  });
});

describe('srcObject swap (LiveKit reconnect)', () => {
  // C1/C2 fix: when SDK swaps the entire MediaStream on reconnect, the
  // element fires another loadedmetadata. Bridge must rebind addtrack
  // listener to the new stream so subsequent renegotiations are caught.
  it('rebinds to a new srcObject and continues to refire onVideoTrack', async () => {
    const { onVideoTrack } = await bootBridge();
    expect(onVideoTrack).toHaveBeenCalledTimes(1);

    // SDK reconnect: brand new MediaStream replaces srcObject.
    const newStream = new FakeMediaStream();
    const v1 = new FakeMediaStreamTrack('video');
    newStream.addVideo(v1);
    videoEl.srcObject = newStream;
    videoEl.fireLoadedMetadata();

    expect(onVideoTrack).toHaveBeenCalledTimes(2);
    expect(onVideoTrack).toHaveBeenLastCalledWith(v1);

    // Subsequent renegotiation on the NEW stream still fires.
    const v2 = new FakeMediaStreamTrack('video');
    v1.end();
    newStream.swapVideo(v2);

    expect(onVideoTrack).toHaveBeenCalledTimes(3);
    expect(onVideoTrack).toHaveBeenLastCalledWith(v2);
  });

  it('skips a track that arrives in ended state (M5)', async () => {
    // Boot a fresh bridge with NO initial tracks so the only track ever
    // arriving is the dead one — proves the live-state filter, not the
    // identity-dedupe.
    const { createSimliBridge } = await import('./simli-bridge');
    const onVideoTrack = vi.fn();
    const bridge = createSimliBridge({ onVideoTrack });
    const openPromise = bridge.open({
      replicaId: 'r-test',
      preMintedSessionToken: 'tok',
      videoEl: videoEl as unknown as HTMLVideoElement,
      audioEl: audioEl as unknown as HTMLAudioElement,
    });
    for (let i = 0; i < 50 && !sdkState.startResolve; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const stream = new FakeMediaStream();
    const dead = new FakeMediaStreamTrack('video');
    dead.readyState = 'ended';
    stream.addVideo(dead);
    videoEl.srcObject = stream;
    audioEl.srcObject = stream;
    videoEl.fireLoadedMetadata();
    audioEl.fireLoadedMetadata();
    sdkState.startResolve?.();
    await openPromise;

    expect(onVideoTrack).not.toHaveBeenCalled();
    expect(bridge.getCurrentTracks().video).toBeNull();
  });

  it('finds video track on audioEl srcObject as fallback (M2)', async () => {
    // Some LiveKit setups put both tracks on a single MediaStream attached
    // to videoEl, leaving audioEl.srcObject pointing at the same stream OR
    // null. Symmetric fallback exercises the cross-element lookup.
    const { createSimliBridge } = await import('./simli-bridge');
    const onAudioTrack = vi.fn();
    const bridge = createSimliBridge({ onAudioTrack });
    const openPromise = bridge.open({
      replicaId: 'r-test',
      preMintedSessionToken: 'tok',
      videoEl: videoEl as unknown as HTMLVideoElement,
      audioEl: audioEl as unknown as HTMLAudioElement,
    });
    for (let i = 0; i < 50 && !sdkState.startResolve; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    // BOTH tracks on videoEl's stream; audioEl.srcObject stays null.
    const stream = new FakeMediaStream();
    const v = new FakeMediaStreamTrack('video');
    const a = new FakeMediaStreamTrack('audio');
    stream.addVideo(v);
    stream.addAudio(a);
    videoEl.srcObject = stream;
    audioEl.srcObject = null;
    videoEl.fireLoadedMetadata();
    audioEl.fireLoadedMetadata();
    sdkState.startResolve?.();
    await openPromise;

    expect(onAudioTrack).toHaveBeenCalledWith(a);
    expect(bridge.getCurrentTracks().audio).toBe(a);
  });
});

describe('sendAudio chunker (R3-C1)', () => {
  it('flushes 6000-byte chunks and carries remainder', async () => {
    const { bridge } = await driveOpenWithBothTracks();
    // Feed 1000 bytes (carries) then 5500 bytes (total 6500 → one 6000-byte
    // flush + 500-byte carry).
    bridge.sendAudio(new Uint8Array(1000).fill(1).buffer);
    expect(sdkState.audioCalls.length).toBe(0);
    bridge.sendAudio(new Uint8Array(5500).fill(2).buffer);
    expect(sdkState.audioCalls.length).toBe(1);
    expect(sdkState.audioCalls[0].byteLength).toBe(6000);
    // Next 5500 → 5500 + 500 carry = 6000 → exactly one more flush.
    bridge.sendAudio(new Uint8Array(5500).fill(3).buffer);
    expect(sdkState.audioCalls.length).toBe(2);
    expect(sdkState.audioCalls[1].byteLength).toBe(6000);
  });

  it('cancel() drops the carry so prior turn does not bleed', async () => {
    const { bridge } = await driveOpenWithBothTracks();
    bridge.sendAudio(new Uint8Array(3000).fill(7).buffer);
    expect(sdkState.audioCalls.length).toBe(0);
    bridge.cancel();
    expect(sdkState.clearBufferCalls).toBeGreaterThanOrEqual(1);
    bridge.sendAudio(new Uint8Array(6000).fill(9).buffer);
    expect(sdkState.audioCalls.length).toBe(1);
    // Verify the flushed chunk is all 9s — no 7s leaked from prior turn.
    expect(sdkState.audioCalls[0].every((b) => b === 9)).toBe(true);
  });
});

async function driveOpenWithBothTracks() {
  const { createSimliBridge } = await import('./simli-bridge');
  const bridge = createSimliBridge({});
  const openPromise = bridge.open({
    replicaId: 'r-test',
    preMintedSessionToken: 'tok-test',
    videoEl: videoEl as unknown as HTMLVideoElement,
    audioEl: audioEl as unknown as HTMLAudioElement,
  });
  for (let i = 0; i < 50 && !sdkState.startResolve; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  const stream = new FakeMediaStream();
  const v = new FakeMediaStreamTrack('video');
  const a = new FakeMediaStreamTrack('audio');
  stream.addVideo(v); stream.addAudio(a);
  videoEl.srcObject = stream; audioEl.srcObject = stream;
  videoEl.fireLoadedMetadata(); audioEl.fireLoadedMetadata();
  sdkState.startResolve?.();
  await openPromise;
  return { bridge };
}
