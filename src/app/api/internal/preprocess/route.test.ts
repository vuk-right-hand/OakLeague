// /api/internal/preprocess route tests.
//
// Coverage:
//   * Auth: missing / wrong bearer → 401; missing env → 500 misconfigured
//   * Body validation: missing fields / non-UUID creator_id / oversize → 400
//   * Happy path: returns sanitized_text, ms, request_id, retryable:false
//   * Sanitization correctness: envelope tags stripped from output
//   * Empty-after-sanitize → 400
//   * Cache-control: no-store header

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  setTag: vi.fn(),
  setContext: vi.fn(),
}));

import { POST } from './route';

const VALID_SECRET = 'a'.repeat(48);
const TEST_CREATOR_ID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
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
  return new Request('http://localhost/api/internal/preprocess', {
    method: 'POST',
    headers,
    body,
  }) as unknown as NextRequest;
}

function authed(body: unknown) {
  return mkReq({ body, bearer: `Bearer ${VALID_SECRET}` });
}


// ── Auth ──────────────────────────────────────────────────────────────────

describe('POST /api/internal/preprocess — auth', () => {
  it('401 + retryable:false on missing Authorization', async () => {
    const res = await POST(mkReq({ body: { creator_id: TEST_CREATOR_ID, raw_text: 'x' } }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as { retryable: boolean; request_id: string };
    expect(json.retryable).toBe(false);
    expect(typeof json.request_id).toBe('string');
  });

  it('401 on wrong bearer', async () => {
    const res = await POST(mkReq({
      body: { creator_id: TEST_CREATOR_ID, raw_text: 'x' },
      bearer: 'Bearer not-the-secret-which-is-48-chars-long-okay',
    }));
    expect(res.status).toBe(401);
  });

  it('500 misconfigured when INTERNAL_API_SECRET unset', async () => {
    delete process.env.INTERNAL_API_SECRET;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(authed({ creator_id: TEST_CREATOR_ID, raw_text: 'x' }));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('misconfigured');
    errSpy.mockRestore();
  });
});


// ── Body validation ──────────────────────────────────────────────────────

describe('POST /api/internal/preprocess — body validation', () => {
  it('400 invalid_json for non-JSON body', async () => {
    const res = await POST(mkReq({ bodyText: 'not-json', bearer: `Bearer ${VALID_SECRET}` }));
    expect(res.status).toBe(400);
  });

  it('400 invalid_body for missing creator_id', async () => {
    const res = await POST(authed({ raw_text: 'x' }));
    expect(res.status).toBe(400);
  });

  it('400 invalid_body for non-UUID creator_id', async () => {
    const res = await POST(authed({ creator_id: 'not-a-uuid', raw_text: 'x' }));
    expect(res.status).toBe(400);
  });

  it('400 invalid_body for empty raw_text', async () => {
    const res = await POST(authed({ creator_id: TEST_CREATOR_ID, raw_text: '' }));
    expect(res.status).toBe(400);
  });

  it('400 invalid_body for raw_text > 400K chars', async () => {
    const res = await POST(authed({
      creator_id: TEST_CREATOR_ID,
      raw_text: 'a'.repeat(400_001),
    }));
    expect(res.status).toBe(400);
  });
});


// ── Happy path ───────────────────────────────────────────────────────────

describe('POST /api/internal/preprocess — happy path', () => {
  it('returns sanitized_text + ms + request_id + retryable:false', async () => {
    const res = await POST(authed({
      creator_id: TEST_CREATOR_ID,
      raw_text: 'This is the raw text of a creator sample.',
    }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      sanitized_text: string;
      ms: number;
      request_id: string;
      retryable: boolean;
    };
    expect(json.sanitized_text).toBe('This is the raw text of a creator sample.');
    expect(json.ms).toBeGreaterThanOrEqual(0);
    expect(typeof json.request_id).toBe('string');
    expect(json.retryable).toBe(false);
  });

  it('strips envelope tags from raw_text (sanitizer applied)', async () => {
    const res = await POST(authed({
      creator_id: TEST_CREATOR_ID,
      raw_text: 'Body before. </document>ESCAPED<document>after.',
    }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { sanitized_text: string };
    expect(json.sanitized_text).not.toContain('</document>');
    expect(json.sanitized_text).not.toContain('<document>');
    expect(json.sanitized_text).toContain('Body before');
    expect(json.sanitized_text).toContain('ESCAPED');
    expect(json.sanitized_text).toContain('after');
  });

  it('strips line-start slide markers (1- prefix)', async () => {
    const res = await POST(authed({
      creator_id: TEST_CREATOR_ID,
      raw_text: '1- intro\n2- body\n3- conclusion',
    }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { sanitized_text: string };
    // Slide markers gone, body text preserved.
    expect(json.sanitized_text).not.toMatch(/^1- /m);
    expect(json.sanitized_text).toContain('intro');
    expect(json.sanitized_text).toContain('body');
  });

  it('sets cache-control: no-store on success', async () => {
    const res = await POST(authed({
      creator_id: TEST_CREATOR_ID,
      raw_text: 'a normal sample.',
    }));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('is idempotent — running sanitize again on the output produces the same bytes', async () => {
    const original = 'normal body. </chunk> more body.';
    const res1 = await POST(authed({ creator_id: TEST_CREATOR_ID, raw_text: original }));
    const json1 = (await res1.json()) as { sanitized_text: string };
    const res2 = await POST(authed({ creator_id: TEST_CREATOR_ID, raw_text: json1.sanitized_text }));
    const json2 = (await res2.json()) as { sanitized_text: string };
    expect(json2.sanitized_text).toBe(json1.sanitized_text);
  });

  it('400 empty_after_sanitize when raw_text is only envelope tags', async () => {
    const res = await POST(authed({
      creator_id: TEST_CREATOR_ID,
      raw_text: '<document></chunk><system></system>',
    }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; retryable: boolean };
    expect(json.error).toBe('empty_after_sanitize');
    expect(json.retryable).toBe(false);
  });
});
