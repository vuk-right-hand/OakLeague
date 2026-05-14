// query-rewrite.ts — Gemini Flash query rewriter for follow-up disambiguation.
//
// "Tell me more about that" is meaningless to a retrieval pipeline that
// embeds the literal four words. This module rewrites the user utterance
// into a standalone search query using the prior assistant turn as topic
// context. The rewritten query then becomes the basis for:
//   1. Cache lookup (hashed text → exact-match dedup; embed → similarity)
//   2. Vector + BM25 retrieval if cache miss
//
// Lookup order is rewrite → embed → cache → on miss, retrieve. Cache
// keys on the REWRITTEN query (Day-9 audit C1 — hashing the raw utterance
// causes cross-session collisions on common phrases like "tell me more").
//
// ═════════════════════════════════════════════════════════════════════
// LOAD-BEARING ORCHESTRATOR RULE — REWRITE-FALLBACK CACHE BYPASS
// (Day-8/9/10 cross-cutting audit C2; cross-linked from semantic-cache.ts)
// ═════════════════════════════════════════════════════════════════════
//   When this function returns `fallback: true`, the `rewritten` field
//   equals the RAW utterance (passthrough). Hashing it as a cache key
//   would serve cross-session collisions ("tell me more" → same hash for
//   every degraded turn against the same creator). The Day-11 orchestrator
//   MUST skip BOTH `lookupCache` AND `upsertCache` when `result.fallback
//   === true` and proceed with fresh retrieval (no cache touch). See
//   `semantic-cache.ts` header for full discussion.
// ═════════════════════════════════════════════════════════════════════
//
// POSTHOG EVENT CONTRACT (cross-cutting unit audit S2):
//   This module emits only `console.warn` on fallback paths. The Day-11
//   orchestrator MUST emit PostHog events keyed on `fallbackReason`:
//     - 'timeout' / 'transport_error'  → rag_rewrite_transport_failed
//     - 'empty_response' / 'parse_error' → rag_rewrite_model_malformed
//     - 'budget_exhausted'             → rag_rewrite_budget_exhausted
//     - 'empty_utterance'              → (no event; benign)
//   Plus the existing `rag_rewrite_no_context_post_resumption` when
//   `noContextAfterResumption=true`.
//
// COGS_LOG CONTRACT: caller writes cogs_log using returned `modelId +
// usdPerInputToken + usdPerOutputToken + inputTokens + outputTokens +
// quotedAt`. CLAUDE.md "every paid API call writes cogs_log" applies —
// orchestrator owns the write.
//
// BUDGET ALLOCATION (cross-cutting unit audit M7):
//   `deadlineMs` is the caller's overall budget. This module's hard cap
//   is REWRITE_TIMEOUT_MS_HARD_CAP=3000; fast-fails when <500ms remains.
//   The Day-11 orchestrator typically allocates ~30% of the turn budget
//   to rewrite, ~10% to embed, ~30% to rerank, leaving ~30% headroom.
//   Pin per-step ceilings in `RAG_TURN_BUDGET_*` env constants when
//   they're added.
//
// Budget contract: caller passes `deadlineMs` (absolute epoch ms). This
// module computes its own timeout = min(3000, deadlineMs - now()). If less
// than MIN_REMAINING_MS remains, fast-fail to fallback (return user
// utterance verbatim) without burning a Gemini call. Day-9 audit M4.
//
// Failure policy: this module NEVER throws. Every error path returns
// `{ rewritten: userUtterance, ... }` as a fallback so the retrieval
// pipeline always has a query to work with. CLAUDE.md "don't silently
// catch in voice connect" applies to the *brain* path; the rewriter
// is best-effort enrichment — failing it should not crash the session,
// just degrade to the raw query.

import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

// Pinned model. `gemini-2.5-flash` is the current GA alias; matches
// narrative-chunk.ts pattern. CLAUDE.md bans -latest and undated
// -preview. Override via env for swap-readiness.
export const QUERY_REWRITE_MODEL =
  process.env.QUERY_REWRITE_MODEL || 'gemini-2.5-flash';

