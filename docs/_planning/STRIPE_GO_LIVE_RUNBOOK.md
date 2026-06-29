# Stripe Paid Tiers — Go-Live Runbook

**Status (2026-06-29):** code + migrations + Fly proxy **live on prod, dormant**. Paid-tier
checkout + lapse **verified end-to-end on prod in test mode** (boardroom→premium→free, all
data correct, C1/C3 hardening confirmed). `GROWTH_PAID_TIERS_ENABLED` is **OFF** (removed from
Vercel prod). Stripe is on **test-mode keys**. This runbook is the checklist to flip to **real
revenue** without slipping.

Prod URLs: site `https://oak-league.vercel.app` · Fly proxy `oakleague-voice-proxy` · Supabase
ref `rbuuwwupxuanalvtipch`. Tokens (`VERCEL_TOKEN`, `SUPABASE_ACCESS_TOKEN`, `STRIPE_SECRET_KEY`,
`FLY_API_TOKEN`) are in the **main checkout** `.env.local` (see memory `reference-vercel-supabase-access`).

---

## The 3 launch items (do in order, don't skip)

### 1. Stripe test → live keys + live webhook endpoint
The single most error-prone step (the webhook secret rotates).
- [ ] In Stripe, switch to **live mode**. Create the live **prices** for Evangelist + Boardroom
      (the current `price_…` ids are test-mode and will 400 `bad_tier` in live).
- [ ] Create a **live webhook endpoint** → `https://oak-league.vercel.app/api/stripe/webhook`,
      events: `checkout.session.completed`, `customer.subscription.created/updated/deleted`,
      `invoice.paid` (the handler keys on `invoice.paid`; `invoice.payment_succeeded` is handled
      identically and is idempotent via the `stripe_events` PK, so subscribing to both is safe, not
      double-processed). Copy its **signing secret**.
- [ ] **Disable/delete the test-mode webhook endpoint** after cutover — it posts to the same prod
      URL, so leaving it on means test events arrive and 400 (signature mismatch against the live
      secret) = noise.
- [ ] Update **Vercel prod** env (these are runtime — a redeploy is required after ANY change):
      `STRIPE_SECRET_KEY` (live `sk_live_…`), `STRIPE_WEBHOOK_SECRET` (the new live `whsec_…`),
      `STRIPE_PRICE_EVANGELIST`, `STRIPE_PRICE_BOARDROOM` (live price ids).
      **GOTCHA (hit 2026-06-29):** these MUST be in Vercel prod, not just local `.env.local`, or
      checkout returns 400 `bad_tier`.
- [ ] Optional: upgrade the endpoint **API version** off the deprecated `2020-08-27` to
      `2026-05-27.dahlia`. Code is version-tolerant either way (parser reads both shapes); the SDK
      is pinned to dahlia. Not blocking.
- [ ] **Redeploy** prod (`vercel redeploy <latest-prod-url>`), then **flip the flag**:
      `vercel env add GROWTH_PAID_TIERS_ENABLED production` = `1` → redeploy again.
- [ ] Smoke test **immediately** after the flag-on redeploy (no gap — once the flag is on, real
      users can reach live checkout against this deploy): `POST /api/stripe/checkout` from a browser
      (same-origin) returns a session url (curl returns 403 origin-gated, that's expected). Do one
      **live** $3.36 checkout with a real card → confirm the flip with `node
      scripts/stripe-prod-health.mjs` + the verify query. Refund it in Stripe if desired. If the
      smoke test fails, flip the flag back OFF (`vercel env rm GROWTH_PAID_TIERS_ENABLED production`
      + redeploy) before debugging.

### 2. Evangelist micropayments-vs-price decision
Evangelist is $3.36/mo. At standard Stripe pricing (2.9% + $0.30) that's a **−$0.12/mo loss per
sub**. Options:
- [ ] **Micropayments pricing** (5% + $0.05 = break-even) — must **contact Stripe sales** to enable
      on the account (NOT self-serve). Lead time; start early.
- [ ] **OR** nudge the price up (e.g. $3.99) to clear standard fees.
- [ ] **OR** accept the small loss as a low-tier acquisition cost.
Decide before driving volume to Evangelist.

### 3. Ledger flags (wallet / meter / soft-gate) — separate from paid tiers
Turns on the minutes economy itself. **Deploy-order is directional — get it wrong and free minutes
leak.**
- [ ] Confirm migrations live (they are) + Fly proxy redeployed with C4 (it is).
- [ ] Flip **Fly proxy first**: `GROWTH_LEDGER_ENABLED=1` (then `GROWTH_SOFT_GATE_ENABLED`,
      `GROWTH_METER_ENABLED`) via `flyctl secrets set -a oakleague-voice-proxy …`.
- [ ] **Then** flip the **Vercel route**: `GROWTH_LEDGER_ENABLED=1` + redeploy.
- [ ] **THE ONE INVARIANT (check this, not the two orderings):** the **Vercel route must NEVER be ON
      while the Fly proxy is OFF** — that state extends wallet entitlement the proxy doesn't draw =
      unbounded free minutes. So forward = proxy-first; rollback = route-off-first. Same rule, both
      directions.
- [ ] Test a real voice session for correct metering + the soft-gate upsell.

---

## Catch failures FAST (after the flag is live)

Run the health check any time (read-only, exits non-zero on any problem):
```
node scripts/stripe-prod-health.mjs
```
It flags: unresolved **dead-letter** (paid-but-unmapped — CRITICAL), **stuck** unprocessed webhook
events (>10min), and **tier drift** (entitled customer but profile tier mismatched).

**Failure signals + where they surface:**
| Symptom | Check | Meaning |
|---|---|---|
| User paid, no premium | `stripe_unmapped_events` (resolved_at IS NULL) + Sentry `stripe_unmapped_event` | sub never mapped to a user (dashboard/payment-link sub, or no metadata). Manually link + set `resolved_at`. |
| Webhook 500s / Stripe retries | `stripe_events` processed_at IS NULL >10min + Sentry `stripe_handle` | handler failing — read the Sentry exception. |
| Paid user on free | `stripe_customers` entitled vs `profiles.tier` | flip lost; the daily `subscription-reconcile` cron re-asserts, but investigate. |
| Checkout 400 `bad_tier` | Vercel prod env has the `STRIPE_PRICE_*`? | env not set in prod (the 06-29 gotcha). |
| Checkout 404 | `GROWTH_PAID_TIERS_ENABLED` | flag off. |

**Real-time alerting (recommended):** add a **Sentry alert rule** that pages on the messages
`stripe_unmapped_event`, `stripe_handle`, `apply_subscription_state_failed`, `stripe_unknown_price`.
The webhook already captures these at error/fatal level. Optionally schedule the health check as a
cron to page on a non-zero exit.

**Hardening already shipped (don't regress):** C1 invoice re-grant gate (`billing_reason=
subscription_cycle`), C2 webhook flag-gate + 200-ack, C3 dead-letter, C4 proxy wallet-draw fail-
closed, atomic `stripe_apply_subscription_state` (no flip drift), SDK apiVersion pinned + version-
tolerant parser.
