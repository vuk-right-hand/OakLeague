// rag-telemetry.ts — per-turn telemetry aggregator for the RAG v2 pipeline.
//
// PURPOSE (cross-cutting unit-audit M2)
//   The retrieve-knowledge.ts orchestrator composes up to 4 paid-API legs:
//     1. Query rewrite (Gemini Flash) — every turn
//     2. Embed (Gemini embedding) — only on cache miss
//     3. Retrieval RPC (no cost; timing + score signals)
//     4. Rerank (Voyage) — only on cache miss + retrieval returned parents
//   Plus 1 free-call leg: semantic cache lookup + upsert.
//
//   CLAUDE.md says "every paid API call writes cogs_log." Without an
//   aggregator type, the Day-11 orchestrator has to remember to write 3
//   cogs_log rows in 3 different shapes (rewrite has input+output tokens;
//   rerank has input tokens only; embed has input tokens only) — easy to
//   forget one. This module owns the canonical shape.
//
// CONTRACT
//   - Each leg is filled in by the orchestrator as it runs.
//   - At end-of-turn, `toCogsLogRows()` emits the correct number of
//     cogs_log rows (skipping legs that didn't run).
//   - `toPostHogEventBatch()` emits the canonical event set keyed on
//     fallback reasons + cache hit/miss + envelope oversize.
//   - The aggregator is the ONLY place these mappings live — adding a
//     new leg (e.g., contextual-gen for v3) means adding a field here
//     and updating both emitters in one place.
//
// SERVER-ONLY: writes service-role cogs_log rows. Never import from a
// client component.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

// ───────────────────────────────────────────────────────────────────────
// Leg-level shapes — match the return shapes of each Day-9/10 module
// ───────────────────────────────────────────────────────────────────────

export type RewriteLeg = {
  modelId: string;
  fallback: boolean;
  fallbackReason?: string;
  inputTokens: number;
  outputTokens: number;
  usdPerInputToken: number;
  usdPerOutputToken: number;
  quotedAt: string;
  latencyMs: number;
};

export type EmbedLeg = {
  modelId: string;
  inputTokens: number;
  usdPerInputToken: number;
  quotedAt: string;
  latencyMs: number;
};

export type RetrieveLeg = {
  // Hybrid RPC has no $ cost (pure DB) but we still record signals.
  parentsReturned: number;
  /** Highest vector-only score before RRF fusion. NULL when no rows. */
  vectorTop1Score: number | null;
  /** Highest BM25 score before RRF fusion. NULL when no rows. */
  bm25Top1Score: number | null;
  /** Highest RRF score after fusion. NULL when no rows. */
  rrfTop1Score: number | null;
  latencyMs: number;
};

export type RerankLeg = {
  provider: string;
  modelId: string;
  fallback: boolean;
  fallbackReason?: string;
  /** Top-1 rerank score. NULL on fallback (rerank didn't run). */
  rerankTop1Score: number | null;
  inputTokens: number;
  usdPerInputToken: number;
  quotedAt: string;
  latencyMs: number;
};

export type EnvelopeLeg = {
  passageCount: number;
  encodedBytes: number;
  oversize: boolean;
  droppedPassages: number;
  truncatedPassageCount: number;
};

// ───────────────────────────────────────────────────────────────────────
// Aggregate
// ───────────────────────────────────────────────────────────────────────

export type RagTurnTelemetry = {
  // Per-turn identifiers — required at construction.
  userId: string;
  sessionId: string | null;
  creatorId: string;
  retrievalVersion: 1 | 2;
  corpusVersionAtSession: number;

  // Cache result (set by the orchestrator BEFORE any other leg).
  cacheHit: boolean;
  cacheStaleCorpus: boolean; // upsert rejected on stale-version
  cacheAgeSeconds: number | null;

  // Per-leg shapes. NULL when the leg didn't run.
  rewrite: RewriteLeg | null;
  embed: EmbedLeg | null;
  retrieve: RetrieveLeg | null;
  rerank: RerankLeg | null;
  envelope: EnvelopeLeg | null;

  // Overall.
  totalLatencyMs: number;
  budgetExceeded: boolean;
};

