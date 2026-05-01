// Vitest covers the audio-mixer's connect/disconnect lifecycle and the
// static-gain wiring (Plan §20.5). Real AudioContext is unavailable in the
// node test env; we shape-mock just enough of the Web Audio API for the
// mixer's calls + assert the resulting graph topology.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GAIN_AVATAR,
  GAIN_MIC,
  GAIN_SOURCE,
  createAudioMixer,
} from './audio-mixer';

// ── Fake Web Audio ──────────────────────────────────────────────────────

type Edge = { from: string; to: string };

function makeFakeContext() {
  const edges: Edge[] = [];
  const nodes = new Map<object, string>(); // node ref → label
  let nextId = 0;
  const label = (kind: string) => `${kind}#${nextId++}`;

  function track(node: object, kind: string): object {
    const lbl = label(kind);
    nodes.set(node, lbl);
    return node;
  }

  function nameOf(node: object): string {
    return nodes.get(node) ?? 'unknown';
  }

  function makeNode(kind: string) {
    const node = {
      __kind: kind,
      connect(target: object): void {
        edges.push({ from: nameOf(node), to: nameOf(target) });
      },
      disconnect(): void {
        for (let i = edges.length - 1; i >= 0; i--) {
          if (edges[i].from === nameOf(node)) edges.splice(i, 1);
        }
      },
    };
    track(node, kind);
    return node;
  }

  const destination = makeNode('destination');
  const ctx = {
    destination,
    currentTime: 0,
    createGain(): object {
      const node = makeNode('gain') as unknown as {
        gain: {
          value: number;
          cancelScheduledValues: (t: number) => void;
          setValueAtTime: (v: number, t: number) => void;
          linearRampToValueAtTime: (v: number, t: number) => void;
          _scheduled: Array<{ op: string; v?: number; t: number }>;
        };
      };
      const scheduled: Array<{ op: string; v?: number; t: number }> = [];
      node.gain = {
        value: 1,
        _scheduled: scheduled,
        cancelScheduledValues: (t: number) => { scheduled.push({ op: 'cancel', t }); },
        setValueAtTime: (v: number, t: number) => { scheduled.push({ op: 'set', v, t }); node.gain.value = v; },
        // Real AudioParam updates .value continuously during a ramp. We
        // approximate by jumping to the target value at the end-time
        // (audit M6 integration — without this, a future "did the ramp
        // land at the target?" test would silently false-green).
        linearRampToValueAtTime: (v: number, t: number) => {
          scheduled.push({ op: 'ramp', v, t });
          node.gain.value = v;
        },
      };
      return node;
    },
    createMediaStreamDestination(): object {
      const stream = { __isStream: true } as unknown as MediaStream;
      const node = {
        __kind: 'streamDest',
        stream,
        connect(target: object): void {
          edges.push({ from: nameOf(node), to: nameOf(target) });
        },
        disconnect(): void { /* destinations don't outbound, but spec'd */ },
      };
      track(node, 'streamDest');
      return node;
    },
    createMediaStreamSource(_stream: MediaStream): object { return makeNode('streamSrc'); },
    createMediaElementSource(_el: HTMLMediaElement): object { return makeNode('elementSrc'); },
  };

  return { ctx, edges, nameOf };
}

