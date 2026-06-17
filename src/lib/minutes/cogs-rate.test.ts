import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  blendedCogsRate,
  impliedUsd,
  roundUsd,
  DEFAULT_BLENDED_COGS_USD_PER_MIN,
  DEFAULT_BLENDED_COGS_QUOTED_AT,
} from './cogs-rate';

const RATE = 'MINUTES_BLENDED_COGS_USD_PER_MIN';
const QUOTED = 'MINUTES_BLENDED_COGS_QUOTED_AT';

describe('blendedCogsRate', () => {
  let savedRate: string | undefined;
  let savedQuoted: string | undefined;
  beforeEach(() => {
    savedRate = process.env[RATE];
    savedQuoted = process.env[QUOTED];
    delete process.env[RATE];
    delete process.env[QUOTED];
  });
  afterEach(() => {
    if (savedRate === undefined) delete process.env[RATE];
    else process.env[RATE] = savedRate;
    if (savedQuoted === undefined) delete process.env[QUOTED];
    else process.env[QUOTED] = savedQuoted;
  });

  it('uses the pinned env when valid (configured:true)', () => {
    process.env[RATE] = '0.031';
    process.env[QUOTED] = '2026-07-01';
    expect(blendedCogsRate()).toEqual({ usdPerMin: 0.031, quotedAt: '2026-07-01', configured: true });
  });

  it('falls back to the seed when env unset (configured:false)', () => {
    expect(blendedCogsRate()).toEqual({
      usdPerMin: DEFAULT_BLENDED_COGS_USD_PER_MIN,
      quotedAt: DEFAULT_BLENDED_COGS_QUOTED_AT,
      configured: false,
    });
  });

  it.each(['0', '-0.01', 'abc', ''])('rejects a non-positive/non-finite env value (%s) → seed', (bad) => {
    process.env[RATE] = bad;
    const r = blendedCogsRate();
    expect(r.configured).toBe(false);
    expect(r.usdPerMin).toBe(DEFAULT_BLENDED_COGS_USD_PER_MIN);
  });

  it('quotedAt is null when only the rate is set', () => {
    process.env[RATE] = '0.03';
    expect(blendedCogsRate().quotedAt).toBeNull();
  });
});

describe('impliedUsd', () => {
  it('converts seconds → USD at the $/min rate', () => {
    expect(impliedUsd(60, 0.028)).toBeCloseTo(0.028, 6);
    expect(impliedUsd(120, 0.028)).toBeCloseTo(0.056, 6);
  });
  it('returns 0 for non-positive / non-finite inputs', () => {
    expect(impliedUsd(0, 0.028)).toBe(0);
    expect(impliedUsd(-5, 0.028)).toBe(0);
    expect(impliedUsd(60, 0)).toBe(0);
    expect(impliedUsd(Number.NaN, 0.028)).toBe(0);
  });
});

describe('roundUsd', () => {
  it('rounds to whole cents (half-up)', () => {
    expect(roundUsd(0.12345)).toBe(0.12);
    expect(roundUsd(0.125)).toBe(0.13);
    expect(roundUsd(99.999)).toBe(100);
  });
  it('returns 0 for non-finite', () => {
    expect(roundUsd(Number.NaN)).toBe(0);
  });
});
