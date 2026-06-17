// POST /api/stripe/webhook — subscription lifecycle → tier flip (Phase 6, plan §8).
//
// RAW body (await req.text(), never req.json()), signature-verified via
// constructEvent. Exactly-once via a stripe_events PK insert (duplicate event.id
// → 200 no-op). Handlers are idempotent (upserts + tier flips), so a transient
// failure deletes the dedup row and 500s → Stripe retries → safe reprocess.
//
// Dispatch (interpretEvent): checkout.session.completed is the authoritative
// mapping+flip (client_reference_id → user); subscription.* re-flips; invoice.paid
// refreshes the billing period; subscription.deleted → free (earned wallet minutes
// persist). A "mapping not ready" event (sub/invoice before checkout) is a 200
// no-op — checkout establishes the mapping; never a 500/retry-storm.

import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import { stripe, stripeWebhookSecret } from '@/lib/stripe/client';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { interpretEvent, subStateFromSubscription, isEntitledStatus, type SubState, type ProfileTier } from '@/lib/stripe/grant-from-event';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function findUserByCustomer(admin: SupabaseClient, customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const { data } = await admin
    .from('stripe_customers')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  return (data as { user_id?: string } | null)?.user_id ?? null;
}

async function upsertCustomer(admin: SupabaseClient, userId: string, st: SubState): Promise<void> {
  const { error } = await admin.from('stripe_customers').upsert(
    {
      user_id: userId,
      stripe_customer_id: st.customerId,
      subscription_id: st.subscriptionId,
      price_id: st.priceId,
      tier: st.tier,
      status: st.status,
      current_period_start: st.currentPeriodStart,
      current_period_end: st.currentPeriodEnd,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw new Error(`stripe_customers_upsert_failed: ${error.message}`);
}

async function flipTier(admin: SupabaseClient, userId: string, tier: ProfileTier): Promise<void> {
  const { error } = await admin.rpc('set_profile_tier_from_subscription', { p_user_id: userId, p_new_tier: tier });
  if (error) throw new Error(`tier_flip_failed: ${error.message}`);
}

// Throws ONLY on transient errors (DB/Stripe) → 500 + dedup-row delete + retry.
// "mapping not ready" / unknown SKU are 200 no-ops (logged), not throws.
async function handleEvent(admin: SupabaseClient, event: Stripe.Event): Promise<void> {
  const action = interpretEvent(event);
  switch (action.type) {
    case 'checkout': {
      if (!action.userId || !action.subscriptionId) {
        Sentry.captureMessage('stripe_checkout_missing_ids', { extra: { event: event.id } });
        return;
      }
      const sub = await stripe().subscriptions.retrieve(action.subscriptionId);
      const st = subStateFromSubscription(sub);
      if (!st.customerId) st.customerId = action.customerId;
      if (!st.tier) {
        Sentry.captureMessage('stripe_unknown_price', { extra: { event: event.id, price: st.priceId } });
        return;
      }
      await upsertCustomer(admin, action.userId, st);
      await flipTier(admin, action.userId, st.tier);
      return;
    }
    case 'subscription': {
      const st = action.state;
      // Prefer the stored customer→user row; fall back to the subscription's
      // metadata.user_id (M4) so we can map even if checkout was lost.
      const userId = (await findUserByCustomer(admin, st.customerId)) ?? st.metadataUserId;
      if (!userId) return; // checkout will establish the mapping
      await upsertCustomer(admin, userId, st);
      if (isEntitledStatus(st.status)) {
        if (st.tier) await flipTier(admin, userId, st.tier);
      } else {
        await flipTier(admin, userId, 'free'); // terminal status (canceled/unpaid/…) → revoke
      }
      return;
    }
    case 'lapse': {
      const userId = await findUserByCustomer(admin, action.customerId);
      if (!userId) return;
      const { error } = await admin
        .from('stripe_customers')
        .update({ status: 'canceled', updated_at: new Date().toISOString() })
        .eq('user_id', userId);
      if (error) throw new Error(`lapse_status_update_failed: ${error.message}`);
      await flipTier(admin, userId, 'free'); // earned wallet minutes persist
      return;
    }
    case 'invoice': {
      const st = action.state;
      const userId = await findUserByCustomer(admin, st.customerId);
      if (!userId) return; // renewal before checkout-mapping — checkout sets it
      const { error } = await admin
        .from('stripe_customers')
        .update({
          current_period_start: st.currentPeriodStart,
          current_period_end: st.currentPeriodEnd,
          status: 'active',
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);
      if (error) throw new Error(`invoice_period_update_failed: ${error.message}`);
      // M6: re-assert the paid tier on a renewal/reactivation — a prior lapse or a
      // crash may have left profiles.tier=free while the customer is paying. The
      // invoice carries no price, so we read the tier stored at checkout/subscription.
      const { data: cust } = await admin.from('stripe_customers').select('tier').eq('user_id', userId).maybeSingle();
      const tier = (cust as { tier?: string } | null)?.tier;
      if (tier === 'premium' || tier === 'boardroom') await flipTier(admin, userId, tier as ProfileTier);
      return;
    }
    default:
      return; // ignore
  }
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return new NextResponse('missing signature', { status: 400 });

  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(raw, sig, stripeWebhookSecret());
  } catch {
    return new NextResponse('signature verification failed', { status: 400 });
  }

  const admin = supabaseAdmin();
  const objId = (event.data?.object as { id?: string } | undefined)?.id ?? null;

  // Exactly-once: the PK insert is the dedup gate.
  const { error: insErr } = await admin
    .from('stripe_events')
    .insert({ event_id: event.id, type: event.type, payload: { object_id: objId } });
  if (insErr) {
    if (insErr.code === '23505') return NextResponse.json({ received: true, deduped: true });
    Sentry.captureException(insErr, { extra: { op: 'stripe_events_insert', event: event.id } });
    return new NextResponse('event store failed', { status: 500 });
  }

  try {
    await handleEvent(admin, event);
    await admin.from('stripe_events').update({ processed_at: new Date().toISOString() }).eq('event_id', event.id);
    return NextResponse.json({ received: true });
  } catch (e) {
    // Processing failed after the dedup row was stored. Delete it (only while still
    // unprocessed) so Stripe's retry reprocesses — every handler is idempotent
    // (upsert + tier flip). The flip is the LAST DB write in each case, so a crash
    // between customer-upsert and flip leaves at worst a paid customer row with a
    // free tier; the daily subscription-reconcile cron's RE-ASSERT pass repairs that
    // (and any other tier drift), so no paid user is left un-flipped permanently.
    Sentry.captureException(e, { extra: { op: 'stripe_handle', event: event.id, type: event.type } });
    await admin.from('stripe_events').delete().eq('event_id', event.id).is('processed_at', null);
    return new NextResponse('handler failed', { status: 500 });
  }
}
