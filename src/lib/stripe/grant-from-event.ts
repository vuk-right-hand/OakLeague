// Growth & Minutes Economy Phase 6 — pure Stripe-event interpretation (plan §8).
//
// No IO, no SDK calls — takes already-parsed event/object shapes and returns a
// normalized action + extracted state. The webhook route orchestrates the IO
// (retrieve subscription, RPC tier-flip, upsert). Keeping this pure makes the
// price→tier mapping and the field extraction unit-testable with fixture payloads.
//
// Version-tolerant by design — DO NOT assume a single API shape. Our SDK is pinned
// to 2026-05-27.dahlia (client.ts), where Stripe (Basil 2025-03-31+) MOVED
// subscription.current_period_start/end OFF the subscription onto
// items.data[].current_period_*, and DEPRECATED invoice.subscription in favor of
// invoice.parent.subscription_details.subscription. The Stripe webhook ENDPOINT may
// render events at a DIFFERENT version than the SDK uses for retrieve(), so we read
// BOTH locations for the period and NEVER key user-mapping off subscription id —
// mapping is always by `customer` (top-level on every version). subStateFromSubscription
// reads top-level current_period_* first, then the item fallback; invoiceStateFromInvoice
// reads the LINE-ITEM period. Keep it shape-agnostic so neither a version bump nor an
// endpoint/ SDK version skew can silently break parsing.

export type ProfileTier = 'free' | 'premium' | 'boardroom';

// Loose shapes — we never trust the SDK's version-specific types here.
type AnyObj = Record<string, unknown>;
function obj(v: unknown): AnyObj | null {
  return v && typeof v === 'object' ? (v as AnyObj) : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function unixToIso(v: unknown): string | null {
  return typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null;
}
// A field that may be a bare id string or an expanded object with an `id`.
function idOf(v: unknown): string | null {
  if (typeof v === 'string') return v || null;
  const o = obj(v);
  return o ? str(o.id) : null;
}

/** price_id → tier via the pinned env SKUs. Unknown price ⇒ null. Callers handle it:
 *  the webhook stores the customer row + alerts 'stripe_unknown_price' (never silently
 *  dropped, never downgrades a paying user to free on an unrecognized SKU). */
export function tierForPrice(priceId: string | null | undefined): ProfileTier | null {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_EVANGELIST) return 'premium';
  if (priceId === process.env.STRIPE_PRICE_BOARDROOM) return 'boardroom';
  return null;
}

// "Entitled" = the user keeps their paid tier. past_due is the dunning grace
// window (Stripe retries the card for ~2 weeks before going terminal). Must match
// the monthly_window_start + reconcile SQL exactly.
const ENTITLED = new Set(['active', 'trialing', 'past_due']);
export function isEntitledStatus(status: string | null | undefined): boolean {
  return !!status && ENTITLED.has(status);
}

export interface SubState {
  customerId: string | null;
  subscriptionId: string | null;
  priceId: string | null;
  tier: ProfileTier | null;
  status: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  // M4: user mapping carried on the subscription (set via
  // subscription_data.metadata at checkout) so a subscription event can self-map
  // even if checkout.session.completed (the client_reference_id carrier) is lost.
  metadataUserId: string | null;
}

/** Normalize a Stripe Subscription object (from retrieve or a subscription.* event). */
export function subStateFromSubscription(sub: unknown): SubState {
  const s = obj(sub) ?? {};
  const items = obj(s.items);
  const firstItem = items && Array.isArray(items.data) ? obj(items.data[0]) : null;
  const price = firstItem ? obj(firstItem.price) : null;
  const priceId = price ? str(price.id) : null;
  // current_period_* live top-level in 2020-08-27; fall back to the item if a
  // newer payload ever moves them there.
  const cpStart = unixToIso(s.current_period_start) ?? (firstItem ? unixToIso(firstItem.current_period_start) : null);
  const cpEnd = unixToIso(s.current_period_end) ?? (firstItem ? unixToIso(firstItem.current_period_end) : null);
  const meta = obj(s.metadata);
  return {
    customerId: idOf(s.customer),
    subscriptionId: str(s.id),
    priceId,
    tier: tierForPrice(priceId),
    status: str(s.status),
    currentPeriodStart: cpStart,
    currentPeriodEnd: cpEnd,
    metadataUserId: meta ? str(meta.user_id) : null,
  };
}

