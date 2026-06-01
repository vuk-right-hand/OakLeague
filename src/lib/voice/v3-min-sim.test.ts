import { describe, it, expect, vi } from 'vitest';
import {
  resolveV3MinSimByMode,
  V3_MIN_SIM_PLACEHOLDERS,
} from './v3-min-sim';

describe('resolveV3MinSimByMode', () => {
  it('returns the placeholders when no env override is set (silent)', () => {
    const logs: string[] = [];
    const out = resolveV3MinSimByMode({}, (m) => logs.push(m));
    expect(out).toEqual(V3_MIN_SIM_PLACEHOLDERS);
    expect(logs).toEqual([]); // all-absent is the expected pre-calibration state
  });

  it('applies a valid per-mode override', () => {
    const out = resolveV3MinSimByMode({ V3_MIN_SIM_MAX_BLEND: '0.35' }, () => {});
    expect(out.max_blend).toBe(0.35);
    // untouched modes keep placeholders
    expect(out.vec_max).toBe(V3_MIN_SIM_PLACEHOLDERS.vec_max);
  });

  it('accepts the boundary value 1 but REJECTS >1, ≤0, and non-finite (→ placeholder + log)', () => {
    const logs: string[] = [];
    const out = resolveV3MinSimByMode(
      {
        V3_MIN_SIM_MAX: '1',          // valid boundary
        V3_MIN_SIM_MAX_BLEND: '1.5',  // >1 → reject (would nuke every child)
        V3_MIN_SIM_VEC_MAX: '0',      // ≤0 → reject
        V3_MIN_SIM_BEST_CHILD: 'abc', // NaN → reject
      },
      (m) => logs.push(m),
    );
    expect(out.max).toBe(1);
    expect(out.max_blend).toBe(V3_MIN_SIM_PLACEHOLDERS.max_blend);
    expect(out.vec_max).toBe(V3_MIN_SIM_PLACEHOLDERS.vec_max);
    expect(out.best_child).toBe(V3_MIN_SIM_PLACEHOLDERS.best_child);
    const rejected = logs.find((m) => m.includes('REJECTED'));
    expect(rejected).toBeTruthy();
    expect(rejected).toContain('V3_MIN_SIM_MAX_BLEND');
    expect(rejected).toContain('V3_MIN_SIM_VEC_MAX');
    expect(rejected).toContain('V3_MIN_SIM_BEST_CHILD');
    // a rejected value must NOT leak into a "placeholder" disguise — the raw is shown
    expect(rejected).toContain('1.5');
  });

  it('logs which modes are still on placeholders when a PARTIAL override is set', () => {
    const logs: string[] = [];
    resolveV3MinSimByMode({ V3_MIN_SIM_MAX_BLEND: '0.33' }, (m) => logs.push(m));
    const partial = logs.find((m) => m.includes('still on PLACEHOLDER'));
    expect(partial).toBeTruthy();
    // the prod-frozen mode is pinned; the other three are named as un-pinned
    expect(partial).toContain('max');
    expect(partial).toContain('vec_max');
    expect(partial).toContain('best_child');
    expect(partial).not.toMatch(/\bmax_blend\b/); // the one that WAS set
  });

  it('treats empty-string and whitespace env values as absent (placeholder)', () => {
    const out = resolveV3MinSimByMode({ V3_MIN_SIM_MAX: '', V3_MIN_SIM_VEC_MAX: '   ' }, () => {});
    expect(out).toEqual(V3_MIN_SIM_PLACEHOLDERS);
  });

  it('defaults the log sink to console.warn (smoke — does not throw)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => resolveV3MinSimByMode({ V3_MIN_SIM_MAX: 'nope' })).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
