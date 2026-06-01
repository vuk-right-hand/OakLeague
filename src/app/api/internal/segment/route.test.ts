// /api/internal/segment route tests.
//
// Coverage:
//   * Auth + body validation
//   * Happy path: returns sections / mode / oversize
//   * Empty body / invalid body / missing bearer

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { mockSegmentDocument, mockSentryCapture } = vi.hoisted(() => ({
  mockSegmentDocument: vi.fn(),
  mockSentryCapture: vi.fn(),
}));

vi.mock('@/lib/voice/section-segment', async () => {
  const actual = await vi.importActual<typeof import('@/lib/voice/section-segment')>(
    '@/lib/voice/section-segment',
  );
  return {
    ...actual,
    segmentDocument: mockSegmentDocument,
  };
});

vi.mock('@sentry/nextjs', () => ({
  captureException: mockSentryCapture,
  setTag: vi.fn(),
  setContext: vi.fn(),
}));

import { POST } from './route';

const VALID_SECRET = 'a'.repeat(48);
const TEST_CREATOR_ID = '11111111-2222-3333-4444-555555555555';
const TEST_SAMPLE_ID  = '22222222-3333-4444-5555-666666666666';

beforeEach(() => {
  mockSegmentDocument.mockReset();
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
  return new Request('http://localhost/api/internal/segment', {
    method: 'POST',
    headers,
    body,
  }) as unknown as NextRequest;
}

function authed(body: unknown) {
  return mkReq({ body, bearer: `Bearer ${VALID_SECRET}` });
}

const goodBody = {
  creator_id:    TEST_CREATOR_ID,
  sample_id:     TEST_SAMPLE_ID,
  sanitized_doc: 'Sample doc text.\n\nWith two paragraphs.',
};

const goodResult = {
  sections: [
    {
      text: 'Sample doc text.\n\nWith two paragraphs.',
      charStart: 0,
      charEnd: 38,
      estTokens: 10,
      cue: null,
      mode: 'paragraph-packed' as const,
    },
  ],
  mode: 'paragraph-packed' as const,
  oversize: 0,
};

describe('POST /api/internal/segment', () => {
  it('rejects unauthed', async () => {
    mockSegmentDocument.mockReturnValueOnce(goodResult);
    const r = await POST(mkReq({ body: goodBody }));
    expect(r.status).toBe(401);
    expect(mockSegmentDocument).not.toHaveBeenCalled();
  });

  it('returns 400 on missing fields', async () => {
    const r = await POST(authed({ creator_id: TEST_CREATOR_ID }));
    expect(r.status).toBe(400);
    const json = await r.json();
    expect(json.error).toBe('invalid_body');
  });

  it('returns 400 on non-JSON body', async () => {
    const r = await POST(mkReq({ bodyText: 'not json', bearer: `Bearer ${VALID_SECRET}` }));
    expect(r.status).toBe(400);
  });

  it('happy path returns sections + mode + oversize', async () => {
    mockSegmentDocument.mockReturnValueOnce(goodResult);
    const r = await POST(authed(goodBody));
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.sections).toHaveLength(1);
    expect(json.mode).toBe('paragraph-packed');
    expect(json.oversize).toBe(0);
    expect(json.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockSegmentDocument).toHaveBeenCalledTimes(1);
    // Default options forwarded as undefined → module uses its own defaults.
    const callArgs = mockSegmentDocument.mock.calls[0]!;
    expect(callArgs[0]).toBe(goodBody.sanitized_doc);
    expect(callArgs[1]).toEqual({
      cueMode: undefined,
      targetTokens: undefined,
      safeMaxTokens: undefined,
      charsPerToken: undefined,
    });
  });

  it('forwards cue_mode + target_tokens overrides', async () => {
    mockSegmentDocument.mockReturnValueOnce(goodResult);
    const r = await POST(authed({
      ...goodBody,
      cue_mode: 'book',
      target_tokens: 5000,
      safe_max_tokens: 6000,
      chars_per_token: 4,
    }));
    expect(r.status).toBe(200);
    const callArgs = mockSegmentDocument.mock.calls[0]!;
    expect(callArgs[1]).toEqual({
      cueMode: 'book',
      targetTokens: 5000,
      safeMaxTokens: 6000,
      charsPerToken: 4,
    });
  });

  it('returns 500 + retryable on unexpected throw', async () => {
    mockSegmentDocument.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const r = await POST(authed(goodBody));
    expect(r.status).toBe(500);
    const json = await r.json();
    expect(json.error).toBe('internal_error');
    expect(json.retryable).toBe(true);
    expect(mockSentryCapture).toHaveBeenCalled();
  });
});
