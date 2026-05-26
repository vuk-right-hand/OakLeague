// READ-ONLY: does a keyword appear in the raw transcript vs the chunked corpus?
//   node --env-file=.env.local scripts/diag-corpus-keyword.mjs <handle> <kw1> [kw2...]
import { createClient } from '@supabase/supabase-js';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const handle = process.argv[2] || 'vuk_lehendas';
const kws = process.argv.slice(3);
if (kws.length === 0) { console.error('usage: <handle> <kw1> [kw2...]'); process.exit(1); }
const supa = createClient(url, key, { auth: { persistSession: false } });

const { data: c } = await supa.from('creators').select('id').ilike('handle', handle).maybeSingle();
const cid = c.id;

// raw sample_content — find the body column dynamically
const { data: sc } = await supa.from('sample_content').select('*').eq('creator_id', cid);
const bodyCols = sc.length ? Object.keys(sc[0]).filter((k) => typeof sc[0][k] === 'string' && sc[0][k].length > 200) : [];
console.log('sample_content long-text columns:', bodyCols);
let rawAll = '';
for (const s of sc) for (const col of bodyCols) rawAll += ' ' + (s[col] ?? '');

const { data: units } = await supa.from('sample_content_narrative_units').select('title, text').eq('creator_id', cid);
const unitsAll = units.map((u) => `${u.title}\n${u.text}`).join('\n');

const { data: chunks } = await supa.from('sample_content_chunks').select('text, chunker_version').eq('creator_id', cid);
const chunksV2 = chunks.filter((ch) => ch.chunker_version === 2).map((ch) => ch.text).join('\n');
const chunksV1 = chunks.filter((ch) => ch.chunker_version === 1).map((ch) => ch.text).join('\n');

for (const kw of kws) {
  const re = new RegExp(kw, 'gi');
  const count = (s) => (s.match(re) || []).length;
  console.log(`\nKEYWORD "${kw}":`);
  console.log(`  raw transcript : ${count(rawAll)}`);
  console.log(`  v1 chunks      : ${count(chunksV1)}`);
  console.log(`  v2 chunks      : ${count(chunksV2)}`);
  console.log(`  narrative units: ${count(unitsAll)}`);
}
console.log('\ndone (read-only).');
