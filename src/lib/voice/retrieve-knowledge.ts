// retrieve-knowledge.ts — server-only per-turn retrieval orchestrator.
//
// TWO PATHS:
//   - v1 (`retrieveTopK`): Phase-1 legacy — embed → creator_knowledge_topk
//     RPC (chunker_version=1 only). Used for creators with
//     `retrieval_version=1`. Unchanged from Phase 1.
//   - v2 (`retrieveKnowledgeV2`): Day-11 hybrid pipeline — rewrite →
//     cache lookup → embed → topk_v2 → rerank → cache upsert. Used for
//     creators with `retrieval_version=2`.
//
// THE CALLER DECIDES which path to invoke based on `creators.retrieval
// _version` snapshot captured at session-open. Mid-session swap is NOT
// supported (CLAUDE.md: tier routing at session-open only). v2 will land
// in the proxy via a thin shim in a follow-up commit.
//
// v2 ARCHITECTURE (Day-11):
//
//   ┌─ rewrite(rawUtterance, lastAssistant, deadlineMs)
//   │   └─ on fallback=true → SKIP cache (cross-cutting C2); embed raw, retrieve fresh
//   ├─ embed(rewritten, RETRIEVAL_QUERY)
//   ├─ if rewrite.ok → cache.lookupCache(creator, corpusVersion, vec)
//   │   └─ HIT → fetch parent texts by id → DONE (skip retrieve + rerank)
//   ├─ try_build_tsquery(rewritten)  [helper RPC]
//   ├─ creator_knowledge_topk_v2(creator, vec, tsq, k_child, k_parent, min_sim)
//   ├─ rerank.rerank(rewritten, parents, topK)
//   │   └─ on fallback=true → use input order (RRF-ranked) with synthetic scores
//   └─ if rewrite.ok → cache.upsertCache(creator, corpusVersion, vec, hash, ids, scores)
//
// COGS_LOG: writes one batch insert per turn via rag-telemetry.flushCogsLogRows.
// Fired on EVERY return path (cache hit, cache miss, budget exceeded, error)
// via the internal `done()` helper. Day-11 audit C3.
//
// POSTHOG EVENTS (Day-11 audit C4 disposition): this orchestrator returns
// `telemetry` to the caller. The caller (Day-12 proxy shim) MUST invoke
// `toPostHogEventBatch(telemetry).forEach(e => posthog.capture(e.name, e.properties))`
// fire-and-forget. The orchestrator stays transport-agnostic so the same
// module runs in both Next 15 server actions and the Fly proxy — neither
// has the other's PostHog client. Wiring lives in the caller.
//
// TIMEOUTS (Day-11 audit C1/C2): every DB call AND embed call races against
// the caller-supplied `deadlineMs` via the `withDeadline` helper. Hard cap
// is the deadline; soft fail-modes:
//   - Critical RPCs (try_build_tsquery, creator_knowledge_topk_v2, budget):
//     throw RetrieveKnowledgeV2Error('rpc_failed','deadline_exceeded')
//   - Non-critical (cache lookup, upsert, parent fetch): fail-open as miss
//     / empty / partial; telemetry surfaces the partial state.
//   - embedTexts: throw RetrieveKnowledgeV2Error('embed_failed','deadline_exceeded')
//
// KNOWN LIMITATIONS (Day-8/9/10/11 cross-cutting audit, deferred):
//   - M3 (budget counter increments before downstream success): the
//     `voice_retrieval_budget_check_and_increment` RPC is atomic check+
//     increment. If the orchestrator throws after the increment (embed
//     failure mid-turn), the user's quota was burned for a turn that
//     produced nothing. Fix requires splitting into check + commit RPCs
//     OR a decrement-on-failure RPC — both SQL changes deferred to a
//     follow-up day. Mitigation today: dogfood scale = 1 user. At launch
//     scale, accept slight quota over-counting OR ship the SQL change.
//   - M4 (withDeadline cannot cancel inner promise): supabase-js calls
//     accumulate stale in pgbouncer pool when the orchestrator moves on
//     past a timeout. At YC dogfood scale (≤3 concurrent sessions) this
//     is theoretical. Pre-launch fix: thread an AbortController.signal
//     through `.abortSignal()` on every PostgrestBuilder call.
//   - M6 (envelope leg / cogs_log ordering): the orchestrator never
//     fills `telemetry.envelope` — the Day-12 proxy caller constructs the
//     envelope AFTER receiving the orchestrator's result. Two consequences:
//       (a) cogs_log already flushed by then, so envelope state never
//           lands in cogs_log (acceptable — envelope is not a paid API).
//       (b) The Day-12 caller MUST emit envelope PostHog events from
//           the constructed envelope state, not from the returned
//           telemetry alone.
//     Document explicitly in the proxy shim header at Day-12 ship time.
//
// BUDGET ALLOCATION (cross-cutting M7):
//   - Rewrite hard cap 3000ms; ~30% of turn budget
//   - Embed ~10% (Gemini embedding is fast, ~100-200ms)
//   - Topk RPC ~10% (HNSW + tsvector, sub-100ms typical)
//   - Rerank hard cap 2000ms; ~30%
//   - Cache lookup ~5%, upsert ~5% (single HNSW per partition)
//   Default RAG_TURN_BUDGET_MS = 4000ms total. Caller passes deadlineMs.
//
// CLAUDE.md "don't silently catch in voice connect" — applies to bridge
// boundaries (proxy WS). This orchestrator catches at every leg
// (rewrite/cache/rerank all use "never throw + typed fallback" contracts)
// and surfaces a typed `RetrieveKnowledgeError` only for unrecoverable
// states (no budget at start, embed failure, RPC failure on the
// retrieval path itself). The caller (Day-11 proxy shim) decides whether
// to close the WS or fall back to a canned reply.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  embedTexts,
  EMBEDDING_MODEL,
  EMBEDDING_USD_PER_TOKEN,
  EMBEDDING_QUOTED_AT,
  vectorToPgText,
} from './embed';
import { rewriteQuery, QUERY_REWRITE_QUOTED_AT } from './query-rewrite';
import {
  getRerankBridge,
  VOYAGE_RERANK_QUOTED_AT,
  type RerankCandidate,
} from './rerank';
import {
  lookupCache,
  upsertCache,
  CACHE_DEFAULT_THRESHOLD,
  SemanticCacheError,
} from './semantic-cache';
import {
  newTurnTelemetry,
  toCogsLogRows,
  flushCogsLogRows,
  type RagTurnTelemetry,
} from './rag-telemetry';

