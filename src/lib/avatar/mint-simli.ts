// Simli session-token mint. Called by:
//   - `/api/spike-b/session` (admin-gated harness)
//   - `/api/sessions/open` (production, user-authed)
//   - `/api/sessions/rollover` (production, user-authed)
// Neither caller sees SIMLI_API_KEY. No auth guard inside — caller enforces.
// Trinity-1 routing is server-side on the face record (P0-1 finding,
// 2026-04-22) — no client-side flag needed; faceId is sufficient.
//
// When `audit` is provided, writes a $0 row to cogs_log with
// operation='avatar_session_token_mint' after a successful mint. Mirrors
// mintEphemeral's self-audit (R4-M1) so cost-observability surfaces for
// voice and avatar never drift (R5-S4). Harness callers pass env='spike_b';
// production callers pass env='production'.

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';

export type SimliMintEnv = 'spike_b' | 'production';

export type SimliMintAudit = {
  userId: string;
  sessionId: string | null;
  env: SimliMintEnv;
  ua?: string | null;
};

const FACE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SIMLI_COMPOSE_TOKEN_URL = 'https://api.simli.ai/compose/token';

export class SimliMintError extends Error {
  readonly httpStatus: number;
  readonly code:
    | 'simli_api_key_missing'
    | 'bad_face_id'
    | 'replica_not_found'
    | 'replica_not_ready'
    | 'token_expired'
    | 'quota_exceeded'
    | 'simli_mint_failed'
    | 'simli_mint_no_token';
  constructor(httpStatus: number, code: SimliMintError['code'], msg?: string) {
    super(msg ?? code);
    this.name = 'SimliMintError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

export type MintSimliArgs = {
  faceId: string;
  // Seconds. Free tier ≤ 600 keeps avatar TTL ≤ Gemini cap (900s).
  // Production session route passes min(600, remainingDailyQuota).
  maxSessionLength?: number;
  maxIdleTime?: number;
  handleSilence?: boolean;
  // Optional — when present, a $0 audit row is written to cogs_log after
  // the mint succeeds. Harness call sites that don't map to a user (there
  // shouldn't be any in v1) can omit it.
  audit?: SimliMintAudit;
};

export type MintSimliResult = {
  sessionToken: string;
  expiresAt: string; // ISO; advisory. Simli does not echo the TTL.
  faceId: string;
};

export async function mintSimliSessionToken(args: MintSimliArgs): Promise<MintSimliResult> {
  if (!FACE_ID_RE.test(args.faceId)) {
    throw new SimliMintError(400, 'bad_face_id');
  }
  const apiKey = process.env.SIMLI_API_KEY;
  if (!apiKey) throw new SimliMintError(500, 'simli_api_key_missing');

  const maxSessionLength = args.maxSessionLength ?? 600;
  const maxIdleTime = args.maxIdleTime ?? 120;
  const handleSilence = args.handleSilence ?? true;

  const res = await fetch(SIMLI_COMPOSE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-simli-api-key': apiKey },
    body: JSON.stringify({
      faceId: args.faceId,
      handleSilence,
      maxSessionLength,
      maxIdleTime,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const code: SimliMintError['code'] =
      res.status === 404 ? 'replica_not_found' :
      res.status === 409 ? 'replica_not_ready' :
      res.status === 401 || res.status === 403 ? 'token_expired' :
      res.status === 429 ? 'quota_exceeded' :
      'simli_mint_failed';
    throw new SimliMintError(res.status, code, `simli ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = (await res.json()) as { session_token?: string };
  if (!body.session_token) throw new SimliMintError(502, 'simli_mint_no_token');

  // R5-S4: audit the mint even though cost is $0. Session tokens have a
  // 1:1 relationship with provider-billable minutes once consumed, so this
  // row is the upstream signal for ops: "how many times did we hit Simli's
  // compose endpoint tonight?" — answerable without scraping logs.
  if (args.audit) {
    try {
      const admin = supabaseAdmin();
      await admin.from('cogs_log').insert({
        user_id: args.audit.userId,
        session_id: args.audit.sessionId,
        service: 'simli',
        operation: 'avatar_session_token_mint',
        units: 1,
        unit_label: 'token',
        cost_usd: 0,
        environment: args.audit.env,
        metadata: {
          source: args.audit.env === 'spike_b' ? 'spike_b_harness' : 'sessions_open',
          face_id: args.faceId,
          max_session_length: maxSessionLength,
          ua: (args.audit.ua ?? '').slice(0, 256),
        },
      });
    } catch {
      // Non-fatal: if the audit row fails we still have a valid token and
      // the user's session is OK. cogs_log drift is an ops concern, not a
      // session-kill condition.
    }
  }

  return {
    sessionToken: body.session_token,
    // Simli tokens are scoped to maxSessionLength; advisory expiry.
    expiresAt: new Date(Date.now() + Math.min(maxSessionLength, 900) * 1_000).toISOString(),
    faceId: args.faceId,
  };
}
