// POST /api/sessions/close — user self-close + service path.
// Admin force-close is a SEPARATE route (/api/admin/sessions/force-close)
// so the two guards can never collapse into one (R2-C3).

import 'server-only';
import { type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
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

  // Defense-in-depth: stop the HeyGen-side session if any. The voice-proxy
  // teardown also calls /v1/sessions/stop, but that fires only if the
  // client opened a proxy WS — if a user opens then closes before tapping
  // mic (proxy never opens) the HeyGen session would leak for the full
  // 120s server-side silence timeout, burning ~2 credits per orphan.
  // Idempotent per Phase 0 §11 — safe to call from both close paths.
  // Service-role client because sessions_private has RLS+zero policies.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    const admin = createClient(url, key, { auth: { persistSession: false } });
    const { data: priv } = await admin
      .from('sessions_private')
      .select('heygen_session_id, heygen_session_token')
      .eq('session_id', sessionId)
      .maybeSingle<{ heygen_session_id: string | null; heygen_session_token: string | null }>();
    if (priv?.heygen_session_id && priv?.heygen_session_token) {
      // Fire-and-forget — don't block the user's close on HeyGen's API.
      // If this fails, voice-proxy teardown is the second line; if both
      // fail, HeyGen times out at 120s. Logged but not surfaced.
      fetch('https://api.liveavatar.com/v1/sessions/stop', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${priv.heygen_session_token}`,
        },
        body: JSON.stringify({ session_id: priv.heygen_session_id, reason: 'USER_CLOSED' }),
      }).catch(() => { /* non-fatal — second line and 120s timeout backstop */ });
    }
  }

  return json(200, {
    session_id: sessionId,
    active_seconds: row?.active_seconds ?? 0,
    end_reason: row?.end_reason ?? endReason,
  });
}