// ───────────────────────────────────────────────────────────────────────
// v1 path (unchanged from Phase 1)
// ───────────────────────────────────────────────────────────────────────

export type RetrieveTopKArgs = {
  supabaseAdmin: SupabaseClient;
  userId: string;
  creatorId: string;
  queryText: string;
  k?: number;             // default 3; RPC caps at 5
  minSimilarity?: number; // default 0.60 (0.55→0.65→0.60 across 2 dogfood iterations); RPC floors at 0.30
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
  const minSim = Math.max(args.minSimilarity ?? 0.60, 0.30);
  const admin = args.supabaseAdmin;

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

  const { vectors, tokens, ms: embedMs } = await embedTexts({
    texts: [args.queryText.slice(0, 8000)],
    taskType: 'RETRIEVAL_QUERY',
  });
  const queryVec = vectors[0];

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

  return { passages, embedMs, searchMs, budgetExceeded: false, tokens };
}

// ───────────────────────────────────────────────────────────────────────
// v2 path (Day-11 hybrid orchestrator)
// ───────────────────────────────────────────────────────────────────────

export type RetrieveKnowledgeV2Args = {
  supabaseAdmin: SupabaseClient;
  userId: string;
  creatorId: string;
  rawUtterance: string;
  /** Last assistant response (from voice_session_state). Null on start/post-resumption. */
  lastAssistantResponse: string | null;
  /** Session-captured snapshot of creators.current_corpus_version. */
  corpusVersionAtSession: number;
  sessionId: string | null;
  /**
   * Absolute epoch ms by which the turn must complete. Every DB call,
   * embed call, rewrite, and rerank races against this. Callers compute
   * `Date.now() + RAG_TURN_BUDGET_MS_DEFAULT` (4000ms) typically, or
   * tighter for retry paths.
   */
  deadlineMs: number;
  geminiApiKey: string;
  voyageApiKey: string;
  /** Final topK after rerank. Default 5, clamped to [1, 20]. */
  topK?: number;
  /** Cache similarity threshold for lookup. Default 0.92. */
  cacheThreshold?: number;
};

