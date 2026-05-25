// READ-ONLY: find which narrative unit(s) contain a keyword, print title + context.
//   node --env-file=.env.local scripts/diag-find-unit.mjs <handle> <kw>
import { createClient } from '@supabase/supabase-js';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const handle = process.argv[2] || 'vuk_lehendas';
const kw = process.argv[3] || 'lumberjack';
const supa = createClient(url, key, { auth: { persistSession: false } });
const { data: c } = await supa.from('creators').select('id').ilike('handle', handle).maybeSingle();
const { data: units } = await supa.from('sample_content_narrative_units').select('id, title, text').eq('creator_id', c.id);
const re = new RegExp(kw, 'i');
for (const u of units) {
  if (re.test(u.title) || re.test(u.text)) {
    const idx = u.text.search(re);
    console.log(`\n=== UNIT: ${u.title} (id=${u.id})`);
    console.log('context:', u.text.slice(Math.max(0, idx - 200), idx + 300).replace(/\s+/g, ' '));
  }
}
console.log('\ndone.');
