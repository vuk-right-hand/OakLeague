// POST /api/stripe/checkout — create a subscription Checkout Session (Phase 6, plan §8).
//
// Auth'd. Body { tier: 'evangelist'|'boardroom', source? }. Maps the display tier
// to its pinned price id, creates a mode:'subscription' session with
// client_reference_id = our user id (the webhook's mapping back), reuses the
// user's existing Stripe customer if any (no duplicate customers on re-sub), and
// returns { url } for the client to redirect to. Flag-gated.

import 'server-only';
import { type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getCallerUserId } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { stripe, paidTiersEnabled } from '@/lib/stripe/client';
import { json, isSameOrigin } from '@/lib/session/http-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!paidTiersEnabled()) return json(404, { error: 'paid_tiers_disabled' });
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' }); // M1: CSRF guard, like /sessions/open

  const userId = await getCallerUserId();
  if (!userId) return json(401, { error: 'unauthorized' });

  let body: { tier?: unknown; source?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'bad_json' });
  }

  const tierParam = typeof body.tier === 'string' ? body.tier : '';
  const priceId =
    tierParam === 'evangelist'
      ? process.env.STRIPE_PRICE_EVANGELIST
      : tierParam === 'boardroom'
        ? process.env.STRIPE_PRICE_BOARDROOM
        : null;
  if (!priceId) return json(400, { error: 'bad_tier' });

  const source = typeof body.source === 'string' ? body.source.slice(0, 32) : 'upgrade';
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.get('host') ?? ''}`).replace(/\/$/, '');

  const admin = supabaseAdmin();
  const { data: existing } = await admin
    .from('stripe_customers')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .maybeSingle();
  let customerId = (existing as { stripe_customer_id?: string } | null)?.stripe_customer_id ?? null;

  try {
    // M3: ensure a Stripe customer exists + is persisted BEFORE checkout, so a
    // re-click reuses it instead of minting a second customer (whose subscription
    // events would never map back → paid-but-not-flipped). Carries user_id metadata.
    if (!customerId) {
      const customer = await stripe().customers.create({ metadata: { user_id: userId } });
      customerId = customer.id;
      // INTENTIONALLY RETAINED (hardening audit M3): this row is keyed by user_id
      // (PK) so there is at most ONE per user. If the user abandons checkout it
      // persists with status='incomplete' (monthly_window_start ignores non-entitled
      // statuses → calendar month, safe) and is REUSED on the next attempt (no
      // duplicate Stripe customer). Do NOT add a reconcile pass that deletes
      // 'incomplete' rows — that would break customer reuse on re-checkout.
      await admin.from('stripe_customers').upsert(
        { user_id: userId, stripe_customer_id: customerId, status: 'incomplete', updated_at: new Date().toISOString() },
        { onConflict: 'user_id' },
      );
    }

    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: userId,
      customer: customerId,
      success_url: `${siteUrl}/?upgraded=1`,
      cancel_url: `${siteUrl}/upgrade?canceled=1`,
      metadata: { user_id: userId, source },
      subscription_data: { metadata: { user_id: userId } }, // M4: the sub carries the user mapping
      allow_promotion_codes: true,
    });
    if (!session.url) return json(500, { error: 'no_session_url' });
    return json(200, { url: session.url });
  } catch (e) {
    Sentry.captureException(e, { extra: { op: 'stripe_checkout', user_id: userId, tier: tierParam } });
    return json(502, { error: 'checkout_failed' });
  }
}
