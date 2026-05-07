// Unit tests for mintHeygenSessionToken — wire-level mapping only. Mocks
// global fetch; no real network. Audit-row write path is NOT exercised
// here (no `audit` arg passed) — that requires the Supabase admin client
// and is covered by the integration suite.
//
// Coverage focus:
//   * Success path: token+start 200 → expected shape, including the
//     PRIVILEGED livekit_client_token in the result (caller's job to
//     re-mint subscribe-only).
//   * `code: 1000` is the success discriminator (Phase 0 §2 — docs lie).
//   * 4xx mappings on /v1/sessions/token: 404 / 401 / 429 / generic.
//   * 4xx/5xx mappings on /v1/sessions/start: 404, 503 capacity, 402,
//     non-1000 body code.
//   * Defensive validation: bad avatar_id (non-UUID), missing API key.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeygenMintError, mintHeygenSessionToken } from './mint-heygen';

const VALID_AVATAR_UUID = 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a';

const TOKEN_OK_BODY = {
  code: 1000,
  data: {
    session_id: '82e8764f-c993-4d7f-a1d2-3b0523f0dd88',
    session_token: 'eyJhbG.fake.jwt',
  },
  message: 'Session token created successfully',
};

const START_OK_BODY = {
  code: 1000,
  data: {
    session_id: '82e8764f-c993-4d7f-a1d2-3b0523f0dd88',
    livekit_url: 'wss://heygen-feapbkvq.livekit.cloud',
    livekit_client_token: 'eyJhbG.lk.client',
    livekit_agent_token: 'eyJhbG.lk.agent',
    max_session_duration: 60,
    ws_url: 'wss://webrtc-signaling.heygen.io/v2-alpha/interactive-avatar/session/abc',
  },
  message: 'Session created successfully',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('mintHeygenSessionToken — happy path', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('LIVEAVATAR_API_KEY', 'lk_test_key');
    fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, TOKEN_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(201, START_OK_BODY));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('returns the full shape including privileged livekit token', async () => {
    const result = await mintHeygenSessionToken({
      avatarId: VALID_AVATAR_UUID,
      isSandbox: true,
      maxSessionDurationSeconds: 60,
    });
    expect(result.sessionId).toBe('82e8764f-c993-4d7f-a1d2-3b0523f0dd88');
    expect(result.sessionToken).toBe('eyJhbG.fake.jwt');
    expect(result.wsUrl).toContain('webrtc-signaling.heygen.io');
    expect(result.livekitUrl).toContain('livekit.cloud');
    expect(result.livekitClientToken).toBe('eyJhbG.lk.client');
    expect(result.livekitAgentToken).toBe('eyJhbG.lk.agent');
    expect(result.maxSessionDurationSeconds).toBe(60);
    expect(result.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('sends X-API-Key on token call and Bearer JWT on start call', async () => {
    await mintHeygenSessionToken({
      avatarId: VALID_AVATAR_UUID,
      isSandbox: true,
      maxSessionDurationSeconds: 60,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe('https://api.liveavatar.com/v1/sessions/token');
    expect((tokenInit.headers as Record<string, string>)['x-api-key']).toBe('lk_test_key');
    const tokenBody = JSON.parse(tokenInit.body as string);
    expect(tokenBody).toMatchObject({ mode: 'LITE', avatar_id: VALID_AVATAR_UUID, is_sandbox: true });

    const [startUrl, startInit] = fetchMock.mock.calls[1];
    expect(startUrl).toBe('https://api.liveavatar.com/v1/sessions/start');
    expect((startInit.headers as Record<string, string>)['authorization']).toBe('Bearer eyJhbG.fake.jwt');
  });

  it('uses LIVEAVATAR_MAX_SESSION_S env when arg omitted', async () => {
    vi.stubEnv('LIVEAVATAR_MAX_SESSION_S', '450');
    await mintHeygenSessionToken({ avatarId: VALID_AVATAR_UUID, isSandbox: true });
    const tokenBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(tokenBody.max_session_duration).toBe(450);
  });

  it('falls back to 300s default when neither arg nor env is set', async () => {
    vi.stubEnv('LIVEAVATAR_MAX_SESSION_S', '');
    await mintHeygenSessionToken({ avatarId: VALID_AVATAR_UUID, isSandbox: true });
    const tokenBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(tokenBody.max_session_duration).toBe(300);
  });
});

describe('mintHeygenSessionToken — error mapping', () => {
  beforeEach(() => {
    vi.stubEnv('LIVEAVATAR_API_KEY', 'lk_test_key');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('rejects non-UUID avatarId at the boundary', async () => {
    await expect(
      mintHeygenSessionToken({ avatarId: 'not-a-uuid', isSandbox: true }),
    ).rejects.toMatchObject({ code: 'bad_avatar_id', httpStatus: 400 });
  });

  it('rejects when LIVEAVATAR_API_KEY missing', async () => {
    vi.stubEnv('LIVEAVATAR_API_KEY', '');
    await expect(
      mintHeygenSessionToken({ avatarId: VALID_AVATAR_UUID, isSandbox: true }),
    ).rejects.toMatchObject({ code: 'heygen_api_key_missing', httpStatus: 500 });
  });

  it('maps token-mint 404 to replica_not_found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse(404, { code: 1404, message: 'Avatar not found' }),
    ));
    await expect(
      mintHeygenSessionToken({ avatarId: VALID_AVATAR_UUID, isSandbox: true }),
    ).rejects.toMatchObject({ code: 'replica_not_found', httpStatus: 404 });
  });

  it('maps token-mint 401 to token_expired', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse(401, { code: 1401, message: 'Bad API key' }),
    ));
    await expect(
      mintHeygenSessionToken({ avatarId: VALID_AVATAR_UUID, isSandbox: true }),
    ).rejects.toMatchObject({ code: 'token_expired', httpStatus: 401 });
  });

  it('maps token-mint 429 to quota_exceeded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse(429, { code: 1429, message: 'No credits' }),
    ));
    await expect(
      mintHeygenSessionToken({ avatarId: VALID_AVATAR_UUID, isSandbox: true }),
    ).rejects.toMatchObject({ code: 'quota_exceeded', httpStatus: 429 });
  });

  it('maps token-mint 402 (no credits) to quota_exceeded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse(402, { code: 1402, message: 'Payment required' }),
    ));
    await expect(
      mintHeygenSessionToken({ avatarId: VALID_AVATAR_UUID, isSandbox: true }),
    ).rejects.toMatchObject({ code: 'quota_exceeded', httpStatus: 402 });
  });

  it('rejects token-mint 200 with non-1000 code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { code: 100, data: null, message: 'oops docs-style code' }),
    ));
    await expect(
      mintHeygenSessionToken({ avatarId: VALID_AVATAR_UUID, isSandbox: true }),
    ).rejects.toMatchObject({ code: 'token_mint_failed' });
  });

  it('maps start 503 with "capacity" message to session_capacity', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, TOKEN_OK_BODY))
      .mockResolvedValueOnce(new Response('all session slots at capacity right now', { status: 503 })),
    );
    await expect(
      mintHeygenSessionToken({ avatarId: VALID_AVATAR_UUID, isSandbox: true }),
    ).rejects.toMatchObject({ code: 'session_capacity', httpStatus: 503 });
  });

  it('rejects start 200 with non-1000 code', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, TOKEN_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(200, { code: 999, data: {} })),
    );
    await expect(
      mintHeygenSessionToken({ avatarId: VALID_AVATAR_UUID, isSandbox: true }),
    ).rejects.toMatchObject({ code: 'session_start_failed' });
  });

  it('rejects start 201 missing ws_url', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, TOKEN_OK_BODY))
      .mockResolvedValueOnce(jsonResponse(201, {
        code: 1000,
        data: { ...START_OK_BODY.data, ws_url: undefined },
      })),
    );
    await expect(
      mintHeygenSessionToken({ avatarId: VALID_AVATAR_UUID, isSandbox: true }),
    ).rejects.toMatchObject({ code: 'session_start_no_ws_url' });
  });
});

describe('HeygenMintError', () => {
  it('preserves code and httpStatus', () => {
    const e = new HeygenMintError(429, 'quota_exceeded', 'no credits left');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('HeygenMintError');
    expect(e.code).toBe('quota_exceeded');
    expect(e.httpStatus).toBe(429);
    expect(e.message).toBe('no credits left');
  });
});
