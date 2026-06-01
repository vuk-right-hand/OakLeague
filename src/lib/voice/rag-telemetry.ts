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
// Audit-2 C1: a swallowed cogs_log enum failure (the 'voyage' hole) is
// exactly how RAG v2 COGS were silently lost. cogs_log is money — a
// dropped row escalates to Sentry, not console.warn. This module is
// `server-only` + runs only in the Node API route, so @sentry/nextjs is
// the correct (and already-present) Sentry surface.
import * as Sentry from '@sentry/nextjs';

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
  /**
   * True when the rewriter detected a follow-up utterance ("tell me more",
   * "what about that") AND had no `lastAssistantResponse` to expand from
   * — typically because Gemini Live just reopened mid-conversation and
   * the session's voice_session_state row is empty. Final-cross audit C2:
   * propagated to PostHog `rag_rewrite_no_context_post_resumption` for
   * Day-15 dogfood-gate bucket-2 (follow-up) diagnostics.
   */
  noContextAfterResumption: boolean;
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
  // v3-only fields (NULL on v1/v2 paths). Plan §5 retrieval telemetry contract.
  /** Highest v3 parent_score (per-rank-mode aggregation). NULL on v1/v2 + when no rows. */
  parentScoreTop1?: number | null;
  /** v3 p_rank_mode used. NULL on v1/v2 paths. */
  parentRankSource?: 'max' | 'max_blend' | 'vec_max' | 'best_child' | null;
  /** v3 count of candidates that came from the SCOPED pass (vs flat-fallback union). */
  candidatesFromScope?: number;
};

