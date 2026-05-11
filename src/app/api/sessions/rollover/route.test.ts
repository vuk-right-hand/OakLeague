// Coverage for the use-session-pipe rewire (PR-2) /api/sessions/rollover
// changes:
//   1. Voice-ticket mint failure is fatal (was soft-fail) — closes the new
//      session row + returns mapped status. (Round-2 audit M2: an earlier
//      "503 retry" contract was unworkable because session_rollover refuses
//      a second rollover against a now-closed old row.)
//   2. NEXT_PUBLIC_VOICE_PROXY_URL unset → 503 + close new row.
//   3. Success envelope carries `voice: {model}`, no `gemini` key.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  setUser: vi.fn(),
}));

vi.mock('@/lib/auth-guards', () => ({
  getCallerUserId: vi.fn(async () => 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'),
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mintSimliSessionToken: (...args: any[]) => mockMintSimli(...args),
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mintEphemeral: (...args: any[]) => mockMintEphemeral(...args),
  MintError: class MintError extends Error {
    httpStatus = 502; code = 'mint_failed';
  },
}));

const mockMintVoiceTicket = vi.fn();
vi.mock('@/lib/voice/mint-voice-ticket', async () => {
  const real = await vi.importActual<typeof import('@/lib/voice/mint-voice-ticket')>(
    '@/lib/voice/mint-voice-ticket',
  );
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mintVoiceTicket: (...args: any[]) => mockMintVoiceTicket(...args),
    VoiceTicketMintError: real.VoiceTicketMintError,
  };
});

type RpcCall = { name: string; args: unknown };
let rpcCalls: RpcCall[] = [];
let rolloverResult: { data: unknown; error: unknown } = {
  data: [{ new_session_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', tier: 'free', daily_limit_remaining_s: 600 }],
  error: null,
};

function makeSb() {
  return {
    rpc: vi.fn(async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      if (name === 'session_rollover') return rolloverResult;
      if (name === 'session_close') return { data: null, error: null };
      return { data: null, error: null };
    }),
  };
}

function makeAdmin() {
  return {
    from: vi.fn((table: string) => {
      if (table === 'creators') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: 'cccccccc-3333-4333-8333-cccccccccccc',
                  simli_face_id: 'face-1',
                  heygen_avatar_id: null,
                  // Brain wire-up (PR-2). Mock a ready creator with a
                  // populated persona so the new gate at the top of the
                  // route doesn't 409 these test cases.
                  system_prompt: 'You are Test Creator. Topics: x. Answer briefly.',
                  brain_status: 'ready',
                  // Creator voice-speed (migration 20260511000006). Mock
                  // as string to mirror supabase-js's numeric → string
                  // coercion.
                  tts_speed: '1.0',
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'hooks') {
        // Brain wire-up (PR-2): hook↔creator binding pre-check.
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: 'dddddddd-4444-4444-8444-dddddddddddd',
                  video: { creator_id: 'cccccccc-3333-4333-8333-cccccccccccc' },
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'sample_content') {
        // Brain wire-up (PR-2): buildBrainPrefix reads this. Empty result
        // → brain_prefix_skipped (no_overlap), null prefix sent to mint.
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
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { avatar_provider: 'simli' }, error: null }),
            }),
          }),
          update: () => ({ eq: async () => ({ data: null, error: null }) }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      };
    }),
  };
}

vi.mock('@/lib/supabase/server', () => ({ supabaseServer: vi.fn(async () => makeSb()) }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: vi.fn(() => makeAdmin()) }));

import { POST } from './route';
import { VoiceTicketMintError } from '@/lib/voice/mint-voice-ticket';
import { NextRequest } from 'next/server';

function makeReq(body: unknown = {
  old_session_id: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
  creator_id:     'cccccccc-3333-4333-8333-cccccccccccc',
  hook_id:        'dddddddd-4444-4444-8444-dddddddddddd',
  model:          'gemini-3.1-flash-live-preview',
}) {
  return new NextRequest('http://localhost/api/sessions/rollover', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'jest-test/1',
      origin: 'http://localhost',
    },
    body: JSON.stringify(body),
  });
}

describe('/api/sessions/rollover — voice-ticket fatal (PR-2 round-2 M2)', () => {
  beforeEach(() => {
    rpcCalls = [];
    rolloverResult = {
      data: [{ new_session_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', tier: 'free', daily_limit_remaining_s: 600 }],
      error: null,
    };
    mockMintVoiceTicket.mockReset();
    process.env.NEXT_PUBLIC_VOICE_PROXY_URL = 'wss://test-proxy.fly.dev/voice/spike-a';
  });
  afterEach(() => { vi.clearAllMocks(); delete process.env.NEXT_PUBLIC_VOICE_PROXY_URL; });

  it('on too_many_tickets: closes new session + returns 429 (no retry contract)', async () => {
    mockMintVoiceTicket.mockRejectedValue(new VoiceTicketMintError('too_many_tickets', 429));
    const res = await POST(makeReq());
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('too_many_tickets');
    const closeCalls = rpcCalls.filter((c) => c.name === 'session_close');
    expect(closeCalls.length).toBe(1);
    expect((closeCalls[0].args as { p_end_reason?: string }).p_end_reason).toBe('voice_ticket_mint_failed');
  });

  it('on bad_ua (programmer error): masks as 500 voice_ticket_mint_failed', async () => {
    mockMintVoiceTicket.mockRejectedValue(new VoiceTicketMintError('bad_ua', 400));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('voice_ticket_mint_failed');
  });

  it('on ticket_mint_failed: closes new session + returns 500', async () => {
    mockMintVoiceTicket.mockRejectedValue(new VoiceTicketMintError('ticket_mint_failed', 500, 'pg failed'));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('ticket_mint_failed');
    expect(rpcCalls.filter((c) => c.name === 'session_close').length).toBe(1);
  });

  it('on non-VoiceTicketMintError: closes new session + returns 502', async () => {
    mockMintVoiceTicket.mockRejectedValue(new Error('unknown'));
    const res = await POST(makeReq());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('voice_ticket_mint_failed');
    expect(rpcCalls.filter((c) => c.name === 'session_close').length).toBe(1);
  });

  it('PR-2: returns 503 proxy_url_unconfigured when env unset + closes new session', async () => {
    delete process.env.NEXT_PUBLIC_VOICE_PROXY_URL;
    mockMintVoiceTicket.mockResolvedValue({ ticket: 'ticket-1', expiresAt: new Date(Date.now() + 120_000).toISOString() });
    const res = await POST(makeReq());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('proxy_url_unconfigured');
    expect(rpcCalls.filter((c) => c.name === 'session_close').length).toBe(1);
  });

  it('on success: returns 200 envelope with voice + voice_ticket + proxy_url, no gemini key', async () => {
    mockMintVoiceTicket.mockResolvedValue({ ticket: 'ticket-1', expiresAt: new Date(Date.now() + 120_000).toISOString() });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.voice).toEqual({ model: 'gemini-3.1-flash-live-preview' });
    expect(body.gemini).toBeUndefined();
    expect(body.voice_ticket).toEqual({ ticket: 'ticket-1', expiresAt: expect.any(String) });
    expect(body.proxy_url).toBe('wss://test-proxy.fly.dev/voice/spike-a');
    expect(body.session_id).toBe('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb');
    expect(rpcCalls.filter((c) => c.name === 'session_close').length).toBe(0);
  });
});
