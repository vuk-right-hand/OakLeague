// Unit coverage for the pure helpers backing ReactButton. The component
// itself is a thin shell over these — wiring tests live alongside the
// recording-controller in a future PR (and ultimately E2E on real surfaces).

import { afterEach, describe, expect, it } from 'vitest';
import {
  formatCountdown,
  isReactCaptureEnabled,
  isTappable,
  resolveAriaLabel,
  resolveLabel,
} from './react-button-state';

// ── isReactCaptureEnabled ──────────────────────────────────────────────

describe('isReactCaptureEnabled', () => {
  const original = process.env.NEXT_PUBLIC_REACT_CAPTURE_ENABLED;
  afterEach(() => {
    // delete when original was unset — assigning `undefined` writes the
    // literal string 'undefined' to the env which would poison subsequent
    // `=== '1'` checks (audit S integration).
    if (original === undefined) delete process.env.NEXT_PUBLIC_REACT_CAPTURE_ENABLED;
    else process.env.NEXT_PUBLIC_REACT_CAPTURE_ENABLED = original;
  });

  it('returns true only when env var is exactly "1"', () => {
    process.env.NEXT_PUBLIC_REACT_CAPTURE_ENABLED = '1';
    expect(isReactCaptureEnabled()).toBe(true);
  });
  it('returns false for "0"', () => {
    process.env.NEXT_PUBLIC_REACT_CAPTURE_ENABLED = '0';
    expect(isReactCaptureEnabled()).toBe(false);
  });
  it('returns false for empty string', () => {
    process.env.NEXT_PUBLIC_REACT_CAPTURE_ENABLED = '';
    expect(isReactCaptureEnabled()).toBe(false);
  });
  it('returns false for "true" — ONLY "1" is honored', () => {
    // Explicit because devs sometimes write 'true' expecting it to work.
    process.env.NEXT_PUBLIC_REACT_CAPTURE_ENABLED = 'true';
    expect(isReactCaptureEnabled()).toBe(false);
  });
  it('returns false when undefined', () => {
    delete process.env.NEXT_PUBLIC_REACT_CAPTURE_ENABLED;
    expect(isReactCaptureEnabled()).toBe(false);
  });
});

// ── formatCountdown ────────────────────────────────────────────────────

describe('formatCountdown', () => {
  it('formats as M:SS with zero-padded seconds', () => {
    expect(formatCountdown(60)).toBe('1:00');
    expect(formatCountdown(42)).toBe('0:42');
    expect(formatCountdown(7)).toBe('0:07');
    expect(formatCountdown(0)).toBe('0:00');
  });

  it('floors fractional input — never rounds up to over-promise time', () => {
    // We must never display 0:43 when the controller has 42.9s left;
    // the user should see the smaller number and act sooner.
    expect(formatCountdown(42.9)).toBe('0:42');
    expect(formatCountdown(0.5)).toBe('0:00');
  });

  it('clamps negatives to 0:00', () => {
    expect(formatCountdown(-3)).toBe('0:00');
    expect(formatCountdown(Number.NEGATIVE_INFINITY)).toBe('0:00');
  });

  it('NaN-safe (parent computing cap-elapsed with stale perf.now)', () => {
    expect(formatCountdown(Number.NaN)).toBe('0:00');
  });

  it('handles values exceeding the cap (defensive)', () => {
    expect(formatCountdown(125)).toBe('2:05');
  });
});

// ── resolveLabel ───────────────────────────────────────────────────────

describe('resolveLabel (count-up, uncapped rework)', () => {
  it('idle → "React"', () => {
    expect(resolveLabel('idle', undefined)).toBe('React');
  });
  it('priming → ellipsis (ASCII for tabular-nums width stability)', () => {
    expect(resolveLabel('priming', undefined)).toBe('...');
  });
  it('armed → elapsed count-UP', () => {
    expect(resolveLabel('armed', 42)).toBe('0:42');
    expect(resolveLabel('armed', 95)).toBe('1:35');
  });
  it('armed without explicit seconds → 0:00 (truthful just-armed render, distinct from priming)', () => {
    expect(resolveLabel('armed', undefined)).toBe('0:00');
  });
  it('armed in the final 30s before the safety ceiling → "ends in m:ss" warning', () => {
    expect(resolveLabel('armed', 280, 20)).toBe('ends in 0:20');
    expect(resolveLabel('armed', 270, 30)).toBe('ends in 0:30');
  });
  it('armed with >30s remaining shows the plain elapsed count-up', () => {
    expect(resolveLabel('armed', 42, 31)).toBe('0:42');
    expect(resolveLabel('armed', 42, 258)).toBe('0:42');
  });
  it('armed with Infinity remaining never warns', () => {
    expect(resolveLabel('armed', 42, Number.POSITIVE_INFINITY)).toBe('0:42');
  });
  it('stopping → "Saving…" (non-tappable outro, distinct from priming ellipsis)', () => {
    expect(resolveLabel('stopping', undefined)).toBe('Saving…');
  });
  it('disabled → "React" (rationale lives in the tooltip / aria)', () => {
    expect(resolveLabel('disabled', undefined)).toBe('React');
  });
});

// ── resolveAriaLabel ───────────────────────────────────────────────────

describe('resolveAriaLabel', () => {
  it('idle includes creator handle when present', () => {
    expect(resolveAriaLabel('idle', { creatorHandle: 'vuk' })).toBe('Record a duet with @vuk');
  });
  it('idle without handle is generic', () => {
    expect(resolveAriaLabel('idle', {})).toBe('Record a duet');
  });
  it('priming announces preparing state', () => {
    expect(resolveAriaLabel('priming', {})).toMatch(/preparing/i);
  });
  it('armed announces elapsed time and tap-to-finish affordance', () => {
    const a = resolveAriaLabel('armed', { armedSecondsElapsed: 30 });
    expect(a).toMatch(/0:30/);
    expect(a).toMatch(/elapsed/i);
    expect(a).toMatch(/finish/i);
  });
  it('stopping announces the finalize', () => {
    expect(resolveAriaLabel('stopping', {})).toMatch(/finishing/i);
  });
  it('disabled surfaces the reason when given', () => {
    const a = resolveAriaLabel('disabled', { disabledReason: 'daily cap reached' });
    expect(a).toMatch(/unavailable/i);
    expect(a).toMatch(/daily cap reached/);
  });
  it('disabled without reason is still readable', () => {
    expect(resolveAriaLabel('disabled', {})).toMatch(/unavailable/i);
  });
});

// ── isTappable ─────────────────────────────────────────────────────────

describe('isTappable', () => {
  it('true for idle and armed only', () => {
    expect(isTappable('idle')).toBe(true);
    expect(isTappable('armed')).toBe(true);
  });
  it('false during priming — double-tap window protection', () => {
    // A double-tap during the ~200ms cam-acquisition window otherwise
    // triggers a STOP on a session that hasn't even ARMED yet. This
    // guard is the central source of truth for that protection.
    expect(isTappable('priming')).toBe(false);
  });
  it('false during stopping — the 1.5s outro is finalizing the recording', () => {
    expect(isTappable('stopping')).toBe(false);
  });
  it('false when disabled', () => {
    expect(isTappable('disabled')).toBe(false);
  });
});
