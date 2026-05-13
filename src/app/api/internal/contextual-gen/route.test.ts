// /api/internal/contextual-gen route tests.
//
// Coverage:
//   * Auth: missing / wrong / too-short bearer → 401 (or 500 for misconfig)
//   * Body validation: invalid JSON / missing fields / oversize → 400
//   * Happy path: 200 with chunk_context + ms + usage
//   * Error mapping: rate_limit → 429, timeout → 504, invalid_response → 502,
//     auth_error → 500 (not 401 — caller's bearer was fine)
//
// Approach: mock the library (`generateChunkContext`) so the route tests
// the HTTP-boundary logic, not the Anthropic call path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// `vi.mock` is hoisted ABOVE the imports, so any vars it references must
// be hoisted too — use vi.hoisted so the mock fns exist by the time the
// mock factory runs.
const { mockGenerate, mockSentryCapture, mockSentrySetTag } = vi.hoisted(() => ({
  mockGenerate: vi.fn(),
  mockSentryCapture: vi.fn(),
  mockSentrySetTag: vi.fn(),
}));

vi.mock('@/lib/voice/contextual-retrieval', async () => {
  const actual = await vi.importActual<typeof import('@/lib/voice/contextual-retrieval')>(
    '@/lib/voice/contextual-retrieval',
  );
  return {
    ...actual,
    generateChunkContext: mockGenerate,
  };
});

// Mock Sentry so we can assert capture behavior without initializing a real
// Sentry client. Day-4-audit C3 verification.
vi.mock('@sentry/nextjs', () => ({
  captureException: mockSentryCapture,
  setTag: mockSentrySetTag,
  setContext: vi.fn(),
}));

import { POST } from './route';
import {
  ContextualRetrievalError,
  MAX_DOC_CHARS,
  MAX_CHUNK_CHARS,
} from '@/lib/voice/contextual-retrieval';

const VALID_SECRET = 'a'.repeat(48);
const TEST_CREATOR_ID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  mockGenerate.mockReset();
  mockSentryCapture.mockReset();
  mockSentrySetTag.mockReset();
  process.env.INTERNAL_API_SECRET = VALID_SECRET;
});

afterEach(() => {
  delete process.env.INTERNAL_API_SECRET;
  vi.restoreAllMocks();
});


// ── Helpers ───────────────────────────────────────────────────────────────

function mkReq(opts: {
  body?: unknown;
  bodyText?: string;
  bearer?: string;
}): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.bearer !== undefined) headers['authorization'] = opts.bearer;
  const body =
    opts.bodyText !== undefined
      ? opts.bodyText
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;
  return new Request('http://localhost/api/internal/contextual-gen', {
    method: 'POST',
    headers,
    body,
  }) as unknown as NextRequest;
}

const goodBody = {
  creator_id: TEST_CREATOR_ID,
  doc: 'This is the full document.',
  chunk_text: 'This is one chunk of it.',
  sample_title: 'Vuk\'s talk',
};

const goodResult = {
  chunkContext: 'Chunk discusses the document\'s key point.',
  usage: {
    cache_creation_1h_input_tokens: 100,
    cache_read_input_tokens: 0,
    uncached_input_tokens: 50,
    output_tokens: 12,
  },
  ms: 423,
  stopReason: 'end_turn' as string | null,
  requestId: 'req_test_abc' as string | null,
};


// ── Auth ──────────────────────────────────────────────────────────────────

