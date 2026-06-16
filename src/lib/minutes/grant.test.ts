// grantMinutes — maps the minute_grant_insert RPC result to a typed result and
// passes the correct args (the RPC is `any`-typed, so TS won't catch a field
// typo; these tests do).
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRpc, mockSentryCapture } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockSentryCapture: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ rpc: mockRpc }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: mockSentryCapture }));

import { grantMinutes } from './grant';

const UID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

describe('grantMinutes', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockSentryCapture.mockReset();
  });

  it('maps a successful grant', async () => {
    mockRpc.mockResolvedValue({ data: [{ granted: true, reason: null, grant_id: 42 }], error: null });
    const r = await grantMinutes({
      userId: UID, type: 'referral_verified', seconds: 900,
      sourceKind: 'referral_token', sourceKey: 'tok_abc',
    });
    expect(r).toEqual({ granted: true, reason: null, grantId: 42 });
  });

  it('maps a dedup no-op', async () => {
    mockRpc.mockResolvedValue({ data: [{ granted: false, reason: 'duplicate', grant_id: null }], error: null });
    const r = await grantMinutes({
      userId: UID, type: 'signup_bonus', seconds: 900, sourceKind: 'signup', sourceKey: 'signup:x',
    });
    expect(r).toEqual({ granted: false, reason: 'duplicate', grantId: null });
  });

  it('passes floored seconds, null source_key default, and NO expires_at', async () => {
    mockRpc.mockResolvedValue({ data: [{ granted: true, reason: null, grant_id: 1 }], error: null });
    await grantMinutes({ userId: UID, type: 'share_tap', seconds: 60.9, sourceKind: 'share_token' });
    const [fn, args] = mockRpc.mock.calls[0];
    expect(fn).toBe('minute_grant_insert');
    expect(args).toMatchObject({
      p_user_id: UID, p_grant_type: 'share_tap', p_seconds: 60,
      p_source_kind: 'share_token', p_source_key: null, p_metadata: null,
    });
    expect('p_expires_at' in args).toBe(false);
  });

  it('returns reason=error and captures on RPC error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const r = await grantMinutes({
      userId: UID, type: 'paid_topup', seconds: 100, sourceKind: 'stripe_event', sourceKey: 'evt_1',
    });
    expect(r).toEqual({ granted: false, reason: 'error', grantId: null });
    expect(mockSentryCapture).toHaveBeenCalledOnce();
  });
});
