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
import { stripe, stripeWebhookSecret, paidTiersEnabled } from '@/lib/stripe/client';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { interpretEvent, subStateFromSubscription, isEntitledStatus, type SubState, type ProfileTier } from '@/lib/stripe/grant-from-event';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// C3 — a subscription/invoice event whose Stripe customer never mapped to one of
// our users (dashboard/payment-link sub, or a hard out-of-order event with no
// usable metadata). Record it in the dead-letter table + alert LOUDLY so ops can
// recover a paid-but-unmapped sub, instead of a silent 200 that loses money.
async function recordUnmappedEvent(
  admin: SupabaseClient,
  event: Stripe.Event,
  kind: string,
  customerId: string | null,
  subscriptionId: string | null,
  // M2 — a subscription.created that arrives before checkout.session.completed maps
  // it is a benign, self-healing race (the later checkout call resolves the row via
  // applySubscriptionState). So that path logs 'warning'. An unmapped INVOICE is real
  // money already paid → 'error' (it pages). We still dead-letter both so ops has a row.
  severity: 'warning' | 'error' = 'error',
): Promise<void> {
  Sentry.captureMessage('stripe_unmapped_event', {
    level: severity,
    extra: { event: event.id, type: event.type, kind, customer: customerId, subscription: subscriptionId },
  });
  // Best-effort dead-letter; never throw (we don't want a retry-storm on an event
  // that is unmappable BY DEFINITION — a retry won't make the mapping appear).
  const { error } = await admin
    .from('stripe_unmapped_events')
    .upsert(
      { event_id: event.id, type: event.type, stripe_customer_id: customerId, subscription_id: subscriptionId },
      { onConflict: 'event_id' },
    );
  if (error) Sentry.captureException(error, { extra: { op: 'stripe_unmapped_insert', event: event.id } });
}

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

// M1 — atomic (one-txn) customer-upsert + tier flip. effectiveTier is what
// profiles.tier becomes (the paid tier when entitled, else 'free'); st.tier is
// stored on the customer row regardless. Used by the checkout + subscription
// paths so a crash can't leave a paid customer on a free profile.
async function applySubscriptionState(
  admin: SupabaseClient, userId: string, st: SubState, effectiveTier: ProfileTier,
): Promise<void> {
  const { error } = await admin.rpc('stripe_apply_subscription_state', {
    p_user_id: userId,
    p_stripe_customer_id: st.customerId,
    p_subscription_id: st.subscriptionId,
    p_price_id: st.priceId,
    p_customer_tier: st.tier,
    p_status: st.status,
    p_current_period_start: st.currentPeriodStart,
    p_current_period_end: st.currentPeriodEnd,
    p_effective_tier: effectiveTier,
  });
  if (error) throw new Error(`apply_subscription_state_failed: ${error.message}`);
  // M2 — the mapping just landed; auto-close any open dead-letter rows for this
  // customer (a sub event that raced ahead of checkout self-heals here). Best-effort.
  if (st.customerId) {
    await admin
      .from('stripe_unmapped_events')
      .update({ resolved_at: new Date().toISOString(), note: 'auto-resolved: mapping landed' })
      .eq('stripe_customer_id', st.customerId)
      .is('resolved_at', null);
  }
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
      // checkout.session.completed means the sub was created+paid → entitled; still
      // derive defensively so a trialing/odd status maps correctly.
      const effective = isEntitledStatus(st.status) ? st.tier : 'free';
      await applySubscriptionState(admin, action.userId, st, effective);
      return;
    }
    case 'subscription': {
      const st = action.state;
      // Prefer the stored customer→user row; fall back to the subscription's
      // metadata.user_id (M4) so we can map even if checkout was lost.
      // metadataUserId is OUR data — set at checkout via subscription_data.metadata
      // — so it's a safe fallback for a sub we created when checkout.session.completed
      // is lost/out-of-order. A sub NOT created by our checkout (dashboard/payment
      // link) carries no such metadata, so this stays null and falls to the C3
      // dead-letter rather than silently flipping a tier from untrusted input.
      const userId = (await findUserByCustomer(admin, st.customerId)) ?? st.metadataUserId;
      if (!userId) {
        // C3: created/updated before any mapping AND no metadata. If a later
        // checkout.session.completed arrives it will map+flip AND auto-resolve this
        // row (M2) — so this is often a benign race → 'warning', not a page.
        await recordUnmappedEvent(admin, event, 'subscription', st.customerId, st.subscriptionId, 'warning');
        return;
      }
      if (isEntitledStatus(st.status)) {
        if (!st.tier) {
          // Entitled but unrecognized SKU — store the customer state, don't guess a
          // tier (and never downgrade a paying user to free on an unknown price).
          Sentry.captureMessage('stripe_unknown_price', { extra: { event: event.id, price: st.priceId } });
          await upsertCustomer(admin, userId, st);
          return;
        }
        await applySubscriptionState(admin, userId, st, st.tier);
      } else {
        await applySubscriptionState(admin, userId, st, 'free'); // terminal status → revoke
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
      if (!userId) {
        // C3: an invoice for a customer we never mapped = paid-but-unmapped. Don't
        // silently drop it — record + alert (default 'error' severity: real money).
        // NOTE: st.subscriptionId may be null under dahlia (invoice.subscription is
        // deprecated) — the dead-letter row is diagnostic; mapping is by customer.
        await recordUnmappedEvent(admin, event, 'invoice', st.customerId, st.subscriptionId);
        return;
      }
      // C1 (CONFIRMED LIVE) — only a true cycle renewal advances the metering
      // window. A proration / plan-change / manual invoice keeps status fresh and
      // re-asserts the tier, but must NOT move current_period_start (that re-keys
      // the monthly counter and re-grants the allowance mid-cycle).
      const patch: Record<string, unknown> = { status: 'active', updated_at: new Date().toISOString() };
      if (st.isRenewal) {
        patch.current_period_start = st.currentPeriodStart;
        patch.current_period_end = st.currentPeriodEnd;
      }
      const { error } = await admin.from('stripe_customers').update(patch).eq('user_id', userId);
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

  // C2 — the webhook URL is registered before paid tiers go live (and the Phase-6
  // schema may not be on prod yet). Once the signature is verified, if paid tiers
  // are OFF we ACK 200 and do nothing: no stripe_events insert against a possibly-
  // absent table, so Stripe never builds a 72h retry backlog that would replay in
  // arbitrary order the moment the migration + flag land. Flip the flag only after
  // the migration is on prod (deploy runbook). When ON, full processing resumes.
  if (!paidTiersEnabled()) {
    return NextResponse.json({ received: true, ignored: 'paid_tiers_disabled' });
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
    // Best-effort processed marker. If this UPDATE fails the work already SUCCEEDED
    // (handleEvent committed); a Stripe retry PK-conflicts → 200 deduped, never
    // reprocessed. So processed_at IS NULL is NOT a reliable "unprocessed" signal —
    // don't build a reconcile that keys off it without re-deriving this (audit Small).
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
