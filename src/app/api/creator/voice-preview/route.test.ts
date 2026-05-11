// /api/creator/voice-preview tests.
//
// Coverage per R1+R2 audits:
//   * 401 unauthenticated
//   * 400 invalid_speed (non-finite, missing, wrong type)
//   * 400 speed_out_of_range (< 0.6 or > 1.5)
//   * 403 not_a_creator (caller has no creators row)
//   * 409 voice_not_trained (creator row but no env-scoped voice_id)
//   * 429 rate_limited (burst)
//   * 429 daily_cap_reached
//   * 502 cartesia_auth_failed, cartesia_voice_not_found, cartesia_error
//   * 504 cartesia_timeout
//   * 502 cartesia_empty_body (200 + 0 bytes)
//   * 200 mp3 success + generation_config.speed included when speed != 1.0
//   * 200 mp3 success + generation_config OMITTED when speed === 1.0
//   * cogs_log insert shape verified

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const mockGetCallerUserId = vi.fn();
vi.mock('@/lib/auth-guards', () => ({
  getCallerUserId: (...args: unknown[]) => mockGetCallerUserId(...args),
}));

type CreatorRow = {
  id: string;
  voice_id: string | null;
  voice_id_preview: string | null;
  voice_id_dev: string | null;
};
let creatorLookupResult: { data: CreatorRow | null; error: unknown } = {
  data: {
    id: 'cccccccc-3333-4333-8333-cccccccccccc',
    voice_id: 'voice-prod-1',
    voice_id_preview: 'voice-prev-1',
    voice_id_dev: 'voice-dev-1',
  },
  error: null,
};
let burstAllowed: boolean | null = true;
let burstError: { message: string } | null = null;
let dailyAllowed: boolean | null = true;
let dailyError: { message: string } | null = null;
let cogsInsertCalls: unknown[] = [];
let cogsInsertError: { message: string } | null = null;

function makeAdmin() {
  return {
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
      if (table === 'cogs_log') {
        return {
          insert: vi.fn(async (row: unknown) => {
            cogsInsertCalls.push(row);
            return cogsInsertError ? { error: cogsInsertError } : { error: null };
          }),
        };
      }
      return {};
    }),
    rpc: vi.fn(async (name: string, args: { p_scope: string; p_window?: string }) => {
      if (name === 'rate_limit_hit') {
        // Pre-commit audit C1 regression guard: rate_limit_hit RAISEs
        // 22023 on any window other than '1 minute' (migration
        // 20260503000009:397). Fail loud if route ever drifts.
        if (args.p_window !== '1 minute') {
          return { data: null, error: { message: `bad window: ${args.p_window}` } };
        }
        if (args.p_scope === 'voice_tts_preview_burst') {
          return burstError ? { data: null, error: burstError } : { data: burstAllowed, error: null };
        }
      }
      if (name === 'rate_limit_hit_day') {
        if (args.p_scope === 'voice_tts_preview_daily') {
          return dailyError ? { data: null, error: dailyError } : { data: dailyAllowed, error: null };
        }
      }
      return { data: null, error: null };
    }),
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => makeAdmin(),
}));

// resolveVoiceId picks based on VERCEL_ENV. Mock it directly so tests
// don't depend on the env var.
let resolveVoiceIdReturn: string | null = 'voice-prod-1';
vi.mock('@/lib/voice/env-scoped-voice-id', () => ({
  resolveVoiceId: () => resolveVoiceIdReturn,
  currentVoiceIdEnv: () => 'production',
  voiceIdColumn: () => 'voice_id',
}));

