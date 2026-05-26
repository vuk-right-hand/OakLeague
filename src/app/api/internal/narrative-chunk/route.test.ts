// /api/internal/narrative-chunk route tests.
//
// Coverage:
//   * Auth + body validation (same shape as preprocess + contextual-gen)
//   * Happy path: returns units, attempt, ms
//   * Fallback path: lib returns null → 200 with units:null + message
//   * empty_input → 400
//   * api_key_missing → 500 misconfigured + Sentry fatal

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { mockNarrativeChunk, mockSentryCapture } = vi.hoisted(() => ({
  mockNarrativeChunk: vi.fn(),
  mockSentryCapture: vi.fn(),
}));

vi.mock('@/lib/voice/narrative-chunk', async () => {
  const actual = await vi.importActual<typeof import('@/lib/voice/narrative-chunk')>(
    '@/lib/voice/narrative-chunk',
  );
  return {
    ...actual,
    narrativeChunk: mockNarrativeChunk,
  };
});

vi.mock('@sentry/nextjs', () => ({
  captureException: mockSentryCapture,
  setTag: vi.fn(),
  setContext: vi.fn(),
}));

import { POST } from './route';
import { NarrativeChunkError } from '@/lib/voice/narrative-chunk';

const VALID_SECRET = 'a'.repeat(48);
const TEST_CREATOR_ID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  mockNarrativeChunk.mockReset();
  mockSentryCapture.mockReset();
  process.env.INTERNAL_API_SECRET = VALID_SECRET;
});

afterEach(() => {
  delete process.env.INTERNAL_API_SECRET;
  vi.restoreAllMocks();
});

function mkReq(opts: { body?: unknown; bodyText?: string; bearer?: string }): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.bearer !== undefined) headers['authorization'] = opts.bearer;
  const body =
    opts.bodyText !== undefined
      ? opts.bodyText
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;
  return new Request('http://localhost/api/internal/narrative-chunk', {
    method: 'POST',
    headers,
    body,
  }) as unknown as NextRequest;
}

function authed(body: unknown) {
  return mkReq({ body, bearer: `Bearer ${VALID_SECRET}` });
}

const goodBody = {
  creator_id: TEST_CREATOR_ID,
  sanitized_doc: 'This is a sample doc body about the twins.',
  sample_title: 'My talk',
};

const goodResult = {
  units: [
    { title: 'The Twins Story', text: 'Two twins walked into a bar...' },
    { title: 'Why Sleep Wins', text: 'After a year of cutting sleep...' },
  ],
  attempt: 1 as 1 | 2,
  ms: 432,
  usage: {
    prompt_token_count: 1200,
    candidates_token_count: 180,
    total_token_count: 1380,
  },
};


// ── Auth ──────────────────────────────────────────────────────────────────

describe('POST /api/internal/narrative-chunk — auth', () => {
  it('401 on missing bearer', async () => {
    const res = await POST(mkReq({ body: goodBody }));
    expect(res.status).toBe(401);
  });

  it('500 misconfigured when INTERNAL_API_SECRET unset', async () => {
    delete process.env.INTERNAL_API_SECRET;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(authed(goodBody));
    expect(res.status).toBe(500);
    errSpy.mockRestore();
  });
});


// ── Body validation ──────────────────────────────────────────────────────

describe('POST /api/internal/narrative-chunk — body validation', () => {
  it('400 for non-UUID creator_id', async () => {
    const res = await POST(authed({ ...goodBody, creator_id: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('400 for missing sanitized_doc', async () => {
    const res = await POST(authed({ creator_id: TEST_CREATOR_ID }));
    expect(res.status).toBe(400);
  });

  it('400 for empty sanitized_doc', async () => {
    const res = await POST(authed({ creator_id: TEST_CREATOR_ID, sanitized_doc: '' }));
    expect(res.status).toBe(400);
  });
});


// ── Happy path ───────────────────────────────────────────────────────────

describe('POST /api/internal/narrative-chunk — happy path', () => {
  it('returns units + attempt + ms + usage + request_id when lib succeeds', async () => {
    mockNarrativeChunk.mockResolvedValueOnce(goodResult);
    const res = await POST(authed(goodBody));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      units: Array<{ title: string; text: string }>;
      attempt: number;
      ms: number;
      usage: {
        prompt_token_count: number;
        candidates_token_count: number;
        total_token_count: number;
      };
      request_id: string;
      retryable: boolean;
    };
    expect(json.units).toHaveLength(2);
    expect(json.units[0].title).toBe('The Twins Story');
    expect(json.attempt).toBe(1);
    expect(json.ms).toBe(432);
    // Day-5-audit C2: usage forwarded to the worker so cogs_log can attribute spend.
    expect(json.usage.prompt_token_count).toBe(1200);
    expect(json.usage.candidates_token_count).toBe(180);
    expect(json.usage.total_token_count).toBe(1380);
    expect(typeof json.request_id).toBe('string');
    expect(json.retryable).toBe(false);
  });

  it('passes sanitized_doc + sample_title through to the lib', async () => {
    mockNarrativeChunk.mockResolvedValueOnce(goodResult);
    await POST(authed(goodBody));
    expect(mockNarrativeChunk).toHaveBeenCalledWith({
      sanitizedDocument: goodBody.sanitized_doc,
      sampleTitle: goodBody.sample_title,
    });
  });

  it('returns 200 + units:null when lib returns null (fallback signal to worker)', async () => {
    mockNarrativeChunk.mockResolvedValueOnce(null);
    const res = await POST(authed(goodBody));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      units: null;
      message: string;
      retryable: boolean;
    };
    expect(json.units).toBeNull();
    expect(json.message).toBe('fallback_to_v1_chunker');
    expect(json.retryable).toBe(false);
  });
});


// ── Error mapping ────────────────────────────────────────────────────────

describe('POST /api/internal/narrative-chunk — error mapping', () => {
  it('400 empty_input when lib throws NarrativeChunkError(empty_input)', async () => {
    mockNarrativeChunk.mockRejectedValueOnce(
      new NarrativeChunkError('empty_input', 1, 'empty'),
    );
    const res = await POST(authed(goodBody));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; retryable: boolean };
    expect(json.error).toBe('empty_input');
    expect(json.retryable).toBe(false);
  });

  it('500 misconfigured + Sentry fatal on api_key_missing', async () => {
    mockNarrativeChunk.mockRejectedValueOnce(
      new NarrativeChunkError('api_key_missing', 1, 'no key'),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(authed(goodBody));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string; retryable: boolean };
    expect(json.error).toBe('misconfigured');
    expect(json.retryable).toBe(false);
    expect(mockSentryCapture).toHaveBeenCalled();
    const opts = mockSentryCapture.mock.calls[0][1] as { level: string };
    expect(opts.level).toBe('fatal');
    errSpy.mockRestore();
  });

  it('500 internal_error on unknown thrown value', async () => {
    mockNarrativeChunk.mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(authed(goodBody));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string; retryable: boolean };
    expect(json.error).toBe('internal_error');
    expect(json.retryable).toBe(true);
    errSpy.mockRestore();
  });
});
