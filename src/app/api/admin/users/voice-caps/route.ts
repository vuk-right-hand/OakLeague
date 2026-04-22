// POST /api/admin/users/voice-caps — admin-only per-user voice cap editor.
//
// Calls admin_set_user_voice_caps(p_target_user_id, p_daily, p_weekly, p_monthly).
// The RPC enforces admin auth, range validation, and writes admin_audit_log.
// Caps apply at the next ticket_check — never mid-session (CLAUDE.md + handoff §4).

import 'server-only';
import { type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { isSameOrigin, json, mapPgError, mapAuthGuardStatus } from '@/lib/session/http-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirror the DB column CHECK constraints so a malformed body never touches the RPC.
const DAILY_MAX = 86400;      // 24h
const WEEKLY_MAX = 604800;    // 7d
const MONTHLY_MAX = 2678400;  // 31d

type Body = {
  target_user_id?: unknown;
  voice_daily_cap_seconds?: unknown;
  voice_weekly_cap_seconds?: unknown;
  voice_monthly_cap_seconds?: unknown;
};

function parseIntOrNull(v: unknown, allowNull: boolean): number | null | 'bad' {
  if (v === null || v === undefined || v === '') {
    return allowNull ? null : 'bad';
  }
  if (typeof v !== 'number' && typeof v !== 'string') return 'bad';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 'bad';
  if (!Number.isInteger(n)) return 'bad';
  return n;
}

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

  const daily = parseIntOrNull(body.voice_daily_cap_seconds, false);
  if (daily === 'bad' || daily === null || daily < 0 || daily > DAILY_MAX) {
    return json(400, { error: 'bad_daily_cap' });
  }
  const weekly = parseIntOrNull(body.voice_weekly_cap_seconds, true);
  if (weekly === 'bad' || (weekly !== null && (weekly < 0 || weekly > WEEKLY_MAX))) {
    return json(400, { error: 'bad_weekly_cap' });
  }
  const monthly = parseIntOrNull(body.voice_monthly_cap_seconds, true);
  if (monthly === 'bad' || (monthly !== null && (monthly < 0 || monthly > MONTHLY_MAX))) {
    return json(400, { error: 'bad_monthly_cap' });
  }

  // Cookie-bound client so auth.uid() inside the RPC resolves to the admin.
  const sb = await supabaseServer();
  const { error } = await sb.rpc('admin_set_user_voice_caps', {
    p_target_user_id: targetUserId,
    p_daily: daily,
    p_weekly: weekly,
    p_monthly: monthly,
  });
  if (error) {
    const { status, body: errBody } = mapPgError(error);
    return json(status, errBody);
  }

  return json(200, {
    ok: true,
    target_user_id: targetUserId,
    voice_daily_cap_seconds: daily,
    voice_weekly_cap_seconds: weekly,
    voice_monthly_cap_seconds: monthly,
  });
}
