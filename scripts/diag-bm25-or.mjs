// READ-ONLY: prove the BM25 OR-semantics fix on real prod data WITHOUT applying
// the migration. Builds the OR tsquery from the existing AND one (replace & → |,
// stemming already baked in by try_build_tsquery), runs topk_v2 both ways,
// compares the bm25_score column.
//   node --env-file=.env.local scripts/diag-bm25-or.mjs <handle> "query"
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const gkey = process.env.GEMINI_API_KEY;
const handle = process.argv[2] || 'vuk_lehendas';
const query = process.argv[3] || 'lumberjack monk businessman hunter what is there to learn from that story';
const DIM = 768;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';

const supa = createClient(url, key, { auth: { persistSession: false } });
const { data: c } = await supa.from('creators').select('id').ilike('handle', handle).maybeSingle();
const cid = c.id;

const genai = new GoogleGenAI({ apiKey: gkey });
const er = await genai.models.embedContent({
  model: EMBEDDING_MODEL, contents: [query],
  config: { outputDimensionality: DIM, taskType: 'RETRIEVAL_QUERY' },
});
const vec = (er.embeddings?.[0]?.values) || er.embedding?.values;
const vecText = '[' + vec.join(',') + ']';

const { data: andTsq } = await supa.rpc('try_build_tsquery', { p_text: query.slice(0, 4000) });
const orTsq = String(andTsq).replace(/ & /g, ' | ');
console.log(`query="${query}"`);
console.log(`AND tsquery (current/dead): ${andTsq}`);
console.log(`OR  tsquery (the fix):      ${orTsq}\n`);

async function run(label, tsq) {
  const { data: rows, error } = await supa.rpc('creator_knowledge_topk_v2', {
    p_creator_id: cid, p_query_vec: vecText, p_query_tsq: tsq,
    p_k_child: 30, p_k_parent: 20, p_min_sim: 0.30,
  });
  if (error) { console.error(`${label} err:`, error.message); return; }
  const nonzero = rows.filter((r) => Number(r.bm25_score) > 0).length;
  console.log(`${label}: ${rows.length} parents, ${nonzero} with bm25_score>0`);
  rows.slice(0, 5).forEach((r, i) => console.log(
    `   #${i + 1} bm25=${Number(r.bm25_score).toFixed(6)} vec=${Number(r.vector_score).toFixed(4)} rrf=${Number(r.rrf_score).toFixed(6)}  ${r.parent_title}`,
  ));
}
await run('AND (current)', andTsq);
console.log('');
await run('OR  (fixed)  ', orTsq);
console.log('\ndone (read-only).');
