import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RecordingPermissionError,
  attachRevokeWatcher,
  clearPermissionMemory,
  mapMediaError,
  queryDetailedPermissionState,
  queryPermissionState,
  releaseStream,
  requestMediaPermission,
} from './permission';

// ── localStorage shim ───────────────────────────────────────────────────
// vitest runs in node env per vitest.config.ts; window/localStorage are
// undefined. The lib's typeof-guards return early on the server. To
// exercise the cache path we install a minimal shim before each test.
function installWindowShim(): void {
  const store: Record<string, string> = {};
  const ls: Storage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    key: (i) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; },
  };
  // Use globalThis so cleanup works regardless of whether the test
  // already populated some bits.
  Object.defineProperty(globalThis, 'window',       { value: { localStorage: ls }, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: ls,                   configurable: true });
}

function teardownWindowShim() {
  // delete via redefining as undefined — `delete globalThis.window` throws
  // in some node versions when the property was non-configurable.
  Object.defineProperty(globalThis, 'window',       { value: undefined, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
}

function teardownNavigator() {
  Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
}

// Top-level cleanup — runs after EVERY test in this file regardless of
// describe block. Prevents cross-describe pollution where one block
// leaves window/navigator stubbed and a later block silently inherits
// the stale state (audit R3 M1 hygiene).
afterEach(() => {
  teardownWindowShim();
  teardownNavigator();
});

describe('mapMediaError', () => {
  it('maps NotAllowedError to denied', () => {
    const e = mapMediaError({ name: 'NotAllowedError', message: 'no' });
    expect(e).toBeInstanceOf(RecordingPermissionError);
    expect(e.code).toBe('denied');
  });

  it('maps legacy PermissionDeniedError to denied', () => {
    expect(mapMediaError({ name: 'PermissionDeniedError' }).code).toBe('denied');
  });

  it('maps NotFoundError to no_device', () => {
    expect(mapMediaError({ name: 'NotFoundError' }).code).toBe('no_device');
    expect(mapMediaError({ name: 'DevicesNotFoundError' }).code).toBe('no_device');
  });

  it('maps NotReadableError to in_use', () => {
    expect(mapMediaError({ name: 'NotReadableError' }).code).toBe('in_use');
    expect(mapMediaError({ name: 'TrackStartError' }).code).toBe('in_use');
  });

  it('maps OverconstrainedError to overconstrained', () => {
    expect(mapMediaError({ name: 'OverconstrainedError' }).code).toBe('overconstrained');
    expect(mapMediaError({ name: 'ConstraintNotSatisfiedError' }).code).toBe('overconstrained');
  });

  it('maps AbortError + SecurityError to their own codes', () => {
    expect(mapMediaError({ name: 'AbortError' }).code).toBe('aborted');
    expect(mapMediaError({ name: 'SecurityError' }).code).toBe('security');
  });

  it('falls through to unknown for unfamiliar shapes', () => {
    expect(mapMediaError({ name: 'WeirdError' }).code).toBe('unknown');
    expect(mapMediaError(null).code).toBe('unknown');
    expect(mapMediaError(undefined).code).toBe('unknown');
    expect(mapMediaError(new Error('plain')).code).toBe('unknown');
  });

  it('preserves the original error on .cause', () => {
    const orig = { name: 'NotAllowedError', detail: 42 };
    expect(mapMediaError(orig).cause).toBe(orig);
  });
});

describe('queryDetailedPermissionState', () => {
  afterEach(() => Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true }));

  it('returns unsupported for both when navigator is missing', async () => {
    expect(await queryDetailedPermissionState()).toEqual({ camera: 'unsupported', microphone: 'unsupported' });
  });

  it('returns unsupported for both when permissions.query throws (Safari)', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { permissions: { query: () => { throw new TypeError('not supported'); } } },
      configurable: true,
    });
    expect(await queryDetailedPermissionState()).toEqual({ camera: 'unsupported', microphone: 'unsupported' });
  });

  it('returns per-device states (audio-only fallback unblocked)', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        permissions: {
          query: vi.fn()
            .mockResolvedValueOnce({ state: 'denied'  })  // camera
            .mockResolvedValueOnce({ state: 'granted' }), // microphone
        },
      },
      configurable: true,
    });
    expect(await queryDetailedPermissionState()).toEqual({ camera: 'denied', microphone: 'granted' });
  });

  it('runs the two queries in parallel via Promise.all', async () => {
    const log: string[] = [];
    const query = vi.fn(async ({ name }: { name: string }) => {
      log.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, 10));
      log.push(`end:${name}`);
      return { state: 'granted' };
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: { permissions: { query } },
      configurable: true,
    });
    await queryDetailedPermissionState();
    // Parallel: both starts come before either end.
    expect(log[0]).toMatch(/^start:/);
    expect(log[1]).toMatch(/^start:/);
    expect(log[2]).toMatch(/^end:/);
  });
});

