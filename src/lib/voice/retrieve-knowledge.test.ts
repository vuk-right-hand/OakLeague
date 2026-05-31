// retrieve-knowledge.test.ts — vitest for the v2 hybrid orchestrator.
//
// Coverage:
//   - Pre-flight: empty utterance + invalid corpus_version throw typed errors
//   - Budget exceeded → returns budgetExceeded:true, no other legs run
//   - Cache HIT path: lookup hit → fetch parent texts → return; skip rerank
//   - Cache MISS path: lookup miss → tsquery → topk_v2 → rerank → upsert
//   - Rewrite FALLBACK: skip cache lookup AND upsert (cross-cutting C2)
//   - Rerank FALLBACK: parents still returned with RRF order + synthetic scores;
//     scoreSource='rrf'
//   - Stale corpus upsert: telemetry.cacheStaleCorpus=true
//   - Empty topk_v2 result: no rerank, no upsert, parents=[]
//   - Telemetry assembled correctly (all legs, cost values, latencies)
//   - cogs_log batch insert fired (fire-and-forget)
//
// v1 path is unchanged from Phase 1; not re-tested here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @google/genai before importing the modules under test.
const generateContentMock = vi.fn();
const embedContentMock = vi.fn();
// Mock only the GoogleGenAI client; keep the real ThinkingLevel/Type enum
// exports so the v3 thinkingLevel path (gemini-3.x models) initializes.
vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return {
    ...actual,
    GoogleGenAI: vi.fn().mockImplementation(() => ({
      models: {
        generateContent: generateContentMock,
        embedContent: embedContentMock,
      },
    })),
  };
});

import {
  retrieveKnowledgeV2,
  retrieveKnowledgeV3,
  RetrieveKnowledgeV2Error,
  RetrieveKnowledgeV3Error,
  parentsToPassages,
} from './retrieve-knowledge';
import { _resetTokenBucketForTests } from './rerank';
import { _resetClientForTests as _resetRewriteClientForTests } from './query-rewrite';
import { HALFVEC_DIM } from './halfvec';

// ───────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────

const BASE_ARGS = {
  userId: 'user-uuid',
  creatorId: '11111111-1111-1111-1111-111111111111',
  rawUtterance: 'how do I deal with difficult coworkers',
  lastAssistantResponse: null,
  corpusVersionAtSession: 3,
  sessionId: 'session-uuid',
  geminiApiKey: 'gem-test-key',
  voyageApiKey: 'pa-test-key',
  topK: 3,
  deadlineMs: Date.now() + 30_000,
};

function makeVec(): number[] {
  return Array.from({ length: HALFVEC_DIM }, (_, i) => (i % 7) * 0.01);
}

function mockEmbedOk(tokens = 10) {
  embedContentMock.mockResolvedValueOnce({
    embeddings: [{ values: makeVec() }],
    metadata: { totalTokenCount: tokens },
  });
}

function mockRewriteOk(rewritten = 'how to handle difficult coworkers') {
  generateContentMock.mockResolvedValueOnce({
    text: JSON.stringify({ rewritten }),
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
  });
}

function mockRewriteFallback() {
  // Reject so rewriteQuery returns fallback=true with reason=transport_error.
  generateContentMock.mockRejectedValueOnce(new Error('transport explode'));
}

function makeRpcRow(i: number, score = 0.9 - i * 0.1) {
  return {
    parent_unit_id: `pu-${i}`,
    parent_text: `Parent narrative number ${i} discussing workplace dynamics in detail.`,
    parent_title: `Parent ${i}`,
    sample_id: 'sample-1',
    source_type: 'transcript',
    vector_score: score,
    bm25_score: score - 0.1,
    rrf_score: score,
    matched_child_chunk_ids: [`c${i}-1`, `c${i}-2`],
  };
}

type ParentRow = {
  id: string;
  text: string;
  title: string | null;
  // source_type is read via the sample_content FK embed (it lives on the
  // parent sample, not the narrative unit). Mock the PostgREST to-one shape.
  sample_content: { source_type: string };
};

