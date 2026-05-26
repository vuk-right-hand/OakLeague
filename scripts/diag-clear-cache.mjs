// WRITE (scoped): delete semantic_query_cache rows for ONE creator.
// Used to clear stale pinned retrieval results while iterating on the RAG path.
//   node --env-file=.env.local scripts/diag-clear-cache.mjs <handle>
import { createClient } from '@supabase/supabase-js';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const handle = process.argv[2] || 'vuk_lehendas';
const supa = createClient(url, key, { auth: { persistSession: false } });
const { data: c } = await supa.from('creators').select('id, handle').ilike('handle', handle).maybeSingle();
if (!c) { console.error(`no creator ${handle}`); process.exit(1); }
const before = await supa.from('semantic_query_cache').select('id', { count: 'exact', head: true }).eq('creator_id', c.id);
const { error } = await supa.from('semantic_query_cache').delete().eq('creator_id', c.id);
if (error) { console.error('delete error:', error.message); process.exit(1); }
const after = await supa.from('semantic_query_cache').select('id', { count: 'exact', head: true }).eq('creator_id', c.id);
console.log(`creator=${c.handle} cache rows: before=${before.count} after=${after.count} (deleted ${before.count - after.count})`);
console.log('done.');
