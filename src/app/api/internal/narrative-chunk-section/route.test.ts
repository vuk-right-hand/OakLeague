// /api/internal/narrative-chunk-section route tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { mockNarrativeChunkSection, mockSentryCapture } = vi.hoisted(() => ({
  mockNarrativeChunkSection: vi.fn(),
  mockSentryCapture: vi.fn(),
}));

vi.mock('@/lib/voice/narrative-chunk', async () => {
  const actual = await vi.importActual<typeof import('@/lib/voice/narrative-chunk')>(
    '@/lib/voice/narrative-chunk',
  );
  return {
    ...actual,
    narrativeChunkSection: mockNarrativeChunkSection,
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
const TEST_SAMPLE_ID  = '22222222-3333-4444-5555-666666666666';

beforeEach(() => {
  mockNarrativeChunkSection.mockReset();
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
  return new Request('http://localhost/api/internal/narrative-chunk-section', {
    method: 'POST',
    headers,
    body,
  }) as unknown as NextRequest;
}

function authed(body: unknown) {
  return mkReq({ body, bearer: `Bearer ${VALID_SECRET}` });
}

const goodBody = {
  creator_id:        TEST_CREATOR_ID,
  sample_id:         TEST_SAMPLE_ID,
  section_index:     0,
  sanitized_section: 'Section body content for the test.',
  sample_title:      'My Talk',
  section_cue:       '# Chapter 1',
};

const goodResult = {
  units: [
    { title: 'Beat One', text: 'First beat in the section.' },
    { title: 'Beat Two', text: 'Second beat in the section.' },
  ],
  sectionTitle: 'Section Zero',
  sectionSummary: 'A short summary of the first section.',
  attempt: 1 as 1 | 2,
  ms: 850,
  usage: {
    prompt_token_count: 600,
    candidates_token_count: 90,
    total_token_count: 690,
  },
};

describe('POST /api/internal/narrative-chunk-section', () => {
  it('rejects unauthed', async () => {
    const r = await POST(mkReq({ body: goodBody }));
    expect(r.status).toBe(401);
    expect(mockNarrativeChunkSection).not.toHaveBeenCalled();
  });

  it('returns 400 on missing required fields', async () => {
    const r = await POST(authed({ creator_id: TEST_CREATOR_ID }));
    expect(r.status).toBe(400);
  });

  it('happy path returns units + section_title + section_summary + usage', async () => {
    mockNarrativeChunkSection.mockResolvedValueOnce(goodResult);
    const r = await POST(authed(goodBody));
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.units).toHaveLength(2);
    expect(json.section_title).toBe('Section Zero');
    expect(json.section_summary).toContain('summary');
    expect(json.attempt).toBe(1);
    expect(json.usage.total_token_count).toBe(690);
    expect(json.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('fallback path: null result → 200 with units:null + message', async () => {
    mockNarrativeChunkSection.mockResolvedValueOnce(null);
    const r = await POST(authed(goodBody));
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.units).toBeNull();
    expect(json.attempt).toBe(2);
    expect(json.message).toBe('fallback_to_skip_section');
    expect(json.retryable).toBe(false);
  });

  it('empty_input throw → 400', async () => {
    mockNarrativeChunkSection.mockRejectedValueOnce(
      new NarrativeChunkError('empty_input', 1, 'whitespace only'),
    );
    const r = await POST(authed(goodBody));
    expect(r.status).toBe(400);
    const json = await r.json();
    expect(json.error).toBe('empty_input');
  });

  it('api_key_missing throw → 500 misconfigured + Sentry fatal', async () => {
    mockNarrativeChunkSection.mockRejectedValueOnce(
      new NarrativeChunkError('api_key_missing', 1, 'GEMINI_API_KEY unset'),
    );
    const r = await POST(authed(goodBody));
    expect(r.status).toBe(500);
    const json = await r.json();
    expect(json.error).toBe('misconfigured');
    expect(json.code).toBe('api_key_missing');
    expect(mockSentryCapture).toHaveBeenCalledWith(
      expect.any(NarrativeChunkError),
      expect.objectContaining({ level: 'fatal' }),
    );
  });

  it('accepts null section_cue (paragraph-pack mode)', async () => {
    mockNarrativeChunkSection.mockResolvedValueOnce(goodResult);
    const r = await POST(authed({ ...goodBody, section_cue: null }));
    expect(r.status).toBe(200);
    const callArgs = mockNarrativeChunkSection.mock.calls[0]![0] as { sectionCue?: string | null };
    expect(callArgs.sectionCue).toBeNull();
  });
});
