// /api/admin/corpus-reprocess route tests.
//
// Coverage:
//   POST:
//     * bad origin / wrong content-type → 403 / 415
//     * AuthGuardError 401 + 403 → mapped through
//     * bad JSON / missing creator_id / non-UUID creator_id → 400
//     * happy path: rpc returns one row → echo counts back
//     * force=true is forwarded to the rpc
//     * force is coerced — only literal `true` toggles on
//     * rpc errors mapped: creator_not_found (42704), creator_id_null
//       (22023), not_an_active_admin (42501), generic → 500
//     * empty array result → 500 enqueue_no_result
//   GET:
//     * bad origin → 403
//     * missing/invalid creator_id → 400
//     * happy path: returns counts + rows
//     * limit clamping (default 100, max 500, NaN → 100)
//     * rpc error → 500 list_failed

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
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  },
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ rpc: mockRpc, from: mockFrom }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: mockSentryCapture,
  captureMessage: mockSentryMessage,
  setUser: vi.fn(),
  setTag: vi.fn(),
  setContext: vi.fn(),
}));

import { POST, GET } from './route';

const ADMIN_USER_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CREATOR_ID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  mockRpc.mockReset();
  mockFrom.mockReset();
  mockAssertAdmin.mockReset();
  mockSentryCapture.mockReset();
  mockSentryMessage.mockReset();
  mockAssertAdmin.mockResolvedValue({ userId: ADMIN_USER_ID, email: 'a@b', role: 'superadmin' });
  // Default `from(...).insert(...)` chain — used by writeRejectionAudit.
  // Tests that care about audit writes override this with their own spy.
  mockFrom.mockReturnValue({ insert: vi.fn().mockResolvedValue({ error: null }) });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mkReq(opts: {
  method?: 'POST' | 'GET';
  body?: unknown;
  bodyText?: string;
  origin?: string | null;
  contentType?: string | null;
  url?: string;
} = {}) {
  const headers: Record<string, string> = {};
  if (opts.method !== 'GET') {
    if (opts.contentType !== null) {
      headers['content-type'] = opts.contentType ?? 'application/json';
    }
  }
  if (opts.origin !== null) headers['origin'] = opts.origin ?? 'http://localhost';
  const body =
    opts.bodyText !== undefined
      ? opts.bodyText
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;
  return new NextRequest(opts.url ?? 'http://localhost/api/admin/corpus-reprocess', {
    method: opts.method ?? 'POST',
    headers,
    body,
  });
}

// ── POST: origin / content-type ───────────────────────────────────────────

