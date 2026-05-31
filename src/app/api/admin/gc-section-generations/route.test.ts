import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockAssertAdmin, mockUserRpc, mockAdminFrom } = vi.hoisted(() => ({
  mockAssertAdmin: vi.fn(),
  mockUserRpc: vi.fn(),
  mockAdminFrom: vi.fn(),
}));

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

import { AuthGuardError } from '@/lib/auth-guards';

const ROUTE = '/api/admin/gc-section-generations';
const UUID = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';

function makeReq(body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertAdmin.mockResolvedValue({ userId: 'admin-1', email: 'a@b', role: 'superadmin' });
});

function wireAdmin(admin?: Error) {
  if (admin) mockAssertAdmin.mockRejectedValue(admin);
}
function wireRpc(rpcResult: { data?: unknown; error: unknown }) {
  mockUserRpc.mockResolvedValue(rpcResult);
}
function wireAdminClient(tables: Record<string, unknown>) {
  mockAdminFrom.mockImplementation((table: string) => {
    const result = tables[table];
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.limit = () => chain;
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

describe(`POST ${ROUTE}`, () => {
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
    wireRpc({ data: { stale_sections_deleted: 3, corpus_version: 5 }, error: null });
    const { POST } = await import('./route');
    const res = await POST(makeReq({ creator_id: UUID }) as never);
    expect(res.status).toBe(200);
    expect((await res.json()).result.stale_sections_deleted).toBe(3);
  });

  it('403 forbidden on 42501', async () => {
    wireAdmin();
    wireRpc({ error: { code: '42501', message: 'permission denied' } });
    const { POST } = await import('./route');
    expect((await POST(makeReq({ creator_id: UUID }) as never)).status).toBe(403);
  });
});

describe(`GET ${ROUTE} (preview)`, () => {
  it('403 when not admin', async () => {
    wireAdmin(new AuthGuardError('Forbidden', 403));
    const { GET } = await import('./route');
    expect((await GET(makeGet(UUID) as never)).status).toBe(403);
  });

  it('counts stale sections per-sample: section_generation < active - 1', async () => {
    wireAdmin();
    // sample A active=3 → stale iff gen < 2 (gen 1 stale, gen 2/3 kept).
    // sample B active=2 → stale iff gen < 1 (nothing stale).
    wireAdminClient({
      sample_content: {
        data: [
          { id: 'A', active_section_generation: 3 },
          { id: 'B', active_section_generation: 2 },
        ],
        error: null,
      },
      sample_content_sections: {
        data: [
          { sample_id: 'A', section_generation: 1 }, // stale (1 < 2)
          { sample_id: 'A', section_generation: 2 }, // kept
          { sample_id: 'A', section_generation: 3 }, // kept (active)
          { sample_id: 'B', section_generation: 1 }, // kept (1 not < 1)
        ],
        error: null,
      },
    });
    const { GET } = await import('./route');
    const res = await GET(makeGet(UUID) as never);
    expect(res.status).toBe(200);
    expect((await res.json()).stale_sections).toBe(1);
  });
});
