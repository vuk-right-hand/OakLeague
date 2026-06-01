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
import { resolveV3MinSimByMode } from './v3-min-sim';
import {
  getRerankBridge,
  VOYAGE_RERANK_QUOTED_AT,
  MAX_CANDIDATES as RERANK_MAX_CANDIDATES,
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

/**
 * Final-cross audit M1: explicit helper to map orchestrator output to
 * envelope input. The shapes differ — RetrievedParent has parentUnitId +
 * scoreSource (Day-12 audit didn't drop them; they're needed for
 * downstream telemetry), but buildInjectionEnvelope only needs text +
 * sourceType + title + score. Day-13 proxy author calls this once per
 * turn between `retrieveKnowledgeV2` and `buildInjectionEnvelope`.
 *
 * NOT a method on the result so callers can drop into v1's RetrievedChunk
 * → envelope path through the same shape if needed.
 */
export function parentsToPassages(
  parents: readonly RetrievedParent[],
): Array<{ text: string; sourceType: string; title?: string; score?: number }> {
  return parents.map((p) => ({
    text: p.text,
    sourceType: p.sourceType,
    title: p.title ?? undefined,
    score: p.score ?? undefined,
  }));
}

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

// 2026-05-25 — kill switch for the semantic cache. When '1', the orchestrator
// skips BOTH lookup and upsert: every turn retrieves + reranks FRESH. The
// semantic cache pins (creator, corpus_version, query≈) → parent-id set for 7
// days at 0.92 cosine, which is correct for prod but a TRAP while iterating on
// retrieval/injection — you keep getting the pinned set and never see your
// change. Strict === '1' (not Boolean) so a stray value can't silently disable
// the cache in prod. Leave UNSET in prod; flip to '1' locally during RAG work.
const CACHE_DISABLED = process.env.RAG_CACHE_DISABLED === '1';
if (CACHE_DISABLED) {
  // Re-audit M4 — loud boot signal. A stray RAG_CACHE_DISABLED=1 in prod is a
  // silent ~4-paid-calls-per-turn (rewrite+embed+retrieve+rerank) cost
  // regression with no other signal until the COGS kill-switch trips. Log it so
  // it's greppable the moment the process starts, not after quota burns.
  // eslint-disable-next-line no-console
  console.warn(
    '[retrieve-knowledge] RAG_CACHE_DISABLED=1 — semantic cache OFF (fresh '
    + 'retrieve+rerank EVERY turn). Local-iteration flag ONLY; MUST be unset in prod.',
  );
}

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
    // Per-stage latency breakdown (rewrite/embed/topk/rerank/total). Useful
    // observability, but audit M1 — gate behind RAG_DIAG_LOGS so it isn't a
    // warn-level line on EVERY retrieve in prod. Flip the env to debug.
    if (process.env.RAG_DIAG_LOGS === '1') {
      // eslint-disable-next-line no-console
      console.warn(
        `[retrieve-knowledge] timing: rewrite=${telemetry.rewrite?.latencyMs ?? 'na'} `
        + `embed=${telemetry.embed?.latencyMs ?? 'na'} topk=${telemetry.retrieve?.latencyMs ?? 'na'} `
        + `rerank=${telemetry.rerank?.latencyMs ?? 'na'}(fb=${telemetry.rerank?.fallback ?? 'na'}) `
        + `total=${telemetry.totalLatencyMs} cacheHit=${telemetry.cacheHit ?? false}`,
      );
    }
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
    // Final-cross audit C2: propagate the follow-up-without-context flag
    // so the Day-13 proxy's PostHog emitter fires
    // `rag_rewrite_no_context_post_resumption` on Day-15 bucket-2 misses.
    noContextAfterResumption: rewriteResult.noContextAfterResumption,
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
  // CACHE_DISABLED (2026-05-25) forces a fresh retrieve+rerank every turn — see
  // the const. Gates BOTH lookup (below) and upsert (step 7) via this one flag.
  const canTouchCache = !rewriteResult.fallback && !CACHE_DISABLED;
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
    // `source_type` lives on the PARENT sample_content row, NOT on
    // sample_content_narrative_units (that table has no such column — selecting
    // it directly errored every turn, killing the semantic cache: parents
    // fetched=0 → always fell through to a fresh ~2s retrieve). Join through the
    // sample_id FK to read it. (The topk_v2 RPC already does this server-side;
    // this is the cache-hit re-fetch path, which had drifted.)
    // Step-9 audit R5/C-2: go through the gen-filtered RPC instead of a raw
    // by-id select. corpusVersionAtSession is frozen at session-open, so a
    // mid-session re-ingest generation swap can't be caught by the cache key;
    // the RPC drops any stale-generation id server-side (returns 0 → cache miss
    // → fresh retrieve). v2 parents (gen 1) on a v2 creator (active gen 1) pass.
    const { data, error } = await withDeadline(
      args.admin.rpc('_fetch_active_parents_v3', {
        p_creator_id: args.creatorId,
        p_ids: args.ids,
      }),
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
    type Row = { id: string; text: string; title: string | null; source_type: string | null };
    const rows = (data ?? []) as Row[];
    return rows.flatMap((r) => {
      // The RPC's JOIN to sample_content (NOT-NULL sample_id FK, ON DELETE
      // CASCADE) means every returned row HAS a source_type. Defense in depth:
      // drop a sourceless row rather than inject "--- BEGIN (source: ) ---".
      if (!r.source_type) {
        // eslint-disable-next-line no-console
        console.warn(`[retrieve-knowledge] parent ${r.id} has no source_type — dropping`);
        return [];
      }
      return [{ id: r.id, text: r.text, title: r.title, sourceType: r.source_type }];
    });
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

// ───────────────────────────────────────────────────────────────────────
// v3 path — routed hierarchical retrieval (plan §4 items 5+6+7, §5)
// ───────────────────────────────────────────────────────────────────────
//
// Pipeline:
//   ┌─ budget check                         (shared with v2 — same RPC)
//   ├─ rewrite(rawUtterance, lastAssistant) (shared with v2)
//   ├─ embed(rewritten, RETRIEVAL_QUERY)    (shared with v2)
//   ├─ cache lookup                         (shared with v2 — same row shape)
//   │   └─ HIT → fetch parents → DONE
//   ├─ try_build_tsquery(rewritten)         (shared with v2 — same helper)
//   ├─ _creator_route_sections_v3(creator, vec, topic_tags, top_s)  -- NEW
//   │   └─ top-S section_ids + scores
//   ├─ _creator_knowledge_topk_v3(          -- NEW (replaces topk_v2)
//   │     creator, section_ids, vec, tsq,
//   │     k_child, n_parent_per_section, min_sim, rank_mode, lambda)
//   │   └─ top-N parents per section (max S*N total)
//   ├─ Flat-fallback (plan §2.3): if scoped pass returned 0 rows, refetch
//   │   ALL section_ids of the creator and re-run topk_v3 over the wider
//   │   scope. Rank-capped so it can't flood rerank. Guarantees v3 recall
//   │   floor >= v2's. (Adaptive gap-threshold trigger is a §7 harness
//   │   knob — start with zero-rows trigger only; widen later.)
//   ├─ rerank(query, parents, topK)         (shared with v2)
//   └─ cache upsert                         (shared with v2 — same row shape)
//
// SAME RetrievedParent[] shape returned so buildInjectionEnvelope is
// agnostic. Telemetry gets a new `route: RouteLeg` field + v3-specific
// retrieve-leg fields (parentScoreTop1, parentRankSource, candidatesFromScope).
//
// PROD-SAFETY: this is a NEW orchestrator next to v2, not a refactor.
// v2 prod traffic is untouched. The shared helper functions (rewrite,
// embed, cache, rerank, parent fetch) are imported, not duplicated, so a
// future audit/improvement of those legs benefits both versions.

export type RetrieveKnowledgeV3Args = {
  supabaseAdmin: SupabaseClient;
  userId: string;
  creatorId: string;
  rawUtterance: string;
  lastAssistantResponse: string | null;
  corpusVersionAtSession: number;
  sessionId: string | null;
  deadlineMs: number;
  geminiApiKey: string;
  voyageApiKey: string;
  /** Final topK after rerank. Default 5, clamped to [1, 20]. */
  topK?: number;
  /** Cache similarity threshold for lookup. Default 0.92. */
  cacheThreshold?: number;
  /**
   * v3-specific: topic tags from the hook the user tapped (soft boost to
   * route_sections_v3). NULL/empty disables the boost.
   */
  topicTags?: string[] | null;
  /**
   * v3-specific: parent aggregation rank mode (plan §3b candidates a-d).
   * 'max' | 'max_blend' (DEFAULT) | 'vec_max' | 'best_child'. The §7
   * harness pins the prod value before v3 takes traffic.
   */
  rankMode?: 'max' | 'max_blend' | 'vec_max' | 'best_child';
  /** v3-specific: lambda for max_blend. Default 0.10. */
  lambda?: number;
  /** v3-specific: p_top_s for route_sections. Default 6 (DEFAULT_V3_TOP_S). Clamped server-side [1, 10]. */
  topS?: number;
  /** v3-specific: p_n_parent_per_section for topk. Default 5. Clamped server-side [1, 20]. */
  nParentPerSection?: number;
  /**
   * v3-specific: p_min_sim for topk. Omit to use the per-rank-mode default from
   * `DEFAULT_V3_MIN_SIM_BY_MODE` (0.20 for the default max_blend mode; see
   * v3-min-sim.ts). CALIBRATED 2026-06-01 — the floor has no recall effect in
   * [0,0.3]; env-overridable via V3_MIN_SIM_*. An explicit value wins over the
   * default (the eval harness passes per-grid-point values this way).
   */
  minSim?: number;
};

export type RetrieveKnowledgeV3Result = {
  parents: RetrievedParent[];
  telemetry: RagTurnTelemetry;
  budgetExceeded: boolean;
  rewriteFallback: boolean;
  /** Number of sections returned by route_sections_v3. */
  sectionsRouted: number;
  /**
   * True when the flat (unscoped) fallback fired. Distinct from
   * `routePhaseRan`: a cache hit returns sectionsRouted=0,
   * flatFallbackFired=false, routePhaseRan=false (audit M7 — three
   * distinct states must be distinguishable for dashboards).
   */
  flatFallbackFired: boolean;
  /**
   * True when the route_sections_v3 + scoped topk_v3 actually executed
   * (i.e., the cache did NOT short-circuit). Dashboards filter
   * `WHERE routePhaseRan = true` to compute routing-only metrics
   * without including cache-hit turns that bypassed routing.
   */
  routePhaseRan: boolean;
};

export class RetrieveKnowledgeV3Error extends Error {
  readonly code:
    | 'budget_check_failed'
    | 'embed_failed'
    | 'rpc_failed'
    | 'empty_utterance'
    | 'invalid_corpus_version';
  constructor(code: RetrieveKnowledgeV3Error['code'], msg?: string) {
    super(msg ?? code);
    this.name = 'RetrieveKnowledgeV3Error';
    this.code = code;
  }
}

// Frozen from the §8 eval sweep (2026-05-30, AoD full-book / 12 needles, S=6).
// Sweep result: routing 4→6 jumps 58%→81% and recall@1 39%→47%; 6→8 is noise
// (recall@1 identical, S=6 actually wins recall@2 56% vs 53%). rank_mode /
// topk_min / λ had ~no effect on recall@1, so they stay at their prior defaults.
// S is a CEILING (route RPC does `LIMIT top_s`), so a creator with <6 sections
// returns all of them — no padding. Picked 6 over 8 because per-turn rerank
// payload + topk cost scale with sections actually searched; at book/company
// scale 6 reranks ~25% less text than 8 for equal recall@1. See
// CLEANUP_BACKLOG "adaptive-S" — a fixed S is a v1 simplification; a 3-section
// creator and a 5000-section company-brain should not share one S long-term.
const DEFAULT_V3_TOP_S = 6;
const DEFAULT_V3_N_PARENT_PER_SECTION = 5;
// Step-9 audit S4: the rerank candidate cap MUST cover the frozen v3 fan-out
// (top_s × n_parent_per_section parents), or rerank slices off — by RRF/blend
// proxy score — the very parents the cross-encoder exists to re-rank. The cap
// lived as a hand-synced literal in rerank.ts; tie it to the constants here so a
// future fan-out bump that forgets the cap fails LOUD at module load. (If a
// caller overrides args.topS ABOVE the default, the cap must be re-derived —
// today prod freezes topS=6.)
if (RERANK_MAX_CANDIDATES !== DEFAULT_V3_TOP_S * DEFAULT_V3_N_PARENT_PER_SECTION) {
  throw new Error(
    `rerank MAX_CANDIDATES (${RERANK_MAX_CANDIDATES}) != DEFAULT_V3_TOP_S (${DEFAULT_V3_TOP_S}) × DEFAULT_V3_N_PARENT_PER_SECTION (${DEFAULT_V3_N_PARENT_PER_SECTION}) = ${DEFAULT_V3_TOP_S * DEFAULT_V3_N_PARENT_PER_SECTION}. The v3 fan-out and the rerank cap drifted — bump MAX_CANDIDATES in rerank.ts in lockstep or rerank silently drops candidates (Step-9 audit S4).`,
  );
}
const DEFAULT_V3_K_CHILD = 30;
const DEFAULT_V3_RANK_MODE = 'max_blend' as const;
const DEFAULT_V3_LAMBDA = 0.10;
// Per-rank-mode floors (audit M4). v2's flat 0.30 was tuned for SUM-RRF and is
// meaningless for MAX-child ranking. Per-mode defaults live in v3-min-sim.ts and
// are env-overridable (V3_MIN_SIM_* — clamped to (0,1], invalid → placeholder +
// log) so the §7 harness output can be pinned WITHOUT a code edit. CALIBRATED
// 2026-06-01 (aod sweep): the floor has no recall effect in [0,0.3] and off-topic
// already returns empty at floor 0, so the defaults are validated-safe (see
// v3-min-sim.ts header). Resolved once at module load against process.env.
const DEFAULT_V3_MIN_SIM_BY_MODE = resolveV3MinSimByMode();
// Flat-fallback hard cap on sections widened to (round-5 C3). Books with
// 200+ sections would otherwise feed an unbounded ANY filter to topk_v3.
const FLAT_FALLBACK_MAX_SECTIONS = 50;
// Flat-fallback budget cap (round-5 C3). The scoped pass burned some of
// `deadlineMs` already; flat is bounded by min(remaining, this) so it
// can't blow the §7 3500ms LIVE decoupled ceiling on long-route turns.
const FLAT_FALLBACK_BUDGET_MS = 800;

export async function retrieveKnowledgeV3(
  args: RetrieveKnowledgeV3Args,
): Promise<RetrieveKnowledgeV3Result> {
  const startedAt = Date.now();
  const admin = args.supabaseAdmin;
  const telemetry = newTurnTelemetry({
    userId: args.userId,
    sessionId: args.sessionId,
    creatorId: args.creatorId,
    retrievalVersion: 3,
    corpusVersionAtSession: args.corpusVersionAtSession,
  });

  if (!args.rawUtterance || args.rawUtterance.trim().length === 0) {
    throw new RetrieveKnowledgeV3Error('empty_utterance');
  }
  if (
    !Number.isInteger(args.corpusVersionAtSession) ||
    args.corpusVersionAtSession < 1
  ) {
    throw new RetrieveKnowledgeV3Error(
      'invalid_corpus_version',
      `corpusVersionAtSession must be a positive integer; got ${args.corpusVersionAtSession}`,
    );
  }

  try {
    return await runOrchestratorV3(args, telemetry, startedAt);
  } finally {
    telemetry.totalLatencyMs = Date.now() - startedAt;
    void flushCogsLogRows(admin, toCogsLogRows(telemetry));
  }
}

async function runOrchestratorV3(
  args: RetrieveKnowledgeV3Args,
  telemetry: RagTurnTelemetry,
  startedAt: number,
): Promise<RetrieveKnowledgeV3Result> {
  const admin = args.supabaseAdmin;
  const topK = Math.max(1, Math.min(args.topK ?? DEFAULT_TOP_K, MAX_TOP_K));
  const cacheThreshold = args.cacheThreshold ?? CACHE_DEFAULT_THRESHOLD;
  const deadlineMs = args.deadlineMs;
  const topS = args.topS ?? DEFAULT_V3_TOP_S;
  const nParentPerSection = args.nParentPerSection ?? DEFAULT_V3_N_PARENT_PER_SECTION;
  const rankMode = args.rankMode ?? DEFAULT_V3_RANK_MODE;
  const lambda = args.lambda ?? DEFAULT_V3_LAMBDA;
  // M4: per-mode minSim default — vec_max needs a higher floor than max-rrf modes.
  const minSim = args.minSim ?? DEFAULT_V3_MIN_SIM_BY_MODE[rankMode];
  const topicTags = args.topicTags && args.topicTags.length > 0 ? args.topicTags : null;

  const done = (
    parents: RetrievedParent[],
    budgetExceeded: boolean,
    rewriteFallback: boolean,
    sectionsRouted: number,
    flatFallbackFired: boolean,
    routePhaseRan: boolean,
  ): RetrieveKnowledgeV3Result => {
    telemetry.totalLatencyMs = Date.now() - startedAt;
    if (process.env.RAG_DIAG_LOGS === '1') {
      // eslint-disable-next-line no-console
      console.warn(
        `[retrieve-knowledge-v3] timing: rewrite=${telemetry.rewrite?.latencyMs ?? 'na'} `
        + `embed=${telemetry.embed?.latencyMs ?? 'na'} route=${telemetry.route?.latencyMs ?? 'na'} `
        + `topk=${telemetry.retrieve?.latencyMs ?? 'na'} rerank=${telemetry.rerank?.latencyMs ?? 'na'} `
        + `total=${telemetry.totalLatencyMs} sectionsRouted=${sectionsRouted} `
        + `flat=${flatFallbackFired} routeRan=${routePhaseRan}`,
      );
    }
    return {
      parents, telemetry, budgetExceeded, rewriteFallback,
      sectionsRouted, flatFallbackFired, routePhaseRan,
    };
  };

  // 1. Budget check (same as v2).
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
    if (error) throw new RetrieveKnowledgeV3Error('budget_check_failed', error.message);
    budgetOk = data as boolean;
  } catch (e) {
    if (isDeadlineExceeded(e)) {
      throw new RetrieveKnowledgeV3Error('budget_check_failed', 'deadline_exceeded');
    }
    throw e;
  }
  if (budgetOk === false) {
    telemetry.budgetExceeded = true;
    return done([], true, false, 0, false, false);
  }

  // 2. Rewrite (same as v2).
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
    noContextAfterResumption: rewriteResult.noContextAfterResumption,
  };
  const rewrittenText =
    rewriteResult.rewritten && rewriteResult.rewritten.length > 0
      ? rewriteResult.rewritten
      : args.rawUtterance;

  // 3. Embed (same as v2).
  const embedStart = Date.now();
  let queryVec: number[];
  let embedTokens: number;
  try {
    const { vectors, tokens } = await withDeadline(
      embedTexts({ texts: [rewrittenText.slice(0, 8000)], taskType: 'RETRIEVAL_QUERY' }),
      deadlineMs,
      'embed',
    );
    queryVec = vectors[0];
    embedTokens = tokens;
  } catch (e) {
    const msg = (e as Error)?.message ?? 'embed_failed';
    throw new RetrieveKnowledgeV3Error(
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

  // 4. Cache lookup (same as v2 — semantic_query_cache is creator+corpus_version-keyed
  // and version-agnostic; a v3 hit returns the same RetrievedParent[] shape).
  let parents: RetrievedParent[] = [];
  const canTouchCache = !rewriteResult.fallback && !CACHE_DISABLED;
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
      console.warn(`[retrieve-knowledge-v3] cache lookup fail-open: ${why}`);
    }
    if (hit) {
      telemetry.cacheHit = true;
      telemetry.cacheAgeSeconds = hit.ageSeconds;
      const fetched = await fetchParentNarrativesByIds({
        admin, creatorId: args.creatorId, ids: hit.parentUnitIds, deadlineMs,
      });
      if (fetched.length < hit.parentUnitIds.length) {
        telemetry.cacheStaleCorpus = true;
      }
      if (fetched.length === 0) {
        telemetry.cacheHit = false;
        // Fall through to fresh retrieve.
      } else {
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
        // Cache hit: routePhaseRan=false (the route + scoped topk never executed).
        return done(parents, false, rewriteResult.fallback, 0, false, false);
      }
    }
  }

  // 5a. ROUTE — pick top-S sections.
  const routeStart = Date.now();
  type RouteRow = {
    section_id: string;
    sample_id: string;
    title: string | null;
    summary_sim: number | string;
    centroid_sim: number | string;
    topic_boost: number | string;
    score: number | string;
  };
  let routeRows: RouteRow[] = [];
  try {
    const { data: rows, error } = await withDeadline(
      admin.rpc('_creator_route_sections_v3', {
        p_creator_id: args.creatorId,
        p_query_vec: vectorToPgText(queryVec),
        p_topic_tags: topicTags,
        p_top_s: topS,
        p_min_sim: 0.0, // routing uses its own internal floor; don't double-gate
      }),
      deadlineMs,
      'route_sections_v3',
    );
    if (error) throw new RetrieveKnowledgeV3Error('rpc_failed', `route_sections_v3: ${error.message}`);
    routeRows = Array.isArray(rows) ? (rows as RouteRow[]) : [];
  } catch (e) {
    if (e instanceof RetrieveKnowledgeV3Error) throw e;
    if (isDeadlineExceeded(e)) {
      throw new RetrieveKnowledgeV3Error('rpc_failed', 'route_sections_v3: deadline_exceeded');
    }
    throw e;
  }
  const sectionIdsScoped = routeRows.map((r) => r.section_id);
  const routeTop1 = routeRows.length > 0 ? toNum(routeRows[0].score) : null;
  const routeTop2 = routeRows.length > 1 ? toNum(routeRows[1].score) : null;
  const routeGap =
    routeTop1 !== null && routeTop2 !== null ? routeTop1 - routeTop2 : null;

  // 5b. tsquery (same as v2 — shared helper). `tsqStart` is the boundary
  // between the route leg and the topk leg for the M1 latency split.
  const tsqStart = Date.now();
  let tsq = '';
  try {
    const { data: tsqData, error: tsqErr } = await withDeadline(
      admin.rpc('try_build_tsquery', { p_text: rewrittenText.slice(0, 4000) }),
      deadlineMs,
      'try_build_tsquery',
    );
    if (tsqErr) throw new RetrieveKnowledgeV3Error('rpc_failed', `try_build_tsquery: ${tsqErr.message}`);
    tsq = (tsqData as string) ?? '';
  } catch (e) {
    if (e instanceof RetrieveKnowledgeV3Error) throw e;
    if (isDeadlineExceeded(e)) {
      throw new RetrieveKnowledgeV3Error('rpc_failed', 'try_build_tsquery: deadline_exceeded');
    }
    throw e;
  }

  // 5c. Scoped topk_v3 over routed sections.
  type RpcRowV3 = {
    parent_unit_id: string;
    parent_text: string;
    parent_title: string | null;
    sample_id: string;
    source_type: string;
    section_id: string;
    vector_score: number | string;
    bm25_score: number | string;
    rrf_score: number | string;
    parent_score: number | string;
    matched_child_chunk_ids: string[];
  };
  const callTopk = async (sectionIds: string[]): Promise<RpcRowV3[]> => {
    if (sectionIds.length === 0) return [];
    const { data: rows, error } = await withDeadline(
      admin.rpc('_creator_knowledge_topk_v3', {
        p_creator_id: args.creatorId,
        p_section_ids: sectionIds,
        p_query_vec: vectorToPgText(queryVec),
        p_query_tsq: tsq,
        p_k_child: DEFAULT_V3_K_CHILD,
        p_n_parent_per_section: nParentPerSection,
        p_min_sim: minSim,
        p_rank_mode: rankMode,
        p_lambda: lambda,
      }),
      deadlineMs,
      'topk_v3',
    );
    if (error) throw new RetrieveKnowledgeV3Error('rpc_failed', `topk_v3: ${error.message}`);
    if (!Array.isArray(rows)) {
      // eslint-disable-next-line no-console
      console.warn(`[retrieve-knowledge-v3] topk_v3 returned non-array: ${typeof rows}`);
      return [];
    }
    return rows as RpcRowV3[];
  };

  let rows: RpcRowV3[] = [];
  let candidatesFromScope = 0;
  let flatFallbackFired = false;
  let flatFallbackCapped: boolean | null = null;
  let scopedTopkLatencyMs = 0;
  let flatLatencyMs: number | null = null;
  const scopedTopkStart = Date.now();
  try {
    rows = await callTopk(sectionIdsScoped);
    candidatesFromScope = rows.length;
  } catch (e) {
    if (e instanceof RetrieveKnowledgeV3Error) throw e;
    if (isDeadlineExceeded(e)) {
      throw new RetrieveKnowledgeV3Error('rpc_failed', 'topk_v3: deadline_exceeded');
    }
    throw e;
  }
  scopedTopkLatencyMs = Date.now() - scopedTopkStart;

  // 5d. Flat fallback (plan §2.3) -- fires when scoped pass returned 0 rows.
  // Adaptive gap-threshold trigger is a §7 harness knob; ship with the
  // zero-rows trigger so v3's recall floor >= v2's even on a routing miss.
  //
  // Round-5 C3: BOUNDED. (a) tighter deadline (FLAT_FALLBACK_BUDGET_MS or
  // remaining, whichever is smaller) so flat can't blow the §7 3500ms LIVE
  // ceiling on long-route turns; (b) hard cap on section count
  // (FLAT_FALLBACK_MAX_SECTIONS) so a 200-section book doesn't feed a
  // 200-uuid ANY filter to topk_v3.
  if (rows.length === 0 && sectionIdsScoped.length > 0) {
    const flatStart = Date.now();
    const flatDeadlineMs = Math.min(deadlineMs, flatStart + FLAT_FALLBACK_BUDGET_MS);
    try {
      // Step-9 audit R2/C-1: go through the gen-filtered RPC, NOT a raw
      // creator-wide select. The old raw `.from(sections).select(id)
      // .eq(creator_id)` had no generation filter → mid-re-ingest it returned
      // BOTH generations' ids (and duplicate section_index rows after the
      // UNIQUE swap), feeding half-built sections into topk. The RPC filters
      // to each sample's active_section_generation server-side.
      const { data: allSections, error: secErr } = await withDeadline(
        admin.rpc('_creator_active_section_ids_v3', {
          p_creator_id: args.creatorId,
          p_limit: FLAT_FALLBACK_MAX_SECTIONS,
        }),
        flatDeadlineMs,
        'flat_sections_fetch',
      );
      if (!secErr && Array.isArray(allSections) && allSections.length > 0) {
        const allIds = (allSections as Array<{ section_id: string }>).map((r) => r.section_id);
        // Step-9 audit M3: the flat fallback asks for at most
        // FLAT_FALLBACK_MAX_SECTIONS active section ids. If the creator has MORE
        // active sections than that, the RPC returns the first N by section_index
        // and the fallback silently under-recalls later content (a large-corpus
        // creator "forgetting the back half of book 2"). Emit a loud breadcrumb +
        // telemetry flag so this surfaces BEFORE a creator reports it — the fix is
        // to raise the cap AND re-derive the topk fan-out budget, not to ignore it.
        if (allSections.length >= FLAT_FALLBACK_MAX_SECTIONS) {
          flatFallbackCapped = true;
          // eslint-disable-next-line no-console
          console.warn(
            `[retrieve-knowledge-v3] flat fallback hit the ${FLAT_FALLBACK_MAX_SECTIONS}-section cap for creator=${args.creatorId}: active sections exceed the cap, so only the first ${FLAT_FALLBACK_MAX_SECTIONS} (by section_index) are considered — later content may be unreachable on a routing miss. Raise FLAT_FALLBACK_MAX_SECTIONS + re-derive the topk fan-out budget.`,
          );
        }
        // callTopk reads `deadlineMs` from closure; the flat call needs to
        // race against the TIGHTER `flatDeadlineMs`. Inline the call here
        // with the tight deadline rather than restructure callTopk.
        const { data: flatRpcRows, error: flatErr } = await withDeadline(
          admin.rpc('_creator_knowledge_topk_v3', {
            p_creator_id: args.creatorId,
            p_section_ids: allIds,
            p_query_vec: vectorToPgText(queryVec),
            p_query_tsq: tsq,
            p_k_child: DEFAULT_V3_K_CHILD,
            p_n_parent_per_section: nParentPerSection,
            p_min_sim: minSim,
            p_rank_mode: rankMode,
            p_lambda: lambda,
          }),
          flatDeadlineMs,
          'topk_v3_flat',
        );
        if (!flatErr && Array.isArray(flatRpcRows) && flatRpcRows.length > 0) {
          rows = flatRpcRows as RpcRowV3[];
          flatFallbackFired = true;
        }
      }
    } catch (e) {
      const why = isDeadlineExceeded(e) ? 'deadline_exceeded' : (e as Error)?.message ?? 'unknown';
      // eslint-disable-next-line no-console
      console.warn(`[retrieve-knowledge-v3] flat fallback fail-open: ${why}`);
    }
    flatLatencyMs = Date.now() - flatStart;
  }

  telemetry.route = {
    sectionsReturned: routeRows.length,
    sectionTop1Score: routeTop1,
    sectionTop1to2Gap: routeGap,
    flatFallbackFired,
    flatFallbackCapped,
    // Round-5 M1: split latencies (route alone, scoped topk alone, flat alone).
    latencyMs: tsqStart - routeStart,
    scopedTopkLatencyMs,
    flatLatencyMs,
  };
  telemetry.retrieve = {
    parentsReturned: rows.length,
    vectorTop1Score: rows.length > 0 ? toNum(rows[0].vector_score) : null,
    bm25Top1Score: rows.length > 0 ? toNum(rows[0].bm25_score) : null,
    rrfTop1Score: rows.length > 0 ? toNum(rows[0].rrf_score) : null,
    parentScoreTop1: rows.length > 0 ? toNum(rows[0].parent_score) : null,
    parentRankSource: rankMode,
    candidatesFromScope,
    // M1: this is the scoped topk alone; flat is in route.flatLatencyMs.
    latencyMs: scopedTopkLatencyMs,
  };

  if (rows.length === 0) {
    return done([], false, rewriteResult.fallback, routeRows.length, flatFallbackFired, true);
  }

  // 6. Rerank (same as v2).
  const candidates: RerankCandidate[] = rows.map((r) => ({
    id: r.parent_unit_id, text: r.parent_text,
  }));
  const rowsById = new Map<string, RpcRowV3>();
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

  parents = [];
  for (const r of rerankResult.reranked) {
    const row = rowsById.get(r.id);
    if (!row) {
      // eslint-disable-next-line no-console
      console.warn(`[retrieve-knowledge-v3] rerank returned unknown id=${r.id}`);
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

  // 7. Cache upsert.
  // Round-5 C2: gate on `!flatFallbackFired && !topicTags`. The
  // semantic_query_cache key is `(creator, corpus_version, query_vec)` --
  // NOT keyed on `topic_tags` or `rank_mode`. Caching parents from:
  //   (a) the flat fallback (parents from sections the router did NOT
  //       route to) would poison the cache: a next-session scoped pass
  //       on the same query would never get to run because the cache hits
  //       FIRST and serves the wrong-scope parents.
  //   (b) a tag-boosted route (topicTags set) would similarly poison: a
  //       next-session caller with DIFFERENT topicTags gets the writer's
  //       parents.
  // Full fix is a schema change (add tags + rank_mode + flat-fired to the
  // cache key) -- tracked in CLEANUP_BACKLOG. Until then, the safe move
  // is to NOT write these cases at all -- a missed cache write costs one
  // extra retrieval per next-turn; a poisoned cache costs WRONG retrieval
  // for the cache TTL (7 days).
  const cacheUpsertSafe = !flatFallbackFired && !topicTags;
  if (canTouchCache && cacheUpsertSafe && parents.length > 0 && !rerankResult.fallback) {
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
      const why = isDeadlineExceeded(e) ? 'deadline_exceeded' : (e as Error)?.message ?? 'unknown';
      // eslint-disable-next-line no-console
      console.warn(`[retrieve-knowledge-v3] cache upsert fail-open: ${why}`);
    }
    if (upsertResult && !upsertResult.ok && upsertResult.reason === 'stale_corpus') {
      telemetry.cacheStaleCorpus = true;
    }
  }

  return done(parents, false, rewriteResult.fallback, routeRows.length, flatFallbackFired, true);
}
