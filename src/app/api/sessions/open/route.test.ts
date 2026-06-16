// Coverage for the use-session-pipe rewire (round-2 audit) tightenings:
//   1. voice_usage_ticket_check pre-mint cap RPC → structured 429 daily_cap_hit.
//   2. mintVoiceTicket failure now closes the session row + returns mapped status.
//
// Both gates run before any avatar/Gemini mint, so we keep the mock surface
// narrow. The cap test bails at the cap-check RPC; the ticket-fatal test
// runs the full success path up to mintVoiceTicket and asserts the
// post-failure cleanup.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Module mocks (hoisted) ────────────────────────────────────────────────
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  setUser: vi.fn(),
}));

vi.mock('@/lib/auth-guards', () => ({
  getCallerUserId: vi.fn(async () => 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'),
}));

vi.mock('@/lib/voice/voice-config', () => ({
  // HUME_TTS_PLAN §6 audit M5 — mock includes ttsProvider + failOpen.
  // failOpen:false is the steady-state success shape; tests that want
  // the proxy-unreachable path override per-test.
  getProxyVoiceConfig: vi.fn(async () => ({
    useTtsLayer: true,
    ttsProvider: 'cartesia',
    failOpen: false,
  })),
}));

vi.mock('@/lib/voice/env-scoped-voice-id', () => ({
  resolveVoiceId: vi.fn(() => 'voice-id-stub'),
  pickEnvScoped: vi.fn(() => null),
  coerceNumericOrNull: (v: unknown) => {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  },
  currentVoiceIdEnv: vi.fn(() => 'production'),
}));

vi.mock('@/lib/avatar/resolver', () => ({
  resolveAvatarProvider: vi.fn(() => 'simli'),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockMintSimli: any = vi.fn(async () => ({
  sessionToken: 'simli-tok',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  faceId: 'face-1',
}));
vi.mock('@/lib/avatar/mint-simli', () => ({
  mintSimliSessionToken: // eslint-disable-next-line @typescript-eslint/no-explicit-any
(...args: any[]) => mockMintSimli(...args),
  SimliMintError: class SimliMintError extends Error {
    httpStatus = 503; code = 'simli_failed';
  },
}));

vi.mock('@/lib/avatar/mint-heygen', () => ({
  mintHeygenSessionToken: vi.fn(),
  HeygenMintError: class HeygenMintError extends Error {
    httpStatus = 503; code = 'heygen_failed';
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockMintEphemeral: any = vi.fn(async () => ({
  token: 'gemini-tok',
  model: 'gemini-3.1-flash-live-preview',
}));
vi.mock('@/lib/voice/mint-ephemeral', () => ({
  mintEphemeral: // eslint-disable-next-line @typescript-eslint/no-explicit-any
(...args: any[]) => mockMintEphemeral(...args),
  MintError: class MintError extends Error {
    httpStatus = 502; code = 'mint_failed';
  },
}));

const mockMintVoiceTicket = vi.fn();
vi.mock('@/lib/voice/mint-voice-ticket', async () => {
  // Re-export the real VoiceTicketMintError so `instanceof` checks in the
  // route hit the same constructor we throw in tests.
  const real = await vi.importActual<typeof import('@/lib/voice/mint-voice-ticket')>(
    '@/lib/voice/mint-voice-ticket',
  );
  return {
    mintVoiceTicket: // eslint-disable-next-line @typescript-eslint/no-explicit-any
(...args: any[]) => mockMintVoiceTicket(...args),
    VoiceTicketMintError: real.VoiceTicketMintError,
  };
});

vi.mock('@/lib/recording/referral-token', () => ({
  candidateTokenHashes: vi.fn(() => []),
  isValidTokenPlaintext: vi.fn(() => false),
}));

const mockCaptureServerSafe = vi.fn();
vi.mock('@/lib/posthog-server', () => ({
  // Phase C B3.1 audit fix C2: typed signature mirrors the production
  // captureServerSafe so a mock call with an unregistered event name fails
  // typecheck rather than silently passing while production typechecks fail.
  captureServerSafe: (
    distinctId: string,
    event: import('@/lib/posthog-events').ServerPostHogEvent,
    props?: Record<string, unknown>,
  ) => mockCaptureServerSafe(distinctId, event, props),
}));

// next/server's `after` is a thin wrapper; vitest doesn't ship the runtime,
// so stub it as a sync no-op invoker.
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, after: (fn: () => unknown) => { try { void fn(); } catch { /* */ } } };
});

// ── Supabase client mocks ─────────────────────────────────────────────────
type RpcCall = { name: string; args: unknown };

let rpcCalls: RpcCall[] = [];
let capRpcResult: { data: unknown; error: unknown } = { data: [{ remaining_seconds: 9999, daily_used: 0, daily_cap: 300, weekly_used: 0, weekly_cap: 900, monthly_used: null, monthly_cap: null }], error: null };
let sessionOpenResult: { data: unknown; error: unknown } = { data: [{ session_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', tier: 'free', daily_limit_remaining_s: 600 }], error: null };
let sessionCloseResult: { data: unknown; error: unknown } = { data: null, error: null };
let rateLimitResult: { data: unknown; error: unknown } = { data: true, error: null };
let takeoverLookupResult: { data: unknown; error: unknown } = { data: null, error: null };
let creatorLookupResult: { data: unknown; error: unknown } = {
  data: {
    id: 'cccccccc-3333-4333-8333-cccccccccccc',
    simli_face_id: 'face-1',
    heygen_avatar_id: null,
    voice_id: 'voice-1',
    voice_id_preview: null,
    voice_id_dev: null,
    published_at: '2026-01-01T00:00:00Z',
    // Brain wire-up (PR-2). Mock a ready creator with persona populated
    // so the new brain_not_ready 409 gate doesn't fire on these tests.
    system_prompt: 'You are Test Creator. Topics: x. Answer briefly.',
    brain_status: 'ready',
    // Creator voice-speed knob (migration 20260511000006). Mock as
    // string to mirror supabase-js's `numeric → string` coercion;
    // the route's boundary coercion (Number()) MUST handle this shape.
    tts_speed: '1.0',
  },
  error: null,
};
let hookBindingLookupResult: { data: unknown; error: unknown } = {
  data: {
    id: 'dddddddd-4444-4444-8444-dddddddddddd',
    video: { creator_id: 'cccccccc-3333-4333-8333-cccccccccccc' },
  },
  error: null,
};

function makeSb() {
  return {
    rpc: vi.fn(async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      if (name === 'session_open') return sessionOpenResult;
      if (name === 'session_close') return sessionCloseResult;
      return { data: null, error: null };
    }),
  };
}

function makeAdmin() {
  return {
    rpc: vi.fn(async (name: string, args: unknown) => {
      // Growth & Minutes Economy Phase 1: the pre-mint gate now calls the UNIFIED
      // voice_balance_check (free allowance + wallet) via admin (service-role) —
      // it REVOKEs EXECUTE from `authenticated` (R1-S3). The route reads
      // remaining_seconds (= effective_remaining) plus wallet_remaining /
      // daily_cap_eff / cap_period (all default to 0/undefined when absent).
      if (name === 'voice_balance_check') {
        rpcCalls.push({ name, args });
        return capRpcResult;
      }
      // Fuse-anchor write (R2-C1) after session_open — non-fatal no-op in tests.
      if (name === 'voice_fuse_anchor_apply') {
        rpcCalls.push({ name, args });
        return { data: null, error: null };
      }
      if (name === 'rate_limit_hit') return rateLimitResult;
      return { data: null, error: null };
    }),
    from: vi.fn((table: string) => {
      if (table === 'creators') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => creatorLookupResult,
            }),
          }),
        };
      }
      if (table === 'hooks') {
        // Brain wire-up (PR-2): hook↔creator binding pre-check.
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => hookBindingLookupResult,
            }),
          }),
        };
      }
      if (table === 'sample_content') {
        // Brain wire-up (PR-2): buildBrainPrefix reads this. Empty
        // result → brain_prefix_skipped (no_overlap), null prefix sent.
        // .neq() chained for whole-build M1 fetch_status='errored' filter.
        return {
          select: () => ({
            eq: () => ({
              neq: () => ({
                overlaps: () => ({
                  order: () => ({
                    limit: async () => ({ data: [], error: null }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'admin_roles') {
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'sessions') {
        // Takeover-path lookup: chained .eq().is().maybeSingle().
        // Audit C1 (unit-wide) — route now writes tts_provider_at_session
        // post-session_open via `.update().eq()`. Test mock must return
        // success for that UPDATE chain or the route returns 500.
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                maybeSingle: async () => takeoverLookupResult,
              }),
              maybeSingle: async () => takeoverLookupResult,
            }),
          }),
          update: () => ({
            eq: async () => ({ data: null, error: null }),
          }),
        };
      }
      if (table === 'sessions_private' || table === 'cogs_log') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          insert: async () => ({ data: null, error: null }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
        insert: async () => ({ data: null, error: null }),
      };
    }),
  };
}

vi.mock('@/lib/supabase/server', () => ({ supabaseServer: vi.fn(async () => makeSb()) }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: vi.fn(() => makeAdmin()) }));