/** Construct an empty telemetry shell — fill in legs as the orchestrator runs. */
export function newTurnTelemetry(args: {
  userId: string;
  sessionId: string | null;
  creatorId: string;
  retrievalVersion: 1 | 2;
  corpusVersionAtSession: number;
}): RagTurnTelemetry {
  return {
    userId: args.userId,
    sessionId: args.sessionId,
    creatorId: args.creatorId,
    retrievalVersion: args.retrievalVersion,
    corpusVersionAtSession: args.corpusVersionAtSession,
    cacheHit: false,
    cacheStaleCorpus: false,
    cacheAgeSeconds: null,
    rewrite: null,
    embed: null,
    retrieve: null,
    rerank: null,
    envelope: null,
    totalLatencyMs: 0,
    budgetExceeded: false,
  };
}

// ───────────────────────────────────────────────────────────────────────
// cogs_log emitters — one row per paid leg
// ───────────────────────────────────────────────────────────────────────

export type CogsLogRow = {
  user_id: string;
  session_id: string | null;
  service: 'gemini' | 'voyage';
  operation: 'rewrite' | 'embedding' | 'rerank';
  units: number; // tokens
  unit_label: 'tokens';
  cost_usd: number;
  metadata: Record<string, unknown>;
};

/**
 * Emit one cogs_log row per leg that actually ran with paid cost.
 * Caller is the orchestrator; this function does NOT write to the DB
 * directly — the orchestrator passes the rows to `flushCogsLogRows()`.
 *
 * Skipping unrun legs is what makes the aggregator robust to "we forgot
 * a cogs_log call" — if `rewrite` is null we just don't emit a row.
 * Symmetric: forgetting to FILL IN a leg means the row is missing, which
 * is the correct outcome (no API call, no cost).
 */