describe('queryPermissionState', () => {
  afterEach(() => Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true }));

  it('returns unsupported when navigator is missing', async () => {
    expect(await queryPermissionState()).toBe('unsupported');
  });

  it('collapses to weakest state across camera + mic', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        permissions: {
          query: vi.fn()
            .mockResolvedValueOnce({ state: 'granted' })
            .mockResolvedValueOnce({ state: 'denied' }),
        },
      },
      configurable: true,
    });
    expect(await queryPermissionState()).toBe('denied');
  });

  it('returns granted only when both are granted', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { permissions: { query: vi.fn().mockResolvedValue({ state: 'granted' }) } },
      configurable: true,
    });
    expect(await queryPermissionState()).toBe('granted');
  });
});

describe('requestMediaPermission', () => {
  beforeEach(() => installWindowShim());
  afterEach(() => {
    teardownWindowShim();
    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
  });

  it('throws unsupported when getUserMedia is unavailable', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    await expect(requestMediaPermission()).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('returns the stream + writes granted=true to cache on success', async () => {
    const fakeStream = { getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream);
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: { getUserMedia } },
      configurable: true,
    });
    const res = await requestMediaPermission();
    expect(res.stream).toBe(fakeStream);
    expect(res.fromCache).toBe(false);
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: true });
    expect(window.localStorage.getItem('oak_recording_perm_v1')).toMatch(/"granted":true/);
  });

  it('reports fromCache=true when the cache says granted', async () => {
    window.localStorage.setItem(
      'oak_recording_perm_v1',
      JSON.stringify({ granted: true, ts: Date.now() }),
    );
    const fakeStream = {} as unknown as MediaStream;
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(fakeStream) } },
      configurable: true,
    });
    const res = await requestMediaPermission();
    expect(res.fromCache).toBe(true);
  });

  it('writes granted=false on denied + throws RecordingPermissionError', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        mediaDevices: {
          getUserMedia: vi.fn().mockRejectedValue({ name: 'NotAllowedError' }),
        },
      },
      configurable: true,
    });
    await expect(requestMediaPermission()).rejects.toMatchObject({ code: 'denied' });
    expect(window.localStorage.getItem('oak_recording_perm_v1')).toMatch(/"granted":false/);
  });

  it('does NOT clobber a granted cache on transient errors (in_use, no_device)', async () => {
    window.localStorage.setItem(
      'oak_recording_perm_v1',
      JSON.stringify({ granted: true, ts: Date.now() }),
    );
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        mediaDevices: {
          getUserMedia: vi.fn().mockRejectedValue({ name: 'NotReadableError' }),
        },
      },
      configurable: true,
    });
    await expect(requestMediaPermission()).rejects.toMatchObject({ code: 'in_use' });
    // Cache must still report granted=true; the device was just busy.
    expect(window.localStorage.getItem('oak_recording_perm_v1')).toMatch(/"granted":true/);
  });

  it('rejects immediately when an already-aborted signal is passed', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: { getUserMedia: vi.fn() } },
      configurable: true,
    });
    const ctl = new AbortController();
    ctl.abort();
    await expect(requestMediaPermission({ signal: ctl.signal })).rejects.toMatchObject({ code: 'aborted' });
  });

  it('releases the orphan stream when abort wins after getUserMedia resolves (audit R2 C1)', async () => {
    const stop = vi.fn();
    const fakeStream = {
      getTracks: () => [{ stop }, { stop }] as unknown as MediaStreamTrack[],
    } as unknown as MediaStream;
    // getUserMedia resolves on next microtask; abort fires synchronously
    // before that resolution lands.
    let resolveGUM: (s: MediaStream) => void = () => {};
    const gumPromise = new Promise<MediaStream>((res) => { resolveGUM = res; });
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: { getUserMedia: vi.fn().mockReturnValue(gumPromise) } },
      configurable: true,
    });
    const ctl = new AbortController();
    const reqPromise = requestMediaPermission({ signal: ctl.signal });
    // Abort while getUserMedia is still pending.
    ctl.abort();
    await expect(reqPromise).rejects.toMatchObject({ code: 'aborted' });
    // Now getUserMedia resolves with a stream. The lib must release it.
    resolveGUM(fakeStream);
    // Wait for the late-release microtask.
    await new Promise((r) => setTimeout(r, 0));
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('drops cache that is stale beyond TTL', async () => {
    // 31 days ago — beyond the 30d TTL.
    window.localStorage.setItem(
      'oak_recording_perm_v1',
      JSON.stringify({ granted: true, ts: Date.now() - 31 * 24 * 60 * 60 * 1000 }),
    );
    const fakeStream = {} as unknown as MediaStream;
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(fakeStream) } },
      configurable: true,
    });
    const res = await requestMediaPermission();
    // Stale cache is treated as no cache.
    expect(res.fromCache).toBe(false);
  });
});

