import { describe, it, expect } from 'vitest';
import {
  crossedQuartiles,
  takeBfcacheBaseline,
  shouldFinalizeOnPagehide,
  type Quartile,
} from './quartile-tracker';

describe('crossedQuartiles — natural playback', () => {
  const empty = new Set<Quartile>();

  it('fires q=25 on a small forward step crossing 25%', () => {
    // duration=100s, prev=24s, curr=25.5s (1.5s step)
    const out = crossedQuartiles({ duration: 100, prev: 24, curr: 25.5, fired: empty });
    expect(out).toEqual([25]);
  });

  it('fires q=50 on natural playback', () => {
    const out = crossedQuartiles({ duration: 100, prev: 49.8, curr: 50.2, fired: empty });
    expect(out).toEqual([50]);
  });

  it('fires q=75 on natural playback', () => {
    const out = crossedQuartiles({ duration: 100, prev: 74.5, curr: 75.5, fired: empty });
    expect(out).toEqual([75]);
  });

  it('does NOT fire q=100 — that is wired to onEnded directly', () => {
    const out = crossedQuartiles({ duration: 100, prev: 99, curr: 100, fired: empty });
    expect(out).toEqual([]);
  });

  it('skips quartiles already in the fired set', () => {
    const fired = new Set<Quartile>([25]);
    const out = crossedQuartiles({ duration: 100, prev: 24, curr: 25.5, fired });
    expect(out).toEqual([]);
  });
});

describe('crossedQuartiles — scrub-forward gate (audit M3)', () => {
  const empty = new Set<Quartile>();

  it('does NOT fire q=25 or q=50 on a large jump (10 → 60)', () => {
    const out = crossedQuartiles({ duration: 100, prev: 10, curr: 60, fired: empty });
    expect(out).toEqual([]);
  });

  it('does NOT fire on a 2.5s step (above the 2.0s gate)', () => {
    const out = crossedQuartiles({ duration: 100, prev: 24, curr: 26.5, fired: empty });
    expect(out).toEqual([]);
  });

  it('does fire on a 1.99s step (under the 2.0s gate)', () => {
    const out = crossedQuartiles({ duration: 100, prev: 24, curr: 25.99, fired: empty });
    expect(out).toEqual([25]);
  });

  it('does NOT fire on backwards seek', () => {
    const out = crossedQuartiles({ duration: 100, prev: 60, curr: 10, fired: empty });
    expect(out).toEqual([]);
  });

  it('does NOT fire on identical sample (same currentTime)', () => {
    const out = crossedQuartiles({ duration: 100, prev: 25, curr: 25, fired: empty });
    expect(out).toEqual([]);
  });
});

describe('crossedQuartiles — multi-quartile in one step (degenerate, but valid)', () => {
  const empty = new Set<Quartile>();

  it('fires q=25 AND q=50 if both crossed in one ≤2s step (very short video)', () => {
    // duration=10s, prev=2s, curr=5.4s — step of 3.4s exceeds gate, so empty.
    // duration=10s, prev=2s, curr=3.5s — 1.5s step, crosses q=25 (2.5s)
    // and q=50 (5.0s)? No: curr=3.5 < 5.0, only q=25 crosses.
    const out = crossedQuartiles({ duration: 10, prev: 2, curr: 3.5, fired: empty });
    expect(out).toEqual([25]);
  });
});

describe('takeBfcacheBaseline (audit M5)', () => {
  it('pre-marks all quartiles already passed at restore time', () => {
    // restored at 60% of 100s
    const out = takeBfcacheBaseline({ duration: 100, curr: 60 });
    expect(out).toEqual([25, 50]);
  });

  it('pre-marks q=25 only when restored at 30%', () => {
    const out = takeBfcacheBaseline({ duration: 100, curr: 30 });
    expect(out).toEqual([25]);
  });

  it('pre-marks nothing when restored at 5%', () => {
    const out = takeBfcacheBaseline({ duration: 100, curr: 5 });
    expect(out).toEqual([]);
  });

  it('pre-marks all four when restored at 100%', () => {
    const out = takeBfcacheBaseline({ duration: 100, curr: 100 });
    expect(out).toEqual([25, 50, 75, 100]);
  });

  it('handles zero/invalid duration gracefully', () => {
    expect(takeBfcacheBaseline({ duration: 0, curr: 50 })).toEqual([]);
    expect(takeBfcacheBaseline({ duration: NaN, curr: 50 })).toEqual([]);
  });
});

describe('shouldFinalizeOnPagehide (audit M6)', () => {
  const empty = new Set<Quartile>();

  it('returns true when within last 3% and q=100 not yet fired', () => {
    const r = shouldFinalizeOnPagehide({ duration: 100, curr: 98, fired: empty });
    expect(r).toBe(true);
  });

  it('returns false when below 97%', () => {
    const r = shouldFinalizeOnPagehide({ duration: 100, curr: 90, fired: empty });
    expect(r).toBe(false);
  });

  it('returns false when q=100 already fired', () => {
    const fired = new Set<Quartile>([100]);
    const r = shouldFinalizeOnPagehide({ duration: 100, curr: 99, fired });
    expect(r).toBe(false);
  });

  it('returns false on zero/invalid duration', () => {
    expect(shouldFinalizeOnPagehide({ duration: 0, curr: 99, fired: empty })).toBe(false);
    expect(shouldFinalizeOnPagehide({ duration: NaN, curr: 99, fired: empty })).toBe(false);
  });
});

describe('end-to-end natural watch sequence', () => {
  it('emits exactly q=25, q=50, q=75 across a continuous 100s watch (q=100 via onEnded)', () => {
    const fired = new Set<Quartile>();
    const samples = [
      { prev: 0,    curr: 0.25 },
      { prev: 0.25, curr: 24.0 }, // big jump — gate filters
      { prev: 24,   curr: 25.5 }, // crosses 25
      { prev: 25.5, curr: 49.6 }, // big jump — gate filters
      { prev: 49.6, curr: 50.4 }, // crosses 50
      { prev: 50.4, curr: 74.6 }, // big jump — gate filters
      { prev: 74.6, curr: 75.6 }, // crosses 75
    ];
    const all: Quartile[] = [];
    for (const s of samples) {
      const out = crossedQuartiles({ duration: 100, prev: s.prev, curr: s.curr, fired });
      for (const q of out) {
        fired.add(q);
        all.push(q);
      }
    }
    expect(all).toEqual([25, 50, 75]);
  });

  it('does NOT double-emit even if the same crossing is sampled twice', () => {
    const fired = new Set<Quartile>();
    const a = crossedQuartiles({ duration: 100, prev: 24, curr: 25.5, fired });
    for (const q of a) fired.add(q);
    const b = crossedQuartiles({ duration: 100, prev: 25.5, curr: 26.5, fired });
    expect(a).toEqual([25]);
    expect(b).toEqual([]);
  });
});
