import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { ceilingUsdPerMin, estimatedRunCostUsd } from '@/lib/avatar/cost';
import type { AvatarProvider } from '@/lib/avatar/avatar-bridge';
import { mintSimliSessionToken, SimliMintError } from '@/lib/avatar/mint-simli';
import { mintHeygenSessionToken, HeygenMintError } from '@/lib/avatar/mint-heygen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Spike B session mint — admin-gated, same-origin, kill-switch gated.
// SPIKE_B_PLAN.md Phase 1 + §Kill-switch. Accepts provider override for the
// spike harness (production resolves from tier; harness exercises both).

function json(status: number, body: unknown) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

// Copy-inline from src/app/api/voice/spike-a/record/route.ts — honors
// x-forwarded-host for TLS-terminating tunnels (ngrok dev, prod reverse proxy).
// See .claude_learnings.md 2026-04-21 "ngrok HTTPS → Next dev HTTP".
function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    const originHost = new URL(origin).host;
    const forwardedHost = req.headers.get('x-forwarded-host');
    const reqHost = forwardedHost ?? req.nextUrl.host;
    return originHost === reqHost;
  } catch {
    return false;
  }
}

function startOfUtcDayIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

const VALID_PROVIDERS: ReadonlySet<AvatarProvider> = new Set(['simli', 'tavus', 'heygen']);
const REPLICA_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = {
  provider?: unknown;
  replica_id?: unknown;
  // HeyGen-only: if omitted, defaults to true (sandbox/free, Wayne avatar).
  // Admin can flip to false for paid prod-rate measurements via this same
  // route (gated by admin auth + spike-b kill-switch). Sandbox runs IGNORE
  // replica_id and pin Wayne (post-build audit M3).
  is_sandbox?: unknown;
};