// Import AFTER mocks so the route module picks up the stubs.
import { POST } from './route';
import { VoiceTicketMintError } from '@/lib/voice/mint-voice-ticket';
import { NextRequest } from 'next/server';

function makeReq(body: unknown = {
  creator_id: 'cccccccc-3333-4333-8333-cccccccccccc',
  hook_id:    'dddddddd-4444-4444-8444-dddddddddddd',
  model:      'gemini-3.1-flash-live-preview',
}) {
  return new NextRequest('http://localhost/api/sessions/open', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'jest-test/1',
      // isSameOrigin matches origin host vs req.nextUrl.host.
      origin: 'http://localhost',
    },
    body: JSON.stringify(body),
  });
}

describe('/api/sessions/open — pre-mint cap RPC (use-session-pipe rewire R2-C1)', () => {
  beforeEach(() => {
    rpcCalls = [];
    capRpcResult = { data: [{ remaining_seconds: 9999, daily_used: 0, daily_cap: 300, weekly_used: 0, weekly_cap: 900, monthly_used: null, monthly_cap: null }], error: null };
    sessionOpenResult = { data: [{ session_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', tier: 'free', daily_limit_remaining_s: 600 }], error: null };
    rateLimitResult = { data: true, error: null };
    mockMintVoiceTicket.mockReset();
    mockMintVoiceTicket.mockResolvedValue({ ticket: 'ticket-1', expiresAt: new Date(Date.now() + 120_000).toISOString() });
    process.env.NEXT_PUBLIC_VOICE_PROXY_URL = 'wss://test-proxy.fly.dev/voice/spike-a';
  });
  afterEach(() => { vi.clearAllMocks(); delete process.env.NEXT_PUBLIC_VOICE_PROXY_URL; });

  it('returns 429 daily_cap_hit when remaining_seconds=0, BEFORE session_open', async () => {
    mockCaptureServerSafe.mockClear();
    capRpcResult = {
      data: [{ remaining_seconds: 0, daily_used: 300, daily_cap: 300, weekly_used: 800, weekly_cap: 900, monthly_used: null, monthly_cap: null }],
      error: null,
    };
    const res = await POST(makeReq());
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('daily_cap_hit');
    expect(body.daily_used).toBe(300);
    expect(body.daily_cap).toBe(300);
    expect(body.weekly_used).toBe(800);
    // session_open MUST NOT have been called — Vuk's nit: avoid orphan-row.
    const names = rpcCalls.map((c) => c.name);
    expect(names).toContain('voice_balance_check');
    expect(names).not.toContain('session_open');
    expect(names).not.toContain('session_close');
    // Whole-build audit C4: telemetry fires so we can measure conversion.
    const fired = mockCaptureServerSafe.mock.calls.find(
      (c: unknown[]) => c[1] === 'daily_cap_hit_fired',
    );
    expect(fired).toBeTruthy();
    expect(fired?.[2]).toMatchObject({
      surface: 'sessions_open',
      daily_used: 300,
      daily_cap: 300,
    });
  });

  it('returns 500 cap_check_failed on generic RPC error', async () => {
    capRpcResult = { data: null, error: { message: 'pg failure', code: 'XX000' } };
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('cap_check_failed');
  });

  it('returns 409 profile_not_ready on P0002 (auditor M4)', async () => {
    capRpcResult = { data: null, error: { message: 'user X not found', code: 'P0002' } };
    const res = await POST(makeReq());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('profile_not_ready');
  });

  it('returns 500 cap_check_empty on empty array result (auditor M2)', async () => {
    capRpcResult = { data: [], error: null };
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('cap_check_empty');
  });

  it('coerces numeric strings from supabase-js (auditor S1)', async () => {
    // supabase-js deserialises `numeric` as string; route must coerce.
    capRpcResult = {
      data: [{ remaining_seconds: '0', daily_used: '300', daily_cap: 300, weekly_used: '800', weekly_cap: 900, monthly_used: null, monthly_cap: null }],
      error: null,
    };
    const res = await POST(makeReq());
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.daily_used).toBe(300);
    expect(body.weekly_used).toBe(800);
    expect(body.monthly_used).toBe(null);
    expect(body.remaining_seconds).toBe(0);
  });

  it('proceeds to session_open when remaining_seconds > 0', async () => {
    capRpcResult = {
      data: [{ remaining_seconds: 600, daily_used: 0, daily_cap: 300, weekly_used: 0, weekly_cap: 900, monthly_used: null, monthly_cap: null }],
      error: null,
    };
    const res = await POST(makeReq());
    // Whatever the downstream outcome, the cap gate let the request through.
    expect(res.status).not.toBe(429);
    const names = rpcCalls.map((c) => c.name);
    expect(names).toContain('voice_balance_check');
    expect(names).toContain('session_open');
  });
});

describe('/api/sessions/open — voice-ticket mint is fatal (use-session-pipe rewire)', () => {
  beforeEach(() => {
    rpcCalls = [];
    capRpcResult = { data: [{ remaining_seconds: 9999, daily_used: 0, daily_cap: 300, weekly_used: 0, weekly_cap: 900, monthly_used: null, monthly_cap: null }], error: null };
    sessionOpenResult = { data: [{ session_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', tier: 'free', daily_limit_remaining_s: 600 }], error: null };
    rateLimitResult = { data: true, error: null };
    sessionCloseResult = { data: null, error: null };
    mockMintVoiceTicket.mockReset();
    process.env.NEXT_PUBLIC_VOICE_PROXY_URL = 'wss://test-proxy.fly.dev/voice/spike-a';
  });
  afterEach(() => { vi.clearAllMocks(); delete process.env.NEXT_PUBLIC_VOICE_PROXY_URL; });

  it('on too_many_tickets: closes session + returns mapped 429 (httpStatus from VoiceTicketMintError)', async () => {
    mockMintVoiceTicket.mockRejectedValue(new VoiceTicketMintError('too_many_tickets', 429));
    const res = await POST(makeReq());
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('too_many_tickets');
    const closeCalls = rpcCalls.filter((c) => c.name === 'session_close');
    expect(closeCalls.length).toBe(1);
    expect((closeCalls[0].args as { p_end_reason?: string }).p_end_reason).toBe('voice_ticket_mint_failed');
  });

  it('on ticket_mint_failed: closes session + returns 500 (httpStatus from VoiceTicketMintError)', async () => {
    mockMintVoiceTicket.mockRejectedValue(new VoiceTicketMintError('ticket_mint_failed', 500, 'pg insert failed'));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('ticket_mint_failed');
    expect(rpcCalls.filter((c) => c.name === 'session_close').length).toBe(1);
  });

  it('on non-VoiceTicketMintError: closes session + returns 502 voice_ticket_mint_failed', async () => {
    mockMintVoiceTicket.mockRejectedValue(new Error('unknown'));
    const res = await POST(makeReq());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('voice_ticket_mint_failed');
    expect(rpcCalls.filter((c) => c.name === 'session_close').length).toBe(1);
  });

  it('masks bad_ua (programmer error) as 500 voice_ticket_mint_failed (auditor C2)', async () => {
    mockMintVoiceTicket.mockRejectedValue(new VoiceTicketMintError('bad_ua', 400));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('voice_ticket_mint_failed');
  });

  it('masks bad_avatar_provider (programmer error) as 500 (auditor C2)', async () => {
    mockMintVoiceTicket.mockRejectedValue(new VoiceTicketMintError('bad_avatar_provider', 400));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('voice_ticket_mint_failed');
  });

  it('on takeover + voice-ticket failure: does NOT close the existing session (auditor M3)', async () => {
    // Force takeover by tripping the unique-active index on session_open.
    sessionOpenResult = { data: null, error: { code: '23505', message: 'sessions_one_active_per_user' } };
    // Seed the live-session lookup so the takeover branch resolves.
    takeoverLookupResult = {
      data: {
        id: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
        creator_id: 'cccccccc-3333-4333-8333-cccccccccccc',
        tier_at_session: 'free',
      },
      error: null,
    };
    mockMintVoiceTicket.mockRejectedValue(new VoiceTicketMintError('ticket_mint_failed', 500, 'pg insert failed'));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    // session_close MUST NOT be called on the takeover path — closing
    // the existing live session would kill the winner tab.
    expect(rpcCalls.filter((c) => c.name === 'session_close').length).toBe(0);
    // Reset for subsequent tests.
    takeoverLookupResult = { data: null, error: null };
  });

  it('on success: returns 200 envelope with voice + voice_ticket + proxy_url, no gemini key', async () => {
    mockMintVoiceTicket.mockResolvedValue({ ticket: 'ticket-1', expiresAt: new Date(Date.now() + 120_000).toISOString() });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.voice_ticket).toEqual({ ticket: 'ticket-1', expiresAt: expect.any(String) });
    expect(body.session_id).toBe('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb');
    // PR-2: envelope carries `voice: {model}` not `gemini: {token, model}`.
    expect(body.voice).toEqual({ model: 'gemini-3.1-flash-live-preview' });
    expect(body.gemini).toBeUndefined();
    expect(body.proxy_url).toBe('wss://test-proxy.fly.dev/voice/spike-a');
    // session_close NOT called on the success path.
    expect(rpcCalls.filter((c) => c.name === 'session_close').length).toBe(0);
  });

  it('PR-2: returns 503 proxy_url_unconfigured when env unset + closes session', async () => {
    delete process.env.NEXT_PUBLIC_VOICE_PROXY_URL;
    mockMintVoiceTicket.mockResolvedValue({ ticket: 'ticket-1', expiresAt: new Date(Date.now() + 120_000).toISOString() });
    const res = await POST(makeReq());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('proxy_url_unconfigured');
    // Must close the orphaned session row to free the user's slot.
    expect(rpcCalls.filter((c) => c.name === 'session_close').length).toBe(1);
  });
});

// Brain wire-up (PR-2) — new gates added by the route.
describe('/api/sessions/open — brain wire-up gates (R3 audit C1 + M1)', () => {
  beforeEach(() => {
    rpcCalls = [];
    capRpcResult = { data: [{ remaining_seconds: 9999, daily_used: 0, daily_cap: 300, weekly_used: 0, weekly_cap: 900, monthly_used: null, monthly_cap: null }], error: null };
    sessionOpenResult = { data: [{ session_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', tier: 'free', daily_limit_remaining_s: 600 }], error: null };
    rateLimitResult = { data: true, error: null };
    sessionCloseResult = { data: null, error: null };
    mockMintVoiceTicket.mockReset();
    mockMintVoiceTicket.mockResolvedValue({ ticket: 'ticket-1', expiresAt: new Date(Date.now() + 120_000).toISOString() });
    process.env.NEXT_PUBLIC_VOICE_PROXY_URL = 'wss://test-proxy.fly.dev/voice/spike-a';
    // Reset to defaults for this suite.
    creatorLookupResult = {
      data: {
        id: 'cccccccc-3333-4333-8333-cccccccccccc',
        simli_face_id: 'face-1',
        heygen_avatar_id: null,
        voice_id: 'voice-1',
        voice_id_preview: null,
        voice_id_dev: null,
        published_at: '2026-01-01T00:00:00Z',
        system_prompt: 'You are Test Creator. Topics: x. Answer briefly.',
        brain_status: 'ready',
        tts_speed: '1.0',
      },
      error: null,
    };
    hookBindingLookupResult = {
      data: {
        id: 'dddddddd-4444-4444-8444-dddddddddddd',
        video: { creator_id: 'cccccccc-3333-4333-8333-cccccccccccc' },
      },
      error: null,
    };
  });
  afterEach(() => { vi.clearAllMocks(); delete process.env.NEXT_PUBLIC_VOICE_PROXY_URL; });

  it('returns 400 hook_creator_mismatch when hook belongs to a different creator (R3 C1)', async () => {
    hookBindingLookupResult = {
      data: {
        id: 'dddddddd-4444-4444-8444-dddddddddddd',
        video: { creator_id: 'eeeeeeee-9999-4999-8999-eeeeeeeeeeee' }, // different creator
      },
      error: null,
    };
    const res = await POST(makeReq());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('hook_creator_mismatch');
    // Must NOT proceed to session_open RPC.
    expect(rpcCalls.map((c) => c.name)).not.toContain('session_open');
  });

  it('returns 400 hook_creator_mismatch when hook does not exist', async () => {
    hookBindingLookupResult = { data: null, error: null };
    const res = await POST(makeReq());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('hook_creator_mismatch');
  });

  it('returns 409 brain_not_ready when system_prompt is null (R3 M1 — gate semantic)', async () => {
    creatorLookupResult = {
      data: {
        ...((creatorLookupResult.data ?? {}) as Record<string, unknown>),
        system_prompt: null,
        brain_status: 'training',
      },
      error: null,
    };
    const res = await POST(makeReq());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('brain_not_ready');
    expect(body.brain_status).toBe('training');
    // Must NOT proceed to session_open RPC for non-admin caller.
    expect(rpcCalls.map((c) => c.name)).not.toContain('session_open');
  });

  it('returns 409 brain_not_ready when brain_status=errored (whole-build C1)', async () => {
    creatorLookupResult = {
      data: {
        ...((creatorLookupResult.data ?? {}) as Record<string, unknown>),
        system_prompt: 'You are X.',
        brain_status: 'errored',
      },
      error: null,
    };
    const res = await POST(makeReq());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('brain_not_ready');
  });

  it('returns 409 creator_not_published when published_at is null for a non-admin (C3)', async () => {
    creatorLookupResult = {
      data: {
        ...((creatorLookupResult.data ?? {}) as Record<string, unknown>),
        // Brain fully ready, but unpublished (e.g. taken down / not yet live).
        system_prompt: 'You are Test Creator.',
        brain_status: 'ready',
        published_at: null,
      },
      error: null,
    };
    const res = await POST(makeReq());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('creator_not_published');
    // Must NOT proceed to session_open RPC for a non-admin caller.
    expect(rpcCalls.map((c) => c.name)).not.toContain('session_open');
  });

  it('ALLOWS brain_status=training when persona populated (whole-build C1 — loosened gate)', async () => {
    // Pre-fix: this would 409. Post-fix: training+persona is the
    // post-approval steady state and should be allowed.
    creatorLookupResult = {
      data: {
        ...((creatorLookupResult.data ?? {}) as Record<string, unknown>),
        system_prompt: 'You are Test Creator. Topics: x. Answer briefly.',
        brain_status: 'training',
      },
      error: null,
    };
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(rpcCalls.map((c) => c.name)).toContain('session_open');
  });

  it('passes system_prompt + null prefixTurns through to mintVoiceTicket on ready creator', async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(mockMintVoiceTicket).toHaveBeenCalledTimes(1);
    const callArgs = mockMintVoiceTicket.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.systemPrompt).toBe('You are Test Creator. Topics: x. Answer briefly.');
    // No sample_content rows in mock → prefixTurns null.
    expect(callArgs.prefixTurns).toBeNull();
    // Creator voice-speed (migration 20260511000006). Mock returned
    // '1.0' (string, mirroring supabase-js numeric coercion); route
    // MUST coerce to 1.0 (number) before passing to mintVoiceTicket.
    expect(callArgs.ttsSpeed).toBe(1.0);
    expect(typeof callArgs.ttsSpeed).toBe('number');
  });

  it('coerces tts_speed=0.85 (string from supabase-js) to number through to mintVoiceTicket', async () => {
    creatorLookupResult = {
      data: {
        ...((creatorLookupResult.data ?? {}) as Record<string, unknown>),
        tts_speed: '0.85', // string, mirrors supabase-js numeric shape
      },
      error: null,
    };
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const callArgs = mockMintVoiceTicket.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.ttsSpeed).toBe(0.85);
    expect(typeof callArgs.ttsSpeed).toBe('number');
  });

  it('passes tts_speed=null when creator row has null (legacy / forward-compat)', async () => {
    creatorLookupResult = {
      data: {
        ...((creatorLookupResult.data ?? {}) as Record<string, unknown>),
        tts_speed: null,
      },
      error: null,
    };
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const callArgs = mockMintVoiceTicket.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.ttsSpeed).toBeNull();
  });

  // DECOUPLED_BRAIN_PLAN P1-10 — route forwards creators.decoupled to
  // mintVoiceTicket. Pre-P1-10 this field was provably inert at the
  // route layer (whole-build audit: "route writer cannot reach
  // decoupled today") — the proxy bridge always saw consumed.decoupled
  // = false even with creators.decoupled = true. These tests lock the
  // wiring so a future drift fails in CI.
  it('P1-10: forwards decoupled=true through to mintVoiceTicket', async () => {
    creatorLookupResult = {
      data: {
        ...((creatorLookupResult.data ?? {}) as Record<string, unknown>),
        decoupled:  true,
        brain_mode: 'vector', // admin RPC keeps these aligned
      },
      error: null,
    };
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const callArgs = mockMintVoiceTicket.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.decoupled).toBe(true);
    expect(callArgs.brainMode).toBe('vector');
  });

  it('P1-10: forwards decoupled=false on legacy creators', async () => {
    // Default fixture has no `decoupled` field; route MUST coerce to false.
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const callArgs = mockMintVoiceTicket.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.decoupled).toBe(false);
  });
});
