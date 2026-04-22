// Spike-A harness ephemeral-token endpoint. Admin-gated, same-origin.
// Delegates the actual mint to `src/lib/voice/mint-ephemeral.ts` so the
// production `/api/sessions/open` path and this harness path share one
// Gemini SDK init + one COGS audit write (R4-M1). This route's only job:
//   1. admin guard + same-origin + model allowlist sanity check
//   2. parse body.model (wire-form string)
//   3. call mintEphemeral({ env: 'spike_a', session_id: null })

import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { mintEphemeral, MintError } from '@/lib/voice/mint-ephemeral';
import { isAllowedWireModel } from '@/lib/voice/model-map';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

// Same-origin, honoring x-forwarded-host for TLS-terminating tunnels.
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

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });

  let session;
  try {
    session = await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) return json(e.status, { error: e.message });
    throw e;
  }

  let body: { model?: unknown };
  try {
    body = (await req.json()) as { model?: unknown };
  } catch {
    return json(400, { error: 'bad_json' });
  }
  const model = typeof body.model === 'string' ? body.model : '';
  if (!isAllowedWireModel(model)) {
    return json(400, { error: 'model_not_allowed' });
  }

  try {
    const result = await mintEphemeral({
      wireModel: model,
      callerUserId: session.userId,
      sessionId: null,
      env: 'spike_a',
      ua: req.headers.get('user-agent'),
    });
    return json(200, { token: result.token });
  } catch (e) {
    if (e instanceof MintError) return json(e.httpStatus, { error: e.code });
    throw e;
  }
}
