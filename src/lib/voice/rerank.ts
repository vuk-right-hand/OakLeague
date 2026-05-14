// rerank.ts — Voyage rerank-2.5 client behind RerankBridge interface.
//
// PURPOSE
//   After the hybrid RPC (creator_knowledge_topk_v2) returns top-20 parents
//   ranked by RRF(vector, BM25), this module rescores them with a true
//   cross-encoder reranker. NDCG@10 on the 93-dataset benchmark improves
//   ~8% over Cohere v3.5 and ~13% over LLM-as-reranker patterns (Voyage's
//   2025-08 publication). The reranker is the single highest-quality
//   signal in the pipeline, but it costs an extra RTT and a vendor.
//
// BRIDGE PATTERN (CLAUDE.md "swap cost = one env var + one bridge file")
//   - Public surface: `RerankBridge` interface + `getRerankBridge()` factory.
//   - Today: Voyage only. RERANK_PROVIDER MUST equal 'voyage' or the
//     factory throws RerankConfigError('provider_not_voyage'). When we add
//     Cohere (post-scale), implement `CohereRerankBridge` and widen the
//     allowlist in `getRerankBridge` — single-file change.
//   - No provider response types leak past this module. Consumers see only
//     `RerankResult` + `RerankFallbackReason`.
//
// FAILURE POLICY (degrade-to-vector-only, no Cohere fallback)
//   This module follows the same "best-effort enrichment" contract as
//   query-rewrite.ts: failing the rerank call should never crash the
//   session. Every error path returns a typed fallback object; the
//   orchestrator (Day 11) checks `fallback=true` and proceeds with the
//   RRF-ranked input order, taking top-K from there.
//
//   Token-bucket overflow (M5 plan finding) is a fallback path, NOT a
//   wait-forever queue: we tolerate up to 200ms queue wait, then degrade.
//   Voice budget is brutal — better to ship a slightly-worse-ranked
//   answer than to miss the audio-gate.
//
// COST + RATE LIMITS (verified 2026-05-13/14; cost re-derived after Day-10
// audit M3)
//   - Voyage rerank-2.5: $0.05 / 1M input tokens.
//   - Top-20 parents × 3500 chars cap ÷ ~4 chars/token ≈ 875 tokens/parent
//     → ~17.5K input tokens per turn → ~$0.0009/turn at the candidate cap.
//     Real-world avg (parent_text shorter than the 3500 cap) lands lower;
//     cogs_log writes use Voyage's authoritative `usage.total_tokens`, not
//     this estimate.
//   - Tier 1 (pay-as-you-go with payment method): 2000 RPM for rerank-2.5.
//   - 2000 RPM = 33.3 req/s ceiling. Token-bucket capacity 25 + sustained
//     refill 25/sec → worst-case burst-from-full = 50 calls in any
//     1-second window (25 immediate + 25 refilled). Over a 60s window
//     that's bounded by 25 × 60 = 1500 calls, well under the 2000 RPM
//     ceiling. Headroom by design.
//
// IMPORTANT: the request body shape uses `query` + `documents` + `top_k`
// + `truncation` + `return_documents`. We send `return_documents:false`
// to keep response payloads tiny (we only need indexes + scores).
//
// FIFO/FAIRNESS CONTRACT (Day-10 audit C1 disposition)
//   The bucket does NOT guarantee FIFO admission under concurrent
//   contention. When N callers exceed available tokens + refill within
//   the queue tolerance, an arbitrary subset (sized by refill math) wins
//   and the rest fall back to rate_limited. Within a single event-loop
//   tick the synchronous read-modify-write IS atomic (JS single-thread)
//   so the long-term rate (~25 RPS sustained) holds, but individual
//   callers can lose races. This is acceptable because the fallback path
//   is passthrough — the worst case is degraded-but-functional ranking,
//   not a crash. At YC-dogfood scale (≤10 concurrent sessions × ~1
//   retrieve/sec) starvation is theoretical.
//
// POSTHOG EVENT CONTRACT (Day-10 audit M7)
//   This module emits ONLY console.warn for fallback paths. The Day-11
//   orchestrator that wraps `rerank()` MUST emit PostHog events keyed on
//   `RerankResult.fallbackReason`:
//     - 'rate_limited'   → rag_rerank_bucket_overflow
//     - 'timeout'        → rag_rerank_timeout
//     - 'auth_failed'    → rag_rerank_auth_failed (alert-worthy)
//     - 'transport_error'→ rag_rerank_transport_error
//     - 'parse_error' / 'empty_response' → rag_rerank_provider_malformed
//   Without those events ops cannot distinguish "healthy with occasional
//   fallback" from "Voyage has been down 8 hours." This module returns
//   the structured reason; the orchestrator owns telemetry.
//
// SLO ALERTING (Day-8/9/10 cross-cutting audit S8):
//   Sustained rerank fallback rate >5% over a 10-minute window → page.
//   At Vuk dogfood scale a single user can't trigger 5% transient noise;
//   any sustained breach indicates a Voyage outage or API-key issue. The
//   Day-11 PostHog alert is wired against the `rag_rerank_*` event taxa
//   above with `% = sum(fallback events) / sum(rag_rerank_attempt)`.
//
// COGS_LOG CONTRACT: caller writes cogs_log using `modelId + provider +
// usdPerInputToken + inputTokens + quotedAt + latencyMs`. CLAUDE.md
// "every paid API call writes cogs_log" applies — orchestrator owns.
//
// BUDGET ALLOCATION (cross-cutting unit audit M7): caller passes
// `deadlineMs`. Hard cap RERANK_TIMEOUT_MS_HARD_CAP=2000ms; fast-fails
// <500ms remaining. Day-11 orchestrator typically allocates ~30% of
// turn budget here.
//
// TRUNCATION AUTHORITY (Day-8/9/10 cross-cutting audit M4):
//   SQL-side truncation in `creator_knowledge_topk_v2` (MIG-2) is
//   CANONICAL — parent_text comes back already ≤3500 chars. The TS
//   `MAX_DOCUMENT_CHARS=3500` truncation in this module is defense-in-
//   depth ONLY (Voyage's 16K-token cap is far above), and is plain
//   `String.slice` (UTF-16 code units). The SQL truncation is the
//   authoritative source-of-truth for the 3500-char ceiling; do not
//   tighten the TS cap below it without re-deriving SQL too.