describe('POST /api/admin/corpus-reprocess — pre-auth gates', () => {
  it('403 bad_origin when Origin header is absent', async () => {
    const res = await POST(mkReq({ origin: null, body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('bad_origin');
  });

  it('415 bad_content_type when content-type is not JSON', async () => {
    const res = await POST(mkReq({ contentType: 'application/x-www-form-urlencoded', bodyText: 'a=b' }));
    expect(res.status).toBe(415);
    expect((await res.json()).error).toBe('bad_content_type');
  });
});

// ── POST: auth-guard mapping ──────────────────────────────────────────────

describe('POST /api/admin/corpus-reprocess — auth-guard mapping', () => {
  it('maps AuthGuardError(401) → 401 unauthenticated', async () => {
    const { AuthGuardError } = await import('@/lib/auth-guards');
    mockAssertAdmin.mockRejectedValueOnce(new AuthGuardError('Unauthorized', 401));
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthenticated');
  });

  it('maps AuthGuardError(403) → 403 forbidden', async () => {
    const { AuthGuardError } = await import('@/lib/auth-guards');
    mockAssertAdmin.mockRejectedValueOnce(new AuthGuardError('Forbidden', 403));
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
  });
});

// ── POST: body validation ─────────────────────────────────────────────────

describe('POST /api/admin/corpus-reprocess — body validation', () => {
  it('400 bad_json for invalid JSON body', async () => {
    const res = await POST(mkReq({ bodyText: 'not-json' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_json');
  });

  it('400 bad_creator_id for missing creator_id', async () => {
    const res = await POST(mkReq({ body: {} }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_creator_id');
  });

  it('400 bad_creator_id for non-UUID creator_id', async () => {
    const res = await POST(mkReq({ body: { creator_id: 'not-a-uuid' } }));
    expect(res.status).toBe(400);
  });
});

// ── POST: happy path ──────────────────────────────────────────────────────

describe('POST /api/admin/corpus-reprocess — happy path', () => {
  it('200 echo of rpc row when rpc succeeds', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ enqueued_count: 5, total_ready_samples: 5, skipped_in_flight: 0, skipped_already_queued: 0 }],
      error: null,
    });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      creator_id: string;
      force: boolean;
      enqueued_count: number;
      total_ready_samples: number;
      skipped_in_flight: number;
      skipped_already_queued: number;
    };
    expect(body.ok).toBe(true);
    expect(body.creator_id).toBe(CREATOR_ID);
    expect(body.force).toBe(false);
    expect(body.enqueued_count).toBe(5);
    expect(body.total_ready_samples).toBe(5);
    expect(body.skipped_in_flight).toBe(0);
    expect(body.skipped_already_queued).toBe(0);
  });

  it('echoes skipped_already_queued through (audit-1 C3)', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ enqueued_count: 2, total_ready_samples: 10, skipped_in_flight: 0, skipped_already_queued: 8 }],
      error: null,
    });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped_already_queued: number };
    expect(body.skipped_already_queued).toBe(8);
  });

  it('forwards p_admin_user_id, p_creator_id, p_force=true, p_target_version=2 (default) to the rpc', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ enqueued_count: 3, total_ready_samples: 3, skipped_in_flight: 1, skipped_already_queued: 0 }],
      error: null,
    });
    await POST(mkReq({ body: { creator_id: CREATOR_ID, force: true } }));
    expect(mockRpc).toHaveBeenCalledWith('_admin_enqueue_corpus_reprocess_unsafe', {
      p_admin_user_id:  ADMIN_USER_ID,
      p_creator_id:     CREATOR_ID,
      p_force:          true,
      p_target_version: 2,
    });
  });

  it('forwards p_target_version=3 (v3 build-then-flip path); accepts string "3"', async () => {
    mockRpc.mockResolvedValue({
      data: [{ enqueued_count: 4, total_ready_samples: 4, skipped_in_flight: 0, skipped_already_queued: 0 }],
      error: null,
    });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, target_version: 3 } }));
    expect(res.status).toBe(200);
    expect((await res.json()).target_version).toBe(3);
    expect(mockRpc).toHaveBeenLastCalledWith('_admin_enqueue_corpus_reprocess_unsafe',
      expect.objectContaining({ p_target_version: 3 }));
    // string "3" coerces to 3 as well
    await POST(mkReq({ body: { creator_id: CREATOR_ID, target_version: '3' } }));
    expect(mockRpc).toHaveBeenLastCalledWith('_admin_enqueue_corpus_reprocess_unsafe',
      expect.objectContaining({ p_target_version: 3 }));
  });

  it('400 bad_target_version on an out-of-range version (e.g. 30) — before any rpc', async () => {
    mockRpc.mockClear();
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, target_version: 30 } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_target_version');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('400 bad_target_version rejects array coercion ([3] → Number 3) (audit M2)', async () => {
    mockRpc.mockClear();
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID, target_version: [3] } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_target_version');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('coerces non-literal-true force values to false', async () => {
    mockRpc.mockResolvedValue({
      data: [{ enqueued_count: 0, total_ready_samples: 0, skipped_in_flight: 0, skipped_already_queued: 0 }],
      error: null,
    });
    // String "true" should not unlock force.
    await POST(mkReq({ body: { creator_id: CREATOR_ID, force: 'true' } }));
    expect(mockRpc).toHaveBeenLastCalledWith('_admin_enqueue_corpus_reprocess_unsafe',
      expect.objectContaining({ p_force: false }));
    // 1 should not unlock force.
    await POST(mkReq({ body: { creator_id: CREATOR_ID, force: 1 } }));
    expect(mockRpc).toHaveBeenLastCalledWith('_admin_enqueue_corpus_reprocess_unsafe',
      expect.objectContaining({ p_force: false }));
  });
});

// ── POST: rpc error mapping ───────────────────────────────────────────────

describe('POST /api/admin/corpus-reprocess — rpc error mapping', () => {
  it('404 creator_not_found on errcode 42704 + writes rejection audit row', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42704', message: 'creator_not_found' },
    });
    const insertSpy = vi.fn().mockResolvedValue({ error: null });
    mockFrom.mockReturnValue({ insert: insertSpy });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('creator_not_found');
    // Audit-1 C2: rejection audit row written from the route.
    expect(mockFrom).toHaveBeenCalledWith('admin_audit_log');
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'creator_corpus_reprocess_enqueue_rejected',
      target_id: CREATOR_ID,
      after: expect.objectContaining({ reason: 'creator_not_found' }),
    }));
  });

  it('400 creator_id_null on errcode 22023', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22023', message: 'creator_id_null' },
    });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('creator_id_null');
  });

  it('403 forbidden on errcode 42501 + writes rejection audit row', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'not_an_active_admin' },
    });
    const insertSpy = vi.fn().mockResolvedValue({ error: null });
    mockFrom.mockReturnValue({ insert: insertSpy });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(403);
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'creator_corpus_reprocess_enqueue_rejected',
      after: expect.objectContaining({ reason: 'not_an_active_admin' }),
    }));
  });

  it('500 enqueue_failed + Sentry capture on unmapped error', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'XX000', message: 'kaboom' },
    });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('enqueue_failed');
    expect(mockSentryCapture).toHaveBeenCalled();
  });

  it('500 enqueue_no_result + Sentry message on empty array result', async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    const res = await POST(mkReq({ body: { creator_id: CREATOR_ID } }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('enqueue_no_result');
    expect(mockSentryMessage).toHaveBeenCalled();
  });
});

