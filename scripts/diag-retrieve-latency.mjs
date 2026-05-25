// READ-ONLY-ish latency probe: times each retrieval stage (rewrite/embed/topk/rerank).
// rewrite + embed + rerank are external API calls (no DB write); topk is a read RPC.
//   node --env-file=.env.local scripts/diag-retrieve-latency.mjs <handle> "query"
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const gkey = process.env.GEMINI_API_KEY;
const vkey = process.env.VOYAGE_API_KEY;
const handle = process.argv[2] || 'vuk_lehendas';
const query = process.argv[3] || 'tell me the lumberjack story';
const REWRITE_MODEL = process.env.QUERY_REWRITE_MODEL || 'gemini-2.5-flash';
const EMBED_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';

const supa = createClient(url, key, { auth: { persistSession: false } });
const genai = new GoogleGenAI({ apiKey: gkey });
const { data: c } = await supa.from('creators').select('id').ilike('handle', handle).maybeSingle();

const t = (label, ms) => console.log(`  ${label.padEnd(10)} ${Math.round(ms)} ms`);
console.log(`latency probe (3 runs)  query="${query}"\n`);

for (let run = 1; run <= 3; run++) {
  console.log(`RUN ${run}:`);
  // rewrite (gemini 2.5 flash, structured-ish; we approximate with a short prompt)
  let s = performance.now();
  await genai.models.generateContent({
    model: REWRITE_MODEL,
    contents: `Rewrite this into a standalone search query. Output only the query.\nUser: ${query}`,
    config: { maxOutputTokens: 64, temperature: 0 },
  });
  const rewriteMs = performance.now() - s;

  s = performance.now();
  const er = await genai.models.embedContent({ model: EMBED_MODEL, contents: [query], config: { outputDimensionality: 768, taskType: 'RETRIEVAL_QUERY' } });
  const embedMs = performance.now() - s;
  const vec = (er.embeddings?.[0]?.values) || er.embedding?.values;
  const vecText = '[' + vec.join(',') + ']';

  const { data: tsq } = await supa.rpc('try_build_tsquery', { p_text: query });
  s = performance.now();
  const { data: rows } = await supa.rpc('creator_knowledge_topk_v2', { p_creator_id: c.id, p_query_vec: vecText, p_query_tsq: tsq, p_k_child: 30, p_k_parent: 20, p_min_sim: 0.30 });
  const topkMs = performance.now() - s;

  let rerankMs = 0;
  if (vkey) {
    const docs = rows.map((r) => (r.parent_text ?? '').slice(0, 3500));
    s = performance.now();
    await fetch('https://api.voyageai.com/v1/rerank', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${vkey}` }, body: JSON.stringify({ query, documents: docs, model: 'rerank-2.5', top_k: 5, return_documents: false, truncation: true }) });
    rerankMs = performance.now() - s;
  }

  t('rewrite', rewriteMs); t('embed', embedMs); t('topk', topkMs); t('rerank', rerankMs);
  const sum = rewriteMs + embedMs + topkMs + rerankMs;
  console.log(`  SUM        ${Math.round(sum)} ms  (budget=3000, ceiling=3500; +Fly→Vercel hop on top)\n`);
}
console.log('done.');