import 'server-only';

// ───────────────────────────────────────────────────────────────────────
// Configuration (boot-time validated)
// ───────────────────────────────────────────────────────────────────────

// `.trim()` defense (Day-10 audit M2 + C4 whitespace): `Number(' ')` is 0
// (passes truthy `||` but fails our positive-finite check), and a stray
// trailing space on RERANK_PROVIDER in the Vercel UI shouldn't silently
// disable the bridge. Trim every env we parse.
function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

export const RERANK_PROVIDER = envStr('RERANK_PROVIDER', 'voyage');

// Pinned Voyage rerank model. NOT user-overridable mid-deploy — model
// changes affect score distributions, which affect retrieval-quality
// thresholds calibrated against the dogfood gate. Env-override exists
// purely to swap forward to rerank-3 when Voyage ships it.
// `rerank-2.5` is the published GA alias (Voyage publishes dated variants
// in changelog; aliases are pinned-enough per query-rewrite.ts policy).
export const VOYAGE_RERANK_MODEL = envStr('VOYAGE_RERANK_MODEL', 'rerank-2.5');

// Pricing pin. $0.05 / 1M input tokens for rerank-2.5 (Voyage pricing
// page, verified 2026-05-13). Override via env to follow rate changes.
export const VOYAGE_RERANK_USD_PER_INPUT_TOKEN = Number(
  envStr('VOYAGE_RERANK_USD_PER_INPUT_TOKEN', '0.00000005'),
);
export const VOYAGE_RERANK_QUOTED_AT = envStr('VOYAGE_RERANK_QUOTED_AT', '2026-05-14');

