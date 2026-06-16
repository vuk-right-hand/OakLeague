// getBalance — maps the voice_balance_check RPC row to a typed MinutesBalance
// with string→number coercion (supabase-js returns numerics as strings) and
// null cap passthrough. Guards the field names against the `any`-typed RPC.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRpc, mockSentryCapture } = vi.hoisted(() => ({ mockRpc: vi.fn(), mockSentryCapture: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ rpc: mockRpc }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: mockSentryCapture }));

import { getBalance } from './balance';

const UID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

describe('getBalance', () => {
  beforeEach(() => { mockRpc.mockReset(); mockSentryCapture.mockReset(); });

  it('maps + coerces a full balance row (numeric strings → numbers, null caps)', async () => {
    mockRpc.mockResolvedValue({
      data: [{
        effective_remaining: 1020, remaining_seconds: 1020, allowance_remaining: 420,
        wallet_remaining: 600, recruiter_bonus: 120,
        daily_used: '0', daily_cap: 300, daily_cap_eff: 420,
        weekly_used: '0', weekly_cap: 900,
        monthly_used: '0', monthly_cap: null,
        wallet_active_seconds: '600', wallet_spent_seconds: '0',
        cap_period: 'daily', supporter_active: false,
      }],
      error: null,
    });
    const b = await getBalance(UID);
    expect(b).toEqual({
      effectiveRemaining: 1020, allowanceRemaining: 420, walletRemaining: 600,
      recruiterBonus: 120, dailyUsed: 0, dailyCap: 300, dailyCapEff: 420,
      weeklyUsed: 0, weeklyCap: 900, monthlyUsed: 0, monthlyCap: null,
      walletActiveSeconds: 600, walletSpentSeconds: 0, capPeriod: 'daily', supporterActive: false,
    });
  });

  it('returns null + captures on a generic RPC error (M6)', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await getBalance(UID)).toBeNull();
    expect(mockSentryCapture).toHaveBeenCalledOnce();
  });

  it('returns null WITHOUT capturing on P0002 (profile not ready) (M6)', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'P0002', message: 'user not found' } });
    expect(await getBalance(UID)).toBeNull();
    expect(mockSentryCapture).not.toHaveBeenCalled();
  });

  it('returns null on empty data', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    expect(await getBalance(UID)).toBeNull();
  });
});
