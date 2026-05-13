// /api/admin/corpus-compare route tests.
//
// Coverage:
//   * Pre-auth gates (origin / content-type)
//   * Auth-guard mapping (401, 403)
//   * Body validation (json / creator_id / empty query / too-long query)
//   * K clamping (1..20)
//   * Happy path: embed succeeds, RPC returns mixed v1/v2 rows, partitioned
//   * Embed errors (api_key_missing → misconfigured + fatal; dim_mismatch → 500)
//   * RPC errors (42501 → 403; 22023 → 400; generic → 500 compare_failed)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRpc, mockAssertAdmin, mockEmbed, mockSentryCapture } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockAssertAdmin: vi.fn(),
  mockEmbed: vi.fn(),
  mockSentryCapture: vi.fn(),
}));

vi.mock('@/lib/auth-guards', () => ({
  assertAdminFromSession: mockAssertAdmin,
  AuthGuardError: class AuthGuardError extends Error {
    status: number;
    constructor(msg: string, status: number) { super(msg); this.status = status; }
  },
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    rpc: mockRpc,
    // Audit-2 C1: route writes cogs_log via .from('cogs_log').insert(...)
    // Stub it out — tests assert the call shape elsewhere.
    from: () => ({ insert: () => Promise.resolve({ error: null }) }),
  }),
}));

vi.mock('@/lib/voice/embed', async () => {
  const actual = await vi.importActual<typeof import('@/lib/voice/embed')>('@/lib/voice/embed');
  return {
    ...actual,
    embedTexts: mockEmbed,
  };
});

vi.mock('@sentry/nextjs', () => ({
  captureException: mockSentryCapture,
  captureMessage: vi.fn(),
  setUser: vi.fn(),
  setTag: vi.fn(),
  setContext: vi.fn(),
}));

import { POST } from './route';
import { EmbedError } from '@/lib/voice/embed';

const ADMIN_USER_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CREATOR_ID = '11111111-2222-4333-8444-555555555555';
const VALID_VECTOR = Array.from({ length: 768 }, () => 0);

beforeEach(() => {
  mockRpc.mockReset();
  mockAssertAdmin.mockReset();
  mockEmbed.mockReset();
  mockSentryCapture.mockReset();
  mockAssertAdmin.mockResolvedValue({ userId: ADMIN_USER_ID, email: 'a@b', role: 'superadmin' });
  mockEmbed.mockResolvedValue({ vectors: [VALID_VECTOR], tokens: 5, ms: 10 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mkReq(opts: { body?: unknown; bodyText?: string; origin?: string | null; contentType?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (opts.contentType !== null) headers['content-type'] = opts.contentType ?? 'application/json';
  if (opts.origin !== null) headers['origin'] = opts.origin ?? 'http://localhost';
  const body =
    opts.bodyText !== undefined ? opts.bodyText :
    opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return new NextRequest('http://localhost/api/admin/corpus-compare', {
    method: 'POST', headers, body,
  });
}

describe('POST /api/admin/corpus-compare — pre-auth gates', () => {
  it('403 bad_origin when Origin header absent', async () => {
    const res = await POST(mkReq({ origin: null, body: { creator_id: CREATOR_ID, query_text: 'q' } }));
    expect(res.status).toBe(403);
  });
  it('415 bad_content_type', async () => {
    const res = await POST(mkReq({ contentType: 'text/plain', bodyText: 'q' }));
    expect(res.status).toBe(415);
  });
});

describe('POST /api/admin/corpus-compare — auth-guard mapping', () => {
  it('401 unauthenticated', async () => {
    const { AuthGuardError } = await import('@/lib/auth-guards');
    mockAssertAdmin.mockRejectedValueOnce(new AuthGuardError('Unauthorized', 401));
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'q' } }));
    expect(res.status).toBe(401);
  });
  it('403 forbidden', async () => {
    const { AuthGuardError } = await import('@/lib/auth-guards');
    mockAssertAdmin.mockRejectedValueOnce(new AuthGuardError('Forbidden', 403));
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'q' } }));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/corpus-compare — body validation', () => {
  it('400 bad_json', async () => {
    const res = await POST(mkReq({ bodyText: 'not-json' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_json');
  });
  it('400 bad_creator_id', async () => {
    const res = await POST(mkReq({ body: { creator_id: 'not-a-uuid', query_text: 'q' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_creator_id');
  });
  it('400 empty_query for blank query', async () => {
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: '   ' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('empty_query');
  });
  it('400 query_too_long for >2000 chars', async () => {
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'q'.repeat(2001) } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('query_too_long');
  });
});

describe('POST /api/admin/corpus-compare — happy path', () => {
  it('200 partitions v1 + v2 rows', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [
        { chunker_version: 1, chunk_id: 'c1', sample_id: 's1', sample_title: 'S1', chunk_context: null, text: 'v1a', similarity: 0.50 },
        { chunker_version: 2, chunk_id: 'c2', sample_id: 's1', sample_title: 'S1', chunk_context: 'ctx', text: 'v2a', similarity: 0.85 },
        { chunker_version: 2, chunk_id: 'c3', sample_id: 's1', sample_title: 'S1', chunk_context: 'ctx', text: 'v2b', similarity: 0.78 },
      ],
      error: null,
    });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'tell me about twins' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.counts).toEqual({ v1: 1, v2: 2 });
    expect(body.v1).toHaveLength(1);
    expect(body.v2).toHaveLength(2);
    expect(body.v1[0].similarity).toBe(0.50);
    expect(body.v2[0].similarity).toBe(0.85);
  });

  it('clamps k to [1, 20] and defaults to 5', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'q' } }));
    expect(mockRpc).toHaveBeenLastCalledWith('_admin_compare_v1_v2_retrieval_unsafe',
      expect.objectContaining({ p_k: 5 }));
    await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'q', k: 9999 } }));
    expect(mockRpc).toHaveBeenLastCalledWith('_admin_compare_v1_v2_retrieval_unsafe',
      expect.objectContaining({ p_k: 20 }));
    await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'q', k: 0 } }));
    expect(mockRpc).toHaveBeenLastCalledWith('_admin_compare_v1_v2_retrieval_unsafe',
      expect.objectContaining({ p_k: 1 }));
  });
});

