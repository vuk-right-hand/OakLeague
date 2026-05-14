// rag-telemetry.test.ts — vitest for RagTurnTelemetry aggregator.

import { describe, it, expect, vi } from 'vitest';
import {
  newTurnTelemetry,
  toCogsLogRows,
  toPostHogEventBatch,
  flushCogsLogRows,
} from './rag-telemetry';

const BASE_ARGS = {
  userId: 'u1',
  sessionId: 's1',
  creatorId: 'c1',
  retrievalVersion: 2 as const,
  corpusVersionAtSession: 3,
};

describe('newTurnTelemetry', () => {
  it('initializes all legs to null and flags to defaults', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    expect(t.rewrite).toBeNull();
    expect(t.embed).toBeNull();
    expect(t.retrieve).toBeNull();
    expect(t.rerank).toBeNull();
    expect(t.envelope).toBeNull();
    expect(t.cacheHit).toBe(false);
    expect(t.cacheStaleCorpus).toBe(false);
    expect(t.cacheAgeSeconds).toBeNull();
    expect(t.budgetExceeded).toBe(false);
    expect(t.totalLatencyMs).toBe(0);
    expect(t.userId).toBe('u1');
    expect(t.retrievalVersion).toBe(2);
  });
});

describe('toCogsLogRows', () => {
  it('emits no rows when no legs ran', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    expect(toCogsLogRows(t)).toEqual([]);
  });

  it('emits one row per filled paid leg (rewrite + embed + rerank)', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    t.rewrite = {
      modelId: 'gemini-2.5-flash',
      fallback: false,
      inputTokens: 100,
      outputTokens: 30,
      usdPerInputToken: 0.0000003,
      usdPerOutputToken: 0.0000025,
      quotedAt: '2026-05-14',
      latencyMs: 250,
      noContextAfterResumption: false,
    };
    t.embed = {
      modelId: 'gemini-embedding-001',
      inputTokens: 50,
      usdPerInputToken: 0.00000015,
      quotedAt: '2026-05-14',
      latencyMs: 80,
    };
    t.rerank = {
      provider: 'voyage',
      modelId: 'rerank-2.5',
      fallback: false,
      rerankTop1Score: 0.92,
      inputTokens: 5000,
      usdPerInputToken: 0.00000005,
      quotedAt: '2026-05-14',
      latencyMs: 350,
    };
    const rows = toCogsLogRows(t);
    expect(rows).toHaveLength(3);
    expect(rows[0].operation).toBe('rewrite');
    expect(rows[0].service).toBe('gemini');
    expect(rows[0].units).toBe(130); // 100 input + 30 output
    // Cost rounded to 6 decimals by round6 — precision matches that.
    expect(rows[0].cost_usd).toBeCloseTo(100 * 0.0000003 + 30 * 0.0000025, 6);
    expect(rows[1].operation).toBe('embedding');
    expect(rows[1].units).toBe(50);
    expect(rows[1].cost_usd).toBeCloseTo(50 * 0.00000015, 6);
    expect(rows[2].operation).toBe('rerank');
    expect(rows[2].service).toBe('voyage');
    expect(rows[2].units).toBe(5000);
    expect(rows[2].cost_usd).toBeCloseTo(5000 * 0.00000005, 6);
  });

  it('skips rewrite row when both input and output tokens are zero (fallback that never hit API)', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    t.rewrite = {
      modelId: 'gemini-2.5-flash',
      fallback: true,
      fallbackReason: 'budget_exhausted',
      inputTokens: 0,
      outputTokens: 0,
      usdPerInputToken: 0.0000003,
      usdPerOutputToken: 0.0000025,
      quotedAt: '2026-05-14',
      latencyMs: 5,
      noContextAfterResumption: false,
    };
    expect(toCogsLogRows(t)).toEqual([]);
  });

  it('emits rewrite row when fallback hit API and returned partial tokens (transport_error)', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    t.rewrite = {
      modelId: 'gemini-2.5-flash',
      fallback: true,
      fallbackReason: 'transport_error',
      inputTokens: 100,
      outputTokens: 0,
      usdPerInputToken: 0.0000003,
      usdPerOutputToken: 0.0000025,
      quotedAt: '2026-05-14',
      latencyMs: 250,
      noContextAfterResumption: false,
    };
    const rows = toCogsLogRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.rewrite_fallback).toBe(true);
    expect(rows[0].metadata.rewrite_fallback_reason).toBe('transport_error');
  });

  it('skips rerank row when fallback yielded zero inputTokens (no API call)', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    t.rerank = {
      provider: 'voyage',
      modelId: 'rerank-2.5',
      fallback: true,
      fallbackReason: 'rate_limited',
      rerankTop1Score: null,
      inputTokens: 0,
      usdPerInputToken: 0.00000005,
      quotedAt: '2026-05-14',
      latencyMs: 0,
    };
    expect(toCogsLogRows(t)).toEqual([]);
  });

  it('Day-11 audit M6: emits marker rerank row on successful call with zero inputTokens (response-drift)', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    // Successful call (fallback=false) but Voyage didn't return usage.total_tokens.
    t.rerank = {
      provider: 'voyage',
      modelId: 'rerank-2.5',
      fallback: false,
      rerankTop1Score: 0.84,
      inputTokens: 0,
      usdPerInputToken: 0.00000005,
      quotedAt: '2026-05-14',
      latencyMs: 300,
    };
    const rows = toCogsLogRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe('rerank');
    expect(rows[0].units).toBe(0);
    expect(rows[0].cost_usd).toBe(0);
    expect(rows[0].metadata.token_count_unavailable).toBe(true);
    expect(rows[0].metadata.rerank_top1_score).toBe(0.84);
  });

  it('rounds cost_usd to 6 decimals', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    t.embed = {
      modelId: 'gemini-embedding-001',
      inputTokens: 333,
      usdPerInputToken: 0.000_000_777_123, // tiny
      quotedAt: '2026-05-14',
      latencyMs: 80,
    };
    const rows = toCogsLogRows(t);
    expect(rows[0].cost_usd).toBe(0.000259); // rounded to 6 decimals
  });

  it('includes corpus_version_at_session + retrieval_version in metadata', () => {
    const t = newTurnTelemetry({ ...BASE_ARGS, retrievalVersion: 2, corpusVersionAtSession: 7 });
    t.rerank = {
      provider: 'voyage',
      modelId: 'rerank-2.5',
      fallback: false,
      rerankTop1Score: 0.81,
      inputTokens: 100,
      usdPerInputToken: 0.00000005,
      quotedAt: '2026-05-14',
      latencyMs: 200,
    };
    const [row] = toCogsLogRows(t);
    expect(row.metadata.retrieval_version).toBe(2);
    expect(row.metadata.corpus_version_at_session).toBe(7);
  });
});