/** Build a supabase admin mock with controllable rpc + from chains. */
function buildAdmin(opts: {
  budget?: boolean;
  cacheLookupHit?: {
    parent_unit_ids: string[];
    scores: number[];
    age_seconds: number;
    cached_row_id: string;
  } | null;
  tsq?: string;
  topkRows?: ReturnType<typeof makeRpcRow>[];
  cacheUpsertResult?: string | null; // uuid on ok, null on stale_corpus, undefined to skip
  parentFetchRows?: ParentRow[];
  parentFetchError?: { message: string } | null;
  cogsLogError?: { message: string } | null;
}) {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const rpc = vi.fn(async (name: string, args: unknown) => {
    rpcCalls.push({ name, args });
    switch (name) {
      case 'voice_retrieval_budget_check_and_increment':
        return { data: opts.budget ?? true, error: null };
      case 'semantic_query_cache_lookup':
        return { data: opts.cacheLookupHit ? [opts.cacheLookupHit] : [], error: null };
      case 'try_build_tsquery':
        return { data: opts.tsq ?? 'difficult & coworkers', error: null };
      case 'creator_knowledge_topk_v2':
        return { data: opts.topkRows ?? [], error: null };
      case 'semantic_query_cache_upsert':
        return { data: opts.cacheUpsertResult === undefined ? 'cache-row-uuid' : opts.cacheUpsertResult, error: null };
      default:
        return { data: null, error: { message: `unmocked rpc: ${name}` } };
    }
  });

  // .from('sample_content_narrative_units').select(...).eq(...).in(...)
  // .from('cogs_log').insert(...)
  const insertSpy = vi.fn().mockResolvedValue({ error: opts.cogsLogError ?? null });
  const fromSpy = vi.fn((table: string) => {
    if (table === 'sample_content_narrative_units') {
      const inSpy = vi.fn().mockResolvedValue({
        data: opts.parentFetchRows ?? [],
        error: opts.parentFetchError ?? null,
      });
      const eqSpy = vi.fn().mockReturnValue({ in: inSpy });
      const selectSpy = vi.fn().mockReturnValue({ eq: eqSpy });
      return { select: selectSpy };
    }
    if (table === 'cogs_log') {
      return { insert: insertSpy };
    }
    throw new Error(`unmocked table: ${table}`);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin: { rpc, from: fromSpy } as any, rpcCalls, insertSpy, fromSpy };
}

// ───────────────────────────────────────────────────────────────────────
// Setup / teardown
// ───────────────────────────────────────────────────────────────────────

beforeEach(() => {
  generateContentMock.mockReset();
  embedContentMock.mockReset();
  _resetTokenBucketForTests();
  _resetRewriteClientForTests();
  // Default voyage rerank mock — fetch returns 200 with sorted results.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          data: [
            { index: 0, relevance_score: 0.91 },
            { index: 2, relevance_score: 0.74 },
            { index: 1, relevance_score: 0.52 },
          ],
          usage: { total_tokens: 1500 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  vi.stubEnv('GEMINI_API_KEY', 'gem-test-key');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ───────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────

describe('retrieveKnowledgeV2 — pre-flight', () => {
  it('throws empty_utterance on blank rawUtterance', async () => {
    const { admin } = buildAdmin({});
    await expect(
      retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin, rawUtterance: '   ' }),
    ).rejects.toThrow(RetrieveKnowledgeV2Error);
  });

  it('throws invalid_corpus_version code on 0 or negative', async () => {
    const { admin } = buildAdmin({});
    try {
      await retrieveKnowledgeV2({
        ...BASE_ARGS,
        supabaseAdmin: admin,
        corpusVersionAtSession: 0,
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RetrieveKnowledgeV2Error);
      expect((e as RetrieveKnowledgeV2Error).code).toBe('invalid_corpus_version');
    }
  });

  it('throws invalid_corpus_version code on non-integer', async () => {
    const { admin } = buildAdmin({});
    try {
      await retrieveKnowledgeV2({
        ...BASE_ARGS,
        supabaseAdmin: admin,
        corpusVersionAtSession: 1.5,
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RetrieveKnowledgeV2Error);
      expect((e as RetrieveKnowledgeV2Error).code).toBe('invalid_corpus_version');
    }
  });
});

describe('retrieveKnowledgeV2 — budget exceeded', () => {
  it('returns budgetExceeded:true with no other legs run', async () => {
    const { admin } = buildAdmin({ budget: false });
    const r = await retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.budgetExceeded).toBe(true);
    expect(r.parents).toEqual([]);
    expect(r.telemetry.rewrite).toBeNull();
    expect(r.telemetry.embed).toBeNull();
  });
});

describe('retrieveKnowledgeV2 — cache HIT path', () => {
  it('skips topk_v2 + rerank + upsert when cache hits, fetches parent texts', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const { admin, rpcCalls } = buildAdmin({
      cacheLookupHit: {
        parent_unit_ids: ['pu-a', 'pu-b'],
        scores: [0.95, 0.82],
        age_seconds: 30,
        cached_row_id: 'cache-uuid',
      },
      parentFetchRows: [
        { id: 'pu-a', text: 'Parent A text', title: 'A', sample_content: { source_type: 'transcript' } },
        { id: 'pu-b', text: 'Parent B text', title: 'B', sample_content: { source_type: 'book_or_doc' } },
      ],
    });
    const r = await retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.telemetry.cacheHit).toBe(true);
    expect(r.telemetry.cacheAgeSeconds).toBe(30);
    expect(r.parents).toHaveLength(2);
    expect(r.parents[0].parentUnitId).toBe('pu-a');
    expect(r.parents[0].score).toBe(0.95);
    expect(r.parents[0].scoreSource).toBe('cache');
    expect(r.parents[1].parentUnitId).toBe('pu-b');
    // Topk_v2 and rerank MUST NOT have been invoked.
    expect(rpcCalls.some((c) => c.name === 'creator_knowledge_topk_v2')).toBe(false);
    expect(rpcCalls.some((c) => c.name === 'semantic_query_cache_upsert')).toBe(false);
    // Rerank leg telemetry untouched.
    expect(r.telemetry.rerank).toBeNull();
  });

  it('preserves cache-row score ordering (highest first) after parent text fetch', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const { admin } = buildAdmin({
      cacheLookupHit: {
        parent_unit_ids: ['pu-low', 'pu-high'],
        scores: [0.3, 0.99],
        age_seconds: 5,
        cached_row_id: 'r',
      },
      parentFetchRows: [
        // Returned in arbitrary order — the orchestrator must sort by score.
        { id: 'pu-low', text: 'low score text', title: null, sample_content: { source_type: 't' } },
        { id: 'pu-high', text: 'high score text', title: null, sample_content: { source_type: 't' } },
      ],
    });
    const r = await retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.parents[0].parentUnitId).toBe('pu-high');
    expect(r.parents[0].score).toBe(0.99);
    expect(r.parents[1].parentUnitId).toBe('pu-low');
  });
});