export type RetrievedParent = {
  parentUnitId: string;
  text: string;
  title: string | null;
  sourceType: string;
  /** Final score: rerank score on success, RRF score on rerank fallback, NULL on cache hit. */
  score: number | null;
  /** Source of the score: 'rerank' | 'rrf' | 'cache' — for telemetry + injection prioritization. */
  scoreSource: 'rerank' | 'rrf' | 'cache';
};

export type RetrieveKnowledgeV2Result = {
  parents: RetrievedParent[];
  telemetry: RagTurnTelemetry;
  budgetExceeded: boolean;
  /** True when rewrite degraded — orchestrator skipped both cache lookup + upsert. */
  rewriteFallback: boolean;
};

export class RetrieveKnowledgeV2Error extends Error {
  readonly code:
    | 'budget_check_failed'
    | 'embed_failed'
    | 'rpc_failed'
    | 'empty_utterance'
    | 'invalid_corpus_version';
  constructor(code: RetrieveKnowledgeV2Error['code'], msg?: string) {
    super(msg ?? code);
    this.name = 'RetrieveKnowledgeV2Error';
    this.code = code;
  }
}

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;
/**
 * Canonical turn budget. Caller computes `Date.now() + RAG_TURN_BUDGET_MS_DEFAULT`
 * to pass as `deadlineMs`. Override via env for slower-but-more-headroom
 * deploys, e.g. RAG_TURN_BUDGET_MS=6000 on the staging cluster.
 *
 * Day-11-cross Small: validate finite + positive at module load. A
 * malformed env (`RAG_TURN_BUDGET_MS=abc`) yields NaN → every
 * withDeadline instantly rejects → the orchestrator is permanently
 * broken from cold start. Boot-fatal is the right surface.
 */
export const RAG_TURN_BUDGET_MS_DEFAULT = (() => {
  const raw = process.env.RAG_TURN_BUDGET_MS;
  if (raw === undefined || raw === null || raw === '') return 4000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`RAG_TURN_BUDGET_MS must be a positive finite number; got '${raw}'`);
  }
  return n;
})();

// Minimum guaranteed timeout for any DB/embed call. Below this the wrap
// short-circuits with a deadline_exceeded reason rather than launching a
// network call that's guaranteed to time out anyway.
const MIN_OP_TIMEOUT_MS = 50;

/**
 * Race a promise against a `deadlineMs` absolute timestamp. Resolves with
 * the inner promise's value if it completes in time; rejects with
 * Error('deadline_exceeded') otherwise. Used for every DB / embed call
 * the orchestrator makes — Day-11 audit C1/C2.
 *
 * The inner promise is NOT cancelled (supabase-js + @google/genai do not
 * expose AbortController on every endpoint). On timeout it runs to
 * completion in the background; we simply stop awaiting it. The cost is
 * one straggling DB / API call per timeout — acceptable cost for not
 * hanging the user turn.
 */
