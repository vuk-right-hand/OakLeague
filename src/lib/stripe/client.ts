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
// Determinism (audit S1): the `stripe` dependency is pinned to an EXACT version
// in package.json (no `^`), so the SDK's default apiVersion can't drift under an
// `npm update`. We don't override apiVersion in the constructor (the SDK's typed
// LatestApiVersion literal makes pinning an arbitrary older string a type fight
// for no gain) — we read only stable outbound fields (session.url, customer.id),
// and webhook PARSING is version-tolerant regardless (constructEvent verifies the
// raw-body signature; grant-from-event.ts reads only defensively typed fields).

let _stripe: Stripe | null = null;

export function stripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  _stripe = new Stripe(key);
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