describe('retrieveKnowledgeV2 — cache MISS path', () => {
  it('runs topk_v2 → rerank → upsert when cache misses', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const { admin, rpcCalls } = buildAdmin({
      cacheLookupHit: null,
      topkRows: [makeRpcRow(0), makeRpcRow(1), makeRpcRow(2)],
      cacheUpsertResult: 'new-cache-uuid',
    });
    const r = await retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.telemetry.cacheHit).toBe(false);
    expect(r.telemetry.retrieve?.parentsReturned).toBe(3);
    expect(r.telemetry.rerank).not.toBeNull();
    expect(r.telemetry.rerank?.fallback).toBe(false);
    expect(r.parents).toHaveLength(3);
    // Rerank order: index 0 (0.91), index 2 (0.74), index 1 (0.52)
    expect(r.parents[0].parentUnitId).toBe('pu-0');
    expect(r.parents[1].parentUnitId).toBe('pu-2');
    expect(r.parents[2].parentUnitId).toBe('pu-1');
    expect(r.parents.every((p) => p.scoreSource === 'rerank')).toBe(true);
    // All four expected RPCs fired in order:
    const rpcNames = rpcCalls.map((c) => c.name);
    expect(rpcNames).toEqual([
      'voice_retrieval_budget_check_and_increment',
      'semantic_query_cache_lookup',
      'try_build_tsquery',
      'creator_knowledge_topk_v2',
      'semantic_query_cache_upsert',
    ]);
  });

  it('returns empty parents when topk_v2 yields zero rows; no rerank/upsert fired', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const { admin, rpcCalls } = buildAdmin({
      cacheLookupHit: null,
      topkRows: [],
    });
    const r = await retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.parents).toEqual([]);
    expect(r.telemetry.retrieve?.parentsReturned).toBe(0);
    expect(r.telemetry.rerank).toBeNull();
    expect(rpcCalls.some((c) => c.name === 'semantic_query_cache_upsert')).toBe(false);
  });
});

describe('retrieveKnowledgeV2 — rewrite FALLBACK skips cache (cross-cutting C2)', () => {
  it('skips cache lookup AND upsert when rewrite returns fallback=true', async () => {
    mockRewriteFallback();
    mockEmbedOk();
    const { admin, rpcCalls } = buildAdmin({
      topkRows: [makeRpcRow(0), makeRpcRow(1)],
    });
    const r = await retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.rewriteFallback).toBe(true);
    expect(r.telemetry.rewrite?.fallback).toBe(true);
    // Cache lookup MUST NOT have fired.
    expect(rpcCalls.some((c) => c.name === 'semantic_query_cache_lookup')).toBe(false);
    // Cache upsert MUST NOT have fired.
    expect(rpcCalls.some((c) => c.name === 'semantic_query_cache_upsert')).toBe(false);
    // But topk_v2 and rerank DO fire (fresh retrieval).
    expect(rpcCalls.some((c) => c.name === 'creator_knowledge_topk_v2')).toBe(true);
    expect(r.parents.length).toBeGreaterThan(0);
  });
});

describe('retrieveKnowledgeV2 — rerank FALLBACK preserves RRF order', () => {
  it('returns parents in RPC order with scoreSource=rrf when rerank degrades', async () => {
    mockRewriteOk();
    mockEmbedOk();
    // Override fetch to return 429 → rerank falls back to rate_limited.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { admin } = buildAdmin({
      cacheLookupHit: null,
      topkRows: [makeRpcRow(0), makeRpcRow(1), makeRpcRow(2)],
    });
    const r = await retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.telemetry.rerank?.fallback).toBe(true);
    expect(r.telemetry.rerank?.fallbackReason).toBe('rate_limited');
    expect(r.parents).toHaveLength(3);
    // Order preserved from RPC (RRF-ranked input).
    expect(r.parents[0].parentUnitId).toBe('pu-0');
    expect(r.parents[1].parentUnitId).toBe('pu-1');
    expect(r.parents[2].parentUnitId).toBe('pu-2');
    expect(r.parents.every((p) => p.scoreSource === 'rrf')).toBe(true);
    // Synthetic monotonic-decreasing scores — never NaN (Day-10 audit C3).
    expect(r.parents.every((p) => Number.isFinite(p.score))).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('retrieveKnowledgeV2 — stale corpus signaling', () => {
  it('sets telemetry.cacheStaleCorpus when upsert returns NULL (stale_corpus reason)', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const { admin } = buildAdmin({
      cacheLookupHit: null,
      topkRows: [makeRpcRow(0)],
      cacheUpsertResult: null, // RPC returned NULL → stale_corpus
    });
    const r = await retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.telemetry.cacheStaleCorpus).toBe(true);
    // Parents still returned (upsert failure non-fatal).
    expect(r.parents.length).toBe(1);
  });
});