describe('toPostHogEventBatch', () => {
  it('emits rag_cache_hit when cacheHit=true', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    t.cacheHit = true;
    t.cacheAgeSeconds = 42;
    const evs = toPostHogEventBatch(t);
    const hit = evs.find((e) => e.name === 'rag_cache_hit');
    expect(hit).toBeDefined();
    expect(hit?.properties.cache_age_seconds).toBe(42);
  });

  it('emits rag_cache_miss when cacheHit=false', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    const evs = toPostHogEventBatch(t);
    expect(evs.some((e) => e.name === 'rag_cache_miss')).toBe(true);
  });

  it('emits rag_session_corpus_drift when cacheStaleCorpus=true (cross-cutting C1)', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    t.cacheStaleCorpus = true;
    const evs = toPostHogEventBatch(t);
    expect(evs.some((e) => e.name === 'rag_session_corpus_drift')).toBe(true);
  });

  it('maps rewrite timeout → rag_rewrite_transport_failed', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    t.rewrite = {
      modelId: 'gemini-2.5-flash',
      fallback: true,
      fallbackReason: 'timeout',
      inputTokens: 0,
      outputTokens: 0,
      usdPerInputToken: 0,
      usdPerOutputToken: 0,
      quotedAt: '2026-05-14',
      latencyMs: 3000,
      noContextAfterResumption: false,
    };
    const evs = toPostHogEventBatch(t);
    expect(evs.some((e) => e.name === 'rag_rewrite_transport_failed')).toBe(true);
  });

  it('maps rerank rate_limited → rag_rerank_bucket_overflow', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    t.rerank = {
      provider: 'voyage',
      modelId: 'rerank-2.5',
      fallback: true,
      fallbackReason: 'rate_limited',
      rerankTop1Score: null,
      inputTokens: 0,
      usdPerInputToken: 0,
      quotedAt: '2026-05-14',
      latencyMs: 5,
    };
    const evs = toPostHogEventBatch(t);
    expect(evs.some((e) => e.name === 'rag_rerank_bucket_overflow')).toBe(true);
  });

  it('maps rerank auth_failed → rag_rerank_auth_failed (alert-worthy)', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    t.rerank = {
      provider: 'voyage',
      modelId: 'rerank-2.5',
      fallback: true,
      fallbackReason: 'auth_failed',
      rerankTop1Score: null,
      inputTokens: 0,
      usdPerInputToken: 0,
      quotedAt: '2026-05-14',
      latencyMs: 10,
    };
    const evs = toPostHogEventBatch(t);
    expect(evs.some((e) => e.name === 'rag_rerank_auth_failed')).toBe(true);
  });

  it('emits rag_envelope_oversize when envelope.oversize=true', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    t.envelope = {
      passageCount: 0,
      encodedBytes: 0,
      oversize: true,
      droppedPassages: 5,
      truncatedPassageCount: 0,
    };
    const evs = toPostHogEventBatch(t);
    const ov = evs.find((e) => e.name === 'rag_envelope_oversize');
    expect(ov).toBeDefined();
    expect(ov?.properties.dropped_passages).toBe(5);
  });

  it('does not emit rerank events when rerank leg is null', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    const evs = toPostHogEventBatch(t);
    expect(evs.find((e) => e.name.startsWith('rag_rerank_'))).toBeUndefined();
  });

  it('Cross-cutting M1: maps rerank budget_exhausted → rag_rerank_budget_exhausted', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    t.rerank = {
      provider: 'voyage',
      modelId: 'rerank-2.5',
      fallback: true,
      fallbackReason: 'budget_exhausted',
      rerankTop1Score: null,
      inputTokens: 0,
      usdPerInputToken: 0,
      quotedAt: '2026-05-14',
      latencyMs: 5,
    };
    const evs = toPostHogEventBatch(t);
    expect(evs.some((e) => e.name === 'rag_rerank_budget_exhausted')).toBe(true);
    expect(evs.some((e) => e.name === 'rag_rerank_failed')).toBe(false);
  });

  it('Cross-cutting M1: maps rerank empty_candidates → rag_rerank_empty_candidates', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    t.rerank = {
      provider: 'voyage',
      modelId: 'rerank-2.5',
      fallback: true,
      fallbackReason: 'empty_candidates',
      rerankTop1Score: null,
      inputTokens: 0,
      usdPerInputToken: 0,
      quotedAt: '2026-05-14',
      latencyMs: 0,
    };
    const evs = toPostHogEventBatch(t);
    expect(evs.some((e) => e.name === 'rag_rerank_empty_candidates')).toBe(true);
  });

  it('Cross-cutting M2: emits rag_budget_exceeded when budgetExceeded=true', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    t.budgetExceeded = true;
    const evs = toPostHogEventBatch(t);
    expect(evs.some((e) => e.name === 'rag_budget_exceeded')).toBe(true);
  });

  it('Cross-cutting M2: does NOT emit rag_budget_exceeded when budgetExceeded=false', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    const evs = toPostHogEventBatch(t);
    expect(evs.some((e) => e.name === 'rag_budget_exceeded')).toBe(false);
  });

  it('Final-cross C2: emits rag_rewrite_no_context_post_resumption when flagged', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    t.rewrite = {
      modelId: 'gemini-2.5-flash',
      fallback: false,
      inputTokens: 50,
      outputTokens: 10,
      usdPerInputToken: 0.0000003,
      usdPerOutputToken: 0.0000025,
      quotedAt: '2026-05-14',
      latencyMs: 200,
      noContextAfterResumption: true,
    };
    const evs = toPostHogEventBatch(t);
    const ev = evs.find((e) => e.name === 'rag_rewrite_no_context_post_resumption');
    expect(ev).toBeDefined();
    expect(ev?.properties.model).toBe('gemini-2.5-flash');
  });

  it('Final-cross C2: does NOT emit when noContextAfterResumption is false', () => {
    const t = newTurnTelemetry(BASE_ARGS);
    t.rewrite = {
      modelId: 'gemini-2.5-flash',
      fallback: false,
      inputTokens: 50,
      outputTokens: 10,
      usdPerInputToken: 0.0000003,
      usdPerOutputToken: 0.0000025,
      quotedAt: '2026-05-14',
      latencyMs: 200,
      noContextAfterResumption: false,
    };
    const evs = toPostHogEventBatch(t);
    expect(evs.some((e) => e.name === 'rag_rewrite_no_context_post_resumption')).toBe(false);
  });
});

