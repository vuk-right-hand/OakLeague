// /api/stripe/checkout tests — flag gate, origin, auth, tier mapping, customer
// reuse, session url.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockGetCaller, mockSessionCreate, mockCustomerCreate, mockSupabaseAdmin, mockSentry } = vi.hoisted(() => ({
  mockGetCaller: vi.fn(),
  mockSessionCreate: vi.fn(),
  mockCustomerCreate: vi.fn(),
  mockSupabaseAdmin: vi.fn(),
  mockSentry: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth-guards', () => ({ getCallerUserId: mockGetCaller }));
vi.mock('@/lib/stripe/client', () => ({
  stripe: () => ({ checkout: { sessions: { create: mockSessionCreate } }, customers: { create: mockCustomerCreate } }),
  paidTiersEnabled: () => process.env.GROWTH_PAID_TIERS_ENABLED === '1',
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => mockSupabaseAdmin() }));
vi.mock('@sentry/nextjs', () => ({ captureException: mockSentry }));

import { POST } from './route';

function adminDouble(custId: string | null = null) {
  const upsert = vi.fn(() => Promise.resolve({ error: null }));
  const admin = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: custId ? { stripe_customer_id: custId } : null, error: null }) }) }),
      upsert,
    }),
  };
  return { admin, upsert };
}
function req(body: unknown, withOrigin = true) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (withOrigin) headers.origin = 'http://localhost';
  return new NextRequest('http://localhost/api/stripe/checkout', { method: 'POST', headers, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GROWTH_PAID_TIERS_ENABLED = '1';
  process.env.STRIPE_PRICE_EVANGELIST = 'price_ev';
  process.env.STRIPE_PRICE_BOARDROOM = 'price_bd';
  process.env.NEXT_PUBLIC_SITE_URL = 'https://oak-league.vercel.app';
  mockSupabaseAdmin.mockReturnValue(adminDouble().admin);
  mockGetCaller.mockResolvedValue('user_1');
  mockCustomerCreate.mockResolvedValue({ id: 'cus_new' });
});
afterEach(() => {
  delete process.env.GROWTH_PAID_TIERS_ENABLED;
  delete process.env.STRIPE_PRICE_EVANGELIST;
  delete process.env.STRIPE_PRICE_BOARDROOM;
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

describe('POST /api/stripe/checkout', () => {
  it('404 when the flag is off', async () => {
    process.env.GROWTH_PAID_TIERS_ENABLED = '0';
    expect((await POST(req({ tier: 'evangelist' }))).status).toBe(404);
  });

  it('403 bad_origin on a cross-origin POST', async () => {
    const res = await POST(req({ tier: 'evangelist' }, false));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('bad_origin');
  });

  it('401 when unauthenticated', async () => {
    mockGetCaller.mockResolvedValue(null);
    expect((await POST(req({ tier: 'evangelist' }))).status).toBe(401);
  });

  it('400 bad_tier on an unknown tier', async () => {
    const res = await POST(req({ tier: 'nope' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_tier');
  });

  it('creates a customer + subscription session with metadata, returns url', async () => {
    mockSessionCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/c/sess_1' });
    const res = await POST(req({ tier: 'evangelist', source: 'meter' }));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe('https://checkout.stripe.com/c/sess_1');
    expect(mockCustomerCreate).toHaveBeenCalledWith({ metadata: { user_id: 'user_1' } });
    expect(mockSessionCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'subscription',
      line_items: [{ price: 'price_ev', quantity: 1 }],
      client_reference_id: 'user_1',
      customer: 'cus_new',
      subscription_data: { metadata: { user_id: 'user_1' } },
    }));
  });

  it('reuses an existing Stripe customer (no second customers.create)', async () => {
    mockSupabaseAdmin.mockReturnValue(adminDouble('cus_existing').admin);
    mockSessionCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/c/sess_2' });
    await POST(req({ tier: 'boardroom' }));
    expect(mockCustomerCreate).not.toHaveBeenCalled();
    expect(mockSessionCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_existing', line_items: [{ price: 'price_bd', quantity: 1 }] }));
  });

  it('502 when Stripe throws', async () => {
    mockSessionCreate.mockRejectedValue(new Error('stripe down'));
    const res = await POST(req({ tier: 'evangelist' }));
    expect(res.status).toBe(502);
    expect(mockSentry).toHaveBeenCalled();
  });
});