// Boot-time guard. CLAUDE.md: banned model strings.
// Allow: dated GA (`-002`, `-001`, `-2025-04-01`, `-04-2026`, `-2025-09`)
//        or unsuffixed GA aliases (`gemini-2.5-flash`, `gemini-3.1-flash`)
//        — Google's GA alias is considered pinned-enough per
//        existing narrative-chunk.ts policy.
// Reject: `-latest`, `-preview` without a multi-digit date suffix,
//         empty string.
// Day-9-final audit M1: tightened from `\d+` to `\d{2,}-\d{2,}` so a
// single-digit fake-pinned string ("preview-9") doesn't pass.
{
  const m = QUERY_REWRITE_MODEL;
  const isLatest = /-latest$/i.test(m);
  const hasPreview = /-preview/i.test(m);
  const hasDatedPreview =
    /-preview-(?:\d{2,}-\d{4}|\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2}|\d{4}-\d{2}|\d{2}-\d{4})/i.test(m);
  const isUndatedPreview = hasPreview && !hasDatedPreview;
  if (!m || isLatest || isUndatedPreview) {
    throw new Error(`QUERY_REWRITE_MODEL invalid: ${m}. Banned: -latest, undated -preview.`);
  }
}

// Pricing pin. $0.30 / 1M input + $2.50 / 1M output for Gemini 2.5 Flash
// at the time of writing. Caller blends these into cogs_log via the
// modelId + quotedAtRate fields returned below. Override via env to
// follow rate changes.
export const QUERY_REWRITE_USD_PER_INPUT_TOKEN = Number(
  process.env.QUERY_REWRITE_USD_PER_INPUT_TOKEN || '0.0000003',
);
export const QUERY_REWRITE_USD_PER_OUTPUT_TOKEN = Number(
  process.env.QUERY_REWRITE_USD_PER_OUTPUT_TOKEN || '0.0000025',
);
export const QUERY_REWRITE_QUOTED_AT = process.env.QUERY_REWRITE_QUOTED_AT || '2026-05-14';

// Caps. lastAssistantResponse capped at 1500 chars so the rewrite prompt
// stays under ~4KB even with a max-length utterance. Per-call timeout 3s
// hard; min-remaining-budget 500ms to skip if the upstream has burned the
// budget already.
const LAST_ASSISTANT_MAX_CHARS = 1500;
const USER_UTTERANCE_MAX_CHARS = 800;
const REWRITE_TIMEOUT_MS_HARD_CAP = 3000;
const MIN_REMAINING_MS = 500;

// Heuristic for "looks like a follow-up that needs context". Used only
// to set the noContextAfterResumption flag — the rewrite still runs.
const FOLLOWUP_PATTERNS: RegExp[] = [
  /^\s*(tell|say|explain|share)\s+more/i,
  /^\s*more\s+(about|on)/i,
  /^\s*(what|how|why)\s+(about|with|of)\s+(that|this|it)/i,
  /^\s*(what|how)\s+(do|did)\s+you\s+mean/i,
  /^\s*(go|keep)\s+on/i,
  /\b(that|this|it|those|these)\s*\??\s*$/i, // ends with a pronoun (no concrete referent)
];

function isFollowUpUtterance(s: string): boolean {
  return FOLLOWUP_PATTERNS.some((re) => re.test(s));
}

const RewriteSchema = z.object({
  rewritten: z.string().min(1).max(800),
});

export type RewriteInput = {
  userUtterance: string;
  lastAssistantResponse: string | null;
  geminiApiKey: string;
  /**
   * Absolute epoch ms when the caller's overall budget expires. The
   * rewriter computes its own timeout as min(3000, deadlineMs - now()).
   * If <500ms remains, the rewriter fast-fails to fallback.
   */
  deadlineMs: number;
};

