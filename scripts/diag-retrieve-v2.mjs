// READ-ONLY: replicate the v2 retrieval RPC for a query string.
//   node --env-file=.env.local scripts/diag-retrieve-v2.mjs <handle> "query text"
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const gkey = process.env.GEMINI_API_KEY;
const handle = process.argv[2] || 'vuk_lehendas';
const query = process.argv[3] || 'tell me the lumberjack story';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
const DIM = 768;
if (!url || !key || !gkey) { console.error('FATAL: missing supabase or GEMINI_API_KEY'); process.exit(1); }

const supa = createClient(url, key, { auth: { persistSession: false } });
const { data: c } = await supa.from('creators').select('id, current_corpus_version').ilike('handle', handle).maybeSingle();
const cid = c.id;
console.log(`creator=${cid} corpus_version=${c.current_corpus_version}\nquery="${query}"\n`);

// 1. embed (RETRIEVAL_QUERY, 768)
const genai = new GoogleGenAI({ apiKey: gkey });
const resp = await genai.models.embedContent({
  model: EMBEDDING_MODEL,
  contents: [query],
  config: { outputDimensionality: DIM, taskType: 'RETRIEVAL_QUERY' },
});
const vec = (resp.embeddings?.[0]?.values) || resp.embedding?.values;
if (!vec || vec.length !== DIM) { console.error('embed failed, dim=', vec?.length); process.exit(1); }
const vecText = '[' + vec.join(',') + ']';

// 2. tsquery
const { data: tsq, error: tsqErr } = await supa.rpc('try_build_tsquery', { p_text: query.slice(0, 4000) });
if (tsqErr) console.error('tsquery err:', tsqErr);
console.log('tsquery =', JSON.stringify(tsq));

// 3. topk_v2 — same params as the orchestrator
const { data: rows, error: rpcErr } = await supa.rpc('creator_knowledge_topk_v2', {
  p_creator_id: cid,
  p_query_vec: vecText,
  p_query_tsq: tsq,
  p_k_child: 30,
  p_k_parent: 20,
  p_min_sim: 0.30,
});
if (rpcErr) { console.error('topk_v2 err:', rpcErr); process.exit(1); }
console.log(`\ntopk_v2 returned ${rows.length} parents (RRF order):\n`);
rows.forEach((r, i) => {
  console.log(`#${i + 1}`, {
    title: r.parent_title,
    vec: Number(r.vector_score).toFixed(4),
    bm25: Number(r.bm25_score).toFixed(6),
    rrf: Number(r.rrf_score).toFixed(6),
  });
});

// 4. Voyage rerank — top 5, exactly as the orchestrator
const vkey = process.env.VOYAGE_API_KEY;
if (!vkey) { console.log('\n(no VOYAGE_API_KEY — skipping rerank)'); process.exit(0); }
const docs = rows.map((r) => (r.parent_text ?? '').slice(0, 3500));
const rr = await fetch('https://api.voyageai.com/v1/rerank', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${vkey}` },
  body: JSON.stringify({ query, documents: docs, model: process.env.VOYAGE_RERANK_MODEL || 'rerank-2.5', top_k: 5, return_documents: false, truncation: true }),
});
if (!rr.ok) { console.error('\nvoyage rerank err:', rr.status, (await rr.text()).slice(0, 300)); process.exit(1); }
const rj = await rr.json();
console.log(`\nVOYAGE RERANK top-5 (model=${rj.model}, tokens=${rj.usage?.total_tokens}):\n`);
for (const d of rj.data) {
  console.log({ rank_from: d.index + 1, score: Number(d.relevance_score).toFixed(4), title: rows[d.index]?.parent_title });
}
console.log('\ndone (read-only).');