describe('POST /api/admin/corpus-compare — embed error mapping', () => {
  it('500 misconfigured + Sentry fatal on api_key_missing', async () => {
    mockEmbed.mockRejectedValueOnce(new EmbedError('api_key_missing'));
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'q' } }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('misconfigured');
    expect(mockSentryCapture).toHaveBeenCalled();
    const opts = mockSentryCapture.mock.calls[0][1] as { level?: string };
    expect(opts.level).toBe('fatal');
  });
  it('500 embed_dim_mismatch on bad vector shape', async () => {
    mockEmbed.mockResolvedValueOnce({ vectors: [Array.from({ length: 384 }, () => 0)], tokens: 1, ms: 1 });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'q' } }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('embed_dim_mismatch');
  });
});

describe('POST /api/admin/corpus-compare — rpc error mapping', () => {
  it('403 forbidden on errcode 42501', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not_an_active_admin' } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'q' } }));
    expect(res.status).toBe(403);
  });
  it('404 creator_not_found on errcode 42704 (audit-2 M4)', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42704', message: 'creator_not_found' } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'q' } }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('creator_not_found');
  });
  it('400 invalid_argument on errcode 22023', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'creator_id_null' } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'q' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_argument');
  });
  it('500 compare_failed on unmapped error', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'kaboom' } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'q' } }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('compare_failed');
  });
});

describe('POST /api/admin/corpus-compare — audit-2 fixes', () => {
  it('passes p_query_vec as pgvector text literal, not raw array (C2)', async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'q' } }));
    const call = mockRpc.mock.calls[0];
    expect(call[0]).toBe('_admin_compare_v1_v2_retrieval_unsafe');
    const args = call[1] as { p_query_vec: unknown };
    expect(typeof args.p_query_vec).toBe('string');
    expect(args.p_query_vec as string).toMatch(/^\[.*\]$/);
  });

  it('surfaces requested_k + applied_k in response (M7)', async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'q', k: 9999 } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requested_k: number; applied_k: number };
    expect(body.requested_k).toBe(9999);
    expect(body.applied_k).toBe(20);
  });

  it('clamps k correctly for negative/fractional/string-like input (M5)', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    // Negative → clamped to 1.
    await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'q', k: -3.7 } }));
    expect(mockRpc).toHaveBeenLastCalledWith('_admin_compare_v1_v2_retrieval_unsafe',
      expect.objectContaining({ p_k: 1 }));
    // Fractional → floored.
    await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'q', k: 7.9 } }));
    expect(mockRpc).toHaveBeenLastCalledWith('_admin_compare_v1_v2_retrieval_unsafe',
      expect.objectContaining({ p_k: 7 }));
    // String "5" — typeof !== 'number' → default 5.
    await POST(mkReq({ body: { creator_id: CREATOR_ID, query_text: 'q', k: '5' } }));
    expect(mockRpc).toHaveBeenLastCalledWith('_admin_compare_v1_v2_retrieval_unsafe',
      expect.objectContaining({ p_k: 5 }));
  });
});
