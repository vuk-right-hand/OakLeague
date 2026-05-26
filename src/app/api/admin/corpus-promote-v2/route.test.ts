// /api/admin/corpus-promote-v2 route tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRpc, mockFrom, mockAssertAdmin, mockSentryCapture, mockSentryMessage } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockFrom: vi.fn(),
  mockAssertAdmin: vi.fn(),
  mockSentryCapture: vi.fn(),
  mockSentryMessage: vi.fn(),
}));

vi.mock('@/lib/auth-guards', () => ({
  assertAdminFromSession: mockAssertAdmin,
  AuthGuardError: class AuthGuardError extends Error {
    status: number;
    constructor(msg: string, status: number) { super(msg); this.status = status; }
  },
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ rpc: mockRpc, from: mockFrom }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: mockSentryCapture,
  captureMessage: mockSentryMessage,
  setUser: vi.fn(),
}));

import { POST } from './route';

const ADMIN_USER_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CREATOR_ID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  mockRpc.mockReset();
  mockFrom.mockReset();
  mockAssertAdmin.mockReset();
  mockSentryCapture.mockReset();
  mockSentryMessage.mockReset();
  mockAssertAdmin.mockResolvedValue({ userId: ADMIN_USER_ID, email: 'a@b', role: 'superadmin' });
  mockFrom.mockReturnValue({ insert: vi.fn().mockResolvedValue({ error: null }) });
});

afterEach(() => { vi.restoreAllMocks(); });

function mkReq(opts: { body?: unknown; bodyText?: string; origin?: string | null; contentType?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (opts.contentType !== null) headers['content-type'] = opts.contentType ?? 'application/json';
  if (opts.origin !== null) headers['origin'] = opts.origin ?? 'http://localhost';
  const body =
    opts.bodyText !== undefined ? opts.bodyText :
    opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return new NextRequest('http://localhost/api/admin/corpus-promote-v2', {
    method: 'POST', headers, body,
  });
}

describe('POST /api/admin/corpus-promote-v2 — gates + auth', () => {
  it('403 bad_origin', async () => {
    const res = await POST(mkReq({ origin: null, body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(403);
  });
  it('415 bad_content_type', async () => {
    const res = await POST(mkReq({ contentType: 'text/plain', bodyText: 'x' }));
    expect(res.status).toBe(415);
  });
  it('401 unauthenticated', async () => {
    const { AuthGuardError } = await import('@/lib/auth-guards');
    mockAssertAdmin.mockRejectedValueOnce(new AuthGuardError('u', 401));
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(401);
  });
  it('400 bad_creator_id for non-UUID', async () => {
    const res = await POST(mkReq({ body: { creator_id: 'nope' } }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/corpus-promote-v2 — happy path', () => {
  it('200 echoes deleted + remaining counts', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ deleted_v1_count: 12, remaining_v2_count: 15 }],
      error: null,
    });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deleted_v1_count).toBe(12);
    expect(body.remaining_v2_count).toBe(15);
  });

  it('forwards admin_user_id + creator_id to rpc', async () => {
    mockRpc.mockResolvedValueOnce({ data: [{ deleted_v1_count: 0, remaining_v2_count: 5 }], error: null });
    await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(mockRpc).toHaveBeenCalledWith('_admin_promote_v2_chunks_unsafe', {
      p_admin_user_id: ADMIN_USER_ID,
      p_creator_id:    CREATOR_ID,
    });
  });
});

describe('POST /api/admin/corpus-promote-v2 — rpc error mapping', () => {
  it('404 creator_not_found + audit row with distinct action (M6)', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42704', message: 'creator_not_found' } });
    const insertSpy = vi.fn().mockResolvedValue({ error: null });
    mockFrom.mockReturnValue({ insert: insertSpy });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(404);
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'creator_promote_v2_chunks_rejected_creator_not_found',
      after: expect.objectContaining({ reason: 'creator_not_found' }),
    }));
  });

  it('409 no_v2_chunks_yet + audit row with distinct action (M6, footgun guard)', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22023', message: 'no_v2_chunks_yet — re-process before promoting' },
    });
    const insertSpy = vi.fn().mockResolvedValue({ error: null });
    mockFrom.mockReturnValue({ insert: insertSpy });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('no_v2_chunks_yet');
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'creator_promote_v2_chunks_rejected_no_v2_chunks_yet',
    }));
  });

  it('409 reprocess_in_progress on errcode 55P03 lock_timeout (audit-2 C3)', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '55P03', message: 'canceling statement due to lock timeout' },
    });
    const insertSpy = vi.fn().mockResolvedValue({ error: null });
    mockFrom.mockReturnValue({ insert: insertSpy });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('reprocess_in_progress');
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'creator_promote_v2_chunks_rejected_reprocess_in_progress',
    }));
  });

  it('400 invalid_argument on generic 22023', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'creator_id_null' } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_argument');
  });

  it('403 forbidden on 42501 + audit row with distinct action (M6)', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not_an_active_admin' } });
    const insertSpy = vi.fn().mockResolvedValue({ error: null });
    mockFrom.mockReturnValue({ insert: insertSpy });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(403);
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'creator_promote_v2_chunks_rejected_not_an_active_admin',
      after: expect.objectContaining({ reason: 'not_an_active_admin' }),
    }));
  });

  it('500 promote_failed on unmapped error', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'kaboom' } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('promote_failed');
    expect(mockSentryCapture).toHaveBeenCalled();
  });

  it('500 promote_no_result on empty data', async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('promote_no_result');
    expect(mockSentryMessage).toHaveBeenCalled();
  });
});
