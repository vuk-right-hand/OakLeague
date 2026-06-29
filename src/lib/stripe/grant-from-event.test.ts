import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  tierForPrice,
  isEntitledStatus,
  subStateFromSubscription,
  invoiceStateFromInvoice,
  interpretEvent,
} from './grant-from-event';

const iso = (unix: number) => new Date(unix * 1000).toISOString();

beforeEach(() => {
  process.env.STRIPE_PRICE_EVANGELIST = 'price_ev';
  process.env.STRIPE_PRICE_BOARDROOM = 'price_bd';
});
afterEach(() => {
  delete process.env.STRIPE_PRICE_EVANGELIST;
  delete process.env.STRIPE_PRICE_BOARDROOM;
});

describe('tierForPrice', () => {
  it('maps the two pinned SKUs', () => {
    expect(tierForPrice('price_ev')).toBe('premium');
    expect(tierForPrice('price_bd')).toBe('boardroom');
  });
  it('unknown / empty → null', () => {
    expect(tierForPrice('price_other')).toBeNull();
    expect(tierForPrice(null)).toBeNull();
    expect(tierForPrice(undefined)).toBeNull();
  });
});

describe('subStateFromSubscription', () => {
  it('extracts top-level period + item price (2020-08-27 shape)', () => {
    const st = subStateFromSubscription({
      id: 'sub_1', customer: 'cus_1', status: 'active',
      current_period_start: 1700000000, current_period_end: 1702592000,
      items: { data: [{ price: { id: 'price_ev' } }] },
    });
    expect(st).toMatchObject({
      customerId: 'cus_1', subscriptionId: 'sub_1', priceId: 'price_ev', tier: 'premium', status: 'active',
    });
    expect(st.currentPeriodStart).toBe(iso(1700000000));
    expect(st.currentPeriodEnd).toBe(iso(1702592000));
  });
  it('resolves an expanded customer object to its id + boardroom price', () => {
    const st = subStateFromSubscription({ id: 'sub_2', customer: { id: 'cus_2' }, items: { data: [{ price: { id: 'price_bd' } }] } });
    expect(st.customerId).toBe('cus_2');
    expect(st.tier).toBe('boardroom');
  });
  it('falls back to item-level period when top-level absent', () => {
    const st = subStateFromSubscription({ id: 's', customer: 'c', items: { data: [{ current_period_end: 1702592000, price: { id: 'price_ev' } }] } });
    expect(st.currentPeriodEnd).toBe(iso(1702592000));
  });
  it('unknown price → tier null (ignored upstream)', () => {
    const st = subStateFromSubscription({ id: 's', customer: 'c', items: { data: [{ price: { id: 'price_zzz' } }] } });
    expect(st.priceId).toBe('price_zzz');
    expect(st.tier).toBeNull();
  });
  it('extracts metadata.user_id (M4 mapping fallback), null when absent', () => {
    expect(subStateFromSubscription({ id: 's', customer: 'c', metadata: { user_id: 'user_meta' }, items: { data: [{ price: { id: 'price_ev' } }] } }).metadataUserId).toBe('user_meta');
    expect(subStateFromSubscription({ id: 's', customer: 'c', items: { data: [{ price: { id: 'price_ev' } }] } }).metadataUserId).toBeNull();
  });
});

describe('isEntitledStatus', () => {
  it('active / trialing / past_due are entitled (past_due = dunning grace)', () => {
    expect(isEntitledStatus('active')).toBe(true);
    expect(isEntitledStatus('trialing')).toBe(true);
    expect(isEntitledStatus('past_due')).toBe(true);
  });
  it('terminal / empty are not entitled', () => {
    expect(isEntitledStatus('canceled')).toBe(false);
    expect(isEntitledStatus('unpaid')).toBe(false);
    expect(isEntitledStatus('incomplete_expired')).toBe(false);
    expect(isEntitledStatus(null)).toBe(false);
    expect(isEntitledStatus(undefined)).toBe(false);
  });
});

describe('invoiceStateFromInvoice', () => {
  it('reads the renewal window from the LINE ITEM period (not invoice-level)', () => {
    const st = invoiceStateFromInvoice({
      customer: 'cus_1', subscription: 'sub_1',
      lines: { data: [{ period: { start: 1700000000, end: 1702592000 } }] },
    });
    expect(st).toMatchObject({ customerId: 'cus_1', subscriptionId: 'sub_1' });
    expect(st.currentPeriodStart).toBe(iso(1700000000));
    expect(st.currentPeriodEnd).toBe(iso(1702592000));
  });

  // Audit C1 (CONFIRMED LIVE) — only a true cycle renewal may advance the metering
  // window; prorations / plan-changes / manual invoices must NOT (they'd re-key the
  // monthly counter mid-period and re-grant the allowance).
  it('marks isRenewal=true ONLY for billing_reason=subscription_cycle', () => {
    const base = { customer: 'cus_1', subscription: 'sub_1', lines: { data: [{ period: { start: 1700000000, end: 1702592000 } }] } };
    expect(invoiceStateFromInvoice({ ...base, billing_reason: 'subscription_cycle' }).isRenewal).toBe(true);
    expect(invoiceStateFromInvoice({ ...base, billing_reason: 'subscription_cycle' }).billingReason).toBe('subscription_cycle');
  });
  it('marks isRenewal=false for prorations / updates / manual / missing reason', () => {
    const base = { customer: 'cus_1', subscription: 'sub_1', lines: { data: [{ period: { start: 1700000000, end: 1702592000 } }] } };
    for (const reason of ['subscription_update', 'subscription_create', 'manual', 'upcoming']) {
      expect(invoiceStateFromInvoice({ ...base, billing_reason: reason }).isRenewal).toBe(false);
    }
    // No billing_reason at all (fail safe → not a renewal).
    expect(invoiceStateFromInvoice(base).isRenewal).toBe(false);
    expect(invoiceStateFromInvoice(base).billingReason).toBeNull();
  });
});

describe('interpretEvent', () => {
  it('checkout.session.completed (subscription mode) → checkout action', () => {
    const a = interpretEvent({
      type: 'checkout.session.completed',
      data: { object: { mode: 'subscription', client_reference_id: 'user_1', customer: 'cus_1', subscription: 'sub_1' } },
    });
    expect(a).toEqual({ type: 'checkout', userId: 'user_1', customerId: 'cus_1', subscriptionId: 'sub_1' });
  });
  it('ignores a non-subscription checkout', () => {
    expect(interpretEvent({ type: 'checkout.session.completed', data: { object: { mode: 'payment' } } }).type).toBe('ignore');
  });
  it('customer.subscription.updated → subscription action with tier', () => {
    const a = interpretEvent({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: [{ price: { id: 'price_bd' } }] } } },
    });
    expect(a.type).toBe('subscription');
    if (a.type === 'subscription') expect(a.state.tier).toBe('boardroom');
  });
  it('customer.subscription.deleted → lapse', () => {
    expect(interpretEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1' } } }))
      .toEqual({ type: 'lapse', customerId: 'cus_1', subscriptionId: 'sub_1' });
  });
  it('invoice.paid → invoice action', () => {
    const a = interpretEvent({ type: 'invoice.paid', data: { object: { customer: 'cus_1', subscription: 'sub_1', lines: { data: [{ period: { start: 1, end: 2 } }] } } } });
    expect(a.type).toBe('invoice');
  });
  it('unhandled type → ignore', () => {
    expect(interpretEvent({ type: 'charge.refunded', data: { object: {} } }).type).toBe('ignore');
  });
});
