import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { shapeReconcile, loadReconcile } from './reconcile';
import type { BlendedCogsRate } from './cogs-rate';

const RATE: BlendedCogsRate = { usdPerMin: 0.028, quotedAt: '2026-06-16', configured: true };

describe('shapeReconcile', () => {
  it('shapes summary + violations with implied/actual math (numerics arrive as strings)', () => {
    const summary = {
      granted_seconds_total: '120',
      granted_by_type: { signup_bonus: '900', referral_verified: 60 },
      wallet_active_total: '960',
      wallet_spent_total: '100',
      consumed_seconds_total: '600',
      voice_cogs_usd: '0.2799',
      wallet_mismatch_count: 1,
      overspent_count: 0,
      welcome_gap_count: 2,
    };
    const violations = [
      {
        user_id: 'u1', violation: 'wallet_mismatch',
        wallet_active_seconds: '960', wallet_spent_seconds: '0',
        grants_sum: '1060', onboarded_at: null, detail: 'wallet_active=960 but Σgrants=1060',
      },
    ];
    const r = shapeReconcile(summary, violations, RATE, { since: 'S', until: 'U', welcomeFloor: 'F' });

    expect(r.range).toEqual({ since: 'S', until: 'U', welcome_floor: 'F' });
    expect(r.flows.granted_seconds).toBe(120);
    expect(r.flows.granted_by_type).toEqual({ signup_bonus: 900, referral_verified: 60 });
    expect(r.flows.consumed_seconds).toBe(600);
    expect(r.stocks).toEqual({ wallet_active_seconds: 960, wallet_spent_seconds: 100, wallet_remaining_seconds: 860 });
    // implied from consumed: 600/60 * 0.028 = 0.28
    expect(r.cogs.implied_usd_from_consumed).toBe(0.28);
    // implied from granted: 120/60 * 0.028 = 0.056 → roundUsd → 0.06
    expect(r.cogs.implied_usd_from_granted).toBe(0.06);
    // actual: roundUsd(0.2799) → 0.28
    expect(r.cogs.actual_voice_usd).toBe(0.28);
    expect(r.cogs.blended_rate_configured).toBe(true);
    expect(r.cogs.blended_rate_quoted_at).toBe('2026-06-16');
    expect(r.violations.total).toBe(3); // 1 + 0 + 2
    expect(r.violations.offenders).toHaveLength(1);
    expect(r.violations.offenders[0]).toMatchObject({ user_id: 'u1', violation: 'wallet_mismatch', grants_sum: 1060 });
    expect(r.paid_reconciliation).toBe('deferred_phase6');
  });

  it('handles a null summary + empty violations (clean baseline)', () => {
    const r = shapeReconcile(null, [], RATE, { since: null, until: null, welcomeFloor: null });
    expect(r.flows.granted_seconds).toBe(0);
    expect(r.flows.granted_by_type).toEqual({});
    expect(r.stocks.wallet_remaining_seconds).toBe(0);
    expect(r.cogs.actual_voice_usd).toBe(0);
    expect(r.cogs.implied_usd_from_consumed).toBe(0);
    expect(r.violations.total).toBe(0);
    expect(r.violations.offenders).toEqual([]);
  });

  it('clamps wallet_remaining to >= 0 when spent exceeds active', () => {
    const r = shapeReconcile(
      { wallet_active_total: 100, wallet_spent_total: 250, granted_by_type: {} } as never,
      [], RATE, { since: null, until: null, welcomeFloor: null },
    );
    expect(r.stocks.wallet_remaining_seconds).toBe(0);
  });
});

describe('loadReconcile', () => {
  beforeEach(() => {
    process.env.MINUTES_BLENDED_COGS_USD_PER_MIN = '0.028';
    process.env.MINUTES_BLENDED_COGS_QUOTED_AT = '2026-06-16';
  });
  afterEach(() => {
    delete process.env.MINUTES_BLENDED_COGS_USD_PER_MIN;
    delete process.env.MINUTES_BLENDED_COGS_QUOTED_AT;
  });

  const emptySummary = {
    granted_seconds_total: 0, granted_by_type: {}, wallet_active_total: 0, wallet_spent_total: 0,
    consumed_seconds_total: 0, voice_cogs_usd: 0, wallet_mismatch_count: 0, overspent_count: 0, welcome_gap_count: 0,
  };

  it('calls both RPCs with the range + welcome floor and assembles the report', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [emptySummary], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    const r = await loadReconcile({ rpc } as never, { since: 'S', until: 'U', welcomeFloor: 'F', violationLimit: 50 });
    expect(rpc).toHaveBeenCalledWith('minutes_reconcile_summary', { p_from: 'S', p_to: 'U', p_welcome_floor: 'F' });
    expect(rpc).toHaveBeenCalledWith('minutes_reconcile_violations', { p_limit: 50, p_welcome_floor: 'F' });
    expect(r.violations.total).toBe(0);
    expect(r.cogs.blended_rate_configured).toBe(true);
  });

  it('defaults to null range + limit 100 when options omitted', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [emptySummary], error: null });
    await loadReconcile({ rpc } as never, {});
    expect(rpc).toHaveBeenCalledWith('minutes_reconcile_summary', { p_from: null, p_to: null, p_welcome_floor: null });
    expect(rpc).toHaveBeenCalledWith('minutes_reconcile_violations', { p_limit: 100, p_welcome_floor: null });
  });

  it('throws when the summary RPC errors', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
      .mockResolvedValueOnce({ data: [], error: null });
    await expect(loadReconcile({ rpc } as never, {})).rejects.toThrow(/reconcile_summary_failed/);
  });

  it('throws when the violations RPC errors', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [emptySummary], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'kaboom' } });
    await expect(loadReconcile({ rpc } as never, {})).rejects.toThrow(/reconcile_violations_failed/);
  });
});