// Rate-limit defense. 25 req/s ceiling = ~75% of Tier 1 (2000 RPM = 33/s).
// Queue tolerance 200ms: if the next slot opens within 200ms we wait,
// otherwise we degrade to vector-only top-K. Voice budget can't tolerate
// longer waits.
const TOKEN_BUCKET_CAPACITY = Number(envStr('VOYAGE_RERANK_RPS_BUCKET', '25'));
const TOKEN_BUCKET_REFILL_PER_MS = TOKEN_BUCKET_CAPACITY / 1000; // tokens per ms
const QUEUE_TOLERANCE_MS = Number(envStr('VOYAGE_RERANK_QUEUE_TOLERANCE_MS', '200'));

// Per-call hard timeout. Voyage P50 is ~300-595ms; P99 sits well under 1.5s.
// 2000ms is generous; if we hit it, something upstream is wrong and we
// should degrade rather than starve the turn budget.
const RERANK_TIMEOUT_MS_HARD_CAP = 2000;
// Minimum remaining budget below which we don't even attempt the call.
const MIN_REMAINING_MS = 500;

// Voyage's per-document token cap is 16K — far above our parent_text cap
// (3500 chars ≈ 800 tokens). We still defensively truncate at this size
// to give the request a hard byte ceiling for predictable latency.
const MAX_DOCUMENT_CHARS = 3500;
// Maximum number of candidates we forward to rerank. Day-10 audit S2:
// tightened from 50 (dead defense) to 25 — matches TOKEN_BUCKET_CAPACITY
// symmetry. Day-8 RPC `creator_knowledge_topk_v2` returns at most
// p_k_parent (default 20) parents, so 25 leaves margin for a future
// p_k_parent bump without forcing a code change. Voyage's hard cap is
// 1000 docs; we are nowhere near it.
const MAX_CANDIDATES = 25;

// API endpoint. Voyage's rerank endpoint URL, verified 2026-05-13.
const VOYAGE_RERANK_URL = 'https://api.voyageai.com/v1/rerank';

// ───────────────────────────────────────────────────────────────────────
// Boot-time configuration guard
// ───────────────────────────────────────────────────────────────────────