// HeyGen sandbox is exclusively bound to the Wayne avatar (PHASE_0_HEYGEN.md
// §12). Hard-pin server-side so admin's accidentally-passed UUID doesn't
// surface as a confusing replica_not_found — we just route it to Wayne.
const HEYGEN_SANDBOX_AVATAR_ID = 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a';

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });

  let session;
  try {
    session = await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) return json(e.status, { error: e.message });
    throw e;
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { error: 'bad_json' });
  }

  const provider = body.provider;
  if (typeof provider !== 'string' || !VALID_PROVIDERS.has(provider as AvatarProvider)) {
    return json(400, { error: 'bad_provider' });
  }
  const replicaId = body.replica_id;
  if (typeof replicaId !== 'string' || !REPLICA_ID_RE.test(replicaId)) {
    return json(400, { error: 'bad_replica_id' });
  }

  // Kill-switch. Pre-run check: total + estimate >= cap. Uses the CEILING
  // rate, not best-estimate, so the gate fails closed.
  const CAP = Number(process.env.SPIKE_B_HARD_CAP_DOLLARS ?? 25);
  const MAX_RUNS = Number(process.env.SPIKE_B_MAX_RUNS_PER_DAY ?? 300);
  const estimated = estimatedRunCostUsd(provider as AvatarProvider);

  const admin = supabaseAdmin();
  const { data: rows, error: costErr } = await admin
    .from('cogs_log')
    .select('cost_usd')
    .in('service', ['simli', 'tavus', 'heygen'])
    .eq('environment', 'spike_b')
    .gte('created_at', startOfUtcDayIso());
  if (costErr) {
    Sentry.captureException(costErr, { extra: { op: 'spike_b_session_cost_sum' } });
    return json(500, { error: 'cost_sum_failed' });
  }
  const total = (rows ?? []).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
  const runCount = rows?.length ?? 0;

  if (total + estimated >= CAP) return json(429, { error: 'quota_exceeded' });
  if (runCount + 1 > MAX_RUNS) return json(429, { error: 'run_count_exceeded' });

  // Mint provider session. Errors from the provider are logged but not echoed
  // verbatim — callers get taxonomy codes the bridge understands.
  try {
    if (provider === 'simli') {
      const result = await mintSimliSessionToken({
        faceId: replicaId,
        audit: {
          userId: session.userId,
          sessionId: null, // spike-b does not write to public.sessions
          env: 'spike_b',
          ua: req.headers.get('user-agent'),
        },
      });
      return json(200, {
        provider: 'simli' as const,
        session_token: result.sessionToken,
        expires_at: result.expiresAt,
      });
    }
    if (provider === 'heygen') {
      // Default sandbox (free, Wayne-pinned). Admin overrides via
      // body.is_sandbox=false for prod-rate measurements.
      const isSandbox = body.is_sandbox !== false;
      // Sandbox: hard-pin Wayne, ignore replicaId (post-build audit M3).
      // Prod: validate replica_id as UUID.
      let avatarId: string;
      if (isSandbox) {
        avatarId = HEYGEN_SANDBOX_AVATAR_ID;
      } else {
        if (!UUID_RE.test(replicaId)) {
          return json(400, { error: 'bad_replica_id' });
        }
        avatarId = replicaId;
      }
      const result = await mintHeygenSessionToken({
        avatarId,
        isSandbox,
        audit: {
          userId: session.userId,
          sessionId: null, // spike-b does not write to public.sessions
          env: 'spike_b',
          ua: req.headers.get('user-agent'),
        },
      });
      // Build the heygen_session_boot envelope the bridge consumes via
      // opts.heygenSessionBoot. We pass through HeyGen's livekit_client_token
      // verbatim — no subscribe-only re-mint is possible against their
      // LiveKit instance (avatar-bridge.ts heygenSessionBoot comment).
      // Identity is collision-safe per audit-r2 M1 — a future second tab
      // takeover gets a distinct identity so LiveKit doesn't kick the
      // first tab. Spike-B has no concept of "session_id" so we use a
      // run-scoped nonce.
      const nonce = crypto.randomUUID();
      return json(200, {
        provider: 'heygen' as const,
        // Echo the OakLeague-side session token (HeyGen's session JWT) so
        // the consumer can drive /v1/sessions/keep-alive and stop. In
        // spike-b harness, no voice-proxy heartbeat — the harness session
        // is short and ends with /api/spike-b/record.
        session_token: result.sessionToken,
        heygen_session_id: result.sessionId,
        heygen_session_boot: {
          wsUrl: result.wsUrl,
          livekitUrl: result.livekitUrl,
          livekitClientToken: result.livekitClientToken,
          livekitRoom: result.sessionId, // ws_url path UUID == livekit room name
          livekitIdentity: `spike-b:${session.userId}:${nonce}`,
          maxSessionDurationSeconds: result.maxSessionDurationSeconds,
        },
        expires_at: result.expiresAt,
      });
    }
    return json(200, await mintTavus(replicaId));
  } catch (e) {
    Sentry.captureException(e, { extra: { op: 'spike_b_session_mint', provider } });
    if (e instanceof SimliMintError) {
      const status = [401, 403, 404, 409, 429].includes(e.httpStatus) ? e.httpStatus : 502;
      return json(status, {
        error: e.code,
        ceiling_rate: ceilingUsdPerMin(provider as AvatarProvider),
        admin_user: session.userId,
      });
    }
    if (e instanceof HeygenMintError) {
      const status = [400, 401, 403, 404, 409, 429].includes(e.httpStatus) ? e.httpStatus : 502;
      return json(status, {
        error: e.code,
        ceiling_rate: ceilingUsdPerMin(provider as AvatarProvider),
        admin_user: session.userId,
      });
    }
    const status = (e as { status?: number }).status ?? 502;
    const err = (e as { code?: string }).code ?? 'provider_mint_failed';
    return json(status === 404 || status === 409 || status === 401 || status === 403 ? status : 502, {
      error: err,
      ceiling_rate: ceilingUsdPerMin(provider as AvatarProvider),
      admin_user: session.userId, // auditable: who triggered
    });
  }
}

// ---- provider mints -----------------------------------------------------------

class ProviderError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, msg: string) {
    super(msg);
    this.status = status;
    this.code = code;
  }
}

async function mintTavus(replicaId: string) {
  const apiKey = process.env.TAVUS_API_KEY;
  if (!apiKey) throw new ProviderError(500, 'tavus_api_key_missing', 'TAVUS_API_KEY not set');

  // Tavus conversation in echo mode. max_call_duration scopes the conversation
  // URL's lifetime (per plan §Security review — "time-scoped via 1800s").
  const res = await fetch('https://tavusapi.com/v2/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      replica_id: replicaId,
      persona_id: null,
      pipeline_mode: 'echo',
      properties: { max_call_duration: 1800 },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderError(
      res.status,
      res.status === 404 ? 'replica_not_found' :
        res.status === 409 ? 'replica_not_ready' :
          res.status === 401 || res.status === 403 ? 'token_expired' :
            res.status === 429 ? 'quota_exceeded' : 'tavus_mint_failed',
      `tavus ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as {
    conversation_id?: string;
    conversation_url?: string;
  };
  if (!body.conversation_id || !body.conversation_url) {
    throw new ProviderError(502, 'tavus_mint_incomplete', 'missing conversation fields');
  }

  return {
    provider: 'tavus' as const,
    conversation_id: body.conversation_id,
    conversation_url: body.conversation_url,
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
}
