// retrieve-knowledge.ts — server-only per-turn retrieval wrapper.
//
// Caller (the voice-proxy in vector mode) passes the user-turn transcript;
// we:
//   1. Atomic per-user budget check (200 calls/user/day default).
//   2. Embed the query via gemini-embedding-001 RETRIEVAL_QUERY.
//   3. Call creator_knowledge_topk RPC (service-role; HNSW + halfvec).
//   4. Write one cogs_log row for the embedding spend.
//
// The caller is responsible for the creator_id trust chain — pass the
// creator_id captured at voice-ticket consume time, NEVER a value derived
// from a per-message field. The RPC documents this invariant in its
// COMMENT (M5 migration).

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { embedTexts, EMBEDDING_MODEL, EMBEDDING_USD_PER_TOKEN, vectorToPgText } from './embed';

export type RetrieveTopKArgs = {
  supabaseAdmin: SupabaseClient;
  userId: string;
  creatorId: string;
  queryText: string;
  k?: number;             // default 3; RPC caps at 5
  minSimilarity?: number; // default 0.55; RPC floors at 0.30
  sessionId?: string | null;
};

export type RetrievedChunk = {
  chunkId: string;
  sampleId: string;
  text: string;
  sourceType: string;
  similarity: number;
};

export type RetrieveTopKResult = {
  passages: RetrievedChunk[];
  embedMs: number;
  searchMs: number;
  budgetExceeded: boolean;
  tokens: number;
};

export class RetrieveError extends Error {
  readonly code:
    | 'embed_failed'
    | 'rpc_failed'
    | 'budget_check_failed'
    | 'empty_query';
  constructor(code: RetrieveError['code'], msg?: string) {
    super(msg ?? code);
    this.name = 'RetrieveError';
    this.code = code;
  }
}

export async function retrieveTopK(args: RetrieveTopKArgs): Promise<RetrieveTopKResult> {
  if (!args.queryText || args.queryText.trim().length === 0) {
    throw new RetrieveError('empty_query');
  }
  const k = Math.min(Math.max(args.k ?? 3, 1), 5);
  const minSim = Math.max(args.minSimilarity ?? 0.55, 0.30);
  const admin = args.supabaseAdmin;

  // 1. Per-user-per-day budget. Returns false when over cap; we return an
  //    empty result so the proxy skips injection cleanly. Idempotent +
  //    atomic via the RPC's INSERT ... ON CONFLICT DO UPDATE row-lock.
  const { data: budgetOk, error: budgetErr } = await admin.rpc(
    'voice_retrieval_budget_check_and_increment',
    { p_user_id: args.userId, p_limit: 200 },
  );
  if (budgetErr) {
    throw new RetrieveError('budget_check_failed', budgetErr.message);
  }
  if (budgetOk === false) {
    return { passages: [], embedMs: 0, searchMs: 0, budgetExceeded: true, tokens: 0 };
  }

  // 2. Embed the query.
  const { vectors, tokens, ms: embedMs } = await embedTexts({
    texts: [args.queryText.slice(0, 8000)], // belt-and-suspenders cap
    taskType: 'RETRIEVAL_QUERY',
  });
  const queryVec = vectors[0];

  // 3. Call the RPC. PostgREST encodes the halfvec as the pgvector text
  //    format '[v1,v2,...]'; the RPC parameter type halfvec(768) handles
  //    the cast.
  const t1 = Date.now();
  const { data, error: rpcErr } = await admin.rpc('creator_knowledge_topk', {
    p_creator_id: args.creatorId,
    p_query_vec: vectorToPgText(queryVec),
    p_k: k,
    p_min_similarity: minSim,
  });
  const searchMs = Date.now() - t1;
  if (rpcErr) {
    throw new RetrieveError('rpc_failed', rpcErr.message);
  }

  type Row = {
    chunk_id: string;
    sample_id: string;
    text: string;
    source_type: string;
    similarity: number | string;
  };
  const rows = Array.isArray(data) ? (data as Row[]) : [];
  const passages: RetrievedChunk[] = rows.map((r) => ({
    chunkId: r.chunk_id,
    sampleId: r.sample_id,
    text: r.text,
    sourceType: r.source_type,
    similarity: typeof r.similarity === 'number' ? r.similarity : Number(r.similarity),
  }));

  // 4. COGS row for the embedding call. Service='gemini', operation='embedding'.
  //    Non-blocking — a failed COGS write should not block the user turn.
  void admin
    .from('cogs_log')
    .insert({
      user_id: args.userId,
      session_id: args.sessionId ?? null,
      service: 'gemini',
      operation: 'embedding',
      units: tokens,
      unit_label: 'tokens',
      cost_usd: Number((tokens * EMBEDDING_USD_PER_TOKEN).toFixed(6)),
      metadata: {
        model: EMBEDDING_MODEL,
        creator_id: args.creatorId,
        k,
        min_similarity: minSim,
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