describe('flushCogsLogRows', () => {
  it('does nothing when rows is empty (no DB call)', async () => {
    const insertSpy = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = { from: vi.fn(() => ({ insert: insertSpy })) } as any;
    await flushCogsLogRows(admin, []);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('batches all rows into a single insert', async () => {
    const insertSpy = vi.fn().mockResolvedValue({ error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = { from: vi.fn(() => ({ insert: insertSpy })) } as any;
    const rows = [
      {
        user_id: 'u1',
        session_id: 's1',
        service: 'gemini' as const,
        operation: 'rewrite' as const,
        units: 100,
        unit_label: 'tokens' as const,
        cost_usd: 0.0001,
        metadata: {},
      },
      {
        user_id: 'u1',
        session_id: 's1',
        service: 'gemini' as const,
        operation: 'embedding' as const,
        units: 50,
        unit_label: 'tokens' as const,
        cost_usd: 0.00001,
        metadata: {},
      },
    ];
    await flushCogsLogRows(admin, rows);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy).toHaveBeenCalledWith(rows);
  });

  it('warns on DB error but does not throw (fire-and-forget contract)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const insertSpy = vi.fn().mockResolvedValue({ error: { message: 'db_exploded' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = { from: vi.fn(() => ({ insert: insertSpy })) } as any;
    await expect(
      flushCogsLogRows(admin, [
        {
          user_id: 'u1',
          session_id: 's1',
          service: 'gemini' as const,
          operation: 'rewrite' as const,
          units: 100,
          unit_label: 'tokens' as const,
          cost_usd: 0.0001,
          metadata: {},
        },
      ]),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    expect((warnSpy.mock.calls[0][0] as string)).toContain('db_exploded');
    warnSpy.mockRestore();
  });
});