let fake: ReturnType<typeof makeFakeContext>;
beforeEach(() => {
  fake = makeFakeContext();
  // The mixer constructs `new MediaStream([track])` for mic/avatar — node
  // env doesn't ship MediaStream, so install a minimal shim.
  Object.defineProperty(globalThis, 'MediaStream', {
    value: class { constructor(_tracks: MediaStreamTrack[]) {} },
    configurable: true,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function fakeTrack(id?: string): MediaStreamTrack {
  return { id: id ?? `t-${Math.random()}` } as unknown as MediaStreamTrack;
}
function fakeVideoEl(): HTMLMediaElement {
  return { __id: Math.random() } as unknown as HTMLMediaElement;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('createAudioMixer — initial graph', () => {
  it('wires three gain branches to MediaStreamDestination', () => {
    createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    // Three gain → streamDest edges expected.
    const gainToStreamDest = fake.edges.filter(
      (e) => e.from.startsWith('gain#') && e.to.startsWith('streamDest#'),
    );
    expect(gainToStreamDest.length).toBe(3);
  });

  it('source + avatar gain branches also wire to ctx.destination (speaker), mic does NOT', () => {
    createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    const gainToDest = fake.edges.filter(
      (e) => e.from.startsWith('gain#') && e.to.startsWith('destination#'),
    );
    // Exactly 2 — source + avatar. Mic is recording-only.
    expect(gainToDest.length).toBe(2);
  });

  it('exposes the recording stream from the MediaStreamDestination', () => {
    const mixer = createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    expect(mixer.recordingStream).toBeTruthy();
    expect((mixer.recordingStream as unknown as { __isStream?: boolean }).__isStream).toBe(true);
  });

  it('initial gain values match the static-mix spec (mic=1.0, source=0.7, avatar=0.9)', () => {
    // Spy on createGain to capture the gain instances + their final values.
    const gainNodes: Array<{ gain: { value: number } }> = [];
    const wrappedCtx = {
      ...fake.ctx,
      createGain(): object {
        const node = (fake.ctx.createGain() as unknown) as { gain: { value: number } };
        gainNodes.push(node);
        return node;
      },
    };
    createAudioMixer({ audioContext: wrappedCtx as unknown as AudioContext });
    const cmp = (a: number, b: number) => a - b;
    const values = gainNodes.map((g) => g.gain.value).sort(cmp);
    expect(values).toEqual([GAIN_SOURCE, GAIN_AVATAR, GAIN_MIC].sort(cmp));
  });
});

describe('connectMic / disconnectMic', () => {
  it('connectMic wires a streamSrc into the mic gain branch', () => {
    const mixer = createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    fake.edges.length = 0;
    mixer.connectMic(fakeTrack());
    const srcToGain = fake.edges.filter(
      (e) => e.from.startsWith('streamSrc#') && e.to.startsWith('gain#'),
    );
    expect(srcToGain.length).toBe(1);
  });

  it('idempotent on the same track — second connectMic with same track is a no-op', () => {
    const mixer = createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    const t = fakeTrack();
    mixer.connectMic(t);
    fake.edges.length = 0;
    mixer.connectMic(t);
    // No new streamSrc nodes created → no new edges.
    expect(fake.edges.filter((e) => e.from.startsWith('streamSrc#')).length).toBe(0);
  });

  it('replaces a different track and disconnects the old source', () => {
    const mixer = createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    mixer.connectMic(fakeTrack());
    const before = fake.edges.filter((e) => e.from.startsWith('streamSrc#')).map((e) => e.from);
    mixer.connectMic(fakeTrack());
    const after = fake.edges.filter((e) => e.from.startsWith('streamSrc#')).map((e) => e.from);
    // Old source's edge removed, new source's edge added.
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
  });

  it('disconnectMic removes the streamSrc edge', () => {
    const mixer = createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    mixer.connectMic(fakeTrack());
    expect(fake.edges.some((e) => e.from.startsWith('streamSrc#'))).toBe(true);
    mixer.disconnectMic();
    expect(fake.edges.some((e) => e.from.startsWith('streamSrc#'))).toBe(false);
  });

  it('idempotent on different track wrappers sharing the same track.id', () => {
    // Audit M2: React StrictMode double-invoke + parent re-renders that
    // wrap the underlying track in a new object should NOT cause a tear-down/
    // rebuild glitch in the audio graph. Match by track.id as a fallback.
    const mixer = createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    mixer.connectMic(fakeTrack('id-shared'));
    fake.edges.length = 0;
    mixer.connectMic(fakeTrack('id-shared')); // different ref, same id
    expect(fake.edges.filter((e) => e.from.startsWith('streamSrc#')).length).toBe(0);
  });
});

describe('connectSourceVideo (one-shot)', () => {
  it('wires an elementSrc into the source gain branch', () => {
    const mixer = createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    fake.edges.length = 0;
    mixer.connectSourceVideo(fakeVideoEl());
    const srcToGain = fake.edges.filter(
      (e) => e.from.startsWith('elementSrc#') && e.to.startsWith('gain#'),
    );
    expect(srcToGain.length).toBe(1);
  });

  it('idempotent on the same videoEl', () => {
    const mixer = createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    const el = fakeVideoEl();
    mixer.connectSourceVideo(el);
    fake.edges.length = 0;
    mixer.connectSourceVideo(el);
    expect(fake.edges.filter((e) => e.from.startsWith('elementSrc#')).length).toBe(0);
  });

  it('throws when called with a different element (one-shot per mixer)', () => {
    // Audit C1: createMediaElementSource captures the element permanently
    // for the lifetime of the AudioContext. Re-binding silences the prior
    // element rather than freeing it, so we throw rather than papering over.
    const mixer = createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    mixer.connectSourceVideo(fakeVideoEl());
    expect(() => mixer.connectSourceVideo(fakeVideoEl())).toThrow(/already bound/);
  });
});

describe('connectAvatar / disconnectAvatar', () => {
  it('wires a streamSrc into the avatar gain branch (different gain than mic)', () => {
    const mixer = createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    mixer.connectMic(fakeTrack());
    const micEdge = fake.edges.filter((e) => e.from.startsWith('streamSrc#'))[0];
    mixer.connectAvatar(fakeTrack());
    const avatarEdge = fake.edges.filter((e) => e.from.startsWith('streamSrc#'))[1];
    // Mic and avatar wire to DIFFERENT gain nodes.
    expect(micEdge.to).not.toBe(avatarEdge.to);
  });

  it('idempotent on the same track', () => {
    const mixer = createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    const t = fakeTrack();
    mixer.connectAvatar(t);
    fake.edges.length = 0;
    mixer.connectAvatar(t);
    expect(fake.edges.filter((e) => e.from.startsWith('streamSrc#')).length).toBe(0);
  });

  it('disconnectAvatar removes the streamSrc edge', () => {
    const mixer = createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    mixer.connectAvatar(fakeTrack());
    mixer.disconnectAvatar();
    expect(fake.edges.some((e) => e.from.startsWith('streamSrc#'))).toBe(false);
  });
});

type CapturedGain = {
  value: number;
  _scheduled: Array<{ op: string }>;
  cancelScheduledValues: (t: number) => void;
  setValueAtTime: (v: number, t: number) => void;
  linearRampToValueAtTime: (v: number, t: number) => void;
};

function captureGains(): { ctx: object; captured: CapturedGain[] } {
  const captured: CapturedGain[] = [];
  const ctx = {
    ...fake.ctx,
    createGain(): object {
      const node = fake.ctx.createGain() as unknown as { gain: CapturedGain };
      captured.push(node.gain);
      return node;
    },
  };
  return { ctx, captured };
}

describe('setSourceGain (audit C1 integration)', () => {
  it('instant set when durationMs is 0 or omitted', () => {
    const { ctx, captured } = captureGains();
    const mixer = createAudioMixer({ audioContext: ctx as unknown as AudioContext });
    const sourceGain = captured.find((g) => g.value === GAIN_SOURCE)!;
    expect(sourceGain).toBeDefined();
    mixer.setSourceGain(0);
    expect(sourceGain.value).toBe(0);
    expect(sourceGain._scheduled.some((s) => s.op === 'ramp')).toBe(false);
  });

  it('ramps when durationMs is positive', () => {
    const { ctx, captured } = captureGains();
    const mixer = createAudioMixer({ audioContext: ctx as unknown as AudioContext });
    const sourceGain = captured.find((g) => g.value === GAIN_SOURCE)!;
    mixer.setSourceGain(0, 300);
    const ops = sourceGain._scheduled.map((s) => s.op);
    expect(ops).toContain('cancel');
    expect(ops).toContain('set');
    expect(ops).toContain('ramp');
  });

  it('clamps value to [0,1]', () => {
    const { ctx, captured } = captureGains();
    const mixer = createAudioMixer({ audioContext: ctx as unknown as AudioContext });
    const sourceGain = captured.find((g) => g.value === GAIN_SOURCE)!;
    mixer.setSourceGain(2.5);
    expect(sourceGain.value).toBe(1);
    mixer.setSourceGain(-0.5);
    expect(sourceGain.value).toBe(0);
  });

  it('throws after close()', () => {
    const mixer = createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    mixer.close();
    expect(() => mixer.setSourceGain(0)).toThrow(/after close/);
  });
});

describe('disconnectAvatar with ended track (audit C2 integration)', () => {
  it('skips source.disconnect when track.readyState === "ended"', () => {
    // Safari WebKit bug 217983: source.disconnect() on a MediaStreamSource
    // whose underlying track is 'ended' throws InvalidStateError. We
    // defensively skip the disconnect call and clear branch state directly.
    const mixer = createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    const track = { id: 't-x', readyState: 'live' as MediaStreamTrackState };
    mixer.connectAvatar(track as unknown as MediaStreamTrack);
    // Mutate to ended (the controller's bridge.close would do this).
    track.readyState = 'ended';
    // Verify no source.disconnect call hits the streamSrc edge — it would
    // remove the streamSrc→gain edge from fake.edges. Snapshot before.
    const beforeEdges = fake.edges.filter((e) => e.from.startsWith('streamSrc#')).length;
    mixer.disconnectAvatar();
    const afterEdges = fake.edges.filter((e) => e.from.startsWith('streamSrc#')).length;
    // Skip path: edge stays (no disconnect call) but branch state is null.
    expect(afterEdges).toBe(beforeEdges);
    // Re-connect succeeds — branch.inputId was nulled.
    expect(() => mixer.connectAvatar({ id: 'new', readyState: 'live' as MediaStreamTrackState } as unknown as MediaStreamTrack)).not.toThrow();
  });

  it('disconnects normally when track is still live', () => {
    const mixer = createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    const track = { id: 't-y', readyState: 'live' as MediaStreamTrackState };
    mixer.connectAvatar(track as unknown as MediaStreamTrack);
    expect(fake.edges.some((e) => e.from.startsWith('streamSrc#'))).toBe(true);
    mixer.disconnectAvatar();
    expect(fake.edges.some((e) => e.from.startsWith('streamSrc#'))).toBe(false);
  });
});

describe('close()', () => {
  it('disconnects all branches and is idempotent', () => {
    const mixer = createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    mixer.connectMic(fakeTrack());
    mixer.connectAvatar(fakeTrack());
    mixer.connectSourceVideo(fakeVideoEl());
    mixer.close();
    expect(fake.edges.some((e) => e.from.startsWith('streamSrc#'))).toBe(false);
    expect(fake.edges.some((e) => e.from.startsWith('elementSrc#'))).toBe(false);
    expect(fake.edges.some((e) => e.from.startsWith('gain#') && e.to.startsWith('streamDest#'))).toBe(false);
    expect(() => mixer.close()).not.toThrow();
  });

  it('throws on connectMic after close', () => {
    const mixer = createAudioMixer({ audioContext: fake.ctx as unknown as AudioContext });
    mixer.close();
    expect(() => mixer.connectMic(fakeTrack())).toThrow(/after close/);
  });
});
