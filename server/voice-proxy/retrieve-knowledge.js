// retrieve-knowledge.js — proxy-side per-turn retrieval (audit C1 fix).
//
// Mirrors src/lib/voice/retrieve-knowledge.ts minus the 'server-only' import
// (Next-side guard, throws in pure Node). The proxy static-imports THIS file;
// the TS file stays for tests + potential future Next-side callers.

import { embedTexts, EMBEDDING_MODEL, EMBEDDING_USD_PER_TOKEN, vectorToPgText } from './embed-client.js';

export class RetrieveError extends Error {
  constructor(code, msg) {
    super(msg || code);
    this.name = 'RetrieveError';
    this.code = code;
  }
}

// retrieveTopK({ supabase, userId, creatorId, queryText, ... }):
//   supabase:     service-role client (Supabase admin).
//   geminiApiKey: passed to embed-client; proxy already holds it.
//   userId:       voice_retrieval_budget bucket.
//   creatorId:    closure-captured at session-open; NEVER per-message.
//   queryText:    user-turn transcript from inputAudioTranscription.
//   k:            default 3; RPC hard-caps at 5.
//   minSimilarity:default 0.55; RPC floors at 0.30.
//   sessionId:    cogs_log attribution.
//
// Returns:
//   { passages, embedMs, searchMs, budgetExceeded, tokens }
export async function retrieveTopK({
  supabase,
  geminiApiKey,
  userId,
  creatorId,
  queryText,
  k = 3,
  // 2026-05-12 tuning iter 2: 0.65 → 0.60. 0.65 was too strict — borderline
  // matches like "What is superstructure?" hit 0.62 and got injected nothing,
  // triggering "outside my experience" on questions clearly in the corpus.
  // 0.60 catches those while still killing the 0.55-0.58 noise. gemini-embedding-
  // 001 has narrow spread on related content, so the right operating point
  // is empirical not theoretical. May tune further once we re-rank / hybrid.
  minSimilarity = 0.60,
  sessionId = null,
}) {
  if (!queryText || queryText.trim().length === 0) {
    throw new RetrieveError('empty_query');
  }
  const capK = Math.min(Math.max(k, 1), 5);
  const floorSim = Math.max(minSimilarity, 0.30);

  // 1. Per-user-per-day budget check (atomic UPSERT row-lock).
  const { data: budgetOk, error: budgetErr } = await supabase.rpc(
    'voice_retrieval_budget_check_and_increment',
    { p_user_id: userId, p_limit: 200 },
  );
  if (budgetErr) {
    throw new RetrieveError('budget_check_failed', budgetErr.message);
  }
  if (budgetOk === false) {
    return {
      passages: [],
      embedMs: 0,
      searchMs: 0,
      budgetExceeded: true,
      tokens: 0,
    };
  }

  // 2. Embed the user-turn transcript as RETRIEVAL_QUERY.
  let embedResult;
  try {
    embedResult = await embedTexts({
      apiKey: geminiApiKey,
      texts: [queryText.slice(0, 8000)],
      taskType: 'RETRIEVAL_QUERY',
    });
  } catch (e) {
    throw new RetrieveError('embed_failed', e?.message || 'embed_failed');
  }
  const { vectors, tokens, ms: embedMs } = embedResult;
  const queryVec = vectors[0];

  // 3. Top-K RPC. PostgREST sends the halfvec as pgvector text format.
  const t1 = Date.now();
  const { data, error: rpcErr } = await supabase.rpc('creator_knowledge_topk', {
    p_creator_id: creatorId,
    p_query_vec: vectorToPgText(queryVec),
    p_k: capK,
    p_min_similarity: floorSim,
  });
  const searchMs = Date.now() - t1;
  if (rpcErr) {
    throw new RetrieveError('rpc_failed', rpcErr.message);
  }

  const rows = Array.isArray(data) ? data : [];
  const passages = rows.map((r) => ({
    chunkId: r.chunk_id,
    sampleId: r.sample_id,
    text: r.text,
    sourceType: r.source_type,
    similarity:
      typeof r.similarity === 'number' ? r.similarity : Number(r.similarity),
  }));

  // 4. cogs_log row — fire-and-forget. Failed inserts log to console but
  // never block the user turn. (Audit S2: documented as acceptable for v1.5;
  // embedding is 0.2% of session cost so a few dropped rows don't move the
  // kill-switch needle.)
  supabase
    .from('cogs_log')
    .insert({
      user_id: userId,
      session_id: sessionId,
      service: 'gemini',
      operation: 'embedding',
      units: tokens,
      unit_label: 'tokens',
      cost_usd: Number((tokens * EMBEDDING_USD_PER_TOKEN).toFixed(6)),
      metadata: {
        model: EMBEDDING_MODEL,
        creator_id: creatorId,
        k: capK,
        min_similarity: floorSim,
        passages_returned: passages.length,
        embed_ms: embedMs,
        search_ms: searchMs,
      },
    })
    .then(({ error }) => {
      if (error) {
        // eslint-disable-next-line no-console
        console.warn('[retrieve-knowledge] cogs_log insert failed:', error.message);
      }
    });

  return {
    passages,
    embedMs,
    searchMs,
    budgetExceeded: false,
    tokens,
  };
}
