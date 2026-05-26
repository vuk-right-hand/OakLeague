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
//   `deadlineMs` is the caller's overall budget. This module's hard cap is
//   REWRITE_TIMEOUT_MS_HARD_CAP (default 2200 since 2026-05-23; env
//   QUERY_REWRITE_TIMEOUT_MS, clamped ≤ 3000); fast-fails when <500ms remains.
//   The orchestrator runs inside the proxy's DECOUPLED_RETRIEVE_BUDGET_MS
//   (default 3500): ~2200 rewrite + ~350 embed + ~160 topk + ~600 rerank.
//   Pin per-step ceilings in `RAG_TURN_BUDGET_*` env constants when
//   they're added.
//
// Budget contract: caller passes `deadlineMs` (absolute epoch ms). This
// module computes its own timeout = min(REWRITE_TIMEOUT_MS_HARD_CAP,
// deadlineMs - now()). If less than MIN_REMAINING_MS remains, fast-fail to
// fallback (return user utterance verbatim) without burning a Gemini call.
// Day-9 audit M4.
//
// Failure policy: this module NEVER throws. Every error path returns
// `{ rewritten: userUtterance, ... }` as a fallback so the retrieval
// pipeline always has a query to work with. CLAUDE.md "don't silently
// catch in voice connect" applies to the *brain* path; the rewriter
// is best-effort enrichment — failing it should not crash the session,
// just degrade to the raw query.

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
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
// 2026-05-21 (audit M2): set to 1800. History: 3000 (let a slow rewrite eat
// the whole retrieval budget → 504, zero parents, session 69b43a47) → 1200
// (knee-jerk too tight). MEASURED healthy rewrite latencies in prod were
// 622 / 827 / 1116 / 1169ms — a 1200ms cap left only 31–84ms of headroom on
// the slow-but-VALID ones, and a clipped rewrite falls back to the raw
// utterance which ALSO skips the cache and embeds literal "tell me more about
// that" → poisoned retrieval. The rewrite is load-bearing follow-up
// disambiguation, NOT optional, so we must not clip healthy ones. With the C1
// fix the pipeline budget is now 3000ms (not the broken 2500), so 1800ms
// rewrite + ~300 embed + ~250 topk + ~500 rerank still fits. Re-derive if the
// budget changes again.
//
// 2026-05-23 (Vuk): default raised 1800→2200 in tandem with the proxy's
// retrieve budget (3000→3500) + ceiling (3500→4000). 2200 rewrite + ~350 embed
// + ~160 topk + ~600 rerank ≈ 3310ms fits the 3500 budget. Env-overridable
// (QUERY_REWRITE_TIMEOUT_MS) so we can re-tune after the live test without a
// redeploy; boot-fatal on a malformed value (NaN → every rewrite instantly
// fails the deadline → permanently degraded). MUST stay ≤ the proxy budget.
// Hard upper bound (audit C2): the rewrite must NEVER be allowed to eat the
// whole proxy retrieve budget. The proxy's DECOUPLED_RETRIEVE_BUDGET_MS default
// is 3500 and embed+topk+rerank need ~1100ms, so a rewrite cap above ~2500 would
// starve the rest of the pipeline → guaranteed deadline_exceeded → 504 →
// persona-only on every cache-miss turn. We clamp to an absolute 3000 ceiling
// (boot-throw above it) since the two values live in different deploy units
// (this cap on Vercel, the budget on Fly) and no single process can assert
// `cap + downstream ≤ budget`. The boot log below makes the effective cap
// greppable in Vercel logs so a proxy/Vercel skew is visible, not silent.
const REWRITE_TIMEOUT_MS_ABS_MAX = 3000;
const REWRITE_TIMEOUT_MS_HARD_CAP = (() => {
  const raw = process.env.QUERY_REWRITE_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === '') return 2200;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`QUERY_REWRITE_TIMEOUT_MS must be a positive finite number; got '${raw}'`);
  }
  if (n > REWRITE_TIMEOUT_MS_ABS_MAX) {
    throw new Error(
      `QUERY_REWRITE_TIMEOUT_MS (${n}) exceeds the ${REWRITE_TIMEOUT_MS_ABS_MAX}ms ceiling — ` +
      `a rewrite this slow starves embed/topk/rerank inside the proxy retrieve budget. ` +
      `Raise DECOUPLED_RETRIEVE_BUDGET_MS deliberately and re-derive before lifting this.`,
    );
  }
  return Math.floor(n);
})();
const MIN_REMAINING_MS = 500;

// Boot telemetry (audit C2) — one greppable line so a Fly/Vercel deploy skew
// (proxy budget raised, Vercel still on the old rewrite cap) is visible. Skipped
// in test to keep vitest output clean.
if (process.env.NODE_ENV !== 'test') {
  // eslint-disable-next-line no-console
  console.log(`[query-rewrite] boot effective_rewrite_cap_ms=${REWRITE_TIMEOUT_MS_HARD_CAP} (default 2200, env QUERY_REWRITE_TIMEOUT_MS)`);
}

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
   * rewriter computes its own timeout as min(REWRITE_TIMEOUT_MS_HARD_CAP,
   * deadlineMs - now()). If <500ms remains, the rewriter fast-fails to fallback.
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
    // Disable thinking — query rewrite is a trivial JSON-shaping task; thinking
    // adds 1-2s of latency before the first token (the silent default-on
    // behavior of gemini-2.5-flash) and was the direct cause of the rewrite
    // timing out + 504-ing retrieval. Family-aware shape mirrors
    // brain-llm-common.js#thinkingConfigFor (2.5: thinkingBudget, 3.x: level).
    const isV3 = /^gemini-3(\.|-)/i.test(QUERY_REWRITE_MODEL);
    // SDK-canonical enum for generateContent (serializes to "MINIMAL", uppercase).
    // Same LOGICAL level as the JS proxy mirror brain-llm-common.js#thinkingConfigFor,
    // but DIFFERENT WIRE CASING — the proxy sends lowercase 'minimal'. Inert today
    // (default model is gemini-2.5-flash → isV3=false → thinkingBudget:0 path). Before
    // any gemini-3.x model is pinned here, the v3 enable gate (P1-9) MUST verify which
    // casing the pinned model actually honors so the two paths don't silently diverge.
    const thinkingConfig = isV3
      ? { thinkingLevel: ThinkingLevel.MINIMAL }
      : { thinkingBudget: 0 };
    const flashPromise = c.models.generateContent({
      model: QUERY_REWRITE_MODEL,
      contents: prompt,
      config: {
        temperature: 0.0,
        responseMimeType: 'application/json',
        thinkingConfig,
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
