// Latency plan 2026-06-10 — the enter-room beat is a product timing constant
// that masks the /open fetch. Pinned here so a future bump is deliberate:
// raising it slows every session entry; lowering it below /open's p95 makes
// the room overlay flash away mid-fetch on fast networks.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MIN_ENTER_ROOM_MS, holdEnterRoomBeat } from './enter-timing';

describe('enter-timing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins MIN_ENTER_ROOM_MS at 2000 (was 3500 pre-latency-plan)', () => {
    expect(MIN_ENTER_ROOM_MS).toBe(2000);
  });

  it('resolves immediately when the beat has already elapsed', async () => {
    // INTENTIONALLY real timers (no vi.useFakeTimers here): the assertion is
    // a real-clock <100ms bound on the no-timer fast path. Wrapping this in
    // fake timers would freeze performance.now() and void the assertion.
    const startedAt = performance.now() - (MIN_ENTER_ROOM_MS + 50);
    const t0 = performance.now();
    await holdEnterRoomBeat(startedAt);
    // No timer path → resolves on the microtask queue, well under the beat.
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('waits only the remaining portion of the beat', async () => {
    vi.useFakeTimers();
    const startedAt = performance.now() - 1500; // 500ms of the 2000 remain
    let resolved = false;
    const p = holdEnterRoomBeat(startedAt).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(400);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(resolved).toBe(true);
  });
});
