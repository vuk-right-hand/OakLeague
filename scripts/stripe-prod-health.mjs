// Stripe prod health check — surfaces ANY paid-tier failure on production.
// Read-only. Reads prod creds from the main checkout .env.local. Exits non-zero
// if anything is wrong, so it can run in a cron / be run by any agent on demand.
//
//   node scripts/stripe-prod-health.mjs
//
// Failure signals it catches (see docs/_planning/STRIPE_GO_LIVE_RUNBOOK.md):
//   1. DEAD-LETTER   — stripe_unmapped_events with resolved_at IS NULL
//                      = a paid sub never mapped to a user (paid-but-nothing). CRITICAL.
//   2. STUCK EVENTS  — stripe_events processed_at IS NULL older than 10 min
//                      = the webhook handler is failing/retrying.
//   3. TIER DRIFT    — stripe_customers entitled (active/trialing/past_due, not stale)
//                      but profiles.tier != the customer tier = a flip was lost.
// All three are repaired/surfaced by the system (reconcile cron + Sentry), but this
// is the fast manual read.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// Windows-default path; override with OAK_ENV_PATH on other runners.
const ENV_PATH = process.env.OAK_ENV_PATH || 'c:/Antigravity/OakLeague/.env.local';
const env = Object.fromEntries(
  readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
);
const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
// Audit C3 — assert the EXACT prod ref, not just *.supabase.co (every Supabase
// project matches that). Refuse to run service-role SELECTs against any other DB
// (a staging clone / teammate env in a stale .env.local). Ref per the runbook.
const PROD_REF = 'rbuuwwupxuanalvtipch';
if (!new RegExp(`//${PROD_REF}\\.supabase\\.co`).test(url || '')) {
  console.error(`REFUSING: not the prod supabase project (${PROD_REF}). url=`, url); process.exit(2);
}
if (!key) { console.error('REFUSING: no SUPABASE_SERVICE_ROLE_KEY in', ENV_PATH); process.exit(2); }
const sb = createClient(url, key, { auth: { persistSession: false } });

// Pinned to migration 20260616000002 (entitled set at L313/L363; lapse/re-assert
// predicate at L356-385). Keep in lockstep if the enum or the 2-day window changes.
const ENTITLED = ['active', 'trialing', 'past_due'];
const fails = [];

(async () => {
  // Cap noisy detail so a large backlog doesn't bury the count (audit M1).
  const detail = (arr, fn) => arr.slice(0, 10).map(fn).join(', ') + (arr.length > 10 ? ` (+${arr.length - 10} more)` : '');

  // 1. Dead-letter (unresolved)
  const { data: dl, error: dlErr } = await sb
    .from('stripe_unmapped_events').select('event_id,type,stripe_customer_id,received_at').is('resolved_at', null);
  if (dlErr) fails.push(`dead-letter query failed: ${dlErr.message}`);
  else if ((dl || []).length) fails.push(`DEAD-LETTER: ${dl.length} unmapped paid event(s) — ${detail(dl, (r) => r.type + ':' + (r.stripe_customer_id || '?'))}`);
  console.log(`1) dead-letter (unresolved): ${(dl || []).length}`);

  // 2. Stuck unprocessed events (> 10 min old)
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: stuck, error: stErr } = await sb
    .from('stripe_events').select('event_id,type,received_at').is('processed_at', null).lt('received_at', cutoff);
  if (stErr) fails.push(`stuck-events query failed: ${stErr.message}`);
  else if ((stuck || []).length) fails.push(`STUCK EVENTS: ${stuck.length} webhook event(s) unprocessed >10min — ${detail(stuck, (r) => r.type)}`);
  console.log(`2) stuck unprocessed events (>10min): ${(stuck || []).length}`);

  // 3. Tier drift — mirrors migration 20260616000002's RE-ASSERT predicate exactly
  //    (L378-381): a customer that is entitled AND not stale (period_end NULL or
  //    not >2d past, for ANY status) but whose paid SKU tier != profiles.tier is
  //    drift the reconcile cron intends to repair. Stale-active rows are the LAPSE
  //    pass's job (they flip to free), so we skip them here to avoid crying wolf on
  //    a healthy lapse. (stripe_customers.tier is the SKU tier — premium/boardroom —
  //    not the live profile tier; that's the comparison target by design.)
  const { data: cust, error: cErr } = await sb
    .from('stripe_customers').select('user_id,tier,status,current_period_end').in('status', ENTITLED);
  if (cErr) fails.push(`customers query failed: ${cErr.message}`);
  let drift = 0;
  const driftRows = [];
  if (!cErr && cust && cust.length) {
    const ids = cust.map((c) => c.user_id);
    const { data: profs } = await sb.from('profiles').select('id,tier').in('id', ids);
    const tierOf = Object.fromEntries((profs || []).map((p) => [p.id, p.tier]));
    const twoDaysAgo = Date.now() - 2 * 86400 * 1000;
    for (const c of cust) {
      const stale = c.current_period_end && new Date(c.current_period_end).getTime() < twoDaysAgo;
      if (stale) continue; // lapse pass owns these
      if ((c.tier === 'premium' || c.tier === 'boardroom') && tierOf[c.user_id] !== c.tier) {
        drift++; driftRows.push(`${c.user_id} customer=${c.tier} profile=${tierOf[c.user_id]}`);
      }
    }
    if (drift) fails.push(`TIER DRIFT: ${drift} — ${detail(driftRows, (r) => r)}`);
  }
  console.log(`3) entitled customers: ${(cust || []).length}, tier drift: ${drift}`);

  console.log('');
  if (fails.length) { console.error('STRIPE PROD HEALTH: FAIL'); for (const f of fails) console.error('   - ' + f); process.exit(1); }
  console.log('STRIPE PROD HEALTH: OK');
})().catch((e) => { console.error('health check crashed:', e.message); process.exit(2); });
