import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockAssertAdmin, mockUserRpc, mockAdminFrom } = vi.hoisted(() => ({
  mockAssertAdmin: vi.fn(),
  mockUserRpc: vi.fn(),
  mockAdminFrom: vi.fn(),
}));

// Real AuthGuardError class (defined IN the factory so the route's
// `e instanceof AuthGuardError` + `e.status` work; an auto-mock blanks the
// constructor → undefined status). Re-exported for the tests via import below.
vi.mock('@/lib/auth-guards', () => ({
  assertAdminFromSession: () => mockAssertAdmin(),
  AuthGuardError: class AuthGuardError extends Error {
    status: number;
    constructor(msg: string, status: number) { super(msg); this.status = status; }
  },
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: mockAdminFrom }) }));
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: async () => ({ rpc: mockUserRpc }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), setUser: vi.fn() }));

// Pull the mocked AuthGuardError class so tests can construct it.
import { AuthGuardError } from '@/lib/auth-guards';

const ROUTE = '/api/admin/purge-legacy-chunks';
const UUID = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';

function makeReq(body: unknown, origin = 'http://localhost:3000'): NextRequest {
  return new NextRequest(`http://localhost:3000${ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, host: 'localhost:3000' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  // clearAllMocks resets call history AND implementations on the hoisted mocks;
  // do NOT reassign them (they are const from vi.hoisted → TS2588 + runtime throw).
  vi.clearAllMocks();
  mockAssertAdmin.mockResolvedValue({ userId: 'admin-1', email: 'a@b', role: 'superadmin' });
});

function wireAdmin(admin?: Error) {
  if (admin) mockAssertAdmin.mockRejectedValue(admin);
}
function wireRpc(rpcResult: { data?: unknown; error: unknown }) {
  mockUserRpc.mockResolvedValue(rpcResult);
}

describe(`POST ${ROUTE}`, () => {
  it('403 bad_origin when origin mismatches host', async () => {
    wireAdmin();
    const { POST } = await import('./route');
    const req = new NextRequest(`http://localhost:3000${ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.com', host: 'localhost:3000' },
      body: JSON.stringify({ creator_id: UUID }),
    });
    expect((await POST(req as never)).status).toBe(403);
  });

  it('415 for non-JSON content-type', async () => {
    wireAdmin();
    const { POST } = await import('./route');
    const req = new NextRequest(`http://localhost:3000${ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'http://localhost:3000', host: 'localhost:3000' },
      body: 'x',
    });
    expect((await POST(req as never)).status).toBe(415);
  });

  it('401 when unauthenticated', async () => {
    wireAdmin(new AuthGuardError('Unauthorized', 401));
    const { POST } = await import('./route');
    expect((await POST(makeReq({ creator_id: UUID }) as never)).status).toBe(401);
  });

  it('403 when not admin', async () => {
    wireAdmin(new AuthGuardError('Forbidden', 403));
    const { POST } = await import('./route');
    expect((await POST(makeReq({ creator_id: UUID }) as never)).status).toBe(403);
  });

  it('400 for bad uuid', async () => {
    wireAdmin();
    const { POST } = await import('./route');
    expect((await POST(makeReq({ creator_id: 'nope' }) as never)).status).toBe(400);
  });

  it('200 on success, returns RPC jsonb', async () => {
    wireAdmin();
    wireRpc({ data: { legacy_chunks_deleted: 4, v2_narrative_units_deleted: 1, new_corpus_version: 7 }, error: null });
    const { POST } = await import('./route');
    const res = await POST(makeReq({ creator_id: UUID }) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.legacy_chunks_deleted).toBe(4);
  });

  it('409 purge_refused_not_on_v3 on 23514', async () => {
    wireAdmin();
    wireRpc({
      error: { code: '23514', message: 'purge_refused_creator_not_on_v3 -- creator.retrieval_version=2. ...' },
    });
    const { POST } = await import('./route');
    const res = await POST(makeReq({ creator_id: UUID }) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('purge_refused_not_on_v3');
  });

  it('404 creator_not_found on 42704', async () => {
    wireAdmin();
    wireRpc({ error: { code: '42704', message: 'creator_not_found' } });
    const { POST } = await import('./route');
    expect((await POST(makeReq({ creator_id: UUID }) as never)).status).toBe(404);
  });
});

// Preview GET — table-switching admin mock (sets mockAdminFrom).
function wireAdminClient(tables: Record<string, unknown>) {
  mockAdminFrom.mockImplementation((table: string) => {
    const result = tables[table];
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.in = () => chain;
    chain.is = () => chain;
    chain.maybeSingle = () => Promise.resolve(result);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(result).then(resolve);
    return chain;
  });
}
function makeGet(creatorId?: string): NextRequest {
  const url = new URL(`http://localhost:3000${ROUTE}`);
  if (creatorId) url.searchParams.set('creator_id', creatorId);
  return new NextRequest(url, { method: 'GET', headers: { host: 'localhost:3000' } });
}

describe(`GET ${ROUTE} (preview)`, () => {
  it('403 when not admin', async () => {
    wireAdmin(new AuthGuardError('Forbidden', 403));
    const { GET } = await import('./route');
    expect((await GET(makeGet(UUID) as never)).status).toBe(403);
  });

  it('400 for missing/bad creator_id', async () => {
    wireAdmin();
    const { GET } = await import('./route');
    expect((await GET(makeGet() as never)).status).toBe(400);
  });

  it('available:false reason:not_on_v3 when creator is not on v3 (C3 guard parity)', async () => {
    wireAdmin();
    wireAdminClient({ creators: { data: { retrieval_version: 2, legacy_purged_at: null }, error: null } });
    const { GET } = await import('./route');
    const res = await GET(makeGet(UUID) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(false);
    expect(body.reason).toBe('not_on_v3');
  });

  it('available:true with mirrored counts when on v3', async () => {
    wireAdmin();
    wireAdminClient({
      creators: { data: { retrieval_version: 3, legacy_purged_at: null }, error: null },
      sample_content_chunks: { count: 9, error: null },
      sample_content_narrative_units: { count: 2, error: null },
    });
    const { GET } = await import('./route');
    const res = await GET(makeGet(UUID) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.legacy_chunks).toBe(9);
    expect(body.v2_narrative_units).toBe(2);
  });
});