describe('parentsToPassages — Final-cross M1 helper', () => {
  it('maps RetrievedParent → RetrievedPassage shape (drops parentUnitId + scoreSource)', () => {
    const passages = parentsToPassages([
      {
        parentUnitId: 'pu-1',
        text: 'body text',
        title: 'A Story',
        sourceType: 'transcript',
        score: 0.91,
        scoreSource: 'rerank',
      },
    ]);
    expect(passages).toEqual([
      { text: 'body text', sourceType: 'transcript', title: 'A Story', score: 0.91 },
    ]);
  });

  it('coerces null title and null score to undefined', () => {
    const passages = parentsToPassages([
      {
        parentUnitId: 'pu-1',
        text: 't',
        title: null,
        sourceType: 's',
        score: null,
        scoreSource: 'cache',
      },
    ]);
    expect(passages[0].title).toBeUndefined();
    expect(passages[0].score).toBeUndefined();
  });

  it('handles empty input', () => {
    expect(parentsToPassages([])).toEqual([]);
  });
});

describe('retrieveKnowledgeV2 — Day-11 audit fixes', () => {
  it('M2: skips cache upsert when rerank fell back (preserves cache integrity)', async () => {
    mockRewriteOk();
    mockEmbedOk();
    // Force rerank fallback via 429.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { admin, rpcCalls } = buildAdmin({
      cacheLookupHit: null,
      topkRows: [makeRpcRow(0), makeRpcRow(1)],
    });
    const r = await retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.telemetry.rerank?.fallback).toBe(true);
    // Cache upsert MUST NOT have fired — Day-11 audit M2 prevents synthetic
    // passthrough scores from poisoning the cache for 7 days.
    expect(rpcCalls.some((c) => c.name === 'semantic_query_cache_upsert')).toBe(false);
    // But parents are still returned to the caller.
    expect(r.parents).toHaveLength(2);
    warnSpy.mockRestore();
  });

  it('M1: cache HIT with fewer fetched parents sets cacheStaleCorpus + warns', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { admin } = buildAdmin({
      cacheLookupHit: {
        parent_unit_ids: ['pu-a', 'pu-b', 'pu-c'],
        scores: [0.95, 0.82, 0.5],
        age_seconds: 30,
        cached_row_id: 'cache-uuid',
      },
      // Only 2 of 3 rows come back — one was deleted.
      parentFetchRows: [
        { id: 'pu-a', text: 'A', title: null, sample_content: { source_type: 'transcript' } },
        { id: 'pu-b', text: 'B', title: null, sample_content: { source_type: 'transcript' } },
      ],
    });
    const r = await retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.telemetry.cacheHit).toBe(true);
    expect(r.telemetry.cacheStaleCorpus).toBe(true);
    expect(r.parents).toHaveLength(2);
    expect(
      (warnSpy.mock.calls[0]?.[0] as string)?.includes('cache parent missing'),
    ).toBe(true);
    warnSpy.mockRestore();
  });

  it('M4: lookupCache throwing SemanticCacheError fails-open as cache miss', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Custom admin that THROWS during cache lookup but succeeds for other RPCs.
    const rpc = vi.fn(async (name: string) => {
      switch (name) {
        case 'voice_retrieval_budget_check_and_increment':
          return { data: true, error: null };
        case 'semantic_query_cache_lookup':
          // Return a non-null data with structure that semantic-cache will
          // accept as a "non-miss DB error" — actually, simpler: return an
          // error object so the wrapper throws SemanticCacheError.
          return { data: null, error: { message: 'transient db blip' } };
        case 'try_build_tsquery':
          return { data: 'q', error: null };
        case 'creator_knowledge_topk_v2':
          return { data: [makeRpcRow(0)], error: null };
        case 'semantic_query_cache_upsert':
          return { data: 'row-uuid', error: null };
        default:
          return { data: null, error: { message: `unmocked: ${name}` } };
      }
    });
    const insertSpy = vi.fn().mockResolvedValue({ error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = {
      rpc,
      from: vi.fn((table: string) => {
        if (table === 'cogs_log') return { insert: insertSpy };
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        };
      }),
    } as any;
    const r = await retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.telemetry.cacheHit).toBe(false);
    // Cache lookup error logged.
    expect(warnSpy).toHaveBeenCalled();
    expect((warnSpy.mock.calls[0]?.[0] as string)).toContain('cache lookup fail-open');
    // Orchestrator still completes successfully via cache-miss path.
    expect(r.parents.length).toBe(1);
    warnSpy.mockRestore();
  });

  it('C3: cogs_log batch flushes on cache HIT path (not just miss)', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const { admin, insertSpy } = buildAdmin({
      cacheLookupHit: {
        parent_unit_ids: ['pu-a'],
        scores: [0.95],
        age_seconds: 5,
        cached_row_id: 'r',
      },
      parentFetchRows: [
        { id: 'pu-a', text: 'A', title: null, sample_content: { source_type: 'transcript' } },
      ],
    });
    await retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin });
    await new Promise((r) => setTimeout(r, 0));
    expect(insertSpy).toHaveBeenCalled();
    // On cache HIT we still paid for rewrite + embed.
    const rows = insertSpy.mock.calls[0][0] as Array<{ operation: string }>;
    expect(rows.some((r) => r.operation === 'rewrite')).toBe(true);
    expect(rows.some((r) => r.operation === 'embedding')).toBe(true);
    expect(rows.every((r) => r.operation !== 'rerank')).toBe(true); // no rerank on hit
  });

  it('Cross-cutting C2: cache HIT with 0 fetched parents falls through to fresh retrieve', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { admin, rpcCalls } = buildAdmin({
      cacheLookupHit: {
        parent_unit_ids: ['pu-deleted-a', 'pu-deleted-b'],
        scores: [0.9, 0.7],
        age_seconds: 100,
        cached_row_id: 'r',
      },
      // BOTH cached parents have been deleted from sample_content_narrative_units.
      parentFetchRows: [],
      topkRows: [makeRpcRow(0), makeRpcRow(1)],
    });
    const r = await retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin });
    // Cache miss after fallthrough — but cacheStaleCorpus stays TRUE as the
    // "we tried; cache was bunk" signal.
    expect(r.telemetry.cacheHit).toBe(false);
    expect(r.telemetry.cacheStaleCorpus).toBe(true);
    // Topk_v2 + rerank + upsert MUST have fired (fresh retrieve replaces stale row).
    expect(rpcCalls.some((c) => c.name === 'creator_knowledge_topk_v2')).toBe(true);
    expect(rpcCalls.some((c) => c.name === 'semantic_query_cache_upsert')).toBe(true);
    expect(r.parents.length).toBeGreaterThan(0);
    expect(
      (warnSpy.mock.calls.find((c) => (c[0] as string).includes('falling through to fresh retrieve'))) !== undefined,
    ).toBe(true);
    warnSpy.mockRestore();
  });

  it('Cross-cutting C1: telemetry flushes on THROW path (embed_failed)', async () => {
    mockRewriteOk();
    // Embed throws.
    embedContentMock.mockRejectedValueOnce(new Error('gemini embedding outage'));
    const { admin, insertSpy } = buildAdmin({ cacheLookupHit: null });
    await expect(
      retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin }),
    ).rejects.toMatchObject({ code: 'embed_failed' });
    // Even though we threw, the finally block fired flushCogsLogRows.
    await new Promise((r) => setTimeout(r, 0));
    expect(insertSpy).toHaveBeenCalled();
    const rows = insertSpy.mock.calls[0][0] as Array<{ operation: string }>;
    // Rewrite leg was already collected before the throw — its cogs_log row
    // is preserved, NOT lost.
    expect(rows.some((r) => r.operation === 'rewrite')).toBe(true);
  });

  it('Cross-cutting C3: rerank id-based mapping handles candidate-array shifts robustly', async () => {
    mockRewriteOk();
    mockEmbedOk();
    // Construct a Voyage response that references indexes 2, 0, 1 (out of
    // order), and the rerank module returns the corresponding candidate.id
    // strings ('pu-2', 'pu-0', 'pu-1'). Orchestrator maps by id, not index.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { index: 2, relevance_score: 0.95 },
              { index: 0, relevance_score: 0.81 },
              { index: 1, relevance_score: 0.42 },
            ],
            usage: { total_tokens: 100 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const { admin } = buildAdmin({
      cacheLookupHit: null,
      topkRows: [makeRpcRow(0), makeRpcRow(1), makeRpcRow(2)],
    });
    const r = await retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.parents).toHaveLength(3);
    expect(r.parents[0].parentUnitId).toBe('pu-2'); // highest rerank score
    expect(r.parents[1].parentUnitId).toBe('pu-0');
    expect(r.parents[2].parentUnitId).toBe('pu-1');
  });

  it('C1: deadline_exceeded on critical RPC throws RetrieveKnowledgeV2Error', async () => {
    mockRewriteOk();
    mockEmbedOk();
    // Build an admin where topk_v2 NEVER resolves.
    const rpc = vi.fn(async (name: string) => {
      switch (name) {
        case 'voice_retrieval_budget_check_and_increment':
          return { data: true, error: null };
        case 'semantic_query_cache_lookup':
          return { data: [], error: null };
        case 'try_build_tsquery':
          return { data: 'q', error: null };
        case 'creator_knowledge_topk_v2':
          // Never resolves — hang.
          return await new Promise(() => {});
        default:
          return { data: null, error: null };
      }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = {
      rpc,
      from: vi.fn(() => ({ insert: vi.fn().mockResolvedValue({ error: null }) })),
    } as any;
    // Tight deadline — 200ms from now.
    await expect(
      retrieveKnowledgeV2({
        ...BASE_ARGS,
        supabaseAdmin: admin,
        deadlineMs: Date.now() + 200,
      }),
    ).rejects.toMatchObject({ code: 'rpc_failed' });
  });
});

