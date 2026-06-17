import 'server-only';
import Stripe from 'stripe';

// Server-only Stripe SDK init (Growth & Minutes Economy Phase 6, plan §8).
//
// Lazy + fail-closed: we throw at first USE (not import) if the secret is
// missing, because Next's build-phase data collection imports route modules
// before env is materialized in some hosting setups (same reasoning as the
// cron route's CRON_SECRET guard). A missing key must never silently no-op a
// payment path.
//
// Determinism: the `stripe` dependency is exact-pinned in package.json (no `^`).
// We ALSO pin apiVersion explicitly to the SDK's current version so the shape of
// the objects we read from API calls (subscriptions.retrieve in the webhook) is
// deterministic and matches what grant-from-event.ts parses — instead of riding an
// implicit default. (Empirically verified 2026-06-17: on this account the modern
// API moved subscription.current_period_start OFF the subscription onto
// items.data[0]; our parser reads BOTH locations, so it is correct either way, but
// pinning removes the silent-drift surface the auditor flagged.) constructEvent
// signature verification is independent of apiVersion; webhook EVENT shape is set
// by the Stripe endpoint's own version, which the version-tolerant parser handles.
// The literal must equal the SDK's `LatestApiVersion` (= '2026-05-27.dahlia' for the
// exact-pinned stripe@22.2.1) so it type-checks without a cast; a future SDK bump
// that changes the literal will fail the build here — exactly the drift signal we want.
// This guarantee depends on stripe being EXACT-pinned in package.json (no `^`): a
// caret range could pull a newer SDK whose LatestApiVersion no longer matches and
// silently break the build-time check, so keep the pin exact.

let _stripe: Stripe | null = null;

export function stripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  _stripe = new Stripe(key, { apiVersion: '2026-05-27.dahlia' });
  return _stripe;
}

export function stripeWebhookSecret(): string {
  const s = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  return s;
}

// Strict '=== "1"' parse, matching the GROWTH_* / voice-flag convention.
export function paidTiersEnabled(): boolean {
  return process.env.GROWTH_PAID_TIERS_ENABLED === '1';
}
