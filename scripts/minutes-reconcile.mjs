// Phase-7 minutes/wallet reconciliation CLI. READ-ONLY.
//
//   node --env-file=.env.local scripts/minutes-reconcile.mjs [--since ISO] [--until ISO] [--floor ISO] [--limit N]
//
// Prints range-bounded flows (granted/consumed/billed voice COGS) + live wallet
// stocks + invariant violations, then EXITS 1 if any violation is found (so a
// cron/CI wrapper can alert). Exit 2 = config/RPC error, 0 = clean.
//
// Sibling to scripts/diag-cogs-recent.mjs. The blended COGS rate math mirrors
// src/lib/minutes/cogs-rate.ts — a plain .mjs can't import the .ts lib, and it's
// three lines; the SQL (migration 20260616000001) is the shared source of truth
// for the aggregation itself.
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('missing NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(2);
}

function argVal(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const since = argVal('--since'); // null ⇒ all-time
const until = argVal('--until');
const floor = argVal('--floor') || process.env.MINUTES_WELCOME_GAP_FLOOR || null;
const limitArg = Number(argVal('--limit') || 100);
const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.min(Math.floor(limitArg), 1000) : 100;

// Blended COGS rate (mirror of src/lib/minutes/cogs-rate.ts).
const rateRaw = Number(process.env.MINUTES_BLENDED_COGS_USD_PER_MIN);
const rateConfigured = Number.isFinite(rateRaw) && rateRaw > 0;
// 0.028 must stay in sync with cogs-rate.ts DEFAULT_BLENDED_COGS_USD_PER_MIN.
const usdPerMin = rateConfigured ? rateRaw : 0.028;
const impliedUsd = (s) => (Number.isFinite(s) && s > 0 ? (s / 60) * usdPerMin : 0);
const usd = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
const min = (s) => `${(Number(s) / 60).toFixed(1)} min`;

const supa = createClient(url, key, { auth: { persistSession: false } });

const { data: sData, error: sErr } = await supa.rpc('minutes_reconcile_summary', {
  p_from: since,
  p_to: until,
  p_welcome_floor: floor,
});
if (sErr) {
  console.error('minutes_reconcile_summary error:', sErr.message);
  process.exit(2);
}
const s = Array.isArray(sData) ? sData[0] : sData;
if (!s) {
  console.error('minutes_reconcile_summary returned no row');
  process.exit(2);
}

const { data: vData, error: vErr } = await supa.rpc('minutes_reconcile_violations', {
  p_limit: limit,
  p_welcome_floor: floor,
});
if (vErr) {
  console.error('minutes_reconcile_violations error:', vErr.message);
  process.exit(2);
}
const violations = vData || [];

const granted = Number(s.granted_seconds_total || 0);
const consumed = Number(s.consumed_seconds_total || 0);
const actualUsd = Number(s.voice_cogs_usd || 0);
const mismatch = Number(s.wallet_mismatch_count || 0);
const overspent = Number(s.overspent_count || 0);
const gap = Number(s.welcome_gap_count || 0);
const totalViol = mismatch + overspent + gap;

console.log('=== Minutes & wallet reconcile (read-only) ===');
console.log(`range:         ${since || '(all-time)'} → ${until || 'now'}`);
console.log(`welcome_floor: ${floor || '(none — welcome_gap suppressed)'}`);
console.log(
  `blended rate:  ${usd(usdPerMin)}/min ${rateConfigured ? '(env-pinned)' : '(SEED FALLBACK — set MINUTES_BLENDED_COGS_USD_PER_MIN)'}`,
);
console.log('');
console.log('FLOWS (range-bounded):');
console.log(`  granted:  ${min(granted)}   by type: ${JSON.stringify(s.granted_by_type || {})}`);
console.log(`  consumed: ${min(consumed)}`);
console.log('  voice COGS — implied vs actual:');
console.log(`    implied (granted):  ${usd(impliedUsd(granted))}`);
console.log(`    implied (consumed): ${usd(impliedUsd(consumed))}`);
console.log(`    actual  (cogs_log): ${usd(actualUsd)}`);
console.log('');
console.log('STOCKS (point-in-time):');
console.log(`  wallet_active: ${min(Number(s.wallet_active_total || 0))}`);
console.log(`  wallet_spent:  ${min(Number(s.wallet_spent_total || 0))}`);
console.log('');
console.log(
  `INVARIANT VIOLATIONS: ${totalViol}  (wallet_mismatch=${mismatch}, overspent=${overspent}, welcome_gap=${gap})`,
);
for (const v of violations) {
  console.log(`  [${v.violation}] ${v.user_id}  ${v.detail || ''}`);
}
console.log('');
console.log('Note: paid-tier monthly-allowance consumption has no minute_grants row — reconciled in Phase 6.');
console.log(totalViol > 0 ? 'RESULT: VIOLATIONS FOUND' : 'RESULT: clean');
process.exit(totalViol > 0 ? 1 : 0);
