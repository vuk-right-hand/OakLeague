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
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getCallerUserId } from '@/lib/auth-guards';
import { json, isSameOrigin, mapPgError } from '@/lib/session/http-helpers';
import { isAllowedWireModel, WIRE_TO_ENUM } from '@/lib/voice/model-map';
import { mintEphemeral, MintError } from '@/lib/voice/mint-ephemeral';
import { mintSimliSessionToken, SimliMintError } from '@/lib/avatar/mint-simli';
import { mintHeygenSessionToken, HeygenMintError } from '@/lib/avatar/mint-heygen';
import { resolveAvatarProvider } from '@/lib/avatar/resolver';
import type { AvatarProvider } from '@/lib/avatar/avatar-bridge';
import type { AvatarEnvelope } from '@/lib/avatar/avatar-envelope';
import { mintVoiceTicket, VoiceTicketMintError } from '@/lib/voice/mint-voice-ticket';

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

  // Phase C B3.5: tag every Sentry event in this request with the caller's
  // user id. Sentry v10 isolation scope is per-request in the Next.js App
  // Router integration, so this attaches to all subsequent captureException
  // calls in the handler without per-call extras edits.
  Sentry.setUser({ id: callerUserId });

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
    .select('id, simli_face_id, heygen_avatar_id')
    .eq('id', creatorId)
    .maybeSingle<{ id: string; simli_face_id: string | null; heygen_avatar_id: string | null }>();
  if (creatorErr) return json(500, { error: 'creator_lookup_failed' });
  if (!creatorRow) return json(404, { error: 'creator_not_found' });
  // Per-provider readiness checked AFTER tier resolution below — same
  // shape as sessions/open. Don't block on simli_face_id when tier
  // routes through heygen.

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

  // Avatar provider: read the OLD session's snapshot column (post-build
  // audit M1). resolveAvatarProvider(tier) would re-evaluate via env,
  // and an admin flip between original-open and rollover would silently
  // swap providers (audit-r2 C2 violation). Sessions row carries the
  // canonical provider since 20260509000005.
  //
  // Fallback chain: snapshot → env-resolve. Pre-migration sessions have
  // no snapshot — tolerated by the env fallback to keep mid-deploy
  // sessions alive.
  const { data: oldRow, error: oldErr } = await admin
    .from('sessions')
    .select('avatar_provider')
    .eq('id', oldId)
    .maybeSingle<{ avatar_provider: AvatarProvider | null }>();
  if (oldErr) {
    Sentry.captureException(oldErr, { extra: { op: 'sessions_rollover_old_provider_lookup', old_id: oldId } });
  }
  const avatarProvider: AvatarProvider | null = (oldRow?.avatar_provider ?? null) || resolveAvatarProvider(tier);
  const providerAvatarId: string | null =
    avatarProvider === 'simli'  ? creatorRow.simli_face_id :
    avatarProvider === 'heygen' ? creatorRow.heygen_avatar_id :
    avatarProvider === 'tavus'  ? creatorRow.simli_face_id :
    null;
  if (avatarProvider !== null && !providerAvatarId) {
    return json(409, { error: 'creator_not_ready', avatar_provider: avatarProvider });
  }

  // Per-provider session-length clamp (heygen tighter default).
  const maxAvatarSeconds = avatarProvider === 'heygen'
    ? Math.max(60, Math.min(
        GEMINI_MAX_SESSION_S,
        dailyLimitRemaining,
        Number(process.env.LIVEAVATAR_MAX_SESSION_S ?? 300),
      ))
    : Math.max(60, Math.min(GEMINI_MAX_SESSION_S, dailyLimitRemaining, 600));

  // AvatarEnvelope hoisted to @/lib/avatar/avatar-envelope (final-audit S1).
  let avatar: AvatarEnvelope | null = null;
  let avatarStatus: 'minted' | 'failed_mint' = 'failed_mint';

  if (avatarProvider === 'simli') {
    try {
      const result = await mintSimliSessionToken({
        faceId: providerAvatarId!,
        maxSessionLength: maxAvatarSeconds,
        audit: {
          userId: callerUserId,
          sessionId: newSessionId,
          env: 'production',
          ua: req.headers.get('user-agent'),
        },
      });
      avatar = { provider: 'simli', session_token: result.sessionToken, expires_at: result.expiresAt, face_id: result.faceId };
      avatarStatus = 'minted';
      try {
        await admin
          .from('sessions')
          .update({ avatar_provider: 'simli' })
          .eq('id', newSessionId);
      } catch (e) {
        Sentry.captureException(e, { extra: { op: 'sessions_rollover_simli_snapshot', session_id: newSessionId } });
      }
    } catch (e) {
      Sentry.captureException(e, { extra: { op: 'sessions_rollover_simli_mint', session_id: newSessionId } });
      void (e instanceof SimliMintError);
    }
  } else if (avatarProvider === 'heygen') {
    try {
      const result = await mintHeygenSessionToken({
        avatarId: providerAvatarId!,
        isSandbox: false,
        maxSessionDurationSeconds: maxAvatarSeconds,
        audit: {
          userId: callerUserId,
          sessionId: newSessionId,
          env: 'production',
          ua: req.headers.get('user-agent'),
        },
      });
      avatar = {
        provider: 'heygen',
        expires_at: result.expiresAt,
        face_id: providerAvatarId!,
        heygen_session_id: result.sessionId,
        heygen_session_boot: {
          wsUrl: result.wsUrl,
          livekitUrl: result.livekitUrl,
          livekitClientToken: result.livekitClientToken,
          livekitRoom: result.sessionId,
          livekitIdentity: `oak:${callerUserId}:${newSessionId}:${randomUUID().slice(0, 8)}`,
          maxSessionDurationSeconds: result.maxSessionDurationSeconds,
        },
      };
      avatarStatus = 'minted';
      try {
        await admin
          .from('sessions')
          .update({ avatar_provider: 'heygen' })
          .eq('id', newSessionId);
        await admin
          .from('sessions_private')
          .upsert({
            session_id: newSessionId,
            heygen_session_id: result.sessionId,
            heygen_session_token: result.sessionToken,
          }, { onConflict: 'session_id' });
      } catch (e) {
        Sentry.captureException(e, { extra: { op: 'sessions_rollover_heygen_snapshot', session_id: newSessionId } });
      }
    } catch (e) {
      Sentry.captureException(e, { extra: { op: 'sessions_rollover_heygen_mint', session_id: newSessionId } });
      void (e instanceof HeygenMintError);
    }
  }
  // avatarProvider === null (voice-only) or 'tavus' (deprecated) → leave
  // avatar null and avatarStatus 'failed_mint'. Rollover continues; no
  // FORCE_AVATAR_REQUIRED gate here (the original session cleared it at
  // open-time).

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

  // Voice-ticket mint is fatal on rollover (use-session-pipe rewire PR-2,
  // round-2 audit M2). An earlier draft returned 503 {retry:true} for the
  // client to retry — but session_rollover's "old row dead" check
  // (migration 20260502000002 line 301) makes a second-rollover always
  // fail with P0006. So a retry can never succeed after voice-ticket
  // mint fails. Close the orphan new row + return mapped error code.
  let voiceTicket: { ticket: string; expiresAt: string };
  try {
    voiceTicket = await mintVoiceTicket({
      userId:         callerUserId,
      sessionId:      newSessionId,
      creatorId,
      hookId,
      expectedTier:   tier,
      avatarProvider: avatarProvider ?? 'simli',
      ua:             req.headers.get('user-agent') ?? '',
    });
  } catch (e) {
    Sentry.captureException(e, { extra: { op: 'sessions_rollover_voice_ticket', session_id: newSessionId } });
    try {
      await sb.rpc('session_close', {
        p_session_id: newSessionId,
        p_end_reason: 'voice_ticket_mint_failed',
      });
    } catch (closeErr) {
      Sentry.captureException(closeErr, {
        extra: { op: 'sessions_rollover_voice_ticket_close', session_id: newSessionId },
      });
    }
    if (e instanceof VoiceTicketMintError) {
      // Mask programmer errors (audit C2) — bad_ua / bad_avatar_provider
      // mean the route forgot to pass valid args, not a user error.
      if (e.code === 'bad_ua' || e.code === 'bad_avatar_provider') {
        return json(500, { error: 'voice_ticket_mint_failed' });
      }
      return json(e.httpStatus, { error: e.code });
    }
    return json(502, { error: 'voice_ticket_mint_failed' });
  }

  // Proxy URL required, same as /api/sessions/open. Failing here is a
  // deploy-config bug, not a transient. Close the new row + 503.
  const proxyUrl = process.env.NEXT_PUBLIC_VOICE_PROXY_URL;
  if (!proxyUrl) {
    Sentry.captureMessage('sessions_rollover_proxy_url_unconfigured', {
      level: 'error',
      extra: { session_id: newSessionId },
    });
    try {
      await sb.rpc('session_close', {
        p_session_id: newSessionId,
        p_end_reason: 'proxy_url_unconfigured',
      });
    } catch (e) {
      Sentry.captureException(e, { extra: { op: 'sessions_rollover_proxy_url_close', session_id: newSessionId } });
    }
    return json(503, { error: 'proxy_url_unconfigured' });
  }

  return json(200, {
    session_id: newSessionId,
    tier,
    avatar_provider: avatarProvider,
    avatar,
    avatar_status: avatarStatus,
    voice: { model: token.model },
    voice_ticket: voiceTicket,
    proxy_url: proxyUrl,
    max_duration_s: dailyLimitRemaining,
    max_session_s: GEMINI_MAX_SESSION_S,
  });
}