// v3-only: routing step (sections), runs BEFORE retrieve. Plan §4 item 5.
//
// Audit round-5 M1: split latencies. `latencyMs` is the ROUTE RPC alone
// (not route+tsquery+topk). `scopedTopkLatencyMs` is the scoped topk_v3
// alone. `flatLatencyMs` is the flat-fallback section-fetch + second
// topk_v3 alone (NULL when fallback didn't fire). Together with
// rerank.latencyMs they decompose every v3 turn's hot path.
export type RouteLeg = {
  /** Number of section rows returned by _creator_route_sections_v3. */
  sectionsReturned: number;
  /** Top-1 section score (cosine max + soft topic boost). NULL when no rows. */
  sectionTop1Score: number | null;
  /** Gap between top-1 and top-2 section scores. NULL on <2 rows. Used by adaptive flat-fallback trigger. */
  sectionTop1to2Gap: number | null;
  /** True when the flat (unscoped) fallback was unioned with the scoped pass. */
  flatFallbackFired: boolean;
  /**
   * True when the flat fallback hit the FLAT_FALLBACK_MAX_SECTIONS cap (Step-9
   * audit M3): the creator has MORE active sections than the cap, so the flat
   * pass considered only the first N by section_index and may silently
   * under-recall later content. A loud signal that the cap (+ topk fan-out)
   * needs raising for a large-corpus creator. NULL when the fallback didn't run.
   */
  flatFallbackCapped?: boolean | null;
  /** Time spent in `_creator_route_sections_v3` alone. */
  latencyMs: number;
  /** Time spent in the SCOPED `_creator_knowledge_topk_v3` alone. NULL when not run. */
  scopedTopkLatencyMs?: number | null;
  /** Time spent in the FLAT-fallback section fetch + second topk. NULL when not run. */
  flatLatencyMs?: number | null;
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
  retrievalVersion: 1 | 2 | 3;
  corpusVersionAtSession: number;

  // Cache result (set by the orchestrator BEFORE any other leg).
  cacheHit: boolean;
  cacheStaleCorpus: boolean; // upsert rejected on stale-version
  cacheAgeSeconds: number | null;

  // Per-leg shapes. NULL when the leg didn't run.
  rewrite: RewriteLeg | null;
  embed: EmbedLeg | null;
  // v3-only routing step (NULL on v1/v2 paths).
  route: RouteLeg | null;
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
  retrievalVersion: 1 | 2 | 3;
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
    route: null,
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
  // INVARIANT: this union must stay a subset of the `cogs_service`
  // Postgres enum (20260420000001 + ADD VALUE migrations: heygen,
  // anthropic, hume, voyage@20260522000101). Adding a service here
  // without the matching enum migration is exactly the audit-2 C1 bug.
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

// Per-lost-row escalation. cogs_log is money — a dropped row is a
// data-integrity event, NOT a warning (a swallowed console.warn is
// exactly how the 'voyage' enum hole stayed invisible). audit-2 C1-M5:
// send only an allow-listed projection to Sentry, never the raw `row`
// (its `metadata` is `Record<string, unknown>` — a future leg could put
// a text snippet there; don't ship unredacted shapes into Sentry extra).
function reportCogsRowLoss(row: CogsLogRow, err: unknown): void {
  const message =
    (err as { message?: string })?.message ?? String(err ?? 'unknown');
  // eslint-disable-next-line no-console
  console.error(
    `[rag-telemetry] cogs_log ROW LOST — COGS DATA LOSS service=${row.service} ` +
      `operation=${row.operation} cost_usd=${row.cost_usd}: ${message}`,
  );
  try {
    Sentry.captureException(
      err instanceof Error
        ? err
        : new Error(`cogs_log row insert failed: ${message}`),
      {
        tags: { area: 'rag-cogs', service: row.service, operation: row.operation },
        extra: {
          service: row.service,
          operation: row.operation,
          cost_usd: row.cost_usd,
          units: row.units,
          user_id: row.user_id,
          session_id: row.session_id,
        },
      },
    );
  } catch {
    /* never let telemetry-of-telemetry throw */
  }
}

/**
 * Best-effort cogs_log writer. Fire-and-forget — failing one row should
 * not block the user turn.
 *
 * Day-11 audit note: orchestrator typically calls this WITHOUT awaiting
 * so the user response isn't gated on the cogs_log insert latency.
 *
 * Audit-2 C1 (2026-05-22): a single multi-VALUES INSERT is ATOMIC — one
 * bad row (e.g. the historical `service:'voyage'` enum hole) fails the
 * whole batch, so the valid rewrite+embed rows were dropped WITH the bad
 * rerank row, and the failure was swallowed as console.warn → all RAG v2
 * COGS silently lost. Fix: batch-first for the normal one-round-trip
 * path, but on ANY batch failure fall back to per-row inserts so valid
 * legs survive, and escalate each lost row to Sentry. The failed batch
 * inserts NOTHING (atomic) so the per-row retry cannot duplicate.
 *
 * audit-2 C1-M3: the per-row fallback is O(N) SEQUENTIAL round-trips
 * (1 failed batch + up to N per-row). This is acceptable ONLY because
 * the call is `void`-fired (never gates the user turn) and faults are
 * expected to be transient (a real cogs_log outage) or a one-time
 * migration window — NOT free. Do not promote this to the hot path.
 */
export async function flushCogsLogRows(
  admin: SupabaseClient,
  rows: readonly CogsLogRow[],
): Promise<void> {
  if (rows.length === 0) return;
  // Day-12 audit M4: invoked `void`-fired from the orchestrator's
  // try/finally — must never throw (Node 22 unhandled-rejection).
  const perRowFallback = async (reason: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.error(
      `[rag-telemetry] cogs_log batch insert failed (${rows.length} rows): ` +
        `${reason} — falling back to per-row so valid legs are not lost`,
    );
    for (const row of rows) {
      try {
        const { error: rowErr } = await admin.from('cogs_log').insert(row);
        if (rowErr) reportCogsRowLoss(row, rowErr);
      } catch (e) {
        reportCogsRowLoss(row, e);
      }
    }
  };
  try {
    // Normal path: one round-trip. supabase-js handles the array shape.
    const { error } = await admin.from('cogs_log').insert(rows as CogsLogRow[]);
    if (error) await perRowFallback(error.message);
  } catch (e) {
    try {
      await perRowFallback((e as Error)?.message ?? 'unknown (threw)');
    } catch {
      /* per-row path itself must never throw out of a void-fired call */
    }
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
    // Final-cross audit M4 disambiguation. The `cacheStaleCorpus=true`
    // flag fires in two distinct conditions:
    //   1. Upsert was rejected by the FOR SHARE check on
    //      creators.current_corpus_version (the original semantic)
    //   2. Cache lookup hit a row but fetchParentNarrativesByIds
    //      returned 0 parents (Day-11-cross C2 fall-through)
    // Both are "the cache lied" but the second one ALSO causes
    // `cacheHit=false`. PostHog dashboards computing
    // `count(rag_cache_hit) / (count(rag_cache_hit) + count(rag_cache_miss))`
    // would double-deduct on case-2 if we emitted both `rag_cache_miss`
    // and `rag_session_corpus_drift`. To keep the metrics clean we
    // emit ONE event per cause:
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
    // Final-cross audit C2: noContextAfterResumption signal. Fires when
    // the user asked a follow-up ("tell me more about that") AFTER Gemini
    // Live's 15-min reopen — voice_session_state was empty or new, so
    // there's no prior assistant turn for the rewriter to expand from.
    // Day-15 dogfood gate bucket-2 needs this to triage follow-up failures.
    if (t.rewrite.noContextAfterResumption) {
      events.push({
        name: 'rag_rewrite_no_context_post_resumption',
        properties: {
          ...base,
          model: t.rewrite.modelId,
        },
      });
    }
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

  // v3 routing events (audit round-5 M2). Without these the §7 harness
  // can't compute routing recall@k from PostHog — only from raw cogs_log
  // metadata, which doesn't carry the route leg's signals.
  if (t.retrievalVersion === 3 && t.route) {
    events.push({
      name: 'rag_v3_route_executed',
      properties: {
        ...base,
        sections_returned: t.route.sectionsReturned,
        section_top1_score: t.route.sectionTop1Score,
        section_top1_to_2_gap: t.route.sectionTop1to2Gap,
        flat_fallback_fired: t.route.flatFallbackFired,
        flat_fallback_capped: t.route.flatFallbackCapped ?? null,
        route_latency_ms: t.route.latencyMs,
        scoped_topk_latency_ms: t.route.scopedTopkLatencyMs ?? null,
        flat_latency_ms: t.route.flatLatencyMs ?? null,
        parent_rank_source: t.retrieve?.parentRankSource ?? null,
        parent_score_top1: t.retrieve?.parentScoreTop1 ?? null,
        candidates_from_scope: t.retrieve?.candidatesFromScope ?? null,
      },
    });
    if (t.route.flatFallbackFired) {
      events.push({
        name: 'rag_v3_flat_fallback_fired',
        properties: {
          ...base,
          sections_returned: t.route.sectionsReturned,
          flat_latency_ms: t.route.flatLatencyMs ?? null,
        },
      });
    }
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
