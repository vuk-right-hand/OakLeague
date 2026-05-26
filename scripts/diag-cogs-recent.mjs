// READ-ONLY: Step-1c billing-integrity spot-check. Pulls the most recent
// session for a creator and prints its cogs_log rows by operation, so we can
// confirm: (a) per-turn brain_deep_answer rows exist, (b) thoughts tokens are
// 0/null (thinking off), (c) costs are real numbers (kill-switch fed truthfully).
//   node --env-file=.env.local scripts/diag-cogs-recent.mjs <handle>
import { createClient } from '@supabase/supabase-js';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const handle = process.argv[2] || 'vuk_lehendas';
const supa = createClient(url, key, { auth: { persistSession: false } });

const { data: c } = await supa.from('creators').select('id').ilike('handle', handle).maybeSingle();
const { data: sessions } = await supa
  .from('sessions')
  .select('id, created_at, ended_at, tier_at_session, corpus_version_at_session')
  .eq('creator_id', c.id)
  .order('created_at', { ascending: false })
  .limit(3);
if (!sessions || sessions.length === 0) { console.log('no sessions'); process.exit(0); }

for (const s of sessions.slice(0, 1)) {
  console.log(`\nSESSION ${s.id}`);
  console.log({ created_at: s.created_at, ended_at: s.ended_at, tier: s.tier_at_session, corpus_v: s.corpus_version_at_session });
  const { data: rows, error } = await supa
    .from('cogs_log')
    .select('service, operation, units, unit_label, cost_usd, metadata, created_at')
    .eq('session_id', s.id)
    .order('created_at', { ascending: true });
  if (error) { console.error('cogs_log err:', error.message); continue; }
  console.log(`cogs_log rows: ${rows.length}`);
  const byOp = {};
  for (const r of rows) { byOp[r.operation] = (byOp[r.operation] || 0) + 1; }
  console.log('by operation:', byOp);
  for (const r of rows) {
    const m = r.metadata || {};
    const thoughts = m.thoughtsTokens ?? m.thoughts_tokens ?? m.thoughtTokens ?? 'n/a';
    console.log(`  ${r.service}/${r.operation} units=${r.units}${r.unit_label?'('+r.unit_label+')':''} cost=$${r.cost_usd} thoughts=${thoughts}`);
  }
}
console.log('\ndone (read-only).');
