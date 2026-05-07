// HeyGen LiveAvatar Lite session mint. Called by:
//   - `/api/spike-b/session` (admin-gated harness)
//   - `/api/sessions/open` (production, user-authed)
//   - `/api/sessions/rollover` (production, user-authed)
//
// Wire format reference: docs/_planning/PHASE_0_HEYGEN.md (the curated
// source of truth — the public docs at docs.liveavatar.com lie about
// success codes, status codes, inbound vocabulary, and audio chunking).
//
// HeyGen needs TWO REST calls to start a session, unlike Simli's single
// /compose/token. We hide the two-call boot inside this helper:
//   1. POST /v1/sessions/token  (X-API-Key)            → { session_id, session_token }
//   2. POST /v1/sessions/start  (Authorization: Bearer JWT, empty body)
//                                                       → { session_id, ws_url,
//                                                           livekit_url,
//                                                           livekit_client_token,
//                                                           livekit_agent_token,
//                                                           max_session_duration }
//
// Caller responsibilities (NOT this file's job):
//   * Re-mint `livekit_client_token` as subscribe-only via livekit-server-sdk
//     before exposing to the browser (PHASE_0_HEYGEN.md §10 — token is
//     publish-capable; never exposed cross-origin). sessions/open does the
//     re-mint after this helper returns.
//   * Decide whether to gate on is_sandbox or accept production billing.
//
// Audit row: same R5-S4 posture as mint-simli.ts. $0 cogs row at successful
// /v1/sessions/start to count token mints over time. environment = caller's
// env; service = 'heygen' (added to cogs_service enum in migration
// 20260509000002).

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';

export type HeygenMintEnv = 'spike_b' | 'production';

export type HeygenMintAudit = {
  userId: string;
  sessionId: string | null;
  env: HeygenMintEnv;
  ua?: string | null;
};

// HeyGen avatar IDs are UUID v4. Locked-down regex to refuse anything else
// at the mint boundary so a malformed face record can't ship to the API.
const HEYGEN_AVATAR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HEYGEN_API_BASE = 'https://api.liveavatar.com';
const HEYGEN_TOKEN_URL = `${HEYGEN_API_BASE}/v1/sessions/token`;
const HEYGEN_START_URL = `${HEYGEN_API_BASE}/v1/sessions/start`;

// Default per-session max length cap. Audit round 2 / S1 — defaults below
// the 1200s server cap to keep one runaway session from burning ~7 of the
// monthly 10 free credits. Override with LIVEAVATAR_MAX_SESSION_S env.
const HEYGEN_MAX_SESSION_S_DEFAULT = 300;

