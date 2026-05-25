// READ-ONLY: probe the semantic_query_cache for a creator + query.
// Shows whether a cached entry would be SERVED (≥0.92) for this query, at what
// similarity it starts hitting, and which parent units it returns (titles).
//   node --env-file=.env.local scripts/diag-cache-probe.mjs <handle> "query"
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const gkey = process.env.GEMINI_API_KEY;
const handle = process.argv[2] || 'vuk_lehendas';
const query = process.argv[3] || 'tell me about the lumberjack monk businessman and hunter and what we learn';
const DIM = 768;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';

const supa = createClient(url, key, { auth: { persistSession: false } });
const { data: c } = await supa.from('creators')
  .select('id, current_corpus_version').ilike('handle', handle).maybeSingle();
const cid = c.id, cv = c.current_corpus_version;
console.log(`creator=${cid} corpus_version=${cv}\nquery="${query}"\n`);

// embed the RAW query (RETRIEVAL_QUERY, 768) — same task type the live path uses.
const genai = new GoogleGenAI({ apiKey: gkey });
const er = await genai.models.embedContent({
  model: EMBEDDING_MODEL, contents: [query],
  config: { outputDimensionality: DIM, taskType: 'RETRIEVAL_QUERY' },
});
const vec = (er.embeddings?.[0]?.values) || er.embedding?.values;
const vecText = '[' + vec.join(',') + ']';

// title lookup for parent ids
const { data: units } = await supa.from('sample_content_narrative_units')
  .select('id, title').eq('creator_id', cid);
const titleById = new Map(units.map((u) => [u.id, u.title]));

// Bisect the similarity by calling the real lookup RPC at decreasing thresholds.
for (const th of [0.95, 0.92, 0.90, 0.88, 0.85, 0.80, 0.70, 0.50, 0.0]) {
  const { data: rows, error } = await supa.rpc('semantic_query_cache_lookup', {
    p_creator_id: cid, p_corpus_version: cv, p_query_vec: vecText, p_threshold: th,
  });
  if (error) { console.error(`threshold ${th} err:`, error.message); continue; }
  const hit = rows && rows[0];
  if (hit) {
    const titles = (hit.parent_unit_ids || []).map((id) => titleById.get(id) || id.slice(0, 8));
    console.log(`threshold ${th.toFixed(2)} → HIT (age=${hit.age_seconds}s) parents:`);
    titles.forEach((t, i) => console.log(`     #${i + 1} ${t}`));
    console.log(`  *** at the LIVE threshold 0.92 this ${th >= 0.92 ? 'IS' : 'is NOT'} served ***\n`);
    break; // first (highest) threshold that hits brackets the similarity
  } else {
    console.log(`threshold ${th.toFixed(2)} → miss`);
  }
}
console.log('done (read-only).');