export interface InvoiceState {
  customerId: string | null;
  subscriptionId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  // Whole-unit audit C1 (CONFIRMED LIVE) — Stripe fires invoice.paid not only on a
  // clean renewal but also on prorations / plan-changes / mid-cycle updates
  // (billing_reason='subscription_update'|'subscription_create'|'manual'), whose
  // line-item period can start MID-billing-period. The webhook must NOT advance
  // stripe_customers.current_period_start on those — monthly_window_start keys the
  // monthly avatar-talk counter off it, so advancing it re-keys voice_usage_monthly
  // to a fresh 0-used row and RE-GRANTS the whole monthly allowance early (a direct
  // COGS leak). Only a true cycle renewal legitimately opens a new metering window.
  billingReason: string | null;
  isRenewal: boolean;
}

/** Renewal window from an invoice — period comes from the LINE ITEM, not invoice-level (R2-M5). */
export function invoiceStateFromInvoice(invoice: unknown): InvoiceState {
  const inv = obj(invoice) ?? {};
  const lines = obj(inv.lines);
  const data = lines && Array.isArray(lines.data) ? lines.data : [];
  // Prefer the subscription line item's period.
  let start: string | null = null;
  let end: string | null = null;
  let subId = idOf(inv.subscription);
  for (const ln of data) {
    const l = obj(ln);
    if (!l) continue;
    const period = obj(l.period);
    if (period) {
      const ps = unixToIso(period.start);
      const pe = unixToIso(period.end);
      if (pe) { start = ps; end = pe; }
    }
    if (!subId) subId = idOf(l.subscription);
    if (end) break;
  }
  const billingReason = str(inv.billing_reason);
  return {
    customerId: idOf(inv.customer),
    subscriptionId: subId,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    billingReason,
    // 'subscription_cycle' is the ONLY periodic-renewal reason that opens a new
    // billing window. Every other reason — subscription_create, subscription_update
    // (proration/plan-change), subscription_threshold (usage thresholds; N/A to our
    // fixed-price tiers, but it must NOT advance the window if a usage SKU is ever
    // added), manual, upcoming, null — must leave the metering boundary where it is.
    // Fail safe: any unknown reason ⇒ NOT a renewal.
    isRenewal: billingReason === 'subscription_cycle',
  };
}

export type StripeAction =
  | { type: 'checkout'; userId: string | null; customerId: string | null; subscriptionId: string | null }
  | { type: 'subscription'; state: SubState }
  | { type: 'lapse'; customerId: string | null; subscriptionId: string | null }
  | { type: 'invoice'; state: InvoiceState }
  | { type: 'ignore'; reason: string };

/** Dispatch a (parsed) Stripe event to a normalized action. Pure. */
export function interpretEvent(event: { type: string; data: { object: unknown } }): StripeAction {
  const o = event.data?.object;
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = obj(o) ?? {};
      // Only subscription-mode sessions matter here.
      if (str(s.mode) && s.mode !== 'subscription') return { type: 'ignore', reason: 'non_subscription_checkout' };
      return {
        type: 'checkout',
        userId: str(s.client_reference_id),
        customerId: idOf(s.customer),
        subscriptionId: idOf(s.subscription),
      };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return { type: 'subscription', state: subStateFromSubscription(o) };
    case 'customer.subscription.deleted': {
      const s = obj(o) ?? {};
      return { type: 'lapse', customerId: idOf(s.customer), subscriptionId: str(s.id) };
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      return { type: 'invoice', state: invoiceStateFromInvoice(o) };
    default:
      return { type: 'ignore', reason: `unhandled:${event.type}` };
  }
}