export type RewriteFallbackReason =
  | 'empty_utterance'
  | 'budget_exhausted'
  | 'transport_error'
  | 'timeout'
  | 'empty_response'
  | 'parse_error';

export type RewriteResult = {
  rewritten: string;
  noContextAfterResumption: boolean;
  /** True when the LLM call was skipped / failed and we returned the raw utterance. */
  fallback: boolean;
  /** Specific reason when fallback=true. Undefined on success. */
  fallbackReason?: RewriteFallbackReason;
  modelId: string;
  /** USD per input token. Pair with inputTokens for input-side cost. */
  usdPerInputToken: number;
  /** USD per output token. Pair with outputTokens for output-side cost. */
  usdPerOutputToken: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

// apiKey-keyed cache (Day-9-final audit C2). Map size is bounded by the
// number of distinct GEMINI_API_KEYs a single process sees — in practice
// 1 in prod, but never more than a handful in test runs.
const _clients = new Map<string, GoogleGenAI>();
function clientFor(apiKey: string): GoogleGenAI {
  const cached = _clients.get(apiKey);
  if (cached) return cached;
  const c = new GoogleGenAI({ apiKey });
  _clients.set(apiKey, c);
  return c;
}
// Test hook — reset cached clients between tests. Gated on NODE_ENV
// to prevent a stray production caller from racing a session (audit C4).
export function _resetClientForTests() {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_resetClientForTests is test-only');
  }
  _clients.clear();
}