// ── GET: status poll ──────────────────────────────────────────────────────

describe('GET /api/admin/corpus-reprocess — status poll', () => {
  it('200 when Origin header is absent (audit-1 M2: GET is read-only, no origin gate)', async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    const res = await GET(mkReq({
      method: 'GET',
      origin: null,
      url: `http://localhost/api/admin/corpus-reprocess?creator_id=${CREATOR_ID}`,
    }));
    expect(res.status).toBe(200);
  });

  it('400 bad_creator_id when query param is missing', async () => {
    const res = await GET(mkReq({
      method: 'GET',
      url: 'http://localhost/api/admin/corpus-reprocess',
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_creator_id');
  });

  it('400 bad_creator_id when query param is not a UUID', async () => {
    const res = await GET(mkReq({
      method: 'GET',
      url: 'http://localhost/api/admin/corpus-reprocess?creator_id=not-a-uuid',
    }));
    expect(res.status).toBe(400);
  });

  it('200 with counts + rows on happy path', async () => {
    const sampleRows = [
      { id: 'j1', sample_id: 's1', sample_title: 'S1', creator_id: CREATOR_ID, target_version: 2,
        status: 'done', attempts: 1, last_error: null, claimed_by: null, claimed_at: null,
        finished_at: '2026-05-18T00:00:00Z', enqueue_version: 1, progress_json: null,
        created_at: '2026-05-18T00:00:00Z' },
      { id: 'j2', sample_id: 's2', sample_title: 'S2', creator_id: CREATOR_ID, target_version: 2,
        status: 'processing', attempts: 1, last_error: null, claimed_by: 'w', claimed_at: '2026-05-18T00:01:00Z',
        finished_at: null, enqueue_version: 1, progress_json: null,
        created_at: '2026-05-18T00:00:00Z' },
      { id: 'j3', sample_id: 's3', sample_title: 'S3', creator_id: CREATOR_ID, target_version: 2,
        status: 'pending', attempts: 0, last_error: null, claimed_by: null, claimed_at: null,
        finished_at: null, enqueue_version: 1, progress_json: null,
        created_at: '2026-05-18T00:00:00Z' },
    ];
    mockRpc.mockResolvedValueOnce({ data: sampleRows, error: null });
    const res = await GET(mkReq({
      method: 'GET',
      url: `http://localhost/api/admin/corpus-reprocess?creator_id=${CREATOR_ID}`,
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      total: number;
      counts: Record<string, number>;
      rows: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.total).toBe(3);
    expect(body.counts.done).toBe(1);
    expect(body.counts.processing).toBe(1);
    expect(body.counts.pending).toBe(1);
    expect(body.counts.errored).toBe(0);
    expect(body.rows).toHaveLength(3);
  });

  it('clamps limit to 100 when missing; passes value through when within range', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await GET(mkReq({
      method: 'GET',
      url: `http://localhost/api/admin/corpus-reprocess?creator_id=${CREATOR_ID}`,
    }));
    expect(mockRpc).toHaveBeenLastCalledWith('admin_list_corpus_reprocess_jobs',
      expect.objectContaining({ p_limit: 100 }));
    await GET(mkReq({
      method: 'GET',
      url: `http://localhost/api/admin/corpus-reprocess?creator_id=${CREATOR_ID}&limit=250`,
    }));
    expect(mockRpc).toHaveBeenLastCalledWith('admin_list_corpus_reprocess_jobs',
      expect.objectContaining({ p_limit: 250 }));
    // Above-max → clamped down to 500.
    await GET(mkReq({
      method: 'GET',
      url: `http://localhost/api/admin/corpus-reprocess?creator_id=${CREATOR_ID}&limit=10000`,
    }));
    expect(mockRpc).toHaveBeenLastCalledWith('admin_list_corpus_reprocess_jobs',
      expect.objectContaining({ p_limit: 500 }));
    // NaN → default 100.
    await GET(mkReq({
      method: 'GET',
      url: `http://localhost/api/admin/corpus-reprocess?creator_id=${CREATOR_ID}&limit=abc`,
    }));
    expect(mockRpc).toHaveBeenLastCalledWith('admin_list_corpus_reprocess_jobs',
      expect.objectContaining({ p_limit: 100 }));
  });

  it('500 list_failed on rpc error', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'kaboom' } });
    const res = await GET(mkReq({
      method: 'GET',
      url: `http://localhost/api/admin/corpus-reprocess?creator_id=${CREATOR_ID}`,
    }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('list_failed');
    expect(mockSentryCapture).toHaveBeenCalled();
  });
});
