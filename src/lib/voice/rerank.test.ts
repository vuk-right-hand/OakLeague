// rerank.test.ts — vitest for the Voyage rerank-2.5 bridge.
//
// Coverage:
//   1. Happy path: Voyage returns reranked indexes → mapped to candidate ids
//      in returned order, scores preserved, originalIndex preserved.
//   2. Returned topK clamped to candidates.length when caller asks more.
//   3. Empty candidates → fallback empty_candidates, no fetch call.
//   4. Empty query → fallback empty_response, no fetch call.
//   5. Budget exhausted (deadline already past) → fallback budget_exhausted.
//   6. Token-bucket overflow → fallback rate_limited, no fetch call.
//   7. Provider 429 → fallback rate_limited (with retry-after logged).
//   8. Provider 401 → fallback auth_failed (distinct from generic transport).
//   9. Provider 500 → fallback transport_error.
//  10. Fetch abort / timeout → fallback timeout.
//  11. Malformed JSON → fallback parse_error.
//  12. Voyage data=[] → fallback empty_response.
//  13. Voyage data has all-invalid rows → fallback parse_error.
//  14. Voyage out-of-range index → that row dropped, others kept.
//  15. Document text truncated to MAX_DOCUMENT_CHARS in request body.
//  16. Candidates above MAX_CANDIDATES truncated before request.
//  17. Bridge factory throws on RERANK_PROVIDER != 'voyage'.
//  18. Bridge factory returns Voyage bridge with correct provider/model.
//  19. voyageRerank throws RerankConfigError on missing API key.
//  20. Pass-through scores are NaN sentinels (not 0).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertProviderIsVoyage,
  getRerankBridge,
  RerankConfigError,
  VOYAGE_RERANK_MODEL,
  VOYAGE_RERANK_USD_PER_INPUT_TOKEN,
  _resetTokenBucketForTests,
  type RerankCandidate,
} from './rerank';

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  });
}

function textResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain', ...(headers ?? {}) },
  });
}

const APIKEY = 'pa-fake-test-key';

function farDeadline(): number {
  return Date.now() + 30_000;
}

function tightDeadline(): number {
  return Date.now() + 100; // < MIN_REMAINING_MS (500)
}

function cs(n: number, prefix = 'c'): RerankCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    text: `document number ${i} with some retrieval content`,
  }));
}

describe('getRerankBridge — factory', () => {
  it('returns Voyage bridge with correct provider/model when RERANK_PROVIDER=voyage', () => {
    const b = getRerankBridge();
    expect(b.provider).toBe('voyage');
    expect(b.modelId).toBe(VOYAGE_RERANK_MODEL);
    expect(b.usdPerInputToken).toBe(VOYAGE_RERANK_USD_PER_INPUT_TOKEN);
  });
});

describe('assertProviderIsVoyage — pure provider allowlist (Day-10 audit M1)', () => {
  it('accepts exactly "voyage"', () => {
    expect(() => assertProviderIsVoyage('voyage')).not.toThrow();
  });

  it('rejects "VOYAGE" (case mismatch — env hygiene is explicit)', () => {
    expect(() => assertProviderIsVoyage('VOYAGE')).toThrow(RerankConfigError);
    try {
      assertProviderIsVoyage('VOYAGE');
    } catch (e) {
      expect((e as RerankConfigError).code).toBe('provider_not_voyage');
    }
  });

  it('rejects "cohere"', () => {
    expect(() => assertProviderIsVoyage('cohere')).toThrow(RerankConfigError);
  });

  it('rejects empty string', () => {
    expect(() => assertProviderIsVoyage('')).toThrow(RerankConfigError);
  });

  it('error message quotes the bad value (diff-readable)', () => {
    try {
      assertProviderIsVoyage('voyageX');
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain("'voyageX'");
    }
  });
});