export function toCogsLogRows(t: RagTurnTelemetry): CogsLogRow[] {
  const rows: CogsLogRow[] = [];

  if (t.rewrite && (t.rewrite.inputTokens > 0 || t.rewrite.outputTokens > 0)) {
    const cost =
      t.rewrite.inputTokens * t.rewrite.usdPerInputToken +
      t.rewrite.outputTokens * t.rewrite.usdPerOutputToken;
    rows.push({
      user_id: t.userId,
      session_id: t.sessionId,
      service: 'gemini',
      operation: 'rewrite',
      units: t.rewrite.inputTokens + t.rewrite.outputTokens,
      unit_label: 'tokens',
      cost_usd: round6(cost),
      metadata: {
        model: t.rewrite.modelId,
        creator_id: t.creatorId,
        retrieval_version: t.retrievalVersion,
        corpus_version_at_session: t.corpusVersionAtSession,
        input_tokens: t.rewrite.inputTokens,
        output_tokens: t.rewrite.outputTokens,
        rewrite_ms: t.rewrite.latencyMs,
        rewrite_fallback: t.rewrite.fallback,
        rewrite_fallback_reason: t.rewrite.fallbackReason ?? null,
        quoted_at: t.rewrite.quotedAt,
      },
    });
  }

  if (t.embed && t.embed.inputTokens > 0) {
    rows.push({
      user_id: t.userId,
      session_id: t.sessionId,
      service: 'gemini',
      operation: 'embedding',
      units: t.embed.inputTokens,
      unit_label: 'tokens',
      cost_usd: round6(t.embed.inputTokens * t.embed.usdPerInputToken),
      metadata: {
        model: t.embed.modelId,
        creator_id: t.creatorId,
        retrieval_version: t.retrievalVersion,
        corpus_version_at_session: t.corpusVersionAtSession,
        embed_ms: t.embed.latencyMs,
        quoted_at: t.embed.quotedAt,
      },
    });
  }

  // Rerank row emission:
  //   - inputTokens > 0:  normal paid call → emit row with units + cost
  //   - inputTokens == 0 AND fallback == true:  rerank degraded BEFORE
  //     touching the provider (rate_limit, budget_exhausted, etc.) →
  //     do NOT emit (no cost incurred)
  //   - inputTokens == 0 AND fallback == false:  successful rerank that
  //     didn't surface usage.total_tokens (Voyage response-shape drift,
  //     Day-11 audit M6) → emit row with units=0 + metadata flag so ops
  //     can spot the drift and update the parser
  if (t.rerank) {
    if (t.rerank.inputTokens > 0) {
      rows.push({
        user_id: t.userId,
        session_id: t.sessionId,
        service: 'voyage',
        operation: 'rerank',
        units: t.rerank.inputTokens,
        unit_label: 'tokens',
        cost_usd: round6(t.rerank.inputTokens * t.rerank.usdPerInputToken),
        metadata: {
          model: t.rerank.modelId,
          provider: t.rerank.provider,
          creator_id: t.creatorId,
          retrieval_version: t.retrievalVersion,
          corpus_version_at_session: t.corpusVersionAtSession,
          rerank_ms: t.rerank.latencyMs,
          rerank_fallback: t.rerank.fallback,
          rerank_fallback_reason: t.rerank.fallbackReason ?? null,
          rerank_top1_score: t.rerank.rerankTop1Score,
          quoted_at: t.rerank.quotedAt,
        },
      });
    } else if (!t.rerank.fallback) {
      // Day-11 audit M6: zero tokens on a successful call = response-shape
      // drift. Emit a marker row so cogs_log accounting captures the
      // OPERATION even if the cost is unknown.
      rows.push({
        user_id: t.userId,
        session_id: t.sessionId,
        service: 'voyage',
        operation: 'rerank',
        units: 0,
        unit_label: 'tokens',
        cost_usd: 0,
        metadata: {
          model: t.rerank.modelId,
          provider: t.rerank.provider,
          creator_id: t.creatorId,
          retrieval_version: t.retrievalVersion,
          corpus_version_at_session: t.corpusVersionAtSession,
          rerank_ms: t.rerank.latencyMs,
          rerank_fallback: false,
          rerank_top1_score: t.rerank.rerankTop1Score,
          quoted_at: t.rerank.quotedAt,
          token_count_unavailable: true, // ops flag: parser drift or provider change
        },
      });
    }
  }

  return rows;
}

/**
 * Best-effort cogs_log writer. Fire-and-forget — failing one row should
 * not block the user turn. Each failed row is console.warn'd (same
 * pattern as retrieve-knowledge.ts:cogs_log insert).
 *
 * Day-11 audit note: orchestrator typically calls this WITHOUT awaiting
 * so the user response isn't gated on the cogs_log insert latency.
 */