function makeFakeStream(): {
  stream: MediaStream;
  fire: (ev: 'ended' | 'mute') => void;
  listenerCount: () => number;
} {
  const listeners: Record<string, EventListener[]> = {};
  const track = {
    addEventListener:    (ev: string, l: EventListener) => { (listeners[ev] ??= []).push(l); },
    removeEventListener: (ev: string, l: EventListener) => {
      listeners[ev] = (listeners[ev] ?? []).filter((x) => x !== l);
    },
  } as unknown as MediaStreamTrack;
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  return {
    stream,
    fire: (ev) => listeners[ev]?.forEach((l) => l(new Event(ev))),
    listenerCount: () => (listeners.ended?.length ?? 0) + (listeners.mute?.length ?? 0),
  };
}

describe('attachRevokeWatcher', () => {
  it('fires onRevoke with "ended" when a track ends', () => {
    const cb = vi.fn();
    const fake = makeFakeStream();
    const cleanup = attachRevokeWatcher(fake.stream, cb);
    fake.fire('ended');
    expect(cb).toHaveBeenCalledWith('ended');
    cleanup();
    expect(fake.listenerCount()).toBe(0);
  });

  it('fires onRevoke with "mute" when a track mutes', () => {
    const cb = vi.fn();
    const fake = makeFakeStream();
    attachRevokeWatcher(fake.stream, cb);
    fake.fire('mute');
    expect(cb).toHaveBeenCalledWith('mute');
  });

  it('is idempotent under repeated attach (audit R2 M2 — StrictMode safe)', () => {
    const cbA = vi.fn();
    const cbB = vi.fn();
    const fake = makeFakeStream();
    // Two subscribers on the same stream — must share a single pair of
    // track listeners. Without dedupe, this would attach 4 listeners
    // and double-fire each callback.
    const cleanA = attachRevokeWatcher(fake.stream, cbA);
    const cleanB = attachRevokeWatcher(fake.stream, cbB);
    expect(fake.listenerCount()).toBe(2); // ended + mute, ONCE
    fake.fire('ended');
    expect(cbA).toHaveBeenCalledTimes(1);
    expect(cbB).toHaveBeenCalledTimes(1);
    // Detach A — listeners stay (B still subscribed).
    cleanA();
    expect(fake.listenerCount()).toBe(2);
    fake.fire('mute');
    expect(cbA).toHaveBeenCalledTimes(1); // unchanged after cleanup
    expect(cbB).toHaveBeenCalledWith('mute');
    // Detach B — listeners now removed.
    cleanB();
    expect(fake.listenerCount()).toBe(0);
  });

  it('cleanup is idempotent (calling twice does not throw)', () => {
    const fake = makeFakeStream();
    const cleanup = attachRevokeWatcher(fake.stream, () => {});
    cleanup();
    expect(() => cleanup()).not.toThrow();
  });
});

describe('releaseStream', () => {
  it('stops every track', () => {
    const stop = vi.fn();
    const tracks = [{ stop }, { stop }, { stop }] as unknown as MediaStreamTrack[];
    const stream = { getTracks: () => tracks } as unknown as MediaStream;
    releaseStream(stream);
    expect(stop).toHaveBeenCalledTimes(3);
  });

  it('swallows errors from individual track.stop()', () => {
    const tracks = [
      { stop: () => { throw new Error('already stopped'); } },
      { stop: () => {} },
    ] as unknown as MediaStreamTrack[];
    const stream = { getTracks: () => tracks } as unknown as MediaStream;
    expect(() => releaseStream(stream)).not.toThrow();
  });
});

describe('clearPermissionMemory', () => {
  beforeEach(() => installWindowShim());
  afterEach(() => teardownWindowShim());

  it('removes the cache entry', () => {
    window.localStorage.setItem('oak_recording_perm_v1', JSON.stringify({ granted: true, ts: Date.now() }));
    clearPermissionMemory();
    expect(window.localStorage.getItem('oak_recording_perm_v1')).toBeNull();
  });

  it('is a no-op when window is missing', () => {
    teardownWindowShim();
    expect(() => clearPermissionMemory()).not.toThrow();
  });
});
