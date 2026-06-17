// /api/stripe/webhook tests — signature gate, exactly-once dedup, tier flip,
// and the delete-dedup-on-failure retry contract.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockConstructEvent, mockRetrieve, mockSupabaseAdmin, mockSentry } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockRetrieve: vi.fn(),
  mockSupabaseAdmin: vi.fn(),
  mockSentry: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/stripe/client', () => ({
  stripe: () => ({
    webhooks: { constructEvent: mockConstructEvent },
    subscriptions: { retrieve: mockRetrieve },
  }),
  stripeWebhookSecret: () => 'whsec_test',
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => mockSupabaseAdmin() }));
vi.mock('@sentry/nextjs', () => ({ captureException: mockSentry, captureMessage: mockSentry }));

import { POST } from './route';

// A per-test admin double that matches the exact call shapes in the route.
function makeAdmin(opts: { insertError?: { code?: string } | null; userByCustomer?: string | null; storedTier?: string | null; rpcError?: { message: string } | null } = {}) {
  const calls = { insert: vi.fn(), upsert: vi.fn(), rpc: vi.fn(), processed: vi.fn(), deleted: vi.fn(), custUpdate: vi.fn() };
  const row = opts.userByCustomer ? { user_id: opts.userByCustomer, tier: opts.storedTier ?? null } : null;
  const admin = {
    from(table: string) {
      if (table === 'stripe_events') {
        return {
          insert: (vals: unknown) => { calls.insert(vals); return Promise.resolve({ error: opts.insertError ?? null }); },
          update: (vals: unknown) => { calls.processed(vals); return { eq: () => Promise.resolve({ error: null }) }; },
          delete: () => { calls.deleted(); return { eq: () => ({ is: () => Promise.resolve({ error: null }) }) }; },
        };
      }
      // stripe_customers
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }),
        upsert: (vals: unknown) => { calls.upsert(vals); return Promise.resolve({ error: null }); },
        update: (vals: unknown) => { calls.custUpdate(vals); return { eq: () => Promise.resolve({ error: null }) }; },
      };
    },
    rpc: (fn: string, args: unknown) => { calls.rpc(fn, args); return Promise.resolve({ data: null, error: opts.rpcError ?? null }); },
  };
  return { admin, calls };
}

function req(body = '{}', sig: string | null = 'sig') {
  const headers: Record<string, string> = {};
  if (sig !== null) headers['stripe-signature'] = sig;
  return new NextRequest('http://localhost/api/stripe/webhook', { method: 'POST', headers, body });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_PRICE_EVANGELIST = 'price_ev';
  process.env.STRIPE_PRICE_BOARDROOM = 'price_bd';
});
afterEach(() => {
  delete process.env.STRIPE_PRICE_EVANGELIST;
  delete process.env.STRIPE_PRICE_BOARDROOM;
});

describe('POST /api/stripe/webhook', () => {
  it('400 when the signature header is missing', async () => {
    const res = await POST(req('{}', null));
    expect(res.status).toBe(400);
    expect(mockConstructEvent).not.toHaveBeenCalled();
  });

  it('400 when signature verification fails', async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    const res = await POST(req());
    expect(res.status).toBe(400);
  });

  it('200 deduped on a duplicate event (PK conflict), no handling', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_1', type: 'invoice.paid', data: { object: { id: 'in_1' } } });
    const { admin, calls } = makeAdmin({ insertError: { code: '23505' } });
    mockSupabaseAdmin.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).deduped).toBe(true);
    expect(calls.rpc).not.toHaveBeenCalled();
  });

  it('checkout.session.completed → retrieves sub, upserts customer, flips tier, 200', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_2', type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', mode: 'subscription', client_reference_id: 'user_1', customer: 'cus_1', subscription: 'sub_1' } },
    });
    mockRetrieve.mockResolvedValue({
      id: 'sub_1', customer: 'cus_1', status: 'active',
      current_period_start: 1700000000, current_period_end: 1702592000,
      items: { data: [{ price: { id: 'price_ev' } }] },
    });
    const { admin, calls } = makeAdmin({});
    mockSupabaseAdmin.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(mockRetrieve).toHaveBeenCalledWith('sub_1');
    expect(calls.upsert).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'user_1', tier: 'premium', stripe_customer_id: 'cus_1' }));
    expect(calls.rpc).toHaveBeenCalledWith('set_profile_tier_from_subscription', { p_user_id: 'user_1', p_new_tier: 'premium' });
    expect(calls.processed).toHaveBeenCalled();
  });

  it('subscription.deleted → flips the mapped user to free', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1' } } });
    const { admin, calls } = makeAdmin({ userByCustomer: 'user_9' });
    mockSupabaseAdmin.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(calls.rpc).toHaveBeenCalledWith('set_profile_tier_from_subscription', { p_user_id: 'user_9', p_new_tier: 'free' });
  });

  it('subscription event for an unmapped customer (no metadata) → 200 no-op', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_4', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', customer: 'cus_unknown', items: { data: [{ price: { id: 'price_bd' } }] } } } });
    const { admin, calls } = makeAdmin({ userByCustomer: null });
    mockSupabaseAdmin.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(calls.rpc).not.toHaveBeenCalled();
  });

  it('entitled subscription.updated (status active) → flips to the priced tier', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_6', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', customer: 'cus_1', items: { data: [{ price: { id: 'price_bd' } }] } } } });
    const { admin, calls } = makeAdmin({ userByCustomer: 'user_7' });
    mockSupabaseAdmin.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(calls.rpc).toHaveBeenCalledWith('set_profile_tier_from_subscription', { p_user_id: 'user_7', p_new_tier: 'boardroom' });
  });

  it('terminal subscription.updated (status canceled) → flips the user to free', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_7', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'canceled', customer: 'cus_1', items: { data: [{ price: { id: 'price_bd' } }] } } } });
    const { admin, calls } = makeAdmin({ userByCustomer: 'user_7' });
    mockSupabaseAdmin.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(calls.rpc).toHaveBeenCalledWith('set_profile_tier_from_subscription', { p_user_id: 'user_7', p_new_tier: 'free' });
  });

  it('maps an unmapped customer via the subscription metadata.user_id fallback (M4)', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_8', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', customer: 'cus_orphan', metadata: { user_id: 'user_meta' }, items: { data: [{ price: { id: 'price_ev' } }] } } } });
    const { admin, calls } = makeAdmin({ userByCustomer: null });
    mockSupabaseAdmin.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(calls.rpc).toHaveBeenCalledWith('set_profile_tier_from_subscription', { p_user_id: 'user_meta', p_new_tier: 'premium' });
  });

  it('handler failure deletes the dedup row and 500s (so Stripe retries)', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_5', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1' } } });
    const { admin, calls } = makeAdmin({ userByCustomer: 'user_9', rpcError: { message: 'db down' } });
    mockSupabaseAdmin.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(calls.deleted).toHaveBeenCalled();
  });
});
