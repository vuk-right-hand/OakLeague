import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetCallerUserId = vi.fn();
const mockGetBalance = vi.fn();

vi.mock('@/lib/auth-guards', () => ({ getCallerUserId: () => mockGetCallerUserId() }));
vi.mock('@/lib/minutes/balance', () => ({ getBalance: (id: string) => mockGetBalance(id) }));

import { GET } from './route';

describe('GET /api/minutes/balance', () => {
  beforeEach(() => {
    process.env.GROWTH_METER_ENABLED = '1';
    mockGetCallerUserId.mockReset();
    mockGetBalance.mockReset();
  });
  afterEach(() => { delete process.env.GROWTH_METER_ENABLED; });

  it('flag off → {enabled:false} with NO auth and NO RPC', async () => {
    delete process.env.GROWTH_METER_ENABLED;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
    expect(mockGetCallerUserId).not.toHaveBeenCalled();
    expect(mockGetBalance).not.toHaveBeenCalled();
  });

  it('unauthenticated → 401, no RPC', async () => {
    mockGetCallerUserId.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized');
    expect(mockGetBalance).not.toHaveBeenCalled();
  });

  it('authed + balance → enabled with the meter shape, for the CALLER own id', async () => {
    mockGetCallerUserId.mockResolvedValue('user-1');
    mockGetBalance.mockResolvedValue({
      effectiveRemaining: 720, walletRemaining: 120, capPeriod: 'weekly', supporterActive: false,
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.balance).toEqual({
      remaining_seconds: 720, wallet_remaining: 120, cap_period: 'weekly', supporter_active: false,
    });
    expect(mockGetBalance).toHaveBeenCalledWith('user-1');
  });

  it('balance null (new user / transient) → enabled:true, balance:null (meter hides, never 500)', async () => {
    mockGetCallerUserId.mockResolvedValue('user-1');
    mockGetBalance.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.balance).toBeNull();
  });

  it('whitelists fields — never leaks the full balance row', async () => {
    mockGetCallerUserId.mockResolvedValue('user-1');
    mockGetBalance.mockResolvedValue({
      effectiveRemaining: 600, walletRemaining: 0, capPeriod: 'daily', supporterActive: true,
      dailyUsed: 999, walletActiveSeconds: 12345, walletSpentSeconds: 6789, // must NOT appear
    });
    const res = await GET();
    const body = await res.json();
    expect(Object.keys(body.balance).sort())
      .toEqual(['cap_period', 'remaining_seconds', 'supporter_active', 'wallet_remaining']);
  });
});