export async function rewriteQuery(input: RewriteInput): Promise<RewriteResult> {
  const startedAt = Date.now();
  // Trim BEFORE slicing so leading whitespace doesn't burn the char cap
  // (Day-9-final small finding).
  const rawUtterance = (input.userUtterance ?? '').trim().slice(0, USER_UTTERANCE_MAX_CHARS);
  const lastAsst = (input.lastAssistantResponse ?? '').slice(-LAST_ASSISTANT_MAX_CHARS).trim();
  const followUp = isFollowUpUtterance(rawUtterance);
  const noCtx = followUp && lastAsst.length === 0;

  // Empty utterance → no-op fallback. Don't call the model.
  if (rawUtterance.length === 0) {
    return mkFallback({
      rewritten: '',
      noContextAfterResumption: noCtx,
      startedAt,
      fallbackReason: 'empty_utterance',
    });
  }

  // Budget check (M4). If less than MIN_REMAINING_MS remains, skip the call.
  const remaining = input.deadlineMs - Date.now();
  if (remaining < MIN_REMAINING_MS) {
    return mkFallback({
      rewritten: rawUtterance,
      noContextAfterResumption: noCtx,
      startedAt,
      fallbackReason: 'budget_exhausted',
    });
  }

  const callTimeout = Math.min(REWRITE_TIMEOUT_MS_HARD_CAP, remaining);

  let raw = '';
  let inputTokens = 0;
  let outputTokens = 0;
  // Hoist timer handle for the finally clearTimeout (Day-9-final audit C1).
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const c = clientFor(input.geminiApiKey);
    const prompt = buildPrompt({ utterance: rawUtterance, lastAsst });
    const flashPromise = c.models.generateContent({
      model: QUERY_REWRITE_MODEL,
      contents: prompt,
      config: {
        temperature: 0.0,
        responseMimeType: 'application/json',
      },
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`rewrite_timeout_${callTimeout}ms`)),
        callTimeout,
      );
    });
    let resp: unknown;
    try {
      resp = await Promise.race([flashPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    const obj = resp as {
      text?: string;
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
      };
    };
    raw =
      obj.text ??
      obj.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ??
      '';
    inputTokens = obj.usageMetadata?.promptTokenCount ?? 0;
    outputTokens = obj.usageMetadata?.candidatesTokenCount ?? 0;
  } catch (err) {
    // Day-9-final audit C3: log + classify. Distinguishes timeout (budget)
    // from transport (deprecated model / rotated key / quota) so PostHog
    // can alert on transport spikes.
    const msg = (err as Error)?.message ?? String(err);
    const reason: RewriteFallbackReason = msg.startsWith('rewrite_timeout_')
      ? 'timeout'
      : 'transport_error';
    // eslint-disable-next-line no-console
    console.warn(
      `[query-rewrite] ${reason} model=${QUERY_REWRITE_MODEL} budget=${callTimeout}ms: ${msg.slice(0, 200)}`,
    );
    return mkFallback({
      rewritten: rawUtterance,
      noContextAfterResumption: noCtx,
      startedAt,
      inputTokens,
      outputTokens,
      fallbackReason: reason,
    });
  }

  if (!raw || raw.trim().length === 0) {
    // eslint-disable-next-line no-console
    console.warn(`[query-rewrite] empty_response model=${QUERY_REWRITE_MODEL}`);
    return mkFallback({
      rewritten: rawUtterance,
      noContextAfterResumption: noCtx,
      startedAt,
      inputTokens,
      outputTokens,
      fallbackReason: 'empty_response',
    });
  }

  // Trim possible markdown fences (matches narrative-chunk.ts defensive pattern).
  let json = raw.trim();
  if (json.startsWith('```')) {
    json = json.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }

  let parsed: z.infer<typeof RewriteSchema>;
  try {
    parsed = RewriteSchema.parse(JSON.parse(json));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[query-rewrite] parse_error model=${QUERY_REWRITE_MODEL}: ${(err as Error)?.message ?? 'unknown'}`,
    );
    return mkFallback({
      rewritten: rawUtterance,
      noContextAfterResumption: noCtx,
      startedAt,
      inputTokens,
      outputTokens,
      fallbackReason: 'parse_error',
    });
  }

  return {
    rewritten: parsed.rewritten,
    noContextAfterResumption: noCtx,
    fallback: false,
    modelId: QUERY_REWRITE_MODEL,
    usdPerInputToken: QUERY_REWRITE_USD_PER_INPUT_TOKEN,
    usdPerOutputToken: QUERY_REWRITE_USD_PER_OUTPUT_TOKEN,
    inputTokens,
    outputTokens,
    latencyMs: Date.now() - startedAt,
  };
}

function mkFallback(args: {
  rewritten: string;
  noContextAfterResumption: boolean;
  startedAt: number;
  inputTokens?: number;
  outputTokens?: number;
  fallbackReason: RewriteFallbackReason;
}): RewriteResult {
  return {
    rewritten: args.rewritten,
    noContextAfterResumption: args.noContextAfterResumption,
    fallback: true,
    fallbackReason: args.fallbackReason,
    modelId: QUERY_REWRITE_MODEL,
    usdPerInputToken: QUERY_REWRITE_USD_PER_INPUT_TOKEN,
    usdPerOutputToken: QUERY_REWRITE_USD_PER_OUTPUT_TOKEN,
    inputTokens: args.inputTokens ?? 0,
    outputTokens: args.outputTokens ?? 0,
    latencyMs: Date.now() - args.startedAt,
  };
}

function buildPrompt(args: { utterance: string; lastAsst: string }): string {
  // Single user-content prompt; the model returns JSON directly per
  // responseMimeType. The instruction is intentionally short — Gemini
  // 2.5 Flash on temperature 0 produces deterministic enough JSON for
  // a one-field schema.
  return [
    'You rewrite a user utterance into a standalone search query for a knowledge-retrieval system.',
    'If the utterance references the prior assistant turn ("tell me more", "what about that"), expand it using the topic of the prior turn.',
    'Otherwise return the utterance unchanged, possibly tightened.',
    'Return exactly: {"rewritten":"<query>"}. No prose. Keep <100 words.',
    '',
    'Prior assistant turn:',
    args.lastAsst.length > 0 ? args.lastAsst : '(none — start of conversation or post-resumption)',
    '',
    'User utterance:',
    args.utterance,
  ].join('\n');
}
