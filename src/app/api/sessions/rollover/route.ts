// POST /api/sessions/rollover — atomic close-old + insert-new at the
// Gemini 15-min audio-only cap. Client calls this once when the ticker hits
// max_session_s; the RPC handles the tier-inheritance + quota-preservation
// edge cases that a naïve close-then-open would race on.
//
// After a successful rollover the client must mint a fresh Gemini ephemeral
// token (they're 1-use) and re-mint the Simli session token. We inline that
// here so the client does one POST and gets the full new envelope back.
//
// R5-C1 client contract: a 429 {error:'kill_switch_fired'} means the OLD
// row's quota charge tripped the 1.5× latch AFTER we started the rollover
// tx. The tx rolls back entirely, so the OLD session is still open in the
// DB. Client MUST call /api/sessions/close {reason:'kill_switch_fired'} on
// the old_session_id before showing "come back tomorrow" — otherwise the
// ghost_reaper will close it 60s after heartbeat goes stale, but the user
// sees a stuck timer in the meantime.

import 'server-only';
import { type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getCallerUserId } from '@/lib/auth-guards';
import { json, isSameOrigin, mapPgError } from '@/lib/session/http-helpers';
import { isAllowedWireModel, WIRE_TO_ENUM } from '@/lib/voice/model-map';
import { mintEphemeral, MintError } from '@/lib/voice/mint-ephemeral';
import { mintSimliSessionToken, SimliMintError } from '@/lib/avatar/mint-simli';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GEMINI_MAX_SESSION_S = 900;

type Body = {
  old_session_id?: unknown;
  creator_id?: unknown;
  hook_id?: unknown;
  model?: unknown;
};

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });

  const callerUserId = await getCallerUserId();
  if (!callerUserId) return json(401, { error: 'unauthorized' });

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return json(400, { error: 'bad_json' }); }

  const oldId = typeof body.old_session_id === 'string' && UUID_RE.test(body.old_session_id) ? body.old_session_id : null;
  const creatorId = typeof body.creator_id === 'string' && UUID_RE.test(body.creator_id) ? body.creator_id : null;
  const hookId = typeof body.hook_id === 'string' && UUID_RE.test(body.hook_id) ? body.hook_id : null;
  const wireModel = typeof body.model === 'string' ? body.model : '';
  if (!oldId) return json(400, { error: 'bad_old_session_id' });
  if (!creatorId) return json(400, { error: 'bad_creator_id' });
  if (!hookId) return json(400, { error: 'bad_hook_id' });
  if (!isAllowedWireModel(wireModel)) return json(400, { error: 'model_not_allowed' });
  const enumModel = WIRE_TO_ENUM[wireModel];

  const admin = supabaseAdmin();
  const { data: creatorRow, error: creatorErr } = await admin
    .from('creators')
    .select('id, simli_face_id')
    .eq('id', creatorId)
    .maybeSingle<{ id: string; simli_face_id: string | null }>();
  if (creatorErr) return json(500, { error: 'creator_lookup_failed' });
  if (!creatorRow) return json(404, { error: 'creator_not_found' });
  if (!creatorRow.simli_face_id) return json(409, { error: 'creator_not_ready' });

  const sb = await supabaseServer();
  const { data: rollRows, error: rollErr } = await sb.rpc('session_rollover', {
    p_old_session_id: oldId,
    p_creator_id: creatorId,
    p_hook_id: hookId,
    p_model: enumModel,
  });
  if (rollErr) {
    const { status, body: errBody } = mapPgError(rollErr);
    return json(status, errBody);
  }
  const row = Array.isArray(rollRows) ? rollRows[0] : rollRows;
  if (!row?.new_session_id) return json(500, { error: 'rollover_empty' });
  const newSessionId = row.new_session_id as string;
  const tier = row.tier as 'free' | 'premium' | 'boardroom';
  const dailyLimitRemaining = (row.daily_limit_remaining_s as number) ?? 0;

  const maxAvatarSeconds = Math.max(60, Math.min(GEMINI_MAX_SESSION_S, dailyLimitRemaining, 600));

  let avatar: { session_token: string; expires_at: string; face_id: string } | null = null;
  let avatarStatus: 'minted' | 'failed_mint' = 'failed_mint';
  try {
    const result = await mintSimliSessionToken({
      faceId: creatorRow.simli_face_id,
      maxSessionLength: maxAvatarSeconds,
      audit: {
        userId: callerUserId,
        sessionId: newSessionId,
        env: 'production',
        ua: req.headers.get('user-agent'),
      },
    });
    avatar = { session_token: result.sessionToken, expires_at: result.expiresAt, face_id: result.faceId };
    avatarStatus = 'minted';
  } catch (e) {
    Sentry.captureException(e, { extra: { op: 'sessions_rollover_simli_mint', session_id: newSessionId } });
    void (e instanceof SimliMintError);
  }

  try {
    await sb.rpc('session_set_avatar_status', { p_session_id: newSessionId, p_status: avatarStatus });
  } catch (e) {
    Sentry.captureException(e, { extra: { op: 'sessions_rollover_avatar_status', session_id: newSessionId } });
  }

  // Rollover is a "best-effort continue" path — if Simli fails here the user
  // is mid-conversation, show voice-only rather than kill the session. We
  // do NOT honor FORCE_AVATAR_REQUIRED in rollover (the original session
  // cleared that gate at open-time).

  let token: { token: string; model: string };
  try {
    const result = await mintEphemeral({
      wireModel,
      callerUserId,
      sessionId: newSessionId,
      env: 'production',
      ua: req.headers.get('user-agent'),
    });
    token = { token: result.token, model: result.model };
  } catch (e) {
    Sentry.captureException(e, { extra: { op: 'sessions_rollover_gemini_mint', session_id: newSessionId } });
    try {
      await sb.rpc('session_close', {
        p_session_id: newSessionId,
        p_end_reason: 'gemini_rollover_failed',
      });
    } catch { /* already logged */ }
    if (e instanceof MintError) return json(e.httpStatus, { error: e.code });
    return json(502, { error: 'gemini_mint_failed' });
  }

  return json(200, {
    session_id: newSessionId,
    tier,
    avatar,
    avatar_status: avatarStatus,
    gemini: { token: token.token, model: token.model },
    max_duration_s: dailyLimitRemaining,
    max_session_s: GEMINI_MAX_SESSION_S,
  });
}
