// Production-only gate (auditor R2-C5) unit test for /api/admin/face-upload.
//
// The gate is fail-closed: writes are allowed only when
//   VERCEL_ENV === 'production' OR FACE_UPLOAD_ALLOW_LOCAL === '1'.
// Pre-fix the gate was permissive on hosts where VERCEL_ENV was unset
// (custom Docker, CI runs, `next start` on a VPS) — a smoke build outside
// Vercel could quietly POST against production Simli and burn a face slot.
//
// We can't trivially exercise the multipart pipeline without a Supabase /
// Simli stack, so this test covers ONLY the env-gate decision boundary.
// The decision is pure (string comparison) so an isolated unit test is
// sufficient. Anything past the gate is covered by the SQL pgTAP tests
// in supabase/tests/.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoist mocks before importing the route.
vi.mock('@/lib/auth-guards', () => ({
  assertAdminFromSession: vi.fn(async () => ({ userId: 'admin-user-id' })),
  AuthGuardError: class AuthGuardError extends Error {
    status: number;
    constructor(status: number, msg: string) { super(msg); this.status = status; }
  },
}));
vi.mock('@/lib/supabase/admin', () => ({
  // The route only reaches Supabase past the gate; for gate-only tests
  // we never call this. Returning a sentinel makes mis-ordering visible.
  supabaseAdmin: vi.fn(() => { throw new Error('supabaseAdmin should not be called when the gate rejects'); }),
}));
vi.mock('@/lib/avatar/image-probe', () => ({
  probeImage: vi.fn(),
  classifyAspect: vi.fn(),
}));

import { POST } from './route';

const ORIGINAL = { ...process.env };

function makeReq() {
  // Minimal Request-shaped object: same-origin check passes when origin/host both empty.
  return new Request('http://localhost/api/admin/face-upload', {
    method: 'POST',
    body: new FormData(),
  });
}

describe('face-upload route — production-only gate (R2-C5)', () => {
  beforeEach(() => {
    delete process.env.VERCEL_ENV;
    delete process.env.FACE_UPLOAD_ALLOW_LOCAL;
    process.env.SIMLI_API_KEY = 'sk_test';
    // Simulating `next start` outside Vercel: NODE_ENV='production' but
    // VERCEL_ENV unset. The route no longer reads NODE_ENV (post R2-C5 fix);
    // we leave it as set by the test runner.
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.clearAllMocks();
  });

  it('returns 503 face_upload_only_in_production when VERCEL_ENV is unset (fail-closed)', async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('face_upload_only_in_production');
  });

  it('returns 503 when VERCEL_ENV=preview', async () => {
    process.env.VERCEL_ENV = 'preview';
    const res = await POST(makeReq());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('face_upload_only_in_production');
  });

  it('returns 503 when VERCEL_ENV=development', async () => {
    process.env.VERCEL_ENV = 'development';
    const res = await POST(makeReq());
    expect(res.status).toBe(503);
  });

  it('passes the gate when VERCEL_ENV=production (then fails downstream — supabaseAdmin throws)', async () => {
    process.env.VERCEL_ENV = 'production';
    // Past the gate, the next step is Content-Length / multipart parse;
    // the mocked supabaseAdmin will throw if the pipeline reaches it.
    // We assert the gate let it through (status NOT 503) — anything past
    // is downstream-of-gate and covered by SQL tests.
    let res: Response;
    try { res = await POST(makeReq()); }
    catch { res = new Response(null, { status: 500 }); }
    expect(res.status).not.toBe(503);
  });

  it('passes the gate when FACE_UPLOAD_ALLOW_LOCAL=1 even with VERCEL_ENV unset', async () => {
    process.env.FACE_UPLOAD_ALLOW_LOCAL = '1';
    let res: Response;
    try { res = await POST(makeReq()); }
    catch { res = new Response(null, { status: 500 }); }
    expect(res.status).not.toBe(503);
  });

  it('rejects FACE_UPLOAD_ALLOW_LOCAL=true (the literal "1" is required)', async () => {
    process.env.FACE_UPLOAD_ALLOW_LOCAL = 'true';
    const res = await POST(makeReq());
    expect(res.status).toBe(503);
  });
});
