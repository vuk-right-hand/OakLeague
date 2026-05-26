// /api/admin/creator-consent route tests (P0-3 admin attestation override).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockUserRpc, mockAssertAdmin, mockSentryCapture, mockRevalidate } = vi.hoisted(() => ({
  mockUserRpc: vi.fn(),
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

vi.mock('@/lib/supabase/server', () => ({
  supabaseServer: async () => ({ rpc: mockUserRpc }),
}));

vi.mock('next/cache', () => ({ revalidatePath: mockRevalidate }));
vi.mock('@sentry/nextjs', () => ({ captureException: mockSentryCapture, setUser: vi.fn() }));

import { POST } from './route';

const ADMIN_USER_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CREATOR_ID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  mockUserRpc.mockReset();
  mockAssertAdmin.mockReset();
  mockSentryCapture.mockReset();
  mockRevalidate.mockReset();
  mockAssertAdmin.mockResolvedValue({ userId: ADMIN_USER_ID, email: 'a@b', role: 'superadmin' });
});

afterEach(() => { vi.restoreAllMocks(); });

function mkReq(opts: { body?: unknown; origin?: string | null; contentType?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (opts.contentType !== null) headers['content-type'] = opts.contentType ?? 'application/json';
  if (opts.origin !== null) headers['origin'] = opts.origin ?? 'http://localhost';
  return new NextRequest('http://localhost/api/admin/creator-consent', {
    method: 'POST', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

describe('POST /api/admin/creator-consent', () => {
  it('403 bad_origin', async () => {
    const res = await POST(mkReq({ origin: null, body: { creator_id: CREATOR_ID, consent_type: 'voice_clone' } }));
    expect(res.status).toBe(403);
  });
  it('400 bad_creator_id', async () => {
    const res = await POST(mkReq({ body: { creator_id: 'nope', consent_type: 'voice_clone' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_creator_id');
  });
  it('400 bad_consent_type for unknown type', async () => {
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, consent_type: 'bogus' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_consent_type');
  });
  it('200 attest (default action) records consent with the pinned version', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: 'consent-id', error: null });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, consent_type: 'voice_clone' } }));
    expect(res.status).toBe(200);
    expect(mockUserRpc).toHaveBeenCalledWith('admin_attest_creator_consent',
      expect.objectContaining({ p_creator_id: CREATOR_ID, p_consent_type: 'voice_clone', p_version: expect.any(String) }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.action).toBe('attest');
  });

  it('200 revoke calls the revoke RPC (no version)', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: 1, error: null });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, consent_type: 'voice_clone', action: 'revoke' } }));
    expect(res.status).toBe(200);
    expect(mockUserRpc).toHaveBeenCalledWith('admin_revoke_creator_consent', {
      p_creator_id: CREATOR_ID, p_consent_type: 'voice_clone',
    });
    expect((await res.json()).action).toBe('revoke');
  });
  it('404 creator_not_found', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: null, error: { code: '42704', message: 'creator_not_found' } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, consent_type: 'likeness' } }));
    expect(res.status).toBe(404);
  });
  it('403 forbidden on errcode 42501', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'forbidden' } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, consent_type: 'likeness' } }));
    expect(res.status).toBe(403);
  });
  it('500 attest_failed on unmapped error', async () => {
    mockUserRpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'kaboom' } });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, consent_type: 'likeness' } }));
    expect(res.status).toBe(500);
    expect(mockSentryCapture).toHaveBeenCalled();
  });
});