describe('POST /api/internal/contextual-gen — auth', () => {
  it('returns 401 + retryable:false + request_id when Authorization header is missing', async () => {
    const res = await POST(mkReq({ body: goodBody }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string; retryable: boolean; request_id: string };
    expect(json.error).toBe('unauthorized');
    expect(json.retryable).toBe(false);
    expect(typeof json.request_id).toBe('string');
    expect(json.request_id.length).toBeGreaterThan(0);
  });

  it('returns 401 when bearer is wrong', async () => {
    const res = await POST(mkReq({ body: goodBody, bearer: 'Bearer not-the-secret' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when bearer is the wrong length (constant-time bail)', async () => {
    const res = await POST(mkReq({ body: goodBody, bearer: 'Bearer short' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when bearer is empty but env is valid (S16 tightened — auth path must fire)', async () => {
    // Audit-7 S16: previous test asserted 500 on env-empty-AND-bearer-empty,
    // which proves the env-check fires, not the auth-check. This case
    // proves the AUTH check correctly rejects an empty bearer (with valid
    // env), which is the actual R5-M5-class concern.
    const res = await POST(mkReq({ body: goodBody, bearer: 'Bearer ' }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('unauthorized');
  });

  it('returns 500 misconfigured when INTERNAL_API_SECRET is unset', async () => {
    delete process.env.INTERNAL_API_SECRET;
    const res = await POST(mkReq({ body: goodBody, bearer: `Bearer ${VALID_SECRET}` }));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string; retryable: boolean };
    expect(json.error).toBe('misconfigured');
    expect(json.retryable).toBe(false);
  });

  it('captures misconfigured env to Sentry (Day-4-audit C3)', async () => {
    delete process.env.INTERNAL_API_SECRET;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await POST(mkReq({ body: goodBody, bearer: `Bearer ${VALID_SECRET}` }));
    expect(mockSentryCapture).toHaveBeenCalled();
    const callArgs = mockSentryCapture.mock.calls[0];
    const opts = callArgs[1] as { level: string; tags: { stage: string } };
    expect(opts.level).toBe('fatal');
    expect(opts.tags.stage).toBe('auth_env');
    errSpy.mockRestore();
  });

  it('returns 500 misconfigured when INTERNAL_API_SECRET is too short (< 32)', async () => {
    process.env.INTERNAL_API_SECRET = 'too-short';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(mkReq({ body: goodBody, bearer: `Bearer ${VALID_SECRET}` }));
    expect(res.status).toBe(500);
    errSpy.mockRestore();
  });

  it('does NOT bypass auth when both env and bearer are empty (R5-M5 class bug)', async () => {
    // The cron-route precedent: empty secret accepting empty bearer would
    // be a wildcard auth bypass. Env check throws first → 500 misconfigured.
    process.env.INTERNAL_API_SECRET = '';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(mkReq({ body: goodBody, bearer: 'Bearer ' }));
    expect(res.status).toBe(500);
    errSpy.mockRestore();
  });
});


// ── Body validation ──────────────────────────────────────────────────────

describe('POST /api/internal/contextual-gen — body validation', () => {
  function authed(body?: unknown, bodyText?: string) {
    return mkReq({ body, bodyText, bearer: `Bearer ${VALID_SECRET}` });
  }

  it('returns 400 invalid_json for non-JSON body', async () => {
    const res = await POST(authed(undefined, 'not-json-at-all'));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; retryable: boolean };
    expect(json.error).toBe('invalid_json');
    expect(json.retryable).toBe(false);
  });

  it('returns 400 invalid_body for missing creator_id (Day-4-audit C5)', async () => {
    const res = await POST(authed({ doc: 'D', chunk_text: 'C' }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('invalid_body');
  });

  it('returns 400 invalid_body for malformed creator_id (not a UUID)', async () => {
    const res = await POST(authed({
      creator_id: 'not-a-uuid',
      doc: 'D',
      chunk_text: 'C',
    }));
    expect(res.status).toBe(400);
  });

  it('returns 400 invalid_body for missing doc', async () => {
    const res = await POST(authed({ creator_id: TEST_CREATOR_ID, chunk_text: 'C' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 invalid_body for empty doc', async () => {
    const res = await POST(authed({ creator_id: TEST_CREATOR_ID, doc: '', chunk_text: 'C' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 invalid_body for missing chunk_text', async () => {
    const res = await POST(authed({ creator_id: TEST_CREATOR_ID, doc: 'D' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 invalid_body for doc > MAX_DOC_CHARS', async () => {
    const res = await POST(authed({
      creator_id: TEST_CREATOR_ID,
      doc: 'a'.repeat(MAX_DOC_CHARS + 1),
      chunk_text: 'C',
    }));
    expect(res.status).toBe(400);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_body for chunk > MAX_CHUNK_CHARS', async () => {
    const res = await POST(authed({
      creator_id: TEST_CREATOR_ID,
      doc: 'D',
      chunk_text: 'a'.repeat(MAX_CHUNK_CHARS + 1),
    }));
    expect(res.status).toBe(400);
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});


// ── Happy path ───────────────────────────────────────────────────────────

describe('POST /api/internal/contextual-gen — happy path', () => {
  it('returns 200 with chunk_context + usage + ms + stop_reason + request_id + anthropic_request_id', async () => {
    mockGenerate.mockResolvedValueOnce(goodResult);

    const res = await POST(mkReq({
      body: goodBody,
      bearer: `Bearer ${VALID_SECRET}`,
    }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      chunk_context: string;
      usage: { cache_creation_1h_input_tokens: number };
      ms: number;
      stop_reason: string | null;
      request_id: string;
      anthropic_request_id: string | null;
      retryable: boolean;
    };
    expect(json.chunk_context).toBe(goodResult.chunkContext);
    expect(json.usage.cache_creation_1h_input_tokens).toBe(100);
    expect(json.ms).toBe(423);
    expect(json.stop_reason).toBe('end_turn');
    expect(json.request_id).toBeTruthy();
    expect(json.request_id.length).toBeGreaterThan(0);
    expect(json.anthropic_request_id).toBe('req_test_abc');
    expect(json.retryable).toBe(false);  // success carries this for shape symmetry
  });

  it('passes sanitized inputs through to the library (no double-sanitize at boundary)', async () => {
    mockGenerate.mockResolvedValueOnce(goodResult);

    await POST(mkReq({
      body: goodBody,
      bearer: `Bearer ${VALID_SECRET}`,
    }));

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledWith({
      sanitizedDoc: goodBody.doc,
      sanitizedChunk: goodBody.chunk_text,
      sampleTitle: goodBody.sample_title,
    });
  });

  it('sets cache-control: no-store on the response (defense in depth)', async () => {
    mockGenerate.mockResolvedValueOnce(goodResult);
    const res = await POST(mkReq({
      body: goodBody,
      bearer: `Bearer ${VALID_SECRET}`,
    }));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('tags Sentry with the creator_id for correlation (Day-4-audit C5 + M9)', async () => {
    mockGenerate.mockResolvedValueOnce(goodResult);
    await POST(mkReq({
      body: goodBody,
      bearer: `Bearer ${VALID_SECRET}`,
    }));
    const tags = mockSentrySetTag.mock.calls.map((c) => c[0]);
    expect(tags).toContain('creator_id');
    expect(tags).toContain('request_id');
  });
});


// ── Error mapping ────────────────────────────────────────────────────────

describe('POST /api/internal/contextual-gen — error mapping', () => {
  function authed(body: unknown = goodBody) {
    return mkReq({ body, bearer: `Bearer ${VALID_SECRET}` });
  }

  it('maps rate_limit → 429 + retryable:true + retry-after header (Day-4-audit M6)', async () => {
    mockGenerate.mockRejectedValueOnce(
      new ContextualRetrievalError('rate_limit', 'too many requests', 429, {
        retryAfterMs: 15_000,
        requestId: 'req_429',
      }),
    );
    const res = await POST(authed());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('15');
    const json = (await res.json()) as {
      error: string;
      retryable: boolean;
      retry_after_ms: number;
      anthropic_request_id: string;
    };
    expect(json.error).toBe('rate_limit');
    expect(json.retryable).toBe(true);
    expect(json.retry_after_ms).toBe(15_000);
    expect(json.anthropic_request_id).toBe('req_429');
  });

  it('rate_limit without retryAfterMs omits the retry-after header (no fake value)', async () => {
    mockGenerate.mockRejectedValueOnce(
      new ContextualRetrievalError('rate_limit', 'no header', 429),
    );
    const res = await POST(authed());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeNull();
    const json = (await res.json()) as { retry_after_ms: number | null };
    expect(json.retry_after_ms).toBeNull();
  });

  it('maps timeout → 504 + retryable:true', async () => {
    mockGenerate.mockRejectedValueOnce(
      new ContextualRetrievalError('timeout', 'haiku_timeout_30000ms'),
    );
    const res = await POST(authed());
    expect(res.status).toBe(504);
    const json = (await res.json()) as { retryable: boolean };
    expect(json.retryable).toBe(true);
  });

  it('maps invalid_response → 502 + retryable:true', async () => {
    mockGenerate.mockRejectedValueOnce(
      new ContextualRetrievalError('invalid_response', 'empty'),
    );
    const res = await POST(authed());
    expect(res.status).toBe(502);
    const json = (await res.json()) as { retryable: boolean };
    expect(json.retryable).toBe(true);
  });

  it('maps auth_error → 500 upstream_auth_error + retryable:FALSE (Day-4-audit C2)', async () => {
    // Critical: auth_error from Anthropic means OUR Anthropic key is bad.
    // Returning 401 would tell the worker to retry-storm thinking the
    // caller's INTERNAL_API_SECRET was rotated. We surface as 500 AND tell
    // the worker NOT to retry (retryable:false) — this is the C2 fix.
    mockGenerate.mockRejectedValueOnce(
      new ContextualRetrievalError('auth_error', 'bad anthropic key', 401),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(authed());
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string; retryable: boolean };
    expect(json.error).toBe('upstream_auth_error');
    expect(json.retryable).toBe(false);  // Critical contract for worker.
    expect(mockSentryCapture).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('maps anthropic_error → 500 + retryable:true', async () => {
    mockGenerate.mockRejectedValueOnce(
      new ContextualRetrievalError('anthropic_error', '5xx', 500),
    );
    const res = await POST(authed());
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string; retryable: boolean };
    expect(json.error).toBe('anthropic_error');
    expect(json.retryable).toBe(true);
    expect(mockSentryCapture).toHaveBeenCalled();
  });

  it('maps input_too_large from library → 400 + retryable:false', async () => {
    mockGenerate.mockRejectedValueOnce(
      new ContextualRetrievalError('input_too_large', 'exceeded'),
    );
    const res = await POST(authed());
    expect(res.status).toBe(400);
    const json = (await res.json()) as { retryable: boolean };
    expect(json.retryable).toBe(false);
  });

  it('every error response includes request_id for cross-hop correlation (Day-4-audit M9)', async () => {
    mockGenerate.mockRejectedValueOnce(
      new ContextualRetrievalError('anthropic_error', '5xx', 500),
    );
    const res = await POST(authed());
    const json = (await res.json()) as { request_id: string };
    expect(typeof json.request_id).toBe('string');
    expect(json.request_id.length).toBeGreaterThan(0);
  });

  it('returns 500 internal_error + retryable:true on unknown thrown value', async () => {
    mockGenerate.mockRejectedValueOnce(new Error('something exploded'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(authed());
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string; retryable: boolean };
    expect(json.error).toBe('internal_error');
    expect(json.retryable).toBe(true);
    expect(mockSentryCapture).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
