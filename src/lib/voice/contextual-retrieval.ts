// contextual-retrieval.ts — Anthropic Contextual Retrieval per-chunk context
// generation, with 1-hour-TTL prompt caching on the document prefix.
//
// Implements the canonical Anthropic Contextual Retrieval pattern
// (https://www.anthropic.com/news/contextual-retrieval, Sept 2024). For each
// child chunk, we ask Haiku 4.5 to write a 50-100 token "where does this
// chunk fit in the overall document" context, which is then concatenated to
// the chunk text before embedding. Anthropic's published evals show this
// reduces top-20 retrieval failure rate by ~49%.
//
// Architecture (per RAG SOTA plan §10 + audit-3 M5):
//   * Anthropic SDK lives in Next 15 TS-native context (this module).
//   * Fly's embed-worker.js POSTs { doc, chunk_text } to the Next route
//     `/api/internal/contextual-gen`; the route calls this module.
//   * Rationale: 2026-05-09 `.ts` import bug on Fly's bundler made putting
//     the Anthropic SDK behind a Fly worker too fragile. One Vercel hop
//     (~50ms) is the cost of staying in a runtime that can import the SDK
//     cleanly.
//
// PROMPT CACHING:
//   The document portion of the system block carries
//   `cache_control: { type: 'ephemeral', ttl: '1h' }`. Anthropic auto-keys
//   the cache by prefix bytes. As long as the worker sends the same `doc`
//   string for every chunk of the same sample within 1 hour:
//     * First chunk: cache write (2x base input cost on cached tokens).
//     * Subsequent chunks: cache read (0.1x base input cost on cached tokens).
//   Net savings on a 1000-chunk sample with a 125K-token doc: ~90% on doc
//   token spend. The plan's §13 cost model assumes this.
//
//   1-hour TTL was chosen so a single worker run (~5-10 min per creator)
//   stays cached even with retries. 5-minute TTL would expire mid-run on
//   pathological retry loops.
//
// SAFETY:
//   * Caller MUST pass already-sanitized doc + chunk. We do NOT re-sanitize
//     INPUT here — the worker pre-sanitizes via preprocessRawText(). We DO
//     re-sanitize OUTPUT (Haiku is untrusted; the generated context is
//     stored in sample_content_chunks.chunk_context and rides into the
//     Gemini Live brain prompt at retrieval time).
//   * Hard char caps on inputs prevent runaway tokens / cost. Day-3
//     integration-audit M1 also flagged token_count ceiling on CJK-heavy
//     content — the worker (Day 5) clamps on INSERT.
//   * Model selection goes through anthropic-client.ts's Haiku-only guard.
//
// ERROR TAXONOMY:
//   ContextualRetrievalError with const-union codes — mapped from SDK
//   errors at this boundary so callers see our taxonomy, not Anthropic's
//   (CLAUDE.md provider-agnostic rule #3).

