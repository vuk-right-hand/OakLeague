// POST /api/sessions/heartbeat — liveness only. No delta_seconds input
// (server-computed at close). Tri-state response from session_heartbeat RPC
// maps to:
//   'ok'                 → 200 { ts }
//   'rate_limited'       → 204 (client ignores, keeps own interval)
//   'not_found_or_dead'  → 410 Gone (client stops polling + shows reconnect)

import 'server-only';
import { type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { getCallerUserId } from '@/lib/auth-guards';
import { json, isSameOrigin, mapPgError } from '@/lib/session/http-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = { session_id?: unknown };

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });

  const callerUserId = await getCallerUserId();
  if (!callerUserId) return json(401, { error: 'unauthorized' });

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return json(400, { error: 'bad_json' }); }
  const sessionId = typeof body.session_id === 'string' && UUID_RE.test(body.session_id) ? body.session_id : null;
  if (!sessionId) return json(400, { error: 'bad_session_id' });

  const sb = await supabaseServer();
  const { data, error } = await sb.rpc('session_heartbeat', { p_session_id: sessionId });
  if (error) {
    const { status, body: errBody } = mapPgError(error);
    return json(status, errBody);
  }
  const row = Array.isArray(data) ? data[0] : data;
  const status = row?.status as 'ok' | 'rate_limited' | 'not_found_or_dead';

  if (status === 'ok') return json(200, { ts: row?.last_heartbeat_at });
  if (status === 'rate_limited') return new Response(null, { status: 204 });
  return json(410, { error: 'not_found_or_dead' });
}