describe('retrieveKnowledgeV2 — telemetry assembly', () => {
  it('fills rewrite + embed + retrieve + rerank legs with shape per leg', async () => {
    mockRewriteOk('how to handle workplace conflict');
    mockEmbedOk(42);
    const { admin } = buildAdmin({
      cacheLookupHit: null,
      topkRows: [makeRpcRow(0), makeRpcRow(1), makeRpcRow(2)],
    });
    const r = await retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.telemetry.rewrite).toMatchObject({
      modelId: expect.any(String),
      inputTokens: 100,
      outputTokens: 20,
      fallback: false,
    });
    expect(r.telemetry.embed).toMatchObject({
      modelId: expect.any(String),
      inputTokens: 42,
    });
    expect(r.telemetry.retrieve).toMatchObject({ parentsReturned: 3 });
    expect(r.telemetry.retrieve?.rrfTop1Score).toBeGreaterThan(0);
    expect(r.telemetry.rerank).toMatchObject({
      provider: 'voyage',
      fallback: false,
      rerankTop1Score: 0.91,
      inputTokens: 1500,
    });
    // Mocked test can complete in same ms; allow 0 but ensure non-negative.
    expect(r.telemetry.totalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('cogs_log batch insert fires fire-and-forget (does not block return)', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const { admin, insertSpy } = buildAdmin({
      cacheLookupHit: null,
      topkRows: [makeRpcRow(0)],
    });
    await retrieveKnowledgeV2({ ...BASE_ARGS, supabaseAdmin: admin });
    // Wait one tick for the void-promise to schedule.
    await new Promise((r) => setTimeout(r, 0));
    expect(insertSpy).toHaveBeenCalled();
    const rows = insertSpy.mock.calls[0][0] as Array<{ operation: string }>;
    // At least rewrite + embed + rerank legs each emit a row.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.some((r) => r.operation === 'rewrite')).toBe(true);
    expect(rows.some((r) => r.operation === 'embedding')).toBe(true);
    expect(rows.some((r) => r.operation === 'rerank')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────
// v3 fixtures + tests — routed hierarchical retrieval (plan §4 items 5+6+7)
// ───────────────────────────────────────────────────────────────────────

function makeRouteRow(i: number, score = 0.95 - i * 0.05) {
  return {
    section_id: `sec-${i}`,
    sample_id: 'sample-1',
    title: `Section ${i}`,
    summary_sim: score,
    centroid_sim: score - 0.02,
    topic_boost: 0.05,
    score,
  };
}

function makeRpcRowV3(i: number, score = 0.9 - i * 0.1) {
  return {
    parent_unit_id: `pu-${i}`,
    parent_text: `v3 parent ${i} text about workplace dynamics in depth.`,
    parent_title: `V3 Parent ${i}`,
    sample_id: 'sample-1',
    source_type: 'transcript',
    section_id: `sec-${i % 2}`,
    vector_score: score,
    bm25_score: score - 0.1,
    rrf_score: score * 0.5,
    parent_score: score,
    matched_child_chunk_ids: [`c${i}-1`, `c${i}-2`],
  };
}

/**
 * v3 admin builder. Extends v2 fixture with route_sections + topk_v3 +
 * optional flat-fallback sections fetch. Defaults preserve a happy-path
 * scoped pass (no fallback needed).
 */
function buildAdminV3(opts: {
  budget?: boolean;
  cacheLookupHit?: {
    parent_unit_ids: string[];
    scores: number[];
    age_seconds: number;
    cached_row_id: string;
  } | null;
  tsq?: string;
  routeRows?: ReturnType<typeof makeRouteRow>[];
  topkV3Rows?: ReturnType<typeof makeRpcRowV3>[];
  /** Rows for the SECOND topk_v3 call (flat fallback). Default empty (no fallback). */
  topkV3FlatRows?: ReturnType<typeof makeRpcRowV3>[];
  /** Sections returned by the all-sections fetch used by the flat fallback. */
  allSectionsRows?: Array<{ id: string }>;
  cacheUpsertResult?: string | null;
  parentFetchRows?: ParentRow[];
  parentFetchError?: { message: string } | null;
  cogsLogError?: { message: string } | null;
}) {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  let topkV3CallCount = 0;
  const rpc = vi.fn(async (name: string, args: unknown) => {
    rpcCalls.push({ name, args });
    switch (name) {
      case 'voice_retrieval_budget_check_and_increment':
        return { data: opts.budget ?? true, error: null };
      case 'semantic_query_cache_lookup':
        return { data: opts.cacheLookupHit ? [opts.cacheLookupHit] : [], error: null };
      case '_creator_route_sections_v3':
        return { data: opts.routeRows ?? [], error: null };
      case 'try_build_tsquery':
        return { data: opts.tsq ?? 'difficult & coworkers', error: null };
      case '_creator_knowledge_topk_v3': {
        topkV3CallCount += 1;
        // First call = scoped pass; second = flat fallback.
        const rows = topkV3CallCount === 1 ? (opts.topkV3Rows ?? []) : (opts.topkV3FlatRows ?? []);
        return { data: rows, error: null };
      }
      case 'semantic_query_cache_upsert':
        return { data: opts.cacheUpsertResult === undefined ? 'cache-row-uuid' : opts.cacheUpsertResult, error: null };
      default:
        return { data: null, error: { message: `unmocked rpc: ${name}` } };
    }
  });

  const insertSpy = vi.fn().mockResolvedValue({ error: opts.cogsLogError ?? null });
  const fromSpy = vi.fn((table: string) => {
    if (table === 'sample_content_narrative_units') {
      const inSpy = vi.fn().mockResolvedValue({
        data: opts.parentFetchRows ?? [],
        error: opts.parentFetchError ?? null,
      });
      const eqSpy = vi.fn().mockReturnValue({ in: inSpy });
      const selectSpy = vi.fn().mockReturnValue({ eq: eqSpy });
      return { select: selectSpy };
    }
    if (table === 'sample_content_sections') {
      // Used by the flat fallback to enumerate all sections of the creator.
      // Chain shape (post-round-5 C3): .select().eq().order().limit() returns thenable.
      const limitResolver = vi.fn().mockResolvedValue({
        data: opts.allSectionsRows ?? [],
        error: null,
      });
      const orderSpy = vi.fn().mockReturnValue({ limit: limitResolver });
      const eqSpy = vi.fn().mockReturnValue({ order: orderSpy });
      const selectSpy = vi.fn().mockReturnValue({ eq: eqSpy });
      return { select: selectSpy };
    }
    if (table === 'cogs_log') {
      return { insert: insertSpy };
    }
    throw new Error(`unmocked table: ${table}`);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin: { rpc, from: fromSpy } as any, rpcCalls, insertSpy, fromSpy };
}

describe('retrieveKnowledgeV3 — pre-flight', () => {
  it('throws empty_utterance on whitespace input', async () => {
    const { admin } = buildAdminV3({});
    await expect(
      retrieveKnowledgeV3({ ...BASE_ARGS, supabaseAdmin: admin, rawUtterance: '  ' }),
    ).rejects.toBeInstanceOf(RetrieveKnowledgeV3Error);
  });

  it('throws invalid_corpus_version on zero', async () => {
    const { admin } = buildAdminV3({});
    try {
      await retrieveKnowledgeV3({
        ...BASE_ARGS,
        supabaseAdmin: admin,
        corpusVersionAtSession: 0,
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RetrieveKnowledgeV3Error);
      expect((e as RetrieveKnowledgeV3Error).code).toBe('invalid_corpus_version');
    }
  });
});

describe('retrieveKnowledgeV3 — budget exceeded', () => {
  it('returns empty + budgetExceeded:true on budget=false', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const { admin } = buildAdminV3({ budget: false });
    const r = await retrieveKnowledgeV3({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.budgetExceeded).toBe(true);
    expect(r.parents).toEqual([]);
    expect(r.sectionsRouted).toBe(0);
    expect(r.flatFallbackFired).toBe(false);
  });
});

describe('retrieveKnowledgeV3 — happy path (route → scoped topk → rerank)', () => {
  it('routes sections, runs scoped topk_v3, reranks, returns parents', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const { admin, rpcCalls } = buildAdminV3({
      routeRows: [makeRouteRow(0), makeRouteRow(1), makeRouteRow(2)],
      topkV3Rows: [makeRpcRowV3(0), makeRpcRowV3(1), makeRpcRowV3(2)],
    });
    const r = await retrieveKnowledgeV3({ ...BASE_ARGS, supabaseAdmin: admin });

    expect(r.sectionsRouted).toBe(3);
    expect(r.flatFallbackFired).toBe(false);
    expect(r.parents.length).toBe(3);
    expect(r.parents.every((p) => p.scoreSource === 'rerank')).toBe(true);
    // Route RPC was called once.
    const routeCalls = rpcCalls.filter((c) => c.name === '_creator_route_sections_v3');
    expect(routeCalls.length).toBe(1);
    // topk_v3 called once (scoped) — no fallback.
    const topkCalls = rpcCalls.filter((c) => c.name === '_creator_knowledge_topk_v3');
    expect(topkCalls.length).toBe(1);
    // Verify scoped call carries the routed section ids.
    const scopedArgs = topkCalls[0].args as Record<string, unknown>;
    expect(scopedArgs.p_section_ids).toEqual(['sec-0', 'sec-1', 'sec-2']);
    // Telemetry assembled.
    expect(r.telemetry.route?.sectionsReturned).toBe(3);
    expect(r.telemetry.route?.flatFallbackFired).toBe(false);
    expect(r.telemetry.retrieve?.parentRankSource).toBe('max_blend');
    expect(r.telemetry.retrieve?.candidatesFromScope).toBe(3);
  });
});

describe('retrieveKnowledgeV3 — flat fallback fires on zero scoped rows', () => {
  it('refetches all sections + reruns topk_v3 when scoped returned 0', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const { admin, rpcCalls } = buildAdminV3({
      routeRows: [makeRouteRow(0), makeRouteRow(1)],
      topkV3Rows: [],                                          // scoped: zero
      allSectionsRows: [{ id: 'sec-0' }, { id: 'sec-1' }, { id: 'sec-2' }, { id: 'sec-3' }],
      topkV3FlatRows: [makeRpcRowV3(0), makeRpcRowV3(1)],     // flat: 2 rows
    });
    const r = await retrieveKnowledgeV3({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.flatFallbackFired).toBe(true);
    expect(r.parents.length).toBe(2);
    expect(r.telemetry.route?.flatFallbackFired).toBe(true);
    // topk_v3 was called TWICE (scoped + flat).
    const topkCalls = rpcCalls.filter((c) => c.name === '_creator_knowledge_topk_v3');
    expect(topkCalls.length).toBe(2);
    // candidatesFromScope reflects the scoped count (0), not the flat count.
    expect(r.telemetry.retrieve?.candidatesFromScope).toBe(0);
  });

  it('does NOT fire fallback when scoped pass had results', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const { admin, rpcCalls } = buildAdminV3({
      routeRows: [makeRouteRow(0)],
      topkV3Rows: [makeRpcRowV3(0)],
      // allSectionsRows + topkV3FlatRows present but should NOT be consumed.
      allSectionsRows: [{ id: 'sec-0' }, { id: 'sec-1' }],
      topkV3FlatRows: [makeRpcRowV3(5)],
    });
    const r = await retrieveKnowledgeV3({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.flatFallbackFired).toBe(false);
    const topkCalls = rpcCalls.filter((c) => c.name === '_creator_knowledge_topk_v3');
    expect(topkCalls.length).toBe(1);
  });

  it('does NOT fire fallback when routing returned ZERO sections (no scoped attempt to fall back FROM)', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const { admin, rpcCalls } = buildAdminV3({
      routeRows: [],         // routing returned nothing — likely empty creator
      topkV3Rows: [],
    });
    const r = await retrieveKnowledgeV3({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.sectionsRouted).toBe(0);
    expect(r.flatFallbackFired).toBe(false);
    expect(r.parents).toEqual([]);
    // callTopk short-circuits empty section_ids before the RPC fires (perf),
    // AND the fallback only triggers when sectionIdsScoped.length > 0.
    // So topk_v3 wasn't called at all on this path.
    const topkCalls = rpcCalls.filter((c) => c.name === '_creator_knowledge_topk_v3');
    expect(topkCalls.length).toBe(0);
  });
});

describe('retrieveKnowledgeV3 — rank-mode + topic tags propagation', () => {
  it('forwards p_rank_mode, p_lambda, p_topic_tags, p_top_s, p_n_parent_per_section, p_min_sim', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const { admin, rpcCalls } = buildAdminV3({
      routeRows: [makeRouteRow(0)],
      topkV3Rows: [makeRpcRowV3(0)],
    });
    await retrieveKnowledgeV3({
      ...BASE_ARGS,
      supabaseAdmin: admin,
      topicTags: ['topic-a', 'topic-b'],
      rankMode: 'vec_max',
      lambda: 0.25,
      topS: 7,
      nParentPerSection: 8,
      minSim: 0.42,
    });

    const routeCall = rpcCalls.find((c) => c.name === '_creator_route_sections_v3');
    expect(routeCall).toBeTruthy();
    const routeArgs = routeCall!.args as Record<string, unknown>;
    expect(routeArgs.p_topic_tags).toEqual(['topic-a', 'topic-b']);
    expect(routeArgs.p_top_s).toBe(7);

    const topkCall = rpcCalls.find((c) => c.name === '_creator_knowledge_topk_v3');
    const topkArgs = topkCall!.args as Record<string, unknown>;
    expect(topkArgs.p_rank_mode).toBe('vec_max');
    expect(topkArgs.p_lambda).toBe(0.25);
    expect(topkArgs.p_n_parent_per_section).toBe(8);
    expect(topkArgs.p_min_sim).toBe(0.42);
  });

  it('passes null p_topic_tags when none given (no soft boost)', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const { admin, rpcCalls } = buildAdminV3({
      routeRows: [makeRouteRow(0)],
      topkV3Rows: [makeRpcRowV3(0)],
    });
    await retrieveKnowledgeV3({ ...BASE_ARGS, supabaseAdmin: admin });
    const routeCall = rpcCalls.find((c) => c.name === '_creator_route_sections_v3');
    const routeArgs = routeCall!.args as Record<string, unknown>;
    expect(routeArgs.p_topic_tags).toBeNull();
  });
});

describe('retrieveKnowledgeV3 — cache HIT short-circuits before route', () => {
  it('returns cached parents + does NOT call route_sections', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const { admin, rpcCalls } = buildAdminV3({
      cacheLookupHit: {
        parent_unit_ids: ['pu-0', 'pu-1'],
        scores: [0.91, 0.74],
        age_seconds: 42,
        cached_row_id: 'crid',
      },
      parentFetchRows: [
        {
          id: 'pu-0',
          text: 'Cached parent 0 text',
          title: 'Cached 0',
          sample_content: { source_type: 'transcript' },
        },
        {
          id: 'pu-1',
          text: 'Cached parent 1 text',
          title: 'Cached 1',
          sample_content: { source_type: 'transcript' },
        },
      ],
    });
    const r = await retrieveKnowledgeV3({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.parents.length).toBe(2);
    expect(r.parents.every((p) => p.scoreSource === 'cache')).toBe(true);
    expect(r.sectionsRouted).toBe(0);
    expect(rpcCalls.find((c) => c.name === '_creator_route_sections_v3')).toBeUndefined();
    expect(rpcCalls.find((c) => c.name === '_creator_knowledge_topk_v3')).toBeUndefined();
  });
});

describe('retrieveKnowledgeV3 — telemetry shape', () => {
  it('records route leg + retrieve leg v3-specific fields', async () => {
    mockRewriteOk();
    mockEmbedOk();
    const { admin } = buildAdminV3({
      routeRows: [makeRouteRow(0, 0.95), makeRouteRow(1, 0.80), makeRouteRow(2, 0.78)],
      topkV3Rows: [makeRpcRowV3(0, 0.92), makeRpcRowV3(1, 0.81)],
    });
    const r = await retrieveKnowledgeV3({ ...BASE_ARGS, supabaseAdmin: admin });
    expect(r.telemetry.retrievalVersion).toBe(3);
    expect(r.telemetry.route).toBeTruthy();
    expect(r.telemetry.route?.sectionsReturned).toBe(3);
    expect(r.telemetry.route?.sectionTop1Score).toBeCloseTo(0.95, 5);
    expect(r.telemetry.route?.sectionTop1to2Gap).toBeCloseTo(0.15, 5);
    expect(r.telemetry.retrieve?.parentRankSource).toBe('max_blend');
    expect(r.telemetry.retrieve?.parentScoreTop1).toBeCloseTo(0.92, 5);
    expect(r.telemetry.retrieve?.candidatesFromScope).toBe(2);
  });
});
