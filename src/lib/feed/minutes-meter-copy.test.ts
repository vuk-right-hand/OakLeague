import { describe, it, expect } from 'vitest';
import { formatMinutesMeter } from './minutes-meter-copy';

// now is fixed for label determinism; sublabel countdown is asserted by shape (not
// exact value) so the test is independent of the runner's local timezone.
const now = new Date('2026-06-16T12:00:00');

describe('formatMinutesMeter — label', () => {
  it('weekly: floors minutes (never over-promises) + period word', () => {
    // 779s = 12.98 min → 12, not 13.
    expect(formatMinutesMeter({ remainingSeconds: 779, capPeriod: 'weekly', walletRemaining: 0, now }).label)
      .toBe('12 min left this week');
  });

  it('daily / monthly period words', () => {
    expect(formatMinutesMeter({ remainingSeconds: 300, capPeriod: 'daily', walletRemaining: 0, now }).label)
      .toBe('5 min left today');
    expect(formatMinutesMeter({ remainingSeconds: 2400, capPeriod: 'monthly', walletRemaining: 0, now }).label)
      .toBe('40 min left this month');
  });

  it('wallet present → "(incl. earned)", drops the period word', () => {
    expect(formatMinutesMeter({ remainingSeconds: 720, capPeriod: 'weekly', walletRemaining: 120, now }).label)
      .toBe('12 min left (incl. earned)');
  });

  it('sub-minute non-zero → "<1 min" (not a demoralizing 0)', () => {
    expect(formatMinutesMeter({ remainingSeconds: 30, capPeriod: 'daily', walletRemaining: 0, now }).label)
      .toBe('<1 min left today');
  });

  it('zero remaining → "0 min left {period}"', () => {
    expect(formatMinutesMeter({ remainingSeconds: 0, capPeriod: 'daily', walletRemaining: 0, now }).label)
      .toBe('0 min left today');
  });

  it('null capPeriod → no period word', () => {
    expect(formatMinutesMeter({ remainingSeconds: 600, capPeriod: null, walletRemaining: 0, now }).label)
      .toBe('10 min left');
  });

  it('coerces junk numerics to 0 without throwing', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = formatMinutesMeter({ remainingSeconds: NaN as any, capPeriod: 'daily', walletRemaining: NaN as any, now });
    expect(c.label).toBe('0 min left today');
  });
});

describe('formatMinutesMeter — reset sublabel', () => {
  it('no-wallet free user gets a "resets in …" sublabel', () => {
    expect(formatMinutesMeter({ remainingSeconds: 600, capPeriod: 'daily', walletRemaining: 0, now }).sublabel)
      .toMatch(/^resets in /);
  });

  it('daily reset is always sub-24h (hours/minutes form)', () => {
    expect(formatMinutesMeter({ remainingSeconds: 600, capPeriod: 'daily', walletRemaining: 0, now }).sublabel)
      .toMatch(/^resets in (\d+h \d+m|\d+m)$/);
  });

  it('SUPPRESSED when the user holds wallet minutes (earned minutes do not reset)', () => {
    expect(formatMinutesMeter({ remainingSeconds: 720, capPeriod: 'weekly', walletRemaining: 120, now }).sublabel)
      .toBeNull();
  });

  it('SUPPRESSED when capPeriod is null', () => {
    expect(formatMinutesMeter({ remainingSeconds: 600, capPeriod: null, walletRemaining: 0, now }).sublabel)
      .toBeNull();
  });
});