import 'server-only';
import {
  APIError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { anthropicClient, anthropicModel } from './anthropic-client';
import { sanitizeForLLMPrompt } from './preprocess';

// Input caps. Generous enough to handle a full-talk transcript as `doc`
// but small enough to bound prompt size + cost.
//
// 800K chars ≈ 200K tokens for English. Anthropic Haiku 4.5 has a 200K
// context window; a 200K-token doc + chunk + instructions would blow it.
// Cap at 400K chars (~100K tokens) so we always have headroom.
export const MAX_DOC_CHARS = 400_000;
// Match `sample_content_narrative_units.text` CHECK (8000) — caller's
// largest legitimate chunk is one full parent unit.
export const MAX_CHUNK_CHARS = 8_000;

// Output cap. Anthropic's prompt asks for 50-100 tokens; 200 is comfortable
// headroom. We clip at 800 chars post-sanitize before storage to match
// `sample_content_chunks.chunk_context` CHECK (≤2000 chars, but we want
// short — the whole point is a TIGHT context, not a paraphrase).
export const MAX_CONTEXT_OUTPUT_TOKENS = 200;
export const MAX_CONTEXT_OUTPUT_CHARS = 800;

// Per-call wall-clock ceiling. Haiku 4.5 p50 on contextual-gen is ~600ms
// per chunk; p99 is well under 10s. 30s catches genuinely stuck calls and
// returns the worker its budget.
const HAIKU_CALL_TIMEOUT_MS = Number(
  process.env.CONTEXTUAL_GEN_TIMEOUT_MS || '30000',
);


// ── Errors ────────────────────────────────────────────────────────────────

export class ContextualRetrievalError extends Error {
  readonly code:
    | 'input_too_large'
    | 'empty_input'
    | 'rate_limit'
    | 'auth_error'
    | 'anthropic_error'
    | 'timeout'
    | 'invalid_response';
  readonly status?: number;
  /** Anthropic Retry-After header (parsed to ms) on 429. Day-4-audit M6. */
  readonly retryAfterMs?: number;
  /** Anthropic request id for cross-hop log correlation. Day-4-audit M9. */
  readonly requestId?: string | null;
  /**
   * Whether the worker should retry. Day-4-audit C2: terminal errors must
   * be distinguishable from transient ones at the boundary, otherwise the
   * worker retry-storms against permanently-broken upstream state.
   */
  readonly retryable: boolean;
  constructor(
    code: ContextualRetrievalError['code'],
    msg?: string,
    status?: number,
    extras?: { retryAfterMs?: number; requestId?: string | null },
  ) {
    super(msg ?? code);
    this.name = 'ContextualRetrievalError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = extras?.retryAfterMs;
    this.requestId = extras?.requestId;
    // Default retry policy: input_too_large/empty_input/auth_error are
    // caller-bug or terminal-upstream-state → not retryable. Everything
    // else (rate_limit, timeout, anthropic_error 5xx, invalid_response) is
    // worth at least one retry from the worker.
    this.retryable =
      code !== 'input_too_large' &&
      code !== 'empty_input' &&
      code !== 'auth_error';
  }
}


// ── Public types ──────────────────────────────────────────────────────────

export type GenerateChunkContextArgs = {
  /** Pre-sanitized document text. Caller MUST run through preprocessRawText. */
  sanitizedDoc: string;
  /** Pre-sanitized chunk text. */
  sanitizedChunk: string;
  /** Optional title for richer in-prompt orientation. Sanitized by caller. */
  sampleTitle?: string;
};

export type ChunkContextUsage = {
  /** Tokens written to the 1h-TTL cache (first call for this doc). */
  cache_creation_1h_input_tokens: number;
  /** Tokens read from the 1h-TTL cache (subsequent calls within TTL). */
  cache_read_input_tokens: number;
  /** Uncached input tokens (chunk + instruction + any cache misses). */
  uncached_input_tokens: number;
  /** Output tokens (the generated context). */
  output_tokens: number;
};

export type GenerateChunkContextResult = {
  /** Sanitized 50-100 token context, ready to concatenate to chunk text. */
  chunkContext: string;
  /** Per-token usage for COGS accounting (caller writes to cogs_log). */
  usage: ChunkContextUsage;
  /** Wall-clock ms of the Haiku call. */
  ms: number;
  /**
   * Haiku stop reason: `'end_turn'` (clean stop), `'max_tokens'` (truncated),
   * or null/undefined for older SDK shapes. Day-4-audit M7: callers should
   * count `max_tokens` occurrences to detect when our MAX_CONTEXT_OUTPUT_TOKENS
   * cap is too tight.
   */
  stopReason?: string | null;
  /** Anthropic request id for cross-hop log correlation. Day-4-audit M9. */
  requestId?: string | null;
};


// ── Prompt construction ──────────────────────────────────────────────────
//
// Anthropic's canonical Contextual Retrieval prompt from the cookbook
// (https://github.com/anthropics/anthropic-cookbook/blob/main/skills/
// contextual-embeddings/). Two separable pieces:
//
//   1. The CACHED system block: `<document>...</document>`. Same bytes for
//      every chunk of the same sample → cache hit after first call.
//   2. The PER-CHUNK user message: chunk text + the "give a succinct
//      context" instruction. Not cached.
//
// The exact instruction wording is the published Anthropic phrasing —
// don't paraphrase. Re-runs against the cookbook eval datasets only hold
// if the prompt is byte-identical.

function buildSystemDocBlock(args: { sanitizedDoc: string }) {
  // Day-4-audit C4 fix: title is NO LONGER in the cached block. Previously
  // we concatenated `Title: ${sampleTitle}` INTO the system block. Worker
  // bug (omitting title for some chunks of the same sample, DB-returned
  // title with trailing whitespace, etc.) would break byte-identical prefix
  // and miss the 1-hour cache — at our scale that's a ~$50 surprise per
  // affected sample. Title now lives in the per-call user message so it
  // can vary safely. The cookbook prompt doesn't include a title anyway —
  // we were over-engineering.
  return `<document>\n${args.sanitizedDoc}\n</document>`;
}

function buildUserChunkBlock(args: { sanitizedChunk: string; sampleTitle?: string }) {
  // Verbatim from the Anthropic Contextual Retrieval cookbook for the
  // chunk + instruction portion. Title is prepended only when provided and
  // lives OUTSIDE the cached prefix (Day-4-audit C4).
  const titlePrefix = args.sampleTitle
    ? `Document title: ${args.sampleTitle}\n\n`
    : '';
  return `${titlePrefix}Here is the chunk we want to situate within the whole document\n<chunk>\n${args.sanitizedChunk}\n</chunk>\nPlease give a short succinct context to situate this chunk within the overall document for the purposes of improving search retrieval of the chunk. Answer only with the succinct context and nothing else.`;
}


// ── Internal: extract text from a messages.create response ───────────────

function extractText(response: { content: Array<{ type: string; text?: string }> }): string {
  // Haiku responses are text-only here (no tool use); content is an array
  // of blocks where the relevant ones have `type: 'text'`. Concatenate
  // defensively in case the model emits multiple blocks.
  let out = '';
  for (const block of response.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      out += block.text;
    }
  }
  return out;
}


