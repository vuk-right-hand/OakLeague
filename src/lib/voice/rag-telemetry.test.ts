// rag-telemetry.test.ts — vitest for RagTurnTelemetry aggregator.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
import * as Sentry from '@sentry/nextjs';

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when rows is empty (no DB call)', async () => {
    const insertSpy = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = { from: vi.fn(() => ({ insert: insertSpy })) } as any;
    await flushCogsLogRows(admin, []);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  const ROW_REWRITE = {
    user_id: 'u1',
    session_id: 's1',
    service: 'gemini' as const,
    operation: 'rewrite' as const,
    units: 100,
    unit_label: 'tokens' as const,
    cost_usd: 0.0001,
    metadata: {},
  };
  const ROW_EMBED = {
    user_id: 'u1',
    session_id: 's1',
    service: 'gemini' as const,
    operation: 'embedding' as const,
    units: 50,
    unit_label: 'tokens' as const,
    cost_usd: 0.00001,
    metadata: {},
  };
  const ROW_RERANK_VOYAGE = {
    user_id: 'u1',
    session_id: 's1',
    service: 'voyage' as const,
    operation: 'rerank' as const,
    units: 30,
    unit_label: 'tokens' as const,
    cost_usd: 0.0002,
    metadata: {},
  };

  it('happy path: single batch insert, no per-row, no Sentry', async () => {
    const insertSpy = vi.fn().mockResolvedValue({ error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = { from: vi.fn(() => ({ insert: insertSpy })) } as any;
    const rows = [ROW_REWRITE, ROW_EMBED];
    await flushCogsLogRows(admin, rows);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy).toHaveBeenCalledWith(rows);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // Audit-2 C1 regression: this is the exact scenario that silently
  // dropped ALL RAG v2 COGS. A 'voyage' rerank row fails the enum; the
  // atomic batch insert takes the valid gemini rows down with it. The
  // fix must insert the valid legs per-row and only escalate the bad one.
  it('audit-2 C1: a bad enum row does NOT drop valid rows; per-row fallback saves the good legs, only the bad row hits Sentry', async () => {
    const goodInserted: Array<{ operation: string }> = [];
    const insertSpy = vi.fn().mockImplementation((arg: unknown) => {
      const ENUM_ERR = {
        error: { message: 'invalid input value for enum cogs_service: "voyage"', code: '22P02' },
      };
      if (Array.isArray(arg)) return Promise.resolve(ENUM_ERR); // batch fails on the voyage row
      const row = arg as { service: string; operation: string };
      if (row.service === 'voyage') return Promise.resolve(ENUM_ERR); // per-row: still fails
      goodInserted.push({ operation: row.operation });
      return Promise.resolve({ error: null }); // per-row: valid legs land
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = { from: vi.fn(() => ({ insert: insertSpy })) } as any;

    await expect(
      flushCogsLogRows(admin, [ROW_REWRITE, ROW_EMBED, ROW_RERANK_VOYAGE]),
    ).resolves.toBeUndefined();

    // 1 batch attempt + 3 per-row retries
    expect(insertSpy).toHaveBeenCalledTimes(4);
    // audit-2 C1-M4 duplicate-safety: the FIRST call is the atomic batch
    // (array arg) and it failed → it landed ZERO rows; every preserved
    // row came ONLY from a subsequent per-row (object arg) call. If a
    // future refactor makes the batch path partially-persist, this fails.
    expect(Array.isArray(insertSpy.mock.calls[0][0])).toBe(true);
    const perRowCalls = insertSpy.mock.calls
      .slice(1)
      .map((c) => c[0] as { operation?: string });
    expect(perRowCalls.every((a) => !Array.isArray(a))).toBe(true);
    expect(goodInserted.length).toBe(2); // came only from per-row, not the batch
    // the two valid gemini legs were preserved (the original bug lost them)
    expect(goodInserted.map((r) => r.operation).sort()).toEqual([
      'embedding',
      'rewrite',
    ]);
    // only the bad voyage row escalated — exactly once, to Sentry
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  // audit-2 C1-S6: the real-world voyage row on response-shape drift is
  // the zero-cost `token_count_unavailable` marker (units:0, cost_usd:0).
  // Same enum, same fallback path — prove it's covered too.
  it('audit-2 C1: zero-cost voyage marker row also survives the per-row fallback path', async () => {
    const ROW_RERANK_MARKER = {
      user_id: 'u1',
      session_id: 's1',
      service: 'voyage' as const,
      operation: 'rerank' as const,
      units: 0,
      unit_label: 'tokens' as const,
      cost_usd: 0,
      metadata: { token_count_unavailable: true },
    };
    const insertSpy = vi.fn().mockImplementation((arg: unknown) => {
      const ENUM_ERR = {
        error: { message: 'invalid input value for enum cogs_service: "voyage"', code: '22P02' },
      };
      if (Array.isArray(arg)) return Promise.resolve(ENUM_ERR);
      const row = arg as { service: string };
      if (row.service === 'voyage') return Promise.resolve(ENUM_ERR);
      return Promise.resolve({ error: null });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = { from: vi.fn(() => ({ insert: insertSpy })) } as any;
    await expect(
      flushCogsLogRows(admin, [ROW_REWRITE, ROW_RERANK_MARKER]),
    ).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1); // only the marker voyage row
  });

  it('escalates a persistently-failing row to Sentry (not console.warn) and never throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const insertSpy = vi.fn().mockResolvedValue({ error: { message: 'db_exploded' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = { from: vi.fn(() => ({ insert: insertSpy })) } as any;
    await expect(flushCogsLogRows(admin, [ROW_REWRITE])).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    expect((errSpy.mock.calls.flat() as string[]).join(' ')).toContain('COGS DATA LOSS');
    errSpy.mockRestore();
  });

  it('batch insert that THROWS still falls back per-row and never throws out (fire-and-forget)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const insertSpy = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('network boom');
      })
      .mockResolvedValue({ error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = { from: vi.fn(() => ({ insert: insertSpy })) } as any;
    await expect(flushCogsLogRows(admin, [ROW_REWRITE])).resolves.toBeUndefined();
    expect(insertSpy).toHaveBeenCalledTimes(2); // batch threw → 1 per-row retry
    // audit-2 C1-S2: the fallback sends the per-row OBJECT shape, not the array again
    expect(insertSpy).toHaveBeenLastCalledWith(ROW_REWRITE);
    expect(Sentry.captureException).not.toHaveBeenCalled(); // per-row succeeded
    errSpy.mockRestore();
  });

  // audit-2 C1-S3: telemetry-of-telemetry must never throw. If Sentry
  // itself blows up inside reportCogsRowLoss, flushCogsLogRows still
  // resolves (the void-fired contract holds on the worst path).
  it('never throws even when Sentry.captureException itself throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(Sentry.captureException).mockImplementationOnce(() => {
      throw new Error('sentry transport down');
    });
    const insertSpy = vi.fn().mockResolvedValue({ error: { message: 'db_exploded' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = { from: vi.fn(() => ({ insert: insertSpy })) } as any;
    await expect(flushCogsLogRows(admin, [ROW_REWRITE])).resolves.toBeUndefined();
    errSpy.mockRestore();
  });
});
