#!/usr/bin/env node
// One-off, read-only. Headline: total Simli pipe-open minutes + our $ estimate
// over the last 14 days, with per-day and per-session breakouts. Filters to
// operation='simli.video_minutes_bridge_close' (the real-cost row); skips the
// cost=0 'avatar_session_token_mint' audit rows.

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) continue;
  if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
const { data: rows, error } = await sb
  .from('cogs_log')
  .select('id, created_at, session_id, units, cost_usd, metadata')
  .eq('service', 'simli')
  .eq('operation', 'simli.video_minutes_bridge_close')
  .gte('created_at', since)
  .order('created_at', { ascending: false });
if (error) { console.error(error); process.exit(2); }

console.log(`\n== Simli bridge_close rows, last 14 days (${rows.length} rows) ==\n`);

const byDay = new Map();
for (const r of rows) {
  const day = r.created_at.slice(0, 10);
  const cur = byDay.get(day) || { rows: 0, minutes: 0, cost: 0 };
  cur.rows += 1;
  cur.minutes += Number(r.units || 0);
  cur.cost += Number(r.cost_usd || 0);
  byDay.set(day, cur);
}

console.log('Per-day:');
console.log('  date         sessions   pipe_minutes   our_$_estimate');
console.log('  ----------   --------   ------------   ----------------');
for (const [day, v] of [...byDay.entries()].sort().reverse()) {
  console.log(`  ${day}   ${String(v.rows).padStart(8)}   ${v.minutes.toFixed(4).padStart(12)}   $${v.cost.toFixed(4).padStart(10)}`);
}

const totalMinutes = [...byDay.values()].reduce((a, v) => a + v.minutes, 0);
const totalCost = [...byDay.values()].reduce((a, v) => a + v.cost, 0);
const totalSessions = rows.length;
const avgPerSession = totalMinutes / totalSessions;

console.log(`\nHEADLINE`);
console.log(`  closed sessions:   ${totalSessions}`);
console.log(`  pipe-open minutes: ${totalMinutes.toFixed(2)}`);
console.log(`  avg per session:   ${avgPerSession.toFixed(2)} min`);
console.log(`  our cost estimate: $${totalCost.toFixed(4)}  (@ \$0.011/min est)`);

console.log(`\nCROSS-REF`);
console.log(`  Pull Simli console → Usage → last 14 days. Note their MINUTES + $.`);
console.log(`  - If Simli ≈ ${totalMinutes.toFixed(0)} min / ≈ $${totalCost.toFixed(2)} → billing tracks pipe-open. Pacing has zero COGS effect.`);
console.log(`  - If Simli is materially higher (say > ${(totalMinutes * 1.15).toFixed(0)} min) → different billing unit. Pacing may help.`);
console.log(`  - If Simli is much lower → they bill only rendered frames. Pacing has zero COGS effect (also good).\n`);
