// Read-only: dump cogs_log rows for one session to verify the maxOutputTokens
// cap dropped gemini_audio_out. Run:
//   node --env-file=.env.local scripts/check-cogs-session.mjs <session-uuid>
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sid = process.argv[2];
if (!url || !key) { console.error('FATAL: SUPABASE url/service key missing'); process.exit(1); }
if (!sid) { console.error('usage: check-cogs-session.mjs <session-uuid>'); process.exit(1); }
console.log(`supabase=${url.replace(/^https?:\/\//, '').slice(0, 30)}… session=${sid}`);

const supa = createClient(url, key, { auth: { persistSession: false } });
const { data, error } = await supa
  .from('cogs_log')
  .select('created_at, service, operation, units, cost_usd, metadata')
  .eq('session_id', sid)
  .order('created_at', { ascending: true });

if (error) { console.error('query error:', error); process.exit(1); }
if (!data?.length) { console.log('NO cogs_log rows for this session (cogs RPC may have failed to write).'); process.exit(0); }

let geminiOut = 0;
for (const r of data) {
  const m = r.metadata || {};
  const gOutTok = m.gemini_audio_out_tokens ?? m.audio_out_tokens;
  const gOutCost = m.gemini_audio_out_cost ?? m.audio_out_cost;
  if (gOutCost) geminiOut += Number(gOutCost);
  console.log({
    op: `${r.service}/${r.operation}`,
    units: r.units,
    cost_usd: r.cost_usd,
    gemini_audio_out_tokens: gOutTok,
    gemini_audio_out_cost: gOutCost,
  });
}
console.log(`\nΣ gemini_audio_out cost this session = $${geminiOut.toFixed(6)}  (baseline ≈ $0.0157; capped target ≈ $0.002)`);