function withDeadline<T>(p: PromiseLike<T>, deadlineMs: number, label: string): Promise<T> {
  const remaining = deadlineMs - Date.now();
  if (remaining < MIN_OP_TIMEOUT_MS) {
    return Promise.reject(new Error(`${label}_deadline_exceeded`));
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`${label}_deadline_exceeded`)),
      remaining,
    );
  });
  // Wrap the thenable so `.finally` is available. supabase-js's
  // PostgrestFilterBuilder is `then`-able but not a real Promise.
  return Promise.race([Promise.resolve(p), timeoutPromise]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  });
}

function isDeadlineExceeded(err: unknown): boolean {
  return err instanceof Error && /_deadline_exceeded$/i.test(err.message);
}

export async function retrieveKnowledgeV2(
  args: RetrieveKnowledgeV2Args,
): Promise<RetrieveKnowledgeV2Result> {
  const startedAt = Date.now();
  const admin = args.supabaseAdmin;
  const telemetry = newTurnTelemetry({
    userId: args.userId,
    sessionId: args.sessionId,
    creatorId: args.creatorId,
    retrievalVersion: 2,
    corpusVersionAtSession: args.corpusVersionAtSession,
  });

  // Pre-flight validation.
  if (!args.rawUtterance || args.rawUtterance.trim().length === 0) {
    throw new RetrieveKnowledgeV2Error('empty_utterance');
  }
  if (
    !Number.isInteger(args.corpusVersionAtSession) ||
    args.corpusVersionAtSession < 1
  ) {
    throw new RetrieveKnowledgeV2Error(
      'invalid_corpus_version',
      `corpusVersionAtSession must be a positive integer; got ${args.corpusVersionAtSession}`,
    );
  }

  // Day-11-cross C1: paid-API telemetry MUST flush on EVERY exit — return
  // AND throw. Earlier the flush lived inside a `done()` helper that fired
  // only on returns; throws (embed_failed, rpc_failed, budget_check_failed)
  // skipped flush and burned cogs_log accounting for already-paid
  // rewrite/embed calls.
  //
  // Pattern: the function body lives in `runOrchestrator`. The finally
  // flushes once. `done()` only stamps totalLatencyMs and returns —
  // flush happens centrally so we cannot accidentally double-flush.
  try {
    return await runOrchestrator(args, telemetry, startedAt);
  } finally {
    telemetry.totalLatencyMs = Date.now() - startedAt;
    void flushCogsLogRows(admin, toCogsLogRows(telemetry));
  }
}

/**
 * Internal: the actual orchestration body. Extracted so the outer
 * function can wrap it in try/finally for guaranteed telemetry flush
 * (Day-11-cross C1).
 */