describe('voyageRerank — happy path', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetTokenBucketForTests();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps Voyage indexes back to candidate ids in returned order', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { index: 2, relevance_score: 0.91 },
          { index: 0, relevance_score: 0.72 },
          { index: 1, relevance_score: 0.41 },
        ],
        usage: { total_tokens: 1234 },
      }),
    );

    const bridge = getRerankBridge();
    const candidates = [
      { id: 'alpha', text: 'first doc' },
      { id: 'beta', text: 'second doc' },
      { id: 'gamma', text: 'third doc' },
    ];
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'what is the twins story',
      candidates,
      topK: 3,
      deadlineMs: farDeadline(),
    });

    expect(result.ok).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.reranked).toHaveLength(3);
    expect(result.reranked[0]).toEqual({ id: 'gamma', score: 0.91, originalIndex: 2 });
    expect(result.reranked[1]).toEqual({ id: 'alpha', score: 0.72, originalIndex: 0 });
    expect(result.reranked[2]).toEqual({ id: 'beta', score: 0.41, originalIndex: 1 });
    if (!result.fallback) {
      expect(result.inputTokens).toBe(1234);
      expect(result.provider).toBe('voyage');
      expect(result.modelId).toBe(VOYAGE_RERANK_MODEL);
    }
  });

  it('clamps topK to candidates.length when caller asks more', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { index: 1, relevance_score: 0.8 },
          { index: 0, relevance_score: 0.5 },
        ],
        usage: { total_tokens: 10 },
      }),
    );
    const bridge = getRerankBridge();
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: [
        { id: 'a', text: 'aa' },
        { id: 'b', text: 'bb' },
      ],
      topK: 99,
      deadlineMs: farDeadline(),
    });
    expect(result.fallback).toBe(false);
    expect(result.reranked).toHaveLength(2);
  });

  it('truncates document text to MAX_DOCUMENT_CHARS in request body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: [{ index: 0, relevance_score: 0.5 }], usage: { total_tokens: 1 } }),
    );
    const longText = 'x'.repeat(10_000);
    const bridge = getRerankBridge();
    await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: [{ id: 'a', text: longText }],
      topK: 1,
      deadlineMs: farDeadline(),
    });
    const body = JSON.parse((fetchMock.mock.calls as any[])[0][1].body) as {
      documents: string[];
    };
    expect(body.documents[0].length).toBeLessThanOrEqual(3500);
  });

  it('truncates candidates above MAX_CANDIDATES (25) before request', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: [{ index: 0, relevance_score: 0.5 }], usage: { total_tokens: 1 } }),
    );
    const bridge = getRerankBridge();
    await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: cs(75),
      topK: 5,
      deadlineMs: farDeadline(),
    });
    const body = JSON.parse((fetchMock.mock.calls as any[])[0][1].body) as {
      documents: string[];
    };
    expect(body.documents.length).toBeLessThanOrEqual(25);
  });

  it('filters empty-text candidates before send (Day-10 audit S5)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: [{ index: 0, relevance_score: 0.5 }], usage: { total_tokens: 1 } }),
    );
    const bridge = getRerankBridge();
    const candidates: RerankCandidate[] = [
      { id: 'a', text: '' }, // filtered
      { id: 'b', text: 'real text' }, // kept (becomes index 0)
      { id: 'c', text: '' }, // filtered
      { id: 'd', text: 'more text' }, // kept (becomes index 1)
    ];
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates,
      topK: 5,
      deadlineMs: farDeadline(),
    });
    const body = JSON.parse((fetchMock.mock.calls as any[])[0][1].body) as {
      documents: string[];
    };
    expect(body.documents).toEqual(['real text', 'more text']);
    // Voyage returned index 0 → maps to filtered-list[0] = candidate 'b'.
    expect(result.fallback).toBe(false);
    expect(result.reranked[0].id).toBe('b');
  });

  it('coerces NaN/Infinity topK to candidates.length (Day-10 audit S4)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { index: 0, relevance_score: 0.9 },
          { index: 1, relevance_score: 0.5 },
        ],
        usage: { total_tokens: 1 },
      }),
    );
    const bridge = getRerankBridge();
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: cs(2),
      topK: Number.NaN,
      deadlineMs: farDeadline(),
    });
    expect(result.fallback).toBe(false);
    expect(result.reranked).toHaveLength(2);
  });

  it('sends Bearer auth header + correct URL + JSON body shape', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: [{ index: 0, relevance_score: 0.5 }], usage: { total_tokens: 1 } }),
    );
    const bridge = getRerankBridge();
    await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'twins',
      candidates: [{ id: 'a', text: 'aa' }],
      topK: 1,
      deadlineMs: farDeadline(),
    });
    const url = (fetchMock.mock.calls as any[])[0][0];
    const init = (fetchMock.mock.calls as any[])[0][1];
    expect(url).toBe('https://api.voyageai.com/v1/rerank');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${APIKEY}`);
    expect(init.headers['content-type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.query).toBe('twins');
    expect(body.model).toBe(VOYAGE_RERANK_MODEL);
    expect(body.top_k).toBe(1);
    expect(body.return_documents).toBe(false);
    expect(body.truncation).toBe(true);
  });
});

describe('voyageRerank — fallback paths (no fetch)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetTokenBucketForTests();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('empty candidates → empty_candidates, no fetch', async () => {
    const bridge = getRerankBridge();
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: [],
      topK: 3,
      deadlineMs: farDeadline(),
    });
    expect(result.fallback).toBe(true);
    if (result.fallback) expect(result.fallbackReason).toBe('empty_candidates');
    expect(result.reranked).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('empty query → fallback with passthrough, no fetch', async () => {
    const bridge = getRerankBridge();
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: '   ',
      candidates: cs(3),
      topK: 2,
      deadlineMs: farDeadline(),
    });
    expect(result.fallback).toBe(true);
    expect(result.reranked).toHaveLength(2);
    expect(result.reranked[0].id).toBe('c0');
    expect(result.reranked[1].id).toBe('c1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('budget exhausted (deadline in past) → budget_exhausted, no fetch', async () => {
    const bridge = getRerankBridge();
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: cs(3),
      topK: 2,
      deadlineMs: tightDeadline(),
    });
    expect(result.fallback).toBe(true);
    if (result.fallback) expect(result.fallbackReason).toBe('budget_exhausted');
    expect(result.reranked).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pass-through scores are monotonic decreasing in (0, 1] (Day-10 audit C3)', async () => {
    const bridge = getRerankBridge();
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: cs(4),
      topK: 4,
      deadlineMs: tightDeadline(),
    });
    expect(result.fallback).toBe(true);
    expect(result.reranked).toHaveLength(4);
    // First score is 1.0 (i=0, 1 - 0/4); decreases by 0.25 each step.
    expect(result.reranked[0].score).toBeCloseTo(1.0, 5);
    expect(result.reranked[1].score).toBeCloseTo(0.75, 5);
    expect(result.reranked[2].score).toBeCloseTo(0.5, 5);
    expect(result.reranked[3].score).toBeCloseTo(0.25, 5);
    // Verify strict monotonic decreasing — survives downstream sort/filter.
    for (let i = 1; i < result.reranked.length; i++) {
      expect(result.reranked[i].score).toBeLessThan(result.reranked[i - 1].score);
    }
    expect(result.reranked.every((r) => Number.isFinite(r.score))).toBe(true);
  });
});

describe('voyageRerank — provider errors map to typed fallbacks', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetTokenBucketForTests();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    warnSpy.mockRestore();
  });

  it('provider 401 → auth_failed', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(401, 'unauthorized'));
    const bridge = getRerankBridge();
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: cs(3),
      topK: 3,
      deadlineMs: farDeadline(),
    });
    expect(result.fallback).toBe(true);
    if (result.fallback) expect(result.fallbackReason).toBe('auth_failed');
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0][0] as string;
    expect(warnMsg).toContain('auth_failed');
  });

  it('provider 403 → auth_failed', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(403, 'forbidden'));
    const bridge = getRerankBridge();
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: cs(2),
      topK: 2,
      deadlineMs: farDeadline(),
    });
    expect(result.fallback).toBe(true);
    if (result.fallback) expect(result.fallbackReason).toBe('auth_failed');
  });

  it('provider 429 → rate_limited (passes through retry-after to log)', async () => {
    fetchMock.mockResolvedValueOnce(
      textResponse(429, 'slow down', { 'retry-after': '5' }),
    );
    const bridge = getRerankBridge();
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: cs(3),
      topK: 3,
      deadlineMs: farDeadline(),
    });
    expect(result.fallback).toBe(true);
    if (result.fallback) expect(result.fallbackReason).toBe('rate_limited');
    const warnMsg = warnSpy.mock.calls[0][0] as string;
    expect(warnMsg).toContain('retry_after=5');
  });

  it('provider 500 → transport_error', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(500, 'oh no'));
    const bridge = getRerankBridge();
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: cs(2),
      topK: 2,
      deadlineMs: farDeadline(),
    });
    expect(result.fallback).toBe(true);
    if (result.fallback) expect(result.fallbackReason).toBe('transport_error');
  });

  it('fetch throws AbortError → timeout', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(abortErr);
    const bridge = getRerankBridge();
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: cs(2),
      topK: 2,
      deadlineMs: farDeadline(),
    });
    expect(result.fallback).toBe(true);
    if (result.fallback) expect(result.fallbackReason).toBe('timeout');
  });

  it('real AbortSignal integration: hung fetch is aborted at callTimeout (Day-10 audit S10)', async () => {
    // fetch that respects AbortSignal — wait forever unless aborted.
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const signal = init.signal;
          if (!signal) return; // shouldn't happen — our code always passes one
          if (signal.aborted) {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
            return;
          }
          signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    );

    const bridge = getRerankBridge();
    // Deadline 600ms ahead — well below the 2000ms hard cap so the
    // computed callTimeout = ~600ms. The hung fetch must abort by then.
    const start = Date.now();
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: cs(2),
      topK: 2,
      deadlineMs: Date.now() + 600,
    });
    const elapsed = Date.now() - start;
    expect(result.fallback).toBe(true);
    if (result.fallback) expect(result.fallbackReason).toBe('timeout');
    // Belt-and-suspenders: we DID actually wait for the abort, not fall
    // back synchronously via budget check. Range allows for CI jitter.
    expect(elapsed).toBeGreaterThan(400);
    expect(elapsed).toBeLessThan(1500);
  });

  it('fetch throws non-abort Error → transport_error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const bridge = getRerankBridge();
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: cs(2),
      topK: 2,
      deadlineMs: farDeadline(),
    });
    expect(result.fallback).toBe(true);
    if (result.fallback) expect(result.fallbackReason).toBe('transport_error');
  });

  it('200 with malformed JSON → parse_error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('not json {{{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const bridge = getRerankBridge();
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: cs(2),
      topK: 2,
      deadlineMs: farDeadline(),
    });
    expect(result.fallback).toBe(true);
    if (result.fallback) expect(result.fallbackReason).toBe('parse_error');
  });

  it('200 with empty data array → empty_response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: [], usage: { total_tokens: 0 } }),
    );
    const bridge = getRerankBridge();
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: cs(2),
      topK: 2,
      deadlineMs: farDeadline(),
    });
    expect(result.fallback).toBe(true);
    if (result.fallback) expect(result.fallbackReason).toBe('empty_response');
  });

  it('200 with all-invalid rows → parse_error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { index: 'wrong-type', relevance_score: 0.5 },
          { relevance_score: 'not-a-number' },
        ],
        usage: { total_tokens: 1 },
      }),
    );
    const bridge = getRerankBridge();
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: cs(2),
      topK: 2,
      deadlineMs: farDeadline(),
    });
    expect(result.fallback).toBe(true);
    if (result.fallback) expect(result.fallbackReason).toBe('parse_error');
  });

  it('out-of-range index dropped, valid rows kept', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { index: 99, relevance_score: 0.9 }, // OOR for 3-cand input
          { index: 1, relevance_score: 0.7 },
          { index: -1, relevance_score: 0.3 }, // negative
          { index: 0, relevance_score: 0.2 },
        ],
        usage: { total_tokens: 1 },
      }),
    );
    const bridge = getRerankBridge();
    const result = await bridge.rerank({
      voyageApiKey: APIKEY,
      query: 'q',
      candidates: cs(3),
      topK: 3,
      deadlineMs: farDeadline(),
    });
    expect(result.fallback).toBe(false);
    expect(result.reranked).toHaveLength(2);
    expect(result.reranked[0]).toEqual({ id: 'c1', score: 0.7, originalIndex: 1 });
    expect(result.reranked[1]).toEqual({ id: 'c0', score: 0.2, originalIndex: 0 });
  });
});

describe('voyageRerank — config errors', () => {
  beforeEach(() => {
    _resetTokenBucketForTests();
  });

  it('missing voyageApiKey throws RerankConfigError', async () => {
    const bridge = getRerankBridge();
    await expect(
      bridge.rerank({
        voyageApiKey: '',
        query: 'q',
        candidates: cs(2),
        topK: 2,
        deadlineMs: farDeadline(),
      }),
    ).rejects.toThrow(RerankConfigError);
  });

  it('missing voyageApiKey error has code=api_key_missing', async () => {
    const bridge = getRerankBridge();
    try {
      await bridge.rerank({
        voyageApiKey: '',
        query: 'q',
        candidates: cs(1),
        topK: 1,
        deadlineMs: farDeadline(),
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RerankConfigError);
      expect((e as RerankConfigError).code).toBe('api_key_missing');
    }
  });
});

describe('boot guards — env validation rejects bad values (Day-10 audit S9)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // Dynamic-import-then-throw works because rerank.ts's boot IIFE runs at
  // import time. vi.resetModules() ensures each test re-evaluates the
  // module body. We use a relative string variable to keep tsc happy
  // (vs query-string cache busters which tsc rejects as Cannot-find-module).
  const modulePath = './rerank';

  it('rejects VOYAGE_RERANK_MODEL=rerank-latest at module load', async () => {
    vi.stubEnv('VOYAGE_RERANK_MODEL', 'rerank-latest');
    await expect(import(modulePath)).rejects.toThrow(/VOYAGE_RERANK_MODEL invalid/);
  });

  it('rejects VOYAGE_RERANK_MODEL=rerank-preview (undated -preview)', async () => {
    vi.stubEnv('VOYAGE_RERANK_MODEL', 'rerank-preview');
    await expect(import(modulePath)).rejects.toThrow(/VOYAGE_RERANK_MODEL invalid/);
  });

  it('accepts VOYAGE_RERANK_MODEL=rerank-preview-2025-01-15 (dated -preview)', async () => {
    vi.stubEnv('VOYAGE_RERANK_MODEL', 'rerank-preview-2025-01-15');
    await expect(import(modulePath)).resolves.toBeDefined();
  });

  it('whitespace-only VOYAGE_RERANK_USD_PER_INPUT_TOKEN falls through to default (Day-10 audit C4 whitespace)', async () => {
    vi.stubEnv('VOYAGE_RERANK_USD_PER_INPUT_TOKEN', '   ');
    // Whitespace-only env trims to empty → falls through to default
    // 0.00000005 which is positive. Confirms .trim() defense works.
    await expect(import(modulePath)).resolves.toBeDefined();
  });

  it('rejects VOYAGE_RERANK_USD_PER_INPUT_TOKEN=0', async () => {
    vi.stubEnv('VOYAGE_RERANK_USD_PER_INPUT_TOKEN', '0');
    await expect(import(modulePath)).rejects.toThrow(/VOYAGE_RERANK_USD_PER_INPUT_TOKEN/);
  });

  it('rejects VOYAGE_RERANK_RPS_BUCKET=-5', async () => {
    vi.stubEnv('VOYAGE_RERANK_RPS_BUCKET', '-5');
    await expect(import(modulePath)).rejects.toThrow(/VOYAGE_RERANK_RPS_BUCKET/);
  });
});

describe('voyageRerank — token bucket', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetTokenBucketForTests();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    warnSpy.mockRestore();
  });

  it('token-bucket overflow → fallback rate_limited, no fetch', async () => {
    // Use mockImplementation so each concurrent call gets a FRESH Response.
    // (mockResolvedValue reuses the same Response object, and its body
    // stream can only be consumed once → second .json() fails → spurious
    // parse_error masquerading as bucket overflow.)
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, { data: [{ index: 0, relevance_score: 0.5 }], usage: { total_tokens: 1 } }),
    );

    const bridge = getRerankBridge();
    _resetTokenBucketForTests();

    // 50 concurrent calls — bucket capacity is 25. Refill rate 0.025/ms;
    // queue tolerance 200ms → ~5 extra tokens during the wait. Remaining
    // ~20 must overflow into rate_limited fallback.
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        bridge.rerank({
          voyageApiKey: APIKEY,
          query: 'q',
          candidates: cs(1),
          topK: 1,
          deadlineMs: farDeadline(),
        }),
      ),
    );
    const fallbacks = results.filter((r) => r.fallback);
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const r of fallbacks) {
      if (r.fallback) expect(r.fallbackReason).toBe('rate_limited');
    }
    // And the non-fallback ones must be real successes (not other fallback types).
    const successes = results.filter((r) => !r.fallback);
    expect(successes.length).toBeGreaterThan(0);
  });
});
