// POST /api/admin/sessions/force-close — admin force-close of any session.
//
// Kept SEPARATE from /api/sessions/close so the user-self-close guard
// (ALLOWED_USER_END_REASONS) and the admin guard can never collapse (R2-C3).
// Calls admin_force_close_session(session_id, reason) which audits.

import 'server-only';
import { type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { isSameOrigin, json, mapPgError, mapAuthGuardStatus } from '@/lib/session/http-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = { session_id?: unknown; reason?: unknown };

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });

  try {
    await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) {
      const { status, body } = mapAuthGuardStatus(e.status);
      return json(status, body);
    }
    throw e;
  }

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return json(400, { error: 'bad_json' }); }

  const sessionId = typeof body.session_id === 'string' && UUID_RE.test(body.session_id)
    ? body.session_id : null;
  if (!sessionId) return json(400, { error: 'bad_session_id' });

  // RPC caps input at 180 chars so the 'admin_force_close: ' prefix (19) +
  // reason still fits sessions.end_reason's CHECK (<= 200).
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > 180) return json(400, { error: 'bad_reason' });

  const sb = await supabaseServer();
  const { error } = await sb.rpc('admin_force_close_session', {
    p_session_id: sessionId,
    p_reason: reason,
  });
  if (error) {
    const { status, body: errBody } = mapPgError(error);
    return json(status, errBody);
  }

  return json(200, { ok: true, session_id: sessionId });
}
