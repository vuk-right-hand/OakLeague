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
  // C2 — the webhook processes only when paid tiers are enabled. Tests toggle the
  // env directly (beforeEach turns it ON); the flag-OFF case is its own test.
  paidTiersEnabled: () => process.env.GROWTH_PAID_TIERS_ENABLED === '1',
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
      // stripe_customers / stripe_unmapped_events (else branch)
      // .update(...).eq(...) is awaited directly (invoice/lapse patch), AND
      // .update(...).eq(...).is(...) is awaited (M2 dead-letter auto-resolve) — so
      // eq() returns a thenable that ALSO exposes .is().
      const eqResult = () => Object.assign(Promise.resolve({ error: null }), { is: () => Promise.resolve({ error: null }) });
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }),
        upsert: (vals: unknown) => { calls.upsert(vals); return Promise.resolve({ error: null }); },
        update: (vals: unknown) => { calls.custUpdate(vals); return { eq: () => eqResult() }; },
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
  process.env.GROWTH_PAID_TIERS_ENABLED = '1';
});
afterEach(() => {
  delete process.env.STRIPE_PRICE_EVANGELIST;
  delete process.env.STRIPE_PRICE_BOARDROOM;
  delete process.env.GROWTH_PAID_TIERS_ENABLED;
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

  it('C2 — paid tiers OFF: 200 ignored after sig verify, no DB touch', async () => {
    delete process.env.GROWTH_PAID_TIERS_ENABLED;
    mockConstructEvent.mockReturnValue({ id: 'evt_off', type: 'invoice.paid', data: { object: { id: 'in_1' } } });
    const { admin, calls } = makeAdmin({});
    mockSupabaseAdmin.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).ignored).toBe('paid_tiers_disabled');
    expect(calls.insert).not.toHaveBeenCalled();
    expect(calls.rpc).not.toHaveBeenCalled();
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
    // M1 — one ATOMIC RPC does the upsert + flip (no separate upsert round-trip).
    expect(calls.rpc).toHaveBeenCalledWith('stripe_apply_subscription_state', expect.objectContaining({
      p_user_id: 'user_1', p_stripe_customer_id: 'cus_1', p_customer_tier: 'premium',
      p_status: 'active', p_effective_tier: 'premium',
    }));
    expect(calls.processed).toHaveBeenCalled();
  });

  it('checkout under dahlia shape (current_period_* on the ITEM, none top-level) → period still persisted', async () => {
    // Audit C1 — the pinned 2026-05-27.dahlia API returns NO top-level
    // current_period_*; it lives on items.data[0]. The parser's item fallback must
    // keep p_current_period_start non-null, else monthly_window_start degrades to
    // calendar month and re-grants the allowance.
    mockConstructEvent.mockReturnValue({
      id: 'evt_dahlia', type: 'checkout.session.completed',
      data: { object: { id: 'cs_d', mode: 'subscription', client_reference_id: 'user_d', customer: 'cus_d', subscription: 'sub_d' } },
    });
    mockRetrieve.mockResolvedValue({
      id: 'sub_d', customer: 'cus_d', status: 'active',
      // NO top-level current_period_* (dahlia) — only on the item.
      items: { data: [{ price: { id: 'price_ev' }, current_period_start: 1700000000, current_period_end: 1702592000 }] },
    });
    const { admin, calls } = makeAdmin({});
    mockSupabaseAdmin.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(200);
    const args = calls.rpc.mock.calls.find((c: unknown[]) => c[0] === 'stripe_apply_subscription_state')?.[1] as Record<string, unknown>;
    expect(args.p_effective_tier).toBe('premium');
    expect(args.p_current_period_start).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('subscription.deleted → flips the mapped user to free', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1' } } });
    const { admin, calls } = makeAdmin({ userByCustomer: 'user_9' });
    mockSupabaseAdmin.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(calls.rpc).toHaveBeenCalledWith('set_profile_tier_from_subscription', { p_user_id: 'user_9', p_new_tier: 'free' });
  });

  it('C3 — subscription event for an unmapped customer (no metadata) → 200, recorded to dead-letter, no tier rpc', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_4', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', customer: 'cus_unknown', items: { data: [{ price: { id: 'price_bd' } }] } } } });
    const { admin, calls } = makeAdmin({ userByCustomer: null });
    mockSupabaseAdmin.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(calls.rpc).not.toHaveBeenCalled();
    // dead-letter upsert + a loud Sentry alert (not a silent drop)
    expect(calls.upsert).toHaveBeenCalledWith(expect.objectContaining({ event_id: 'evt_4', stripe_customer_id: 'cus_unknown' }));
    expect(mockSentry).toHaveBeenCalled();
  });

  it('entitled subscription.updated (status active) → atomic apply to the priced tier', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_6', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', customer: 'cus_1', items: { data: [{ price: { id: 'price_bd' } }] } } } });
    const { admin, calls } = makeAdmin({ userByCustomer: 'user_7' });
    mockSupabaseAdmin.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(calls.rpc).toHaveBeenCalledWith('stripe_apply_subscription_state', expect.objectContaining({ p_user_id: 'user_7', p_effective_tier: 'boardroom', p_customer_tier: 'boardroom' }));
  });

  it('terminal subscription.updated (status canceled) → atomic apply to free', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_7', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'canceled', customer: 'cus_1', items: { data: [{ price: { id: 'price_bd' } }] } } } });
    const { admin, calls } = makeAdmin({ userByCustomer: 'user_7' });
    mockSupabaseAdmin.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(calls.rpc).toHaveBeenCalledWith('stripe_apply_subscription_state', expect.objectContaining({ p_user_id: 'user_7', p_effective_tier: 'free' }));
  });

  it('maps an unmapped customer via the subscription metadata.user_id fallback (M4)', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_8', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', customer: 'cus_orphan', metadata: { user_id: 'user_meta' }, items: { data: [{ price: { id: 'price_ev' } }] } } } });
    const { admin, calls } = makeAdmin({ userByCustomer: null });
    mockSupabaseAdmin.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(calls.rpc).toHaveBeenCalledWith('stripe_apply_subscription_state', expect.objectContaining({ p_user_id: 'user_meta', p_effective_tier: 'premium' }));
  });

  it('C1 — invoice.paid proration (billing_reason!=subscription_cycle) does NOT advance the period', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_pr', type: 'invoice.paid', data: { object: { id: 'in_pr', customer: 'cus_1', subscription: 'sub_1', billing_reason: 'subscription_update', lines: { data: [{ period: { start: 1700000000, end: 1702592000 } }] } } } });
    const { admin, calls } = makeAdmin({ userByCustomer: 'user_7', storedTier: 'premium' });
    mockSupabaseAdmin.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(200);
    // status refreshed + tier re-asserted, but NO current_period_start in the patch.
    const patch = calls.custUpdate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(patch).toBeDefined();
    expect(patch.status).toBe('active');
    expect(patch).not.toHaveProperty('current_period_start');
  });

  it('C1 — invoice.paid TRUE renewal (subscription_cycle) DOES advance the period', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_rn', type: 'invoice.paid', data: { object: { id: 'in_rn', customer: 'cus_1', subscription: 'sub_1', billing_reason: 'subscription_cycle', lines: { data: [{ period: { start: 1709251200, end: 1711843200 } }] } } } });
    const { admin, calls } = makeAdmin({ userByCustomer: 'user_7', storedTier: 'premium' });
    mockSupabaseAdmin.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(200);
    const patch = calls.custUpdate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(patch.current_period_start).toBe(new Date(1709251200 * 1000).toISOString());
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
