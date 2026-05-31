// /api/admin/creator-retrieval-version route tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRpc, mockUserRpc, mockMaybeSingle, mockAssertAdmin, mockSentryCapture, mockRevalidate } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockUserRpc: vi.fn(),
  mockMaybeSingle: vi.fn(),
  mockAssertAdmin: vi.fn(),
  mockSentryCapture: vi.fn(),
  mockRevalidate: vi.fn(),
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
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: mockMaybeSingle,
        }),
      }),
    }),
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  supabaseServer: async () => ({ rpc: mockUserRpc }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: mockRevalidate,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: mockSentryCapture,
  setUser: vi.fn(),
}));

import { POST } from './route';

const ADMIN_USER_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CREATOR_ID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  mockRpc.mockReset();
  mockUserRpc.mockReset();
  mockMaybeSingle.mockReset();
  mockAssertAdmin.mockReset();
  mockSentryCapture.mockReset();
  mockRevalidate.mockReset();
  mockAssertAdmin.mockResolvedValue({ userId: ADMIN_USER_ID, email: 'a@b', role: 'superadmin' });
  mockMaybeSingle.mockResolvedValue({ data: { retrieval_version: 2, brain_compiled_at: '2026-05-20T00:00:00Z' }, error: null });
});

afterEach(() => { vi.restoreAllMocks(); });

function mkReq(opts: { body?: unknown; bodyText?: string; origin?: string | null; contentType?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (opts.contentType !== null) headers['content-type'] = opts.contentType ?? 'application/json';
  if (opts.origin !== null) headers['origin'] = opts.origin ?? 'http://localhost';
  const body =
    opts.bodyText !== undefined ? opts.bodyText :
    opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return new NextRequest('http://localhost/api/admin/creator-retrieval-version', {
    method: 'POST', headers, body,
  });
}

describe('POST /api/admin/creator-retrieval-version — gates', () => {
  it('403 bad_origin', async () => {
    const res = await POST(mkReq({ origin: null, body: { creator_id: CREATOR_ID, version: 2 } }));
    expect(res.status).toBe(403);
  });
  it('415 bad_content_type', async () => {
    const res = await POST(mkReq({ contentType: 'text/plain', bodyText: 'x' }));
    expect(res.status).toBe(415);
  });
  it('401 unauthenticated', async () => {
    const { AuthGuardError } = await import('@/lib/auth-guards');
    mockAssertAdmin.mockRejectedValueOnce(new AuthGuardError('u', 401));
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, version: 2 } }));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/admin/creator-retrieval-version — body validation', () => {
  it('400 bad_creator_id', async () => {
    const res = await POST(mkReq({ body: { creator_id: 'nope', version: 2 } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_creator_id');
  });
  it('400 bad_version for missing version', async () => {
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_version');
  });
  it('400 bad_version for "2" string', async () => {
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, version: '2' } }));
    expect(res.status).toBe(400);
  });
  // Step-9 C4: version 3 is now VALID (v3 flip). Inverted from the old
  // '400 bad_version for 3' — the RPC owns the creator_v3_ready gate.
  it('200 for version 3 (v3 flip now allowed)', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, version: 3 } }));
    expect(res.status).toBe(200);
    expect(mockUserRpc).toHaveBeenCalledWith('admin_set_creator_retrieval_version',
      expect.objectContaining({ p_version: 3 }));
  });
  it('400 bad_version for 4 (only 1, 2, 3 allowed)', async () => {
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, version: 4 } }));
    expect(res.status).toBe(400);
  });
  it('400 bad_version for true', async () => {
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, version: true } }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/creator-retrieval-version — happy path', () => {
  it('200 flips to 2 + calls revalidatePath', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, version: 2 } }));
    expect(res.status).toBe(200);
    expect(mockUserRpc).toHaveBeenCalledWith('admin_set_creator_retrieval_version', {
      p_creator_id: CREATOR_ID,
      p_version:    2,
    });
    expect(mockRevalidate).toHaveBeenCalledWith(`/admin/creators/${CREATOR_ID}`);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.retrieval_version).toBe(2);
  });

  it('200 flips to 1 (downgrade path — also calls v2 zombie cleanup via the RPC)', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, version: 1 } }));
    expect(res.status).toBe(200);
    expect(mockUserRpc).toHaveBeenCalledWith('admin_set_creator_retrieval_version',
      expect.objectContaining({ p_version: 1 }));
  });
});

describe('POST /api/admin/creator-retrieval-version — rpc error mapping', () => {
  it('404 creator_not_found', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: null, error: { code: '42704', message: 'creator_not_found' } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, version: 2 } }));
    expect(res.status).toBe(404);
  });
  it('400 invalid_version on errcode 22023', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'version_invalid' } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, version: 2 } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_version');
  });
  it('403 forbidden on errcode 42501', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'forbidden' } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, version: 2 } }));
    expect(res.status).toBe(403);
  });
  it('500 flip_failed on unmapped error', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'kaboom' } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, version: 2 } }));
    expect(res.status).toBe(500);
    expect(mockSentryCapture).toHaveBeenCalled();
  });
  // Step-9 C4: both check_violation (23514) raises mapped to 409 by leading
  // token. Token strings pinned to the EXACT migration message so an edit to
  // the migration breaks this test, not prod (audit M-C).
  it('409 rollback_refused_legacy_purged on 23514 rollback message', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: null, error: {
      code: '23514',
      message: 'rollback_refused_legacy_purged -- legacy v1/v2 chunks were purged (admin_purge_legacy_chunks) at 2026-05-31; rolling back to v2 would read an empty corpus. Re-ingest the legacy corpus before downgrading.',
    } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, version: 2 } }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('rollback_refused_legacy_purged');
  });
  it('409 creator_v3_not_ready on 23514 not-ready message', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: null, error: {
      code: '23514',
      message: 'creator_v3_not_ready -- at least one ready sample is missing v3 sections / chunks / done job. Run creator_v3_ready(creator_id) for diagnostics.',
    } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, version: 3 } }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('creator_v3_not_ready');
  });
});
