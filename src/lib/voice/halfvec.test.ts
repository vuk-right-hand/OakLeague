// halfvec.test.ts — vitest for the canonical vectorToPgText.
//
// Coverage:
//   1. Encodes a finite-only 768-elem array to '[0,0,0.5,...]'
//   2. Length-0 array encodes to '[]'
//   3. NaN throws VectorEncodingError naming the index
//   4. Infinity throws
//   5. -Infinity throws
//   6. undefined element throws (sparse array)
//   7. HALFVEC_DIM is 768 (matches Day-8 cache schema halfvec(768))

import { describe, it, expect } from 'vitest';
import { vectorToPgText, VectorEncodingError, HALFVEC_DIM } from './halfvec';

describe('vectorToPgText', () => {
  it('encodes a small finite array', () => {
    expect(vectorToPgText([0, 0, 0.5, -1.25])).toBe('[0,0,0.5,-1.25]');
  });

  it('handles empty array', () => {
    expect(vectorToPgText([])).toBe('[]');
  });

  it('throws VectorEncodingError on NaN with index in message', () => {
    expect(() => vectorToPgText([0, 0, NaN, 1])).toThrow(VectorEncodingError);
    try {
      vectorToPgText([0, 0, NaN, 1]);
    } catch (e) {
      expect((e as Error).message).toContain('non_finite_value_at_2');
    }
  });

  it('throws on Infinity', () => {
    expect(() => vectorToPgText([Infinity])).toThrow(VectorEncodingError);
  });

  it('throws on -Infinity', () => {
    expect(() => vectorToPgText([-Infinity])).toThrow(VectorEncodingError);
  });

  it('throws on undefined element (sparse array)', () => {
    const v: number[] = new Array(3);
    v[0] = 1;
    v[2] = 1; // v[1] undefined
    expect(() => vectorToPgText(v)).toThrow(VectorEncodingError);
  });
});

describe('HALFVEC_DIM', () => {
  it('is 768 — matches Day-8 cache schema halfvec(768)', () => {
    expect(HALFVEC_DIM).toBe(768);
  });
});