export class HeygenMintError extends Error {
  readonly httpStatus: number;
  readonly code:
    | 'heygen_api_key_missing'
    | 'bad_avatar_id'
    | 'token_mint_4xx'        // POST /v1/sessions/token returned 4xx
    | 'token_mint_failed'     // POST /v1/sessions/token returned non-OK or no token
    | 'replica_not_found'     // 404 on /v1/sessions/start (avatar id rejected at start)
    | 'replica_not_ready'     // 409 / 503 on /v1/sessions/start (avatar processing)
    | 'token_expired'         // 401 / 403 (server JWT validation)
    | 'quota_exceeded'        // 429 / payment required
    | 'session_capacity'      // concurrent-session cap (auditor S3 / Phase 0 unknown)
    | 'session_start_failed'
    | 'session_start_no_ws_url'
    | 'session_start_no_token';
  constructor(httpStatus: number, code: HeygenMintError['code'], msg?: string) {
    super(msg ?? code);
    this.name = 'HeygenMintError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

export type MintHeygenArgs = {
  // HeyGen avatar UUID. For sandbox runs pass the Wayne id (the only allowed
  // sandbox avatar — see Phase 0 §12); for prod, the resolved face record's
  // vendor-specific id.
  avatarId: string;
  // When true, HeyGen issues a sandbox session bound to the Wayne avatar.
  // No credits consumed but ~60s cap. For production traffic, false.
  isSandbox?: boolean;
  // Per-session max length seconds. HeyGen returns the actual cap (may be
  // lower than requested) in start-response.max_session_duration. Defaults
  // to env LIVEAVATAR_MAX_SESSION_S (audit round 2 S1).
  maxSessionDurationSeconds?: number;
  // Audit row write. Mirrors mint-simli.ts.
  audit?: HeygenMintAudit;
};

export type MintHeygenResult = {
  // The HeyGen session UUID, used for /v1/sessions/keep-alive +
  // /v1/sessions/stop calls and for room identity on LiveKit.
  sessionId: string;
  // The session JWT — caller uses as Authorization: Bearer for keep-alive
  // and stop. NOT to be exposed to the browser; voice-proxy / mint-callers
  // hold it server-side.
  sessionToken: string;
  // Control-channel WebSocket URL. Server-mediated path: voice-proxy
  // bridges Cartesia output to this WS. Browser does not connect directly.
  wsUrl: string;
  // LiveKit room URL. Browser bridge connects with the SUBSCRIBE-ONLY
  // re-minted token (NOT this raw client token).
  livekitUrl: string;
  // PRIVILEGED LiveKit JWT (canPublish:true canPublishData:true). Server
  // re-mints subscribe-only before exposing to browser. Caller MUST NOT
  // return this raw to the client. (Phase 0 §10 + audit M2.)
  livekitClientToken: string;
  // Reserved for HeyGen agent-mode features we don't use in Lite — kept
  // for parity / forward-compat. Server-side only.
  livekitAgentToken: string | null;
  // Server-returned cap (may be lower than requested due to plan tier or
  // sandbox). Bridge enforces a graceful close before this elapses.
  maxSessionDurationSeconds: number;
  // ISO advisory expiry equal to start-time + maxSessionDurationSeconds.
  expiresAt: string;
};

export async function mintHeygenSessionToken(args: MintHeygenArgs): Promise<MintHeygenResult> {
  // Post-build audit S2 — env first, input second. Avoids reporting
  // bad_avatar_id when the real problem is a missing key (we'd 400 on
  // input, the operator would scratch their head before checking env).
  const apiKey = process.env.LIVEAVATAR_API_KEY;
  if (!apiKey) throw new HeygenMintError(500, 'heygen_api_key_missing');
  if (!HEYGEN_AVATAR_ID_RE.test(args.avatarId)) {
    throw new HeygenMintError(400, 'bad_avatar_id');
  }

  // Resolve max-session in priority order: explicit arg > env > default.
  // Env-string falsy guard: Number('') === 0 → use ?? wouldn't catch it,
  // so we parse first and only accept finite-positive.
  const envMax = Number(process.env.LIVEAVATAR_MAX_SESSION_S);
  const requestedMaxSeconds =
    args.maxSessionDurationSeconds ??
    (Number.isFinite(envMax) && envMax > 0 ? envMax : HEYGEN_MAX_SESSION_S_DEFAULT);

  // ---- Call 1: POST /v1/sessions/token ----
  const tokenRes = await fetch(HEYGEN_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      mode: 'LITE',
      avatar_id: args.avatarId,
      is_sandbox: args.isSandbox === true,
      max_session_duration: requestedMaxSeconds,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    const code: HeygenMintError['code'] =
      tokenRes.status === 404 ? 'replica_not_found' :
      tokenRes.status === 409 ? 'replica_not_ready' :
      tokenRes.status === 401 || tokenRes.status === 403 ? 'token_expired' :
      tokenRes.status === 429 || tokenRes.status === 402 ? 'quota_exceeded' :
      'token_mint_4xx';
    throw new HeygenMintError(tokenRes.status, code, `heygen token ${tokenRes.status}: ${text.slice(0, 200)}`);
  }

  const tokenBody = (await tokenRes.json()) as {
    code?: number;
    data?: { session_id?: string; session_token?: string };
    message?: string;
  };
  // Phase 0 §2: success code is 1000 (docs claim 100 — wrong).
  if (tokenBody.code !== 1000 || !tokenBody.data?.session_id || !tokenBody.data?.session_token) {
    throw new HeygenMintError(502, 'token_mint_failed', `unexpected body: ${JSON.stringify(tokenBody).slice(0, 200)}`);
  }

  const { session_id: sessionId, session_token: sessionToken } = tokenBody.data;

  // ---- Call 2: POST /v1/sessions/start ----
  // Returns 201 (Phase 0 §2 — only endpoint that returns 201, others 200).
  const startRes = await fetch(HEYGEN_START_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${sessionToken}` },
  });

  if (startRes.status !== 200 && startRes.status !== 201) {
    const text = await startRes.text().catch(() => '');
    const code: HeygenMintError['code'] =
      startRes.status === 404 ? 'replica_not_found' :
      startRes.status === 409 ? 'replica_not_ready' :
      startRes.status === 401 || startRes.status === 403 ? 'token_expired' :
      startRes.status === 429 ? 'quota_exceeded' :
      // 402 is HeyGen's "no credits" surface; map to quota_exceeded so the
      // session-open route returns the same UX as Simli's quota cap.
      startRes.status === 402 ? 'quota_exceeded' :
      // 503 with a session-capacity message would be the "all slots taken"
      // shape (Phase 0 known unknown — verify when first observed in prod).
      startRes.status === 503 && /capacity/i.test(text) ? 'session_capacity' :
      'session_start_failed';
    throw new HeygenMintError(startRes.status, code, `heygen start ${startRes.status}: ${text.slice(0, 200)}`);
  }

  const startBody = (await startRes.json()) as {
    code?: number;
    data?: {
      session_id?: string;
      ws_url?: string;
      livekit_url?: string;
      livekit_client_token?: string;
      livekit_agent_token?: string;
      max_session_duration?: number;
    };
    message?: string;
  };
  if (startBody.code !== 1000 || !startBody.data) {
    throw new HeygenMintError(502, 'session_start_failed', `unexpected body: ${JSON.stringify(startBody).slice(0, 200)}`);
  }
  const d = startBody.data;
  if (!d.ws_url) throw new HeygenMintError(502, 'session_start_no_ws_url');
  if (!d.livekit_client_token || !d.livekit_url) throw new HeygenMintError(502, 'session_start_no_token');

  const serverMaxSeconds = typeof d.max_session_duration === 'number' && d.max_session_duration > 0
    ? d.max_session_duration
    : requestedMaxSeconds;

  // ---- Audit row ----
  if (args.audit) {
    try {
      const admin = supabaseAdmin();
      await admin.from('cogs_log').insert({
        user_id: args.audit.userId,
        session_id: args.audit.sessionId,
        service: 'heygen',
        operation: 'avatar_session_token_mint',
        units: 1,
        unit_label: 'token',
        cost_usd: 0,
        environment: args.audit.env,
        metadata: {
          source: args.audit.env === 'spike_b' ? 'spike_b_harness' : 'sessions_open',
          avatar_id: args.avatarId,
          is_sandbox: args.isSandbox === true,
          requested_max_seconds: requestedMaxSeconds,
          server_max_seconds: serverMaxSeconds,
          ua: (args.audit.ua ?? '').slice(0, 256),
          heygen_session_id: sessionId,
        },
      });
    } catch {
      // Non-fatal: cogs drift is an ops concern, not a session-kill condition.
    }
  }

  return {
    sessionId,
    sessionToken,
    wsUrl: d.ws_url,
    livekitUrl: d.livekit_url,
    livekitClientToken: d.livekit_client_token,
    livekitAgentToken: d.livekit_agent_token ?? null,
    maxSessionDurationSeconds: serverMaxSeconds,
    expiresAt: new Date(Date.now() + serverMaxSeconds * 1000).toISOString(),
  };
}
