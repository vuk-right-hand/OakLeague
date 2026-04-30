// Unit tests for the pure decimate3to1 function used by the mic AudioWorklet.
//
// Imports the .js file directly from public/worklets/ — Vitest treats it as
// an ESM module. See SPIKE_A_DEFERRED_FIXUP_PLAN.md §2A.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — public/worklets isn't covered by tsconfig paths; vitest
// resolves at runtime via Node ESM. The function is pure JS.
import { decimate3to1 } from '../../../../public/worklets/mic-decimate.js';

type State = { phase: number };

function decimateAll(chunks: Float32Array[], initial: State = { phase: 0 }): Float32Array {
  const state = { ...initial };
  const outs: Float32Array[] = [];
  for (const c of chunks) outs.push(decimate3to1(c, state));
  const total = outs.reduce((n, o) => n + o.length, 0);
  const merged = new Float32Array(total);
  let off = 0;
  for (const o of outs) { merged.set(o, off); off += o.length; }
  return merged;
}

function rangeFloat(start: number, count: number): Float32Array {
  const f = new Float32Array(count);
  for (let i = 0; i < count; i++) f[i] = start + i;
  return f;
}

describe('decimate3to1', () => {
  it('continuity across chunk boundaries: 25× 480-sample chunks == one 12000-sample buffer', () => {
    // 480 samples = 10ms @ 48k. 25 chunks = 250ms.
    const chunks = Array.from({ length: 25 }, (_, i) => rangeFloat(i * 480, 480));
    const big = new Float32Array(25 * 480);
    for (let i = 0; i < big.length; i++) big[i] = i;

    const fromChunks = decimateAll(chunks);
    const oneShot = decimate3to1(big, { phase: 0 });

    expect(fromChunks.length).toBe(oneShot.length);
    for (let i = 0; i < oneShot.length; i++) {
      expect(fromChunks[i]).toBe(oneShot[i]);
    }
  });

  it('output length math: ⌈(L − P) / 3⌉ for any L, phase ∈ {0,1,2}', () => {
    for (const L of [0, 1, 2, 3, 4, 5, 10, 128, 480, 1024]) {
      for (const P of [0, 1, 2]) {
        const state = { phase: P };
        const input = new Float32Array(L);
        const out = decimate3to1(input, state);
        const expected = L > P ? Math.ceil((L - P) / 3) : 0;
        expect(out.length).toBe(expected);
      }
    }
  });

  it('phase update math: ending phase = (3 − ((L − P) % 3)) % 3 when L > P', () => {
    // The contract: after a chunk of length L starting at phase P, the next
    // chunk's phase is (3 - ((L - P) % 3)) % 3.
    for (const L of [3, 4, 5, 6, 7, 128, 480]) {
      for (const P of [0, 1, 2]) {
        const state = { phase: P };
        decimate3to1(new Float32Array(L), state);
        expect(state.phase).toBe((3 - ((L - P) % 3)) % 3);
      }
    }
  });

  it('empty input: returns length-0 output, phase unchanged', () => {
    const state = { phase: 1 };
    const out = decimate3to1(new Float32Array(0), state);
    expect(out.length).toBe(0);
    expect(state.phase).toBe(1);
  });

  it('starting at phase=0 emits sample 0', () => {
    const out = decimate3to1(rangeFloat(0, 9), { phase: 0 });
    // Samples: 0,1,2,3,4,5,6,7,8 → emits 0, 3, 6
    expect(Array.from(out)).toEqual([0, 3, 6]);
  });

  it('starting at phase=2 emits index 2 first', () => {
    const out = decimate3to1(rangeFloat(0, 9), { phase: 2 });
    // emits 2, 5, 8
    expect(Array.from(out)).toEqual([2, 5, 8]);
  });

  it('chunked emission walks the phase 0→1→2→0 across L=128 chunks', () => {
    const state = { phase: 0 };
    decimate3to1(new Float32Array(128), state); // 128%3=2 → phase = (3-2)%3 = 1
    expect(state.phase).toBe(1);
    decimate3to1(new Float32Array(128), state); // (128-1)=127, 127%3=1 → phase=(3-1)%3=2
    expect(state.phase).toBe(2);
    decimate3to1(new Float32Array(128), state); // (128-2)=126, 126%3=0 → phase=(3-0)%3=0
    expect(state.phase).toBe(0);
  });

  it('multiple-of-3 chunks preserve phase', () => {
    const state = { phase: 1 };
    decimate3to1(new Float32Array(9), state);
    expect(state.phase).toBe(1);
    const state2 = { phase: 2 };
    decimate3to1(new Float32Array(12), state2);
    expect(state2.phase).toBe(2);
  });

  it('phase >= input.length: emits 0 samples, decrements phase', () => {
    const state = { phase: 2 };
    const out = decimate3to1(new Float32Array(2), state);
    expect(out.length).toBe(0);
    // phase 2 - input.length 2 = 0
    expect(state.phase).toBe(0);
  });
});