// fetch mock — controls Cartesia REST response.
const realFetch = globalThis.fetch;
let fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
beforeEach(() => {
  cogsInsertCalls = [];
  cogsInsertError = null;
  burstAllowed = true;
  burstError = null;
  dailyAllowed = true;
  dailyError = null;
  creatorLookupResult = {
    data: {
      id: 'cccccccc-3333-4333-8333-cccccccccccc',
      voice_id: 'voice-prod-1',
      voice_id_preview: 'voice-prev-1',
      voice_id_dev: 'voice-dev-1',
    },
    error: null,
  };
  resolveVoiceIdReturn = 'voice-prod-1';
  mockGetCallerUserId.mockResolvedValue('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
  process.env.CARTESIA_API_KEY = 'k-test';
  process.env.CARTESIA_USD_PER_CHAR = '0.00005';
  // Default fetch: success with a 1-byte mp3 placeholder.
  fetchImpl = async () =>
    new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x40, 0x00]), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => fetchImpl(input, init)) as typeof fetch;
});
afterEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = realFetch;
});

import { POST } from './route';

function makeReq(body: unknown = { speed: 0.85 }): Request {
  return new Request('http://localhost/api/creator/voice-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/creator/voice-preview — auth ladder', () => {
  it('401 when unauthenticated', async () => {
    mockGetCallerUserId.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('unauthorized');
  });

  it('403 not_a_creator when caller has no creator row', async () => {
    creatorLookupResult = { data: null, error: null };
    const res = await POST(makeReq());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('not_a_creator');
  });

  it('409 voice_not_trained when creator exists but no env-scoped voice_id', async () => {
    resolveVoiceIdReturn = null;
    const res = await POST(makeReq());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('voice_not_trained');
  });
});

describe('POST /api/creator/voice-preview — body validation', () => {
  it('400 invalid_json on non-json body', async () => {
    const req = new Request('http://localhost/api/creator/voice-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_json');
  });

  it('400 invalid_speed on missing speed field', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_speed');
  });

  it('400 invalid_speed on non-numeric speed', async () => {
    const res = await POST(makeReq({ speed: 'fast' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_speed');
  });

  it('400 speed_out_of_range below 0.6', async () => {
    const res = await POST(makeReq({ speed: 0.5 }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('speed_out_of_range');
  });

  it('400 speed_out_of_range above 1.5', async () => {
    const res = await POST(makeReq({ speed: 1.6 }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('speed_out_of_range');
  });
});

describe('POST /api/creator/voice-preview — rate limits', () => {
  it('429 rate_limited when burst returns false', async () => {
    burstAllowed = false;
    const res = await POST(makeReq());
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('rate_limited');
  });

  it('429 daily_cap_reached when daily returns false', async () => {
    dailyAllowed = false;
    const res = await POST(makeReq());
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('daily_cap_reached');
  });

  it('500 rate_limit_failed when burst RPC errors', async () => {
    burstError = { message: 'pg failed' };
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('rate_limit_failed');
  });

  it('500 rate_limit_failed when daily RPC errors', async () => {
    dailyError = { message: 'pg failed' };
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('rate_limit_failed');
  });
});

describe('POST /api/creator/voice-preview — Cartesia error branching (R1 M5 / R2 M6)', () => {
  it('502 cartesia_auth_failed on upstream 401', async () => {
    fetchImpl = async () => new Response('unauthorized', { status: 401 });
    const res = await POST(makeReq());
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('cartesia_auth_failed');
  });

  it('502 cartesia_voice_not_found on upstream 404', async () => {
    fetchImpl = async () => new Response('no such voice', { status: 404 });
    const res = await POST(makeReq());
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('cartesia_voice_not_found');
  });

  it('502 cartesia_error on upstream 500', async () => {
    fetchImpl = async () => new Response('internal', { status: 500 });
    const res = await POST(makeReq());
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('cartesia_error');
  });

  it('502 cartesia_empty_body on upstream 200 + zero bytes', async () => {
    fetchImpl = async () =>
      new Response(new Uint8Array(0), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    const res = await POST(makeReq());
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('cartesia_empty_body');
  });

  it('504 cartesia_timeout when fetch aborts', async () => {
    fetchImpl = async () => {
      const err = new Error('The user aborted a request.');
      err.name = 'AbortError';
      throw err;
    };
    const res = await POST(makeReq());
    expect(res.status).toBe(504);
    expect((await res.json()).code).toBe('cartesia_timeout');
  });
});

describe('POST /api/creator/voice-preview — pricing env fail-closed', () => {
  it('500 cartesia_api_key_unset when env missing', async () => {
    delete process.env.CARTESIA_API_KEY;
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('cartesia_api_key_unset');
  });

  it('500 cartesia_pricing_unset when CARTESIA_USD_PER_CHAR missing', async () => {
    delete process.env.CARTESIA_USD_PER_CHAR;
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('cartesia_pricing_unset');
  });

  it('500 cartesia_pricing_unset when CARTESIA_USD_PER_CHAR non-positive', async () => {
    process.env.CARTESIA_USD_PER_CHAR = '0';
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('cartesia_pricing_unset');
  });
});

describe('POST /api/creator/voice-preview — success path', () => {
  it('200 streams audio/mpeg + Cartesia request includes generation_config.speed when speed != 1.0', async () => {
    let capturedBody: string | undefined;
    let capturedHeaders: HeadersInit | undefined;
    fetchImpl = async (_url, init) => {
      capturedBody = init?.body as string;
      capturedHeaders = init?.headers;
      return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x40, 0x00]), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    };
    const res = await POST(makeReq({ speed: 0.85 }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
    const audioBytes = await res.arrayBuffer();
    expect(audioBytes.byteLength).toBe(5);

    expect(capturedBody).toBeDefined();
    const body = JSON.parse(capturedBody!);
    expect(body.model_id).toBe('sonic-3');
    expect(body.voice).toEqual({ mode: 'id', id: 'voice-prod-1' });
    expect(body.generation_config).toEqual({ speed: 0.85 });
    expect(body.output_format.container).toBe('mp3');

    // Pre-commit audit C2 regression guard: Cartesia REST takes
    // `Authorization: Bearer`, NOT `X-API-Key`. Confirm wire shape.
    const hdrs = capturedHeaders as Record<string, string>;
    expect(hdrs.authorization).toBe('Bearer k-test');
    expect(hdrs['X-API-Key']).toBeUndefined();
  });

  it('200 success + generation_config OMITTED when speed === 1.0 (R2 M6)', async () => {
    let capturedBody: string | undefined;
    fetchImpl = async (_url, init) => {
      capturedBody = init?.body as string;
      return new Response(new Uint8Array([0xff, 0xfb]), { status: 200 });
    };
    const res = await POST(makeReq({ speed: 1.0 }));
    expect(res.status).toBe(200);
    const body = JSON.parse(capturedBody!);
    expect(body.generation_config).toBeUndefined();
  });

  it('writes cogs_log row with correct shape (R2 C4)', async () => {
    await POST(makeReq({ speed: 0.85 }));
    expect(cogsInsertCalls).toHaveLength(1);
    const row = cogsInsertCalls[0] as Record<string, unknown>;
    expect(row.service).toBe('cartesia');
    expect(row.operation).toBe('voice_tts_preview_characters');
    expect(row.unit_label).toBe('characters');
    expect(row.environment).toBe('production');
    expect(row.user_id).toBe('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
    expect(row.session_id).toBeNull();
    expect(typeof row.units).toBe('number');
    expect((row.units as number) > 100).toBe(true);
    expect(typeof row.cost_usd).toBe('number');
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.kind).toBe('voice_speed_preview');
    expect(meta.speed).toBe(0.85);
  });

  it('cogs_log failure does not fail the request', async () => {
    cogsInsertError = { message: 'cogs insert failed' };
    // Override to throw rather than return — both paths must not break the request.
    const res = await POST(makeReq({ speed: 0.85 }));
    // Should still return audio.
    expect(res.status).toBe(200);
  });
});