async function runOrchestrator(
  args: RetrieveKnowledgeV2Args,
  telemetry: RagTurnTelemetry,
  startedAt: number,
): Promise<RetrieveKnowledgeV2Result> {
  const admin = args.supabaseAdmin;
  const topK = Math.max(1, Math.min(args.topK ?? DEFAULT_TOP_K, MAX_TOP_K));
  const cacheThreshold = args.cacheThreshold ?? CACHE_DEFAULT_THRESHOLD;
  // Day-11 audit S7: deadlineMs is required in the type, so the `??`
  // fallback was dead. Type wins; we use args.deadlineMs directly.
  // RAG_TURN_BUDGET_MS_DEFAULT remains exported for callers that want
  // the canonical default.
  const deadlineMs = args.deadlineMs;

  // Local `done` — only stamps totalLatencyMs + builds the result. Flush
  // happens in the outer try/finally (Day-11-cross C1).
  const done = (
    parents: RetrievedParent[],
    budgetExceeded: boolean,
    rewriteFallback: boolean,
  ): RetrieveKnowledgeV2Result => {
    telemetry.totalLatencyMs = Date.now() - startedAt;
    return { parents, telemetry, budgetExceeded, rewriteFallback };
  };

  // 1. Budget check (200 calls/user/day default).
  let budgetOk: boolean | null = null;
  try {
    const { data, error } = await withDeadline(
      admin.rpc('voice_retrieval_budget_check_and_increment', {
        p_user_id: args.userId,
        p_limit: 200,
      }),
      deadlineMs,
      'budget_check',
    );
    if (error) {
      throw new RetrieveKnowledgeV2Error('budget_check_failed', error.message);
    }
    budgetOk = data as boolean;
  } catch (e) {
    if (isDeadlineExceeded(e)) {
      throw new RetrieveKnowledgeV2Error('budget_check_failed', 'deadline_exceeded');
    }
    throw e;
  }
  if (budgetOk === false) {
    telemetry.budgetExceeded = true;
    return done([], true, false);
  }

  // 2. Rewrite query.
  const rewriteResult = await rewriteQuery({
    userUtterance: args.rawUtterance,
    lastAssistantResponse: args.lastAssistantResponse,
    geminiApiKey: args.geminiApiKey,
    deadlineMs,
  });
  telemetry.rewrite = {
    modelId: rewriteResult.modelId,
    fallback: rewriteResult.fallback,
    fallbackReason: rewriteResult.fallbackReason,
    inputTokens: rewriteResult.inputTokens,
    outputTokens: rewriteResult.outputTokens,
    usdPerInputToken: rewriteResult.usdPerInputToken,
    usdPerOutputToken: rewriteResult.usdPerOutputToken,
    quotedAt: QUERY_REWRITE_QUOTED_AT,
    latencyMs: rewriteResult.latencyMs,
  };
  const rewrittenText =
    rewriteResult.rewritten && rewriteResult.rewritten.length > 0
      ? rewriteResult.rewritten
      : args.rawUtterance;

  // 3. Embed the rewritten query. CLAUDE.md: don't silently catch in voice
  // connect — embed failure surfaces as a typed error and the caller
  // decides what to do (Day-11 proxy will likely close WS or degrade).
  // Day-11 audit C2: race against deadlineMs so the @google/genai SDK's
  // missing internal timeout doesn't hang the turn.
  const embedStart = Date.now();
  let queryVec: number[];
  let embedTokens: number;
  try {
    const { vectors, tokens } = await withDeadline(
      embedTexts({
        texts: [rewrittenText.slice(0, 8000)],
        taskType: 'RETRIEVAL_QUERY',
      }),
      deadlineMs,
      'embed',
    );
    queryVec = vectors[0];
    embedTokens = tokens;
  } catch (e) {
    const msg = (e as Error)?.message ?? 'embed_failed';
    throw new RetrieveKnowledgeV2Error(
      'embed_failed',
      isDeadlineExceeded(e) ? 'deadline_exceeded' : msg,
    );
  }
  telemetry.embed = {
    modelId: EMBEDDING_MODEL,
    inputTokens: embedTokens,
    usdPerInputToken: EMBEDDING_USD_PER_TOKEN,
    quotedAt: EMBEDDING_QUOTED_AT,
    latencyMs: Date.now() - embedStart,
  };

  // 4. Cache lookup — ONLY when rewrite succeeded (cross-cutting C2).
  // Skip both lookup and upsert when rewrite fell back to raw utterance,
  // otherwise we serve cross-session collisions on common phrases.
  //
  // Day-11 audit M4: lookupCache throws SemanticCacheError on DB error.
  // Cache is a perf optimization — DB errors here should fail-open as
  // cache miss, not propagate. Catch + warn + continue.
  let parents: RetrievedParent[] = [];
  const canTouchCache = !rewriteResult.fallback;
  if (canTouchCache) {
    let hit: Awaited<ReturnType<typeof lookupCache>> | null = null;
    try {
      hit = await withDeadline(
        lookupCache({
          client: admin,
          creatorId: args.creatorId,
          corpusVersion: args.corpusVersionAtSession,
          queryVec,
          threshold: cacheThreshold,
        }),
        deadlineMs,
        'cache_lookup',
      );
    } catch (e) {
      const why = isDeadlineExceeded(e) ? 'deadline_exceeded' : (e as Error)?.message ?? 'unknown';
      // eslint-disable-next-line no-console
      console.warn(`[retrieve-knowledge] cache lookup fail-open: ${why}`);
      // Continue as if miss — fail-open is safer than failing the turn.
    }
    if (hit) {
      telemetry.cacheHit = true;
      telemetry.cacheAgeSeconds = hit.ageSeconds;
      // Fetch parent texts for the cached IDs.
      const fetched = await fetchParentNarrativesByIds({
        admin,
        creatorId: args.creatorId,
        ids: hit.parentUnitIds,
        deadlineMs,
      });
      // Day-11 audit M1: surface partial-fetch state. If the cache
      // promised 5 parents and we got 3, some were deleted between
      // cache write and now — same direction as stale_corpus.
      if (fetched.length < hit.parentUnitIds.length) {
        telemetry.cacheStaleCorpus = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[retrieve-knowledge] cache parent missing: cached=${hit.parentUnitIds.length} fetched=${fetched.length} creator=${args.creatorId}`,
        );
      }
      // Day-11-cross C2: when ALL cached parents are gone (corpus_version
      // didn't bump but rows were deleted, or admin pruned NUs), the cache
      // row is useless. DON'T return persona-only — fall through to fresh
      // retrieve. The downstream upsert will REPLACE the stale row.
      // Flag stayed `cacheHit=true` so telemetry surfaces the wasted
      // lookup, but parents come from the live RPC.
      if (fetched.length === 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[retrieve-knowledge] cache hit but zero fetched parents — falling through to fresh retrieve (creator=${args.creatorId})`,
        );
        // Reset cacheHit=false: we're treating this as a miss for the
        // purpose of the rest of the flow, but cacheStaleCorpus=true
        // remains as the "we tried; the cache was bunk" signal.
        telemetry.cacheHit = false;
        // Intentionally fall through to step 5 (cache-miss path) below.
      } else {
        // Preserve cache-row ordering by score (highest first).
        const idToScore = new Map<string, number>();
        hit.parentUnitIds.forEach((id, i) => idToScore.set(id, hit.scores[i] ?? 0));
        parents = fetched
          .map((n) => ({
            parentUnitId: n.id,
            text: n.text,
            title: n.title,
            sourceType: n.sourceType,
            score: idToScore.get(n.id) ?? null,
            scoreSource: 'cache' as const,
          }))
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
          .slice(0, topK);
        return done(parents, false, rewriteResult.fallback);
      }
    }
  }

  // 5. Cache miss (or skipped). Build tsquery, run hybrid RPC.
  // Both wrapped in withDeadline — these are CRITICAL path, so timeout
  // throws a typed error rather than fail-open.
  const retrieveStart = Date.now();
  let tsq = '';
  try {
    const { data: tsqData, error: tsqErr } = await withDeadline(
      admin.rpc('try_build_tsquery', { p_text: rewrittenText.slice(0, 4000) }),
      deadlineMs,
      'try_build_tsquery',
    );
    if (tsqErr) {
      throw new RetrieveKnowledgeV2Error('rpc_failed', `try_build_tsquery: ${tsqErr.message}`);
    }
    tsq = (tsqData as string) ?? '';
  } catch (e) {
    if (e instanceof RetrieveKnowledgeV2Error) throw e;
    if (isDeadlineExceeded(e)) {
      throw new RetrieveKnowledgeV2Error('rpc_failed', 'try_build_tsquery: deadline_exceeded');
    }
    throw e;
  }

  type RpcRow = {
    parent_unit_id: string;
    parent_text: string;
    parent_title: string | null;
    sample_id: string;
    source_type: string;
    vector_score: number | string;
    bm25_score: number | string;
    rrf_score: number | string;
    matched_child_chunk_ids: string[];
  };
  let rows: RpcRow[] = [];
  try {
    const { data: rpcRows, error: rpcErr } = await withDeadline(
      admin.rpc('creator_knowledge_topk_v2', {
        p_creator_id: args.creatorId,
        p_query_vec: vectorToPgText(queryVec),
        p_query_tsq: tsq,
        p_k_child: 30,
        p_k_parent: 20,
        p_min_sim: 0.30,
      }),
      deadlineMs,
      'topk_v2',
    );
    if (rpcErr) {
      throw new RetrieveKnowledgeV2Error('rpc_failed', `topk_v2: ${rpcErr.message}`);
    }
    if (!Array.isArray(rpcRows)) {
      // Day-11 audit S5: warn on malformed-but-non-error RPC response.
      // eslint-disable-next-line no-console
      console.warn(
        `[retrieve-knowledge] topk_v2 returned non-array: ${typeof rpcRows} — treating as empty`,
      );
      rows = [];
    } else {
      rows = rpcRows as RpcRow[];
    }
  } catch (e) {
    if (e instanceof RetrieveKnowledgeV2Error) throw e;
    if (isDeadlineExceeded(e)) {
      throw new RetrieveKnowledgeV2Error('rpc_failed', 'topk_v2: deadline_exceeded');
    }
    throw e;
  }
  const retrieveMs = Date.now() - retrieveStart;

  telemetry.retrieve = {
    parentsReturned: rows.length,
    vectorTop1Score: rows.length > 0 ? toNum(rows[0].vector_score) : null,
    bm25Top1Score: rows.length > 0 ? toNum(rows[0].bm25_score) : null,
    rrfTop1Score: rows.length > 0 ? toNum(rows[0].rrf_score) : null,
    latencyMs: retrieveMs,
  };

  if (rows.length === 0) {
    // No parents found. Skip rerank + cache upsert. Don't fail — the
    // orchestrator caller should reply persona-only (no injection).
    return done([], false, rewriteResult.fallback);
  }

  // 6. Rerank — candidates from RPC, scored by Voyage cross-encoder.
  // Day-11-cross C3: use `parent_unit_id` as the candidate `id` so the
  // round-trip is robust to rerank-side filtering (empty-text drop)
  // which can shift `originalIndex`. Caller maps r.id back to a row by
  // direct lookup, NOT by index position.
  const candidates: RerankCandidate[] = rows.map((r) => ({
    id: r.parent_unit_id,
    text: r.parent_text,
  }));
  const rowsById = new Map<string, typeof rows[number]>();
  rows.forEach((r) => rowsById.set(r.parent_unit_id, r));
  const bridge = getRerankBridge();
  const rerankResult = await bridge.rerank({
    voyageApiKey: args.voyageApiKey,
    query: rewrittenText,
    candidates,
    topK,
    deadlineMs,
  });
  telemetry.rerank = {
    provider: rerankResult.provider,
    modelId: rerankResult.modelId,
    fallback: rerankResult.fallback,
    fallbackReason: rerankResult.fallback ? rerankResult.fallbackReason : undefined,
    rerankTop1Score:
      !rerankResult.fallback && rerankResult.reranked.length > 0
        ? rerankResult.reranked[0].score
        : null,
    inputTokens: rerankResult.inputTokens,
    usdPerInputToken: rerankResult.usdPerInputToken,
    quotedAt: VOYAGE_RERANK_QUOTED_AT,
    latencyMs: rerankResult.latencyMs,
  };

  // Build parents in rerank order. Day-11-cross C3 + Small: bounds-check
  // via Map lookup; if the rerank result references an unknown id (rerank
  // bug or future-incompatible response shape), skip the row + warn
  // rather than dereference undefined.
  parents = [];
  for (const r of rerankResult.reranked) {
    const row = rowsById.get(r.id);
    if (!row) {
      // eslint-disable-next-line no-console
      console.warn(
        `[retrieve-knowledge] rerank returned unknown id=${r.id} not in topk_v2 rows`,
      );
      continue;
    }
    parents.push({
      parentUnitId: row.parent_unit_id,
      text: row.parent_text,
      title: row.parent_title,
      sourceType: row.source_type,
      score: r.score,
      scoreSource: rerankResult.fallback ? ('rrf' as const) : ('rerank' as const),
    });
  }

  // 7. Cache upsert — only when rewrite ok AND we have results AND rerank
  // didn't degrade (Day-11 audit M2). Caching synthetic-monotonic-decreasing
  // passthrough scores poisons the cache for 7 days: subsequent hits would
  // return parents sorted by synthetic order, indistinguishable from a real
  // rerank ranking via the cache scoreSource='cache' tag. Skip the upsert
  // when rerank fell back so the cache only ever holds known-good rankings.
  // Topk for cache:
  // Day-11 audit M7: the cache stores the rerank topK output (final list);
  // a future hit reads these as the answer. If a future caller passes a
  // different topK, they get the WRITER's topK, not theirs — documented at
  // top of file.
  if (canTouchCache && parents.length > 0 && !rerankResult.fallback) {
    let upsertResult: Awaited<ReturnType<typeof upsertCache>> | null = null;
    try {
      upsertResult = await withDeadline(
        upsertCache({
          client: admin,
          creatorId: args.creatorId,
          corpusVersion: args.corpusVersionAtSession,
          queryVec,
          rewrittenText,
          parentUnitIds: parents.map((p) => p.parentUnitId),
          scores: parents.map((p) => (Number.isFinite(p.score) ? (p.score as number) : 0)),
        }),
        deadlineMs,
        'cache_upsert',
      );
    } catch (e) {
      // Day-11 audit M4-ish: cache upsert errors fail-open. The user
      // already has their result; next session re-pays the cost.
      const why = isDeadlineExceeded(e) ? 'deadline_exceeded' : (e as Error)?.message ?? 'unknown';
      // eslint-disable-next-line no-console
      console.warn(`[retrieve-knowledge] cache upsert fail-open: ${why}`);
    }
    if (upsertResult && !upsertResult.ok && upsertResult.reason === 'stale_corpus') {
      telemetry.cacheStaleCorpus = true;
    }
  }

  return done(parents, false, rewriteResult.fallback);
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

