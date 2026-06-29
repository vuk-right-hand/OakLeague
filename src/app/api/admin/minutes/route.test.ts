// /api/admin/minutes route tests — admin auth gate + report shape.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRpc, mockAssertAdmin } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockAssertAdmin: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth-guards', () => ({
  assertAdminFromSession: mockAssertAdmin,
  AuthGuardError: class AuthGuardError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  },
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ rpc: mockRpc }) }));

import { GET } from './route';
import { AuthGuardError } from '@/lib/auth-guards';

const EMPTY_SUMMARY = {
  granted_seconds_total: 0, granted_by_type: {}, wallet_active_total: 0, wallet_spent_total: 0,
  consumed_seconds_total: 0, voice_cogs_usd: 0, wallet_mismatch_count: 0, overspent_count: 0, welcome_gap_count: 0,
};

function mkReq(qs = '') {
  return new NextRequest(`http://localhost/api/admin/minutes${qs}`, { method: 'GET' });
}

beforeEach(() => {
  mockRpc.mockReset();
  mockAssertAdmin.mockReset();
  mockAssertAdmin.mockResolvedValue({ userId: 'admin-1', email: 'a@b', role: 'superadmin' });
});
afterEach(() => vi.restoreAllMocks());

describe('GET /api/admin/minutes', () => {
  it('403 when caller is not an admin', async () => {
    mockAssertAdmin.mockRejectedValue(new AuthGuardError('Forbidden', 403));
    const res = await GET(mkReq());
    expect(res.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('200 returns the shaped reconcile report', async () => {
    mockRpc.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'minutes_reconcile_summary' ? { data: [EMPTY_SUMMARY], error: null } : { data: [], error: null }),
    );
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('flows');
    expect(body).toHaveProperty('stocks');
    expect(body).toHaveProperty('cogs');
    expect(body.violations.total).toBe(0);
    expect(body.paid_reconciliation).toBe('deferred_phase6');
    // summary call carries the default 30d window (non-null bounds) + null floor.
    const summaryCall = mockRpc.mock.calls.find((c) => c[0] === 'minutes_reconcile_summary');
    expect(summaryCall?.[1]).toMatchObject({ p_welcome_floor: null });
    expect(summaryCall?.[1].p_from).toBeTruthy();
  });

  it('400 bad_range when since is after until', async () => {
    const res = await GET(mkReq('?since=2026-06-10T00:00:00Z&until=2026-06-01T00:00:00Z'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_range');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('400 bad_param on a present-but-unparseable date (M4 — no silent default)', async () => {
    const res = await GET(mkReq('?since=garbage'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_param');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('200 for a valid past window (does not 400 spuriously)', async () => {
    mockRpc.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'minutes_reconcile_summary' ? { data: [EMPTY_SUMMARY], error: null } : { data: [], error: null }),
    );
    const res = await GET(mkReq('?until=2026-06-01T00:00:00Z&since=2026-05-01T00:00:00Z'));
    expect(res.status).toBe(200);
  });

  it('500 reconcile_failed when an RPC errors', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await GET(mkReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('reconcile_failed');
  });
});