// ── Public API ────────────────────────────────────────────────────────────

/**
 * Generates a 50-100 token "where does this chunk fit" context string via
 * Haiku 4.5 with 1-hour-TTL prompt caching on the document prefix. Returns
 * the sanitized output + per-call usage for COGS accounting.
 *
 * The caller is the Next 15 internal API route handler. The Fly worker
 * never touches this module directly — see route file for the network
 * boundary.
 */
export async function generateChunkContext(
  args: GenerateChunkContextArgs,
): Promise<GenerateChunkContextResult> {
  // Input validation. We do not retry on these — they're caller bugs.
  if (!args.sanitizedDoc || args.sanitizedDoc.trim().length === 0) {
    throw new ContextualRetrievalError('empty_input', 'sanitizedDoc is empty');
  }
  if (!args.sanitizedChunk || args.sanitizedChunk.trim().length === 0) {
    throw new ContextualRetrievalError('empty_input', 'sanitizedChunk is empty');
  }
  if (args.sanitizedDoc.length > MAX_DOC_CHARS) {
    throw new ContextualRetrievalError(
      'input_too_large',
      `sanitizedDoc ${args.sanitizedDoc.length} chars > MAX_DOC_CHARS ${MAX_DOC_CHARS}`,
    );
  }
  if (args.sanitizedChunk.length > MAX_CHUNK_CHARS) {
    throw new ContextualRetrievalError(
      'input_too_large',
      `sanitizedChunk ${args.sanitizedChunk.length} chars > MAX_CHUNK_CHARS ${MAX_CHUNK_CHARS}`,
    );
  }

  // Construct client OUTSIDE the try/catch so model-not-haiku / api_key_missing
  // AnthropicConfigError propagates as itself, not wrapped into anthropic_error.
  // Same pattern as narrative-chunk's client() lift.
  const c = anthropicClient();
  const model = anthropicModel();

  // Day-4-audit C1 fix: AbortController + setTimeout that calls
  // `controller.abort()`. Replaces the previous Promise.race that ignored
  // the in-flight Anthropic call on timeout (which kept billing tokens AND
  // leaked the setTimeout closure on the success path). Now: abort signal
  // propagates to the SDK, the HTTPS connection is severed, the Anthropic
  // server-side request is cancelled (Anthropic honors client-disconnect),
  // and we always clearTimeout to free the timer regardless of outcome.
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    HAIKU_CALL_TIMEOUT_MS,
  );

  const t0 = Date.now();
  let response: Awaited<ReturnType<typeof c.messages.create>>;
  try {
    response = await c.messages.create(
      {
        model,
        max_tokens: MAX_CONTEXT_OUTPUT_TOKENS,
        // Day-4-audit M11: temperature 0 makes RETRIES emit identical
        // chunk_context bytes (cheap correctness property for the worker's
        // retry-once-on-invalid-response path) — it does NOT influence the
        // 1-hour cache, which keys off INPUT prefix bytes. Keeping the
        // value but correcting the rationale comment.
        temperature: 0,
        // System block carries the doc with 1-hour TTL cache_control. SDK
        // 0.95.2 supports `ttl: '1h'` first-class (no beta header needed).
        // Title is NO LONGER concatenated here — Day-4-audit C4 moved it
        // to the user message so worker title-drift can't 20× cost.
        system: [
          {
            type: 'text',
            text: buildSystemDocBlock({ sanitizedDoc: args.sanitizedDoc }),
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: buildUserChunkBlock({
              sanitizedChunk: args.sanitizedChunk,
              sampleTitle: args.sampleTitle,
            }),
          },
        ],
      },
      { signal: controller.signal },
    );
  } catch (e) {
    // Map SDK errors to our taxonomy.
    //   APIUserAbortError    → our timeout (we aborted on the setTimeout).
    //   RateLimitError (429) → 'rate_limit' + Retry-After parsed to ms.
    //   AuthenticationError (401) / PermissionDeniedError (403) → 'auth_error'.
    //   Other APIError       → 'anthropic_error' + status.
    //   APIConnectionError / network / other → 'anthropic_error' (no status).
    if (e instanceof ContextualRetrievalError) {
      // Defensive — shouldn't normally happen here, but rethrow as-is.
      throw e;
    }
    if (e instanceof APIUserAbortError) {
      throw new ContextualRetrievalError(
        'timeout',
        `haiku_timeout_${HAIKU_CALL_TIMEOUT_MS}ms`,
      );
    }
    if (e instanceof RateLimitError) {
      // Day-4-audit M6: parse Retry-After. The header may be either a
      // delta-seconds integer or an HTTP-date. Anthropic emits seconds.
      const headers = (e as RateLimitError).headers;
      const retryHeader = headers?.get?.('retry-after');
      let retryAfterMs: number | undefined;
      if (retryHeader) {
        const asNum = Number(retryHeader);
        if (Number.isFinite(asNum) && asNum >= 0) {
          retryAfterMs = Math.floor(asNum * 1000);
        }
      }
      throw new ContextualRetrievalError(
        'rate_limit',
        e.message ?? 'rate_limit',
        429,
        {
          retryAfterMs,
          requestId: (e as RateLimitError).requestID ?? null,
        },
      );
    }
    if (e instanceof AuthenticationError || e instanceof PermissionDeniedError) {
      throw new ContextualRetrievalError(
        'auth_error',
        e.message ?? 'auth_error',
        e.status,
        { requestId: e.requestID ?? null },
      );
    }
    if (e instanceof APIError) {
      throw new ContextualRetrievalError(
        'anthropic_error',
        e.message ?? 'anthropic_error',
        e.status,
        { requestId: e.requestID ?? null },
      );
    }
    // Unknown shape (e.g., dependency error before SDK normalization).
    const fallback = e as { status?: number; message?: string };
    throw new ContextualRetrievalError(
      'anthropic_error',
      fallback.message ?? 'anthropic_error',
      fallback.status,
    );
  } finally {
    // Day-4-audit C1 leak fix: always clear the timeout. Without this, a
    // successful call leaves a 30s timer alive holding a closure into the
    // event loop — fine for a single call, accumulates measurably during
    // the 5-10 min worker burst per creator.
    clearTimeout(timeoutHandle);
  }

  // Extract text. Empty or whitespace-only → invalid_response (do not retry
  // here; caller decides whether to retry the whole chunk or store NULL
  // context and let the embedding-on-chunk-only path handle it per plan §8).
  const raw = extractText(response).trim();
  if (!raw) {
    throw new ContextualRetrievalError(
      'invalid_response',
      'haiku returned empty content',
    );
  }

  // Re-sanitize output. Haiku is untrusted — the generated context is
  // stored AND injected into the Gemini Live brain prompt at retrieval time.
  // Same defense-in-depth as the Day-3 C3 fix on narrative-chunk.
  const sanitized = sanitizeForLLMPrompt(raw).slice(0, MAX_CONTEXT_OUTPUT_CHARS);
  if (!sanitized || sanitized.trim().length === 0) {
    // Edge case: Haiku emitted pure envelope/control noise. Sanitizer left
    // an empty string. Treat as invalid_response — caller can retry the
    // chunk or store NULL.
    throw new ContextualRetrievalError(
      'invalid_response',
      'haiku output was empty after sanitization',
    );
  }

  // Extract usage. SDK shape (verified at install: v0.95.2):
  //   usage.cache_creation.ephemeral_1h_input_tokens — cache write at 1h TTL
  //   usage.cache_creation.ephemeral_5m_input_tokens — cache write at 5m TTL
  //   usage.cache_read_input_tokens — cache hit
  //   usage.input_tokens             — uncached input
  //   usage.output_tokens            — output
  // Defensive defaults of 0 if SDK shape drifts.
  type CacheCreation = {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
  const u = (response as unknown as {
    usage?: {
      cache_creation?: CacheCreation | null;
      cache_read_input_tokens?: number | null;
      input_tokens?: number;
      output_tokens?: number;
    };
  }).usage ?? {};
  const usage: ChunkContextUsage = {
    cache_creation_1h_input_tokens:
      u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    uncached_input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
  };

  // Day-4-audit M7: surface stop_reason so the caller (Day-5 worker) can
  // counter `max_tokens` truncations — that signal lets us know when our
  // MAX_CONTEXT_OUTPUT_TOKENS cap is too tight in practice. We log here
  // (Sentry + future PostHog) and also forward in the result so route-level
  // observability has the field.
  const stopReason = (response as { stop_reason?: string | null }).stop_reason ?? null;
  if (stopReason === 'max_tokens') {
    // Single counter line — keeps Sentry breadcrumbs useful without flooding.
    console.warn(
      '[contextual-retrieval] stop_reason=max_tokens — output truncated at MAX_CONTEXT_OUTPUT_TOKENS',
      MAX_CONTEXT_OUTPUT_TOKENS,
    );
  }

  // Day-4-audit M9: include the Anthropic request id in the result so the
  // route can stitch logs across (worker → route → Anthropic).
  const requestId =
    (response as { _request_id?: string | null })._request_id ??
    (response as { id?: string | null }).id ??
    null;

  return {
    chunkContext: sanitized,
    usage,
    ms: Date.now() - t0,
    stopReason,
    requestId,
  };
}