type ParentNarrativeRow = {
  id: string;
  text: string;
  title: string | null;
  sourceType: string;
};

async function fetchParentNarrativesByIds(args: {
  admin: SupabaseClient;
  creatorId: string;
  ids: string[];
  deadlineMs: number;
}): Promise<ParentNarrativeRow[]> {
  if (args.ids.length === 0) return [];
  try {
    const { data, error } = await withDeadline(
      args.admin
        .from('sample_content_narrative_units')
        .select('id, text, title, source_type')
        .eq('creator_id', args.creatorId)
        .in('id', args.ids),
      args.deadlineMs,
      'parent_fetch',
    );
    if (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[retrieve-knowledge] fetchParentNarrativesByIds error: ${error.message}`,
      );
      return [];
    }
    type Row = { id: string; text: string; title: string | null; source_type: string };
    const rows = (data ?? []) as Row[];
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      title: r.title,
      sourceType: r.source_type,
    }));
  } catch (e) {
    const why = isDeadlineExceeded(e) ? 'deadline_exceeded' : (e as Error)?.message ?? 'unknown';
    // eslint-disable-next-line no-console
    console.warn(`[retrieve-knowledge] fetchParentNarrativesByIds fail-open: ${why}`);
    // Fail-open: empty array — downstream code treats this as a cache miss.
    return [];
  }
}

function toNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// (Day-11 audit S1: removed dead HALFVEC_DIM re-export — callers import
// directly from './halfvec' when needed.)
