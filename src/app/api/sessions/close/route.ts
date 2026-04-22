// POST /api/sessions/close — user self-close + service path.
// Admin force-close is a SEPARATE route (/api/admin/sessions/force-close)
// so the two guards can never collapse into one (R2-C3).

import 'server-only';
import { type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { getCallerUserId } from '@/lib/auth-guards';
import { json, isSameOrigin, mapPgError } from '@/lib/session/http-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Allowed user-initiated close reasons. Admin-only reasons
// ('admin_force_close: …', 'force_required_mint_failed', 'gemini_15min_cap',
// 'mint_never_completed', 'ghost_reaper') never come through here.
const ALLOWED_USER_END_REASONS = new Set([
  'user_ended',
  'user_zombie_cleanup', // one-active-per-user collision → user taps "Close it"
  'client_error',
]);

type Body = { session_id?: unknown; end_reason?: unknown };

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });

  const callerUserId = await getCallerUserId();
  if (!callerUserId) return json(401, { error: 'unauthorized' });

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return json(400, { error: 'bad_json' }); }

  const sessionId = typeof body.session_id === 'string' && UUID_RE.test(body.session_id) ? body.session_id : null;
  if (!sessionId) return json(400, { error: 'bad_session_id' });

  const endReason = typeof body.end_reason === 'string' ? body.end_reason : '';
  if (!ALLOWED_USER_END_REASONS.has(endReason)) return json(400, { error: 'bad_end_reason' });

  const sb = await supabaseServer();
  const { data, error } = await sb.rpc('session_close', {
    p_session_id: sessionId,
    p_end_reason: endReason,
  });
  if (error) {
    const { status, body: errBody } = mapPgError(error);
    return json(status, errBody);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return json(200, {
    session_id: sessionId,
    active_seconds: row?.active_seconds ?? 0,
    end_reason: row?.end_reason ?? endReason,
  });
}