export async function flushCogsLogRows(
  admin: SupabaseClient,
  rows: readonly CogsLogRow[],
): Promise<void> {
  if (rows.length === 0) return;
  // Batch insert — one round-trip for all rows. supabase-js handles the
  // array shape natively.
  const { error } = await admin.from('cogs_log').insert(rows as CogsLogRow[]);
  if (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[rag-telemetry] cogs_log batch insert failed (${rows.length} rows): ${error.message}`,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────
// PostHog event taxonomy
// ───────────────────────────────────────────────────────────────────────
//
// Returned as a plain array of { name, properties } objects so the
// orchestrator can iterate and call its own PostHog client (which may
// be server-side, proxy-side, or queued — the aggregator stays
// transport-agnostic).

export type PostHogEvent = {
  name: string;
  properties: Record<string, unknown>;
};

export function toPostHogEventBatch(t: RagTurnTelemetry): PostHogEvent[] {
  const base = {
    user_id: t.userId,
    session_id: t.sessionId,
    creator_id: t.creatorId,
    retrieval_version: t.retrievalVersion,
    corpus_version_at_session: t.corpusVersionAtSession,
  };

  const events: PostHogEvent[] = [];

  // Cache events
  if (t.cacheHit) {
    events.push({
      name: 'rag_cache_hit',
      properties: { ...base, cache_age_seconds: t.cacheAgeSeconds },
    });
  } else {
    events.push({ name: 'rag_cache_miss', properties: { ...base } });
  }
  if (t.cacheStaleCorpus) {
    events.push({
      name: 'rag_session_corpus_drift',
      properties: { ...base, corpus_version_at_session: t.corpusVersionAtSession },
    });
  }

  // Day-11-cross M2: budget-exceeded gets its own event so admins can
  // distinguish "no paid calls happened because user hit cap" from "no
  // paid calls happened for unrelated reasons." Without this, a daily
  // 200-call cap hit produces ZERO telemetry signal anywhere.
  if (t.budgetExceeded) {
    events.push({
      name: 'rag_budget_exceeded',
      properties: { ...base },
    });
  }

  // Rewrite events
  if (t.rewrite) {
    if (t.rewrite.fallback) {
      const evName = mapRewriteFallbackToEvent(t.rewrite.fallbackReason);
      events.push({
        name: evName,
        properties: {
          ...base,
          reason: t.rewrite.fallbackReason ?? null,
          model: t.rewrite.modelId,
          latency_ms: t.rewrite.latencyMs,
        },
      });
    }
    // M2 plan event: emitted by the orchestrator when noContextAfterResumption
    // is true; the telemetry aggregator surfaces it from the rewrite leg.
  }

  // Rerank events
  if (t.rerank?.fallback) {
    const evName = mapRerankFallbackToEvent(t.rerank.fallbackReason);
    events.push({
      name: evName,
      properties: {
        ...base,
        reason: t.rerank.fallbackReason ?? null,
        provider: t.rerank.provider,
        model: t.rerank.modelId,
        latency_ms: t.rerank.latencyMs,
      },
    });
  }

  // Envelope events
  if (t.envelope?.oversize) {
    events.push({
      name: 'rag_envelope_oversize',
      properties: {
        ...base,
        dropped_passages: t.envelope.droppedPassages,
        passage_count: t.envelope.passageCount,
      },
    });
  }

  return events;
}

function mapRewriteFallbackToEvent(reason: string | undefined): string {
  switch (reason) {
    case 'timeout':
    case 'transport_error':
      return 'rag_rewrite_transport_failed';
    case 'empty_response':
    case 'parse_error':
      return 'rag_rewrite_model_malformed';
    case 'budget_exhausted':
      return 'rag_rewrite_budget_exhausted';
    case 'empty_utterance':
      return 'rag_rewrite_empty_utterance';
    default:
      return 'rag_rewrite_failed';
  }
}

function mapRerankFallbackToEvent(reason: string | undefined): string {
  switch (reason) {
    case 'rate_limited':
      return 'rag_rerank_bucket_overflow';
    case 'timeout':
      return 'rag_rerank_timeout';
    case 'auth_failed':
      return 'rag_rerank_auth_failed';
    case 'transport_error':
      return 'rag_rerank_transport_error';
    case 'parse_error':
    case 'empty_response':
      return 'rag_rerank_provider_malformed';
    // Day-11-cross M1: budget_exhausted is orchestrator-side (the rerank
    // call fast-failed because the turn deadline was already burned).
    // Distinct from bucket_overflow (Voyage-side rate) and from generic
    // failures. Tunable-budget problem, not a Voyage outage.
    case 'budget_exhausted':
      return 'rag_rerank_budget_exhausted';
    // empty_candidates → upstream RPC returned zero rows; not a rerank
    // failure but a "no data" signal worth distinguishing.
    case 'empty_candidates':
      return 'rag_rerank_empty_candidates';
    default:
      return 'rag_rerank_failed';
  }
}

// ───────────────────────────────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────────────────────────────

function round6(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}
