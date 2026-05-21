// /api/admin/creator-publish route tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockUserRpc, mockMaybeSingle, mockAssertAdmin, mockSentryCapture, mockRevalidate } = vi.hoisted(() => ({
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
  mockUserRpc.mockReset();
  mockMaybeSingle.mockReset();
  mockAssertAdmin.mockReset();
  mockSentryCapture.mockReset();
  mockRevalidate.mockReset();
  mockAssertAdmin.mockResolvedValue({ userId: ADMIN_USER_ID, email: 'a@b', role: 'superadmin' });
  mockMaybeSingle.mockResolvedValue({ data: { published_at: '2026-05-21T00:00:00Z', brain_status: 'ready' }, error: null });
});

afterEach(() => { vi.restoreAllMocks(); });

function mkReq(opts: { body?: unknown; bodyText?: string; origin?: string | null; contentType?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (opts.contentType !== null) headers['content-type'] = opts.contentType ?? 'application/json';
  if (opts.origin !== null) headers['origin'] = opts.origin ?? 'http://localhost';
  const body =
    opts.bodyText !== undefined ? opts.bodyText :
    opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return new NextRequest('http://localhost/api/admin/creator-publish', {
    method: 'POST', headers, body,
  });
}

describe('POST /api/admin/creator-publish — gates', () => {
  it('403 bad_origin', async () => {
    const res = await POST(mkReq({ origin: null, body: { creator_id: CREATOR_ID, publish: true } }));
    expect(res.status).toBe(403);
  });
  it('415 bad_content_type', async () => {
    const res = await POST(mkReq({ contentType: 'text/plain', bodyText: 'x' }));
    expect(res.status).toBe(415);
  });
  it('401 unauthenticated', async () => {
    const { AuthGuardError } = await import('@/lib/auth-guards');
    mockAssertAdmin.mockRejectedValueOnce(new AuthGuardError('u', 401));
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, publish: true } }));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/admin/creator-publish — body validation', () => {
  it('400 bad_creator_id', async () => {
    const res = await POST(mkReq({ body: { creator_id: 'nope', publish: true } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_creator_id');
  });
  it('400 bad_publish for missing publish', async () => {
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_publish');
  });
  it('400 bad_publish for "true" string', async () => {
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, publish: 'true' } }));
    expect(res.status).toBe(400);
  });
  it('400 bad_publish for 1', async () => {
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, publish: 1 } }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/creator-publish — happy path', () => {
  it('200 publishes + revalidates feed + admin pages', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, publish: true } }));
    expect(res.status).toBe(200);
    expect(mockUserRpc).toHaveBeenCalledWith('admin_set_creator_published', {
      p_creator_id: CREATOR_ID,
      p_publish:    true,
    });
    // Feed is force-dynamic (no '/' route cache) — only admin pages revalidate.
    expect(mockRevalidate).not.toHaveBeenCalledWith('/');
    expect(mockRevalidate).toHaveBeenCalledWith('/admin/creators');
    expect(mockRevalidate).toHaveBeenCalledWith(`/admin/creators/${CREATOR_ID}`);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.published_at).toBe('2026-05-21T00:00:00Z');
  });

  it('200 unpublishes (publish=false)', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: null, error: null });
    mockMaybeSingle.mockResolvedValueOnce({ data: { published_at: null, brain_status: 'ready' }, error: null });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, publish: false } }));
    expect(res.status).toBe(200);
    expect(mockUserRpc).toHaveBeenCalledWith('admin_set_creator_published',
      expect.objectContaining({ p_publish: false }));
    const body = await res.json();
    expect(body.published_at).toBeNull();
    // Unpublish leaves brain_status untouched (M3) — route echoes the read-back.
    expect(body.brain_status).toBe('ready');
  });
});

describe('POST /api/admin/creator-publish — rpc error mapping', () => {
  it('404 creator_not_found', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: null, error: { code: '42704', message: 'creator_not_found' } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, publish: true } }));
    expect(res.status).toBe(404);
  });

  it('422 with the precondition code for each readiness failure', async () => {
    for (const code of ['voice_not_cloned', 'face_not_uploaded', 'brain_not_compiled', 'brain_errored', 'no_corpus', 'no_v2_chunks', 'voice_consent_missing', 'likeness_consent_missing']) {
      mockUserRpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: code } });
      const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, publish: true } }));
      expect(res.status).toBe(422);
      expect((await res.json()).error).toBe(code);
    }
  });

  it('403 forbidden on errcode 42501', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'forbidden' } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, publish: true } }));
    expect(res.status).toBe(403);
  });

  it('500 publish_failed on unmapped error', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'kaboom' } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, publish: true } }));
    expect(res.status).toBe(500);
    expect(mockSentryCapture).toHaveBeenCalled();
  });
});
