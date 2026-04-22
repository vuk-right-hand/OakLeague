// POST /api/admin/users/tier — admin-only tier flip.
//
// Calls admin_set_profile_tier(p_target_user_id, p_new_tier). The RPC
// enforces: admin auth, no active session (P0004), no same-day downgrade
// after logged seconds (P0003), audit row in admin_audit_log.

import 'server-only';
import { type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { isSameOrigin, json, mapPgError, mapAuthGuardStatus } from '@/lib/session/http-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_TIERS = new Set(['free', 'premium', 'boardroom']);

type Body = { target_user_id?: unknown; new_tier?: unknown };

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

  const targetUserId = typeof body.target_user_id === 'string' && UUID_RE.test(body.target_user_id)
    ? body.target_user_id : null;
  if (!targetUserId) return json(400, { error: 'bad_target_user_id' });

  const newTier = typeof body.new_tier === 'string' && ALLOWED_TIERS.has(body.new_tier)
    ? body.new_tier : null;
  if (!newTier) return json(400, { error: 'bad_tier' });

  // Use the cookie-bound client so auth.uid() inside the RPC resolves to the
  // admin's own id (required for the admin_roles check and audit row).
  const sb = await supabaseServer();
  const { error } = await sb.rpc('admin_set_profile_tier', {
    p_target_user_id: targetUserId,
    p_new_tier: newTier,
  });
  if (error) {
    const { status, body: errBody } = mapPgError(error);
    return json(status, errBody);
  }

  return json(200, { ok: true, target_user_id: targetUserId, new_tier: newTier });
}