// CLAUDE.md banned model strings — same discipline as query-rewrite.ts.
// Reject `-latest`, undated `-preview`. Accept dated suffixes and bare
// versioned aliases like 'rerank-2.5'.
{
  const m = VOYAGE_RERANK_MODEL;
  const isLatest = /-latest$/i.test(m);
  const hasPreview = /-preview/i.test(m);
  const hasDatedPreview =
    /-preview-(?:\d{2,}-\d{4}|\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2}|\d{4}-\d{2}|\d{2}-\d{4})/i.test(m);
  const isUndatedPreview = hasPreview && !hasDatedPreview;
  if (!m || isLatest || isUndatedPreview) {
    throw new Error(`VOYAGE_RERANK_MODEL invalid: ${m}. Banned: -latest, undated -preview.`);
  }
  if (
    !Number.isFinite(VOYAGE_RERANK_USD_PER_INPUT_TOKEN) ||
    VOYAGE_RERANK_USD_PER_INPUT_TOKEN <= 0
  ) {
    throw new Error(
      `VOYAGE_RERANK_USD_PER_INPUT_TOKEN must be a positive finite number; got ${process.env.VOYAGE_RERANK_USD_PER_INPUT_TOKEN}`,
    );
  }
  if (!Number.isFinite(TOKEN_BUCKET_CAPACITY) || TOKEN_BUCKET_CAPACITY <= 0) {
    throw new Error(
      `VOYAGE_RERANK_RPS_BUCKET must be a positive finite number; got ${process.env.VOYAGE_RERANK_RPS_BUCKET}`,
    );
  }
  if (!Number.isFinite(QUEUE_TOLERANCE_MS) || QUEUE_TOLERANCE_MS < 0) {
    throw new Error(
      `VOYAGE_RERANK_QUEUE_TOLERANCE_MS must be a non-negative finite number; got ${process.env.VOYAGE_RERANK_QUEUE_TOLERANCE_MS}`,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────
// Boot telemetry (plan audit-2 M2 — one-time stdout line so deploys
// can grep for the provisioned config without inferring it from API
// errors). Single line, parsable. Skipped in test env to keep vitest
// output clean. Day-10 audit M4: no off-switch — ops MUST be able to
// grep deploys for this line. If you're trying to suppress it, the
// right answer is "don't."
// ───────────────────────────────────────────────────────────────────────

if (process.env.NODE_ENV !== 'test') {
  // eslint-disable-next-line no-console
  console.log(
    `[rerank] boot provider=${RERANK_PROVIDER} model=${VOYAGE_RERANK_MODEL} ` +
      `rps_bucket=${TOKEN_BUCKET_CAPACITY} queue_tolerance_ms=${QUEUE_TOLERANCE_MS} ` +
      `timeout_ms=${RERANK_TIMEOUT_MS_HARD_CAP} max_candidates=${MAX_CANDIDATES} ` +
      `usd_per_input_token=${VOYAGE_RERANK_USD_PER_INPUT_TOKEN} quoted_at=${VOYAGE_RERANK_QUOTED_AT}`,
  );
}

// ───────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────

export type RerankCandidate = {
  /** Caller-supplied opaque identifier; we return the same id with each result. */
  id: string;
  /** Document text to score against the query. Truncated to MAX_DOCUMENT_CHARS in this module before send. */
  text: string;
};

export type RerankedResult = {
  id: string;
  /** Score from the reranker. Voyage's relevance_score is in [0,1]; higher = more relevant. */
  score: number;
  /** Original index in the input candidate array. Useful for diagnostics. */
  originalIndex: number;
};

export type RerankFallbackReason =
  | 'empty_candidates'
  | 'budget_exhausted'
  | 'rate_limited' // token-bucket overflow OR provider 429
  | 'transport_error'
  | 'timeout'
  | 'empty_response'
  | 'parse_error'
  | 'auth_failed';

export type RerankResult =
  | {
      ok: true;
      reranked: RerankedResult[];
      fallback: false;
      modelId: string;
      provider: 'voyage';
      usdPerInputToken: number;
      quotedAt: string;
      inputTokens: number;
      latencyMs: number;
    }
  | {
      ok: true; // call returned (even if degraded); orchestrator still gets passages
      reranked: RerankedResult[]; // input pass-through in original order, truncated to topK
      fallback: true;
      fallbackReason: RerankFallbackReason;
      modelId: string;
      provider: 'voyage';
      usdPerInputToken: number;
      quotedAt: string;
      inputTokens: number;
      latencyMs: number;
    };

export type RerankInput = {
  voyageApiKey: string;
  query: string;
  candidates: readonly RerankCandidate[];
  /** Top-K to return after rerank. Clamped to [1, candidates.length]. */
  topK: number;
  /** Absolute epoch ms when the caller's overall budget expires. */
  deadlineMs: number;
};

// ───────────────────────────────────────────────────────────────────────
// Errors
// ───────────────────────────────────────────────────────────────────────

export class RerankConfigError extends Error {
  readonly code:
    | 'provider_not_voyage'
    | 'api_key_missing';
  constructor(code: RerankConfigError['code'], msg?: string) {
    super(msg ?? code);
    this.name = 'RerankConfigError';
    this.code = code;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Token bucket (process-local; one per Node process)
// ───────────────────────────────────────────────────────────────────────
//
// Bucket model: capacity = TOKEN_BUCKET_CAPACITY; refills at
// TOKEN_BUCKET_REFILL_PER_MS tokens/ms; calls consume 1 token. If 0
// tokens are available, the caller waits up to QUEUE_TOLERANCE_MS for
// the next refill; if still empty after that, the call falls back.
//
// Time source: `performance.now()` (monotonic) — Day-10 audit C2. Wall
// clock (Date.now()) can step backward after NTP sync or VM resume,
// which would have stalled the bucket for the duration of the skew.
// `performance.now()` is process-monotonic on Node since v8.5.
//
// Single instance — Voyage rate-limits per API key, and there's only
// one Voyage key per process. Multi-key tenancy is not a near-term need.

let _bucketTokens = TOKEN_BUCKET_CAPACITY;
let _bucketLastRefillAt = performance.now();

function _refillBucket(now: number): void {
  let elapsed = now - _bucketLastRefillAt;
  // Defensive: if monotonic clock went backwards (shouldn't with
  // performance.now(), but bulletproofing for cross-platform / test
  // weirdness), reset baseline and skip this refill.
  if (elapsed < 0) {
    _bucketLastRefillAt = now;
    return;
  }
  if (elapsed === 0) return;
  _bucketTokens = Math.min(
    TOKEN_BUCKET_CAPACITY,
    _bucketTokens + elapsed * TOKEN_BUCKET_REFILL_PER_MS,
  );
  _bucketLastRefillAt = now;
}

/**
 * Try to acquire one token from the bucket within waitMs. Resolves true
 * if acquired, false if still empty after waitMs (caller degrades).
 *
 * Implementation uses setTimeout for the wait — busy-poll would burn
 * the event loop. Single retry: if a token wasn't available at the
 * scheduled refill time, give up. This is OK because the refill rate
 * is deterministic; if 200ms wasn't enough, 400ms wouldn't be either
 * for this call's slot.
 *
 * FAIRNESS: not FIFO. Under concurrent contention, a subset of waiters
 * (sized by refill math during their wait window) win; the rest see
 * false. Documented in module header.
 */
async function _acquireBucketToken(waitMs: number): Promise<boolean> {
  _refillBucket(performance.now());
  if (_bucketTokens >= 1) {
    _bucketTokens -= 1;
    return true;
  }
  // Compute time until next whole token is available.
  const tokensNeeded = 1 - _bucketTokens;
  const msUntilToken = Math.ceil(tokensNeeded / TOKEN_BUCKET_REFILL_PER_MS);
  if (msUntilToken > waitMs) {
    return false;
  }
  // Wait, then try once more.
  await new Promise<void>((resolve) => setTimeout(resolve, msUntilToken));
  _refillBucket(performance.now());
  if (_bucketTokens >= 1) {
    _bucketTokens -= 1;
    return true;
  }
  return false;
}

/** Test-only: reset bucket between tests. Gated on NODE_ENV. */
export function _resetTokenBucketForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_resetTokenBucketForTests is test-only');
  }
  _bucketTokens = TOKEN_BUCKET_CAPACITY;
  _bucketLastRefillAt = performance.now();
}

// ───────────────────────────────────────────────────────────────────────
// Bridge interface (CLAUDE.md provider-agnostic pattern)
// ───────────────────────────────────────────────────────────────────────

export interface RerankBridge {
  readonly provider: 'voyage';
  readonly modelId: string;
  readonly usdPerInputToken: number;
  readonly quotedAt: string;
  rerank(input: RerankInput): Promise<RerankResult>;
}

/**
 * Pure provider-allowlist check, exported for testability (Day-10 audit M1).
 * Throws RerankConfigError('provider_not_voyage') on any value other than
 * 'voyage' (case-sensitive, post-trim — env hygiene is explicit).
 *
 * Adding a provider is a code change here, not an env flip. The widened
 * allowlist must include a Bridge implementation in this same module.
 */
export function assertProviderIsVoyage(provider: string): void {
  if (provider !== 'voyage') {
    throw new RerankConfigError(
      'provider_not_voyage',
      `RERANK_PROVIDER must be 'voyage' (case-sensitive); got '${provider}'. Cohere fallback is not implemented in v1 (post-scale add).`,
    );
  }
}

/**
 * Returns the active rerank bridge based on RERANK_PROVIDER env.
 * Hard-fails if provider is not 'voyage' — adding Cohere requires a
 * code change here, not an env flip. See header.
 */
export function getRerankBridge(): RerankBridge {
  assertProviderIsVoyage(RERANK_PROVIDER);
  return voyageBridge;
}

// ───────────────────────────────────────────────────────────────────────
// Voyage implementation
// ───────────────────────────────────────────────────────────────────────

// Day-8/9/10 cross-cutting audit S7: Object.freeze prevents accidental
// mutation from tests or future code that imports the bridge and
// reassigns fields. The interface `readonly` annotations are compile-
// time only; freeze enforces at runtime.
const voyageBridge: RerankBridge = Object.freeze({
  provider: 'voyage' as const,
  modelId: VOYAGE_RERANK_MODEL,
  usdPerInputToken: VOYAGE_RERANK_USD_PER_INPUT_TOKEN,
  quotedAt: VOYAGE_RERANK_QUOTED_AT,
  rerank: voyageRerank,
});

async function voyageRerank(input: RerankInput): Promise<RerankResult> {
  const startedAt = Date.now();
  const apiKey = input.voyageApiKey;
  if (!apiKey) {
    throw new RerankConfigError('api_key_missing', 'voyageApiKey is required');
  }

  // Filter candidates with empty/null text BEFORE truncating to MAX_CANDIDATES
  // (Day-10 audit S5). Voyage rejects empty documents; we'd rather drop them
  // client-side than waste a request slot. Original-index semantics are
  // preserved AFTER this filter — Voyage's returned `index` references the
  // filtered list, which we map back to caller-supplied ids by position.
  const candidates = (input.candidates ?? [])
    .filter((c) => typeof c?.text === 'string' && c.text.length > 0)
    .slice(0, MAX_CANDIDATES);

  // Day-10 audit S4: explicit Number.isFinite guard on topK. Falls back to
  // candidates.length when caller passes NaN/Infinity (e.g., from a
  // misconfigured upstream).
  const requestedK = Number.isFinite(input.topK) ? input.topK : candidates.length;
  const safeTopK = Math.max(1, Math.min(requestedK, candidates.length || 1));

  // Edge: empty candidate list. Nothing to rerank, nothing to fall back to.
  if (candidates.length === 0) {
    return mkFallback({
      reason: 'empty_candidates',
      reranked: [],
      startedAt,
    });
  }

  // Edge: empty / blank query. Voyage returns an error here, so fast-fail
  // to pass-through.
  const query = (input.query ?? '').trim();
  if (query.length === 0) {
    return mkFallback({
      reason: 'empty_response', // semantically: nothing to rank against
      reranked: passthrough(candidates, safeTopK),
      startedAt,
    });
  }

  // Budget check.
  const remaining = input.deadlineMs - Date.now();
  if (remaining < MIN_REMAINING_MS) {
    return mkFallback({
      reason: 'budget_exhausted',
      reranked: passthrough(candidates, safeTopK),
      startedAt,
    });
  }

  // Token-bucket admission.
  const acquired = await _acquireBucketToken(QUEUE_TOLERANCE_MS);
  if (!acquired) {
    // eslint-disable-next-line no-console
    console.warn(
      `[rerank] rate_limited token-bucket overflow provider=voyage queue_wait_ms=${QUEUE_TOLERANCE_MS}`,
    );
    return mkFallback({
      reason: 'rate_limited',
      reranked: passthrough(candidates, safeTopK),
      startedAt,
    });
  }

  const callTimeout = Math.min(RERANK_TIMEOUT_MS_HARD_CAP, input.deadlineMs - Date.now());
  if (callTimeout < MIN_REMAINING_MS) {
    return mkFallback({
      reason: 'budget_exhausted',
      reranked: passthrough(candidates, safeTopK),
      startedAt,
    });
  }

  // Truncate documents defensively. Voyage tokenizes server-side; we
  // pre-cap chars to keep payloads predictable and dodge unbounded
  // tokenizer cost on a malformed parent.
  const documents = candidates.map((c) => (c.text ?? '').slice(0, MAX_DOCUMENT_CHARS));

  // Build fetch with AbortController for the timeout. fetch's default
  // behavior with no abort is "wait forever," which is precisely the
  // wrong default for a hot path.
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let resp: Response;
  try {
    timeoutHandle = setTimeout(() => controller.abort(), callTimeout);
    try {
      resp = await fetch(VOYAGE_RERANK_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          documents,
          model: VOYAGE_RERANK_MODEL,
          top_k: safeTopK,
          return_documents: false,
          truncation: true,
        }),
      });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  } catch (err) {
    // Day-10 audit S3: tighten abort detection. Check err.name only; a
    // server-side response body containing the word "timeout" reaches
    // the response-status branch below, not this catch.
    const msg = (err as Error)?.message ?? String(err);
    const isAbort = (err as Error)?.name === 'AbortError';
    const reason: RerankFallbackReason = isAbort ? 'timeout' : 'transport_error';
    // eslint-disable-next-line no-console
    console.warn(
      `[rerank] ${reason} provider=voyage model=${VOYAGE_RERANK_MODEL} budget=${callTimeout}ms: ${msg.slice(0, 200)}`,
    );
    return mkFallback({
      reason,
      reranked: passthrough(candidates, safeTopK),
      startedAt,
    });
  }

  if (resp.status === 401 || resp.status === 403) {
    // Auth failure is louder than other transport — log distinctly so
    // ops can rotate the key without grepping for "transport_error".
    const body = await resp.text().catch(() => '<read-error>');
    // eslint-disable-next-line no-console
    console.warn(
      `[rerank] auth_failed provider=voyage status=${resp.status} body=${body.slice(0, 200)}`,
    );
    return mkFallback({
      reason: 'auth_failed',
      reranked: passthrough(candidates, safeTopK),
      startedAt,
    });
  }

  if (resp.status === 429) {
    // Provider-side rate-limit (our token bucket gave us a token but
    // Voyage still 429'd — clock skew or concurrent processes sharing
    // the key). Degrade same as bucket overflow.
    const retryAfter = resp.headers.get('retry-after') ?? '<none>';
    // eslint-disable-next-line no-console
    console.warn(
      `[rerank] rate_limited provider=voyage status=429 retry_after=${retryAfter}`,
    );
    return mkFallback({
      reason: 'rate_limited',
      reranked: passthrough(candidates, safeTopK),
      startedAt,
    });
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '<read-error>');
    // eslint-disable-next-line no-console
    console.warn(
      `[rerank] transport_error provider=voyage status=${resp.status} body=${body.slice(0, 200)}`,
    );
    return mkFallback({
      reason: 'transport_error',
      reranked: passthrough(candidates, safeTopK),
      startedAt,
    });
  }

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[rerank] parse_error provider=voyage: ${(err as Error)?.message ?? 'unknown'}`,
    );
    return mkFallback({
      reason: 'parse_error',
      reranked: passthrough(candidates, safeTopK),
      startedAt,
    });
  }

  // Voyage response shape (verified 2026-05-13):
  //   {
  //     "object": "list",
  //     "data": [
  //       { "index": 3, "relevance_score": 0.84 },
  //       { "index": 1, "relevance_score": 0.61 },
  //       ...
  //     ],
  //     "model": "rerank-2.5",
  //     "usage": { "total_tokens": 12345 }
  //   }
  const obj = parsed as {
    data?: Array<{ index?: number; relevance_score?: number }>;
    usage?: { total_tokens?: number };
  };

  if (!Array.isArray(obj.data) || obj.data.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(`[rerank] empty_response provider=voyage`);
    return mkFallback({
      reason: 'empty_response',
      reranked: passthrough(candidates, safeTopK),
      startedAt,
    });
  }

  // Map index → original candidate. Defensive: if Voyage returns an out-of-
  // range index (shouldn't happen but cheap to check), drop that entry.
  const reranked: RerankedResult[] = [];
  for (const row of obj.data) {
    const idx = row.index;
    const score = row.relevance_score;
    if (
      typeof idx !== 'number' ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= candidates.length ||
      typeof score !== 'number' ||
      !Number.isFinite(score)
    ) {
      continue;
    }
    reranked.push({
      id: candidates[idx].id,
      score,
      originalIndex: idx,
    });
    if (reranked.length >= safeTopK) break;
  }

  if (reranked.length === 0) {
    // Every row was malformed — treat as parse_error.
    // eslint-disable-next-line no-console
    console.warn(`[rerank] parse_error provider=voyage all_rows_invalid`);
    return mkFallback({
      reason: 'parse_error',
      reranked: passthrough(candidates, safeTopK),
      startedAt,
    });
  }

  const inputTokens = obj.usage?.total_tokens ?? 0;

  return {
    ok: true,
    reranked,
    fallback: false,
    modelId: VOYAGE_RERANK_MODEL,
    provider: 'voyage',
    usdPerInputToken: VOYAGE_RERANK_USD_PER_INPUT_TOKEN,
    quotedAt: VOYAGE_RERANK_QUOTED_AT,
    inputTokens,
    latencyMs: Date.now() - startedAt,
  };
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

/**
 * Pass-through ranking: returns candidates in their input order with
 * synthetic monotonically-decreasing scores in (0, 1]. Used when the
 * reranker degraded (timeout, rate-limit, transport, etc.) — input order
 * IS the rank, and the synthetic scores preserve that under any
 * downstream sort or threshold filter.
 *
 * Day-10 audit C3 reversal: an earlier draft returned `score: NaN` as a
 * sentinel. Problem: downstream threshold filters (`score > 0.3`) silently
 * drop all NaN rows, and sorts comparing NaN produce implementation-
 * defined order. Both failure modes are invisible. Synthetic scores
 * `(1 - i/n)` make the fallback ranking valid-but-uninformative under
 * any comparator, and the orchestrator branches on the boolean
 * `result.fallback === true` (authoritative) when it wants to know the
 * scores aren't real relevance signals.
 */
function passthrough(
  candidates: readonly RerankCandidate[],
  topK: number,
): RerankedResult[] {
  const n = Math.min(topK, candidates.length);
  const out: RerankedResult[] = [];
  for (let i = 0; i < n; i++) {
    // Score range (0, 1] decreasing. n=1 gives 1.0; n=k spans 1.0 down to ~1/k.
    out.push({
      id: candidates[i].id,
      score: n > 0 ? 1 - i / n : 0,
      originalIndex: i,
    });
  }
  return out;
}

function mkFallback(args: {
  reason: RerankFallbackReason;
  reranked: RerankedResult[];
  startedAt: number;
}): RerankResult {
  return {
    ok: true,
    reranked: args.reranked,
    fallback: true,
    fallbackReason: args.reason,
    modelId: VOYAGE_RERANK_MODEL,
    provider: 'voyage',
    usdPerInputToken: VOYAGE_RERANK_USD_PER_INPUT_TOKEN,
    quotedAt: VOYAGE_RERANK_QUOTED_AT,
    inputTokens: 0,
    latencyMs: Date.now() - args.startedAt,
  };
}
