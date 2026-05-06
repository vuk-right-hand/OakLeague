// POST /api/sessions/open — production session lifecycle entry point.
//
// Flow:
//   1. Same-origin + getCallerUserId (NOT admin — regular user cookie).
//   2. Per-user rate-limit: 10/min on scope='sessions_open' (R5-M4). Blocks
//      open→close churn that would burn Simli/Gemini mint budget.
//   3. Parse body (creator_id, hook_id, model wire-form). Translate model
//      wire → enum via WIRE_TO_ENUM BEFORE calling the RPC (R3-C3).
//   4. Call session_open RPC. Tier snapshot + kill-switch check + quota
//      upsert happen in the BEFORE trigger.
//   5. Mint Simli FIRST (R3-M2). If FORCE_AVATAR_REQUIRED=1 and mint fails,
//      close the freshly-created session row via session_close(…,
//      'force_required_mint_failed') BEFORE returning 503 (R4-C2) — otherwise
//      the one-active-per-user partial-unique index blocks the user's
//      immediate retry until the reaper runs 60s later.
//   6. Mint Gemini ephemeral token via mintEphemeral() lib (NOT the
//      admin-gated Spike-A route — R3-C1). mintEphemeral writes the COGS
//      audit row internally (R4-M1). mintSimli writes its own audit row
//      symmetrically (R5-S4).
//   7. Return envelope with avatar.session_token (consumed client-side via
//      SimliBridge.preMintedSessionToken option — R3-C2/P0-5).

import 'server-only';
import { type NextRequest, after } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getCallerUserId } from '@/lib/auth-guards';
import { json, isSameOrigin, mapPgError } from '@/lib/session/http-helpers';
import { isAllowedWireModel, WIRE_TO_ENUM } from '@/lib/voice/model-map';
import { mintEphemeral, MintError } from '@/lib/voice/mint-ephemeral';
import { mintSimliSessionToken, SimliMintError } from '@/lib/avatar/mint-simli';
import { mintVoiceTicket, VoiceTicketMintError } from '@/lib/voice/mint-voice-ticket';
import { resolveVoiceId } from '@/lib/voice/env-scoped-voice-id';
import { createHash } from 'node:crypto';
import { candidateTokenHashes, isValidTokenPlaintext } from '@/lib/recording/referral-token';
import { captureServerSafe } from '@/lib/posthog-server';
import { getProxyVoiceConfig } from '@/lib/voice/voice-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Hard cap: Gemini Live 15-min audio-only session cap. Client advances to
// rollover when it sees this value in the ticker.
const GEMINI_MAX_SESSION_S = 900;

type Body = {
  creator_id?: unknown;
  hook_id?: unknown;
  model?: unknown;
};

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });

  const callerUserId = await getCallerUserId();
  if (!callerUserId) return json(401, { error: 'unauthorized' });

  // R5-M4: per-user rate-limit BEFORE the paid provider mints. Normal use is
  // <1 open per 5min (session length). 10/min is >10× headroom but caps a
  // run-away client loop at ~$0.05/min of Simli mint spend per attacker.
  const admin = supabaseAdmin();
  const { data: allowed, error: rlErr } = await admin.rpc('rate_limit_hit', {
    p_scope: 'sessions_open',
    p_key: callerUserId,
    p_window: '1 minute',
    p_limit: 10,
  });
  if (rlErr) return json(500, { error: 'rate_limit_failed' });
  if (allowed === false) return json(429, { error: 'rate_limited' });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { error: 'bad_json' });
  }

  const creatorId = typeof body.creator_id === 'string' && UUID_RE.test(body.creator_id) ? body.creator_id : null;
  if (!creatorId) return json(400, { error: 'bad_creator_id' });

  // hook_id is nullable in the schema (ON DELETE SET NULL) but we require it
  // from the feed flow. null path is reserved for explicit "open directly"
  // links which don't exist in v1.
  const hookId = typeof body.hook_id === 'string' && UUID_RE.test(body.hook_id) ? body.hook_id : null;
  if (!hookId) return json(400, { error: 'bad_hook_id' });

  const wireModel = typeof body.model === 'string' ? body.model : '';
  if (!isAllowedWireModel(wireModel)) return json(400, { error: 'model_not_allowed' });
  const enumModel = WIRE_TO_ENUM[wireModel];

  // Resolve the creator's simli_face_id + env-scoped voice_id before
  // opening the session. No row → 404 early. We read with the service-role
  // client because `creators` public SELECT is "published only" — drafts
  // still need to route (admin preview).
  //
  // R3-Missing-1 / R4-M6 — three voice_id columns scoped by VERCEL_ENV.
  // resolveVoiceId() picks the env-appropriate value.
  const { data: creatorRow, error: creatorErr } = await admin
    .from('creators')
    .select('id, simli_face_id, voice_id, voice_id_preview, voice_id_dev, published_at')
    .eq('id', creatorId)
    .maybeSingle<{
      id: string;
      simli_face_id: string | null;
      voice_id: string | null;
      voice_id_preview: string | null;
      voice_id_dev: string | null;
      published_at: string | null;
    }>();
  if (creatorErr) return json(500, { error: 'creator_lookup_failed' });
  if (!creatorRow) return json(404, { error: 'creator_not_found' });
  if (!creatorRow.simli_face_id) return json(409, { error: 'creator_not_ready' });
  const envVoiceId = resolveVoiceId(creatorRow);
  // U-C1 pre-WS gate: when the proxy's α' path is on, a session against a
  // creator with no env-scoped voice_id will die at 4009 cartesia_no_voice
  // on first WS open. Pre-empt with a user-actionable 409. The proxy is
  // the authority for `useCartesia`; Vercel polls /voice-config (60s
  // cache, fail-open) — flipping the Fly secret alone propagates here.
  const { useCartesia } = await getProxyVoiceConfig();
  if (useCartesia && !envVoiceId) {
    return json(409, { error: 'creator_voice_not_trained' });
  }

  // RPC under the cookie-bound client so auth.uid() resolves to the caller.
  const sb = await supabaseServer();
  const { data: openRows, error: openErr } = await sb.rpc('session_open', {
    p_creator_id: creatorId,
    p_hook_id: hookId,
    p_model: enumModel,
  });

  let sessionId: string;
  let tier: 'free' | 'premium' | 'boardroom';
  let dailyLimitRemaining: number;
  let isTakeover = false;

  if (openErr) {
    // R3-C2 — multi-tab takeover. session_open RPC returns 23505 when the
    // sessions_one_active_per_user partial-unique index trips (user already
    // has a live session in another tab / a stalled previous attempt).
    // Resolve by attaching to the existing active session: re-mint a fresh
    // ticket pinned to that session_id and return the same envelope shape.
    // Audit row in cogs_log for ops visibility.
    const code = (openErr as { code?: string }).code;
    const isUniqueViolation = code === '23505'
      || /sessions_one_active_per_user/.test(openErr.message || '');
    if (!isUniqueViolation) {
      const { status, body: errBody } = mapPgError(openErr);
      return json(status, errBody);
    }
    // Find the existing active session for this user against THIS creator.
    // If the active session belongs to a different creator, surface a
    // distinct error — we don't silently swap creators.
    const { data: live, error: liveErr } = await admin
      .from('sessions')
      .select('id, creator_id, tier_at_session')
      .eq('user_id', callerUserId)
      .is('ended_at', null)
      .maybeSingle<{ id: string; creator_id: string; tier_at_session: 'free' | 'premium' | 'boardroom' }>();
    if (liveErr) return json(500, { error: 'session_lookup_failed' });
    if (!live) return json(500, { error: 'session_takeover_inconsistent' });
    if (live.creator_id !== creatorId) {
      return json(409, { error: 'live_session_other_creator', existing_creator_id: live.creator_id });
    }
    sessionId = live.id;
    tier = live.tier_at_session;
    // Daily-limit-remaining isn't returned in the takeover path; estimate
    // conservatively as full Gemini cap and let server-side enforcement
    // gate. For the avatar TTL clamp, we use 600s default in mintSimli.
    dailyLimitRemaining = GEMINI_MAX_SESSION_S;
    isTakeover = true;
    try {
      await admin.from('cogs_log').insert({
        user_id: callerUserId,
        session_id: sessionId,
        service: 'gemini',
        operation: 'sessions_open_takeover',
        units: 1,
        unit_label: 'event',
        cost_usd: 0,
        environment: 'production',
        metadata: { creator_id: creatorId, hook_id: hookId },
      });
    } catch (e) {
      Sentry.captureException(e, { extra: { op: 'sessions_open_takeover_audit', session_id: sessionId } });
    }
  } else {
    const openRow = Array.isArray(openRows) ? openRows[0] : openRows;
    if (!openRow?.session_id) return json(500, { error: 'session_open_empty' });
    sessionId = openRow.session_id as string;
    tier = openRow.tier as 'free' | 'premium' | 'boardroom';
    dailyLimitRemaining = (openRow.daily_limit_remaining_s as number) ?? 0;
  }

  // ── Mint Simli FIRST (R3-M2) ────────────────────────────────────────────
  // Session length clamped to min(15min, remaining daily quota, 600s) so the
  // Simli pipe TTL ≤ Gemini audio cap. Any clamp below 60s is a bug — the
  // user already crossed kill-switch threshold; session_open should have
  // raised. Still defensively floor at 60s for sanity.
  const maxAvatarSeconds = Math.max(60, Math.min(GEMINI_MAX_SESSION_S, dailyLimitRemaining, 600));

  let avatar: { session_token: string; expires_at: string; face_id: string } | null = null;
  let avatarStatus: 'minted' | 'failed_mint' = 'failed_mint';
  let avatarError: string | null = null;
  try {
    const result = await mintSimliSessionToken({
      faceId: creatorRow.simli_face_id,
      maxSessionLength: maxAvatarSeconds,
      audit: {
        userId: callerUserId,
        sessionId,
        env: 'production',
        ua: req.headers.get('user-agent'),
      },
    });
    avatar = {
      session_token: result.sessionToken,
      expires_at: result.expiresAt,
      face_id: result.faceId,
    };
    avatarStatus = 'minted';
  } catch (e) {
    Sentry.captureException(e, { extra: { op: 'sessions_open_simli_mint', session_id: sessionId } });
    avatarError = e instanceof SimliMintError ? e.code : 'simli_unknown';
  }

  // Persist the avatar_status transition. Non-fatal on failure — we prefer
  // to continue with voice-only rather than 500 the user.
  try {
    await sb.rpc('session_set_avatar_status', {
      p_session_id: sessionId,
      p_status: avatarStatus,
    });
  } catch (e) {
    Sentry.captureException(e, { extra: { op: 'sessions_open_avatar_status', session_id: sessionId } });
  }

  const forceRequired = process.env.FORCE_AVATAR_REQUIRED === '1';
  if (forceRequired && avatarStatus !== 'minted') {
    // R4-C2: close the freshly-opened session BEFORE returning 503 — otherwise
    // the one-active-per-user partial-unique index blocks retry until the
    // reaper runs 60s later.
    //
    // R3-C2 — takeover path: the session belongs to another tab; do NOT
    // close it. Just return 503 and let the other tab live.
    if (!isTakeover) {
      try {
        await sb.rpc('session_close', {
          p_session_id: sessionId,
          p_end_reason: 'force_required_mint_failed',
        });
      } catch (e) {
        Sentry.captureException(e, { extra: { op: 'sessions_open_force_close_after_mint_fail', session_id: sessionId } });
      }
    }
    return json(503, { error: 'avatar_unavailable', detail: avatarError ?? 'mint_failed' });
  }

  // ── Mint Gemini ephemeral (after Simli path so cost ordering is clear) ──
  let token: { token: string; model: string };
  try {
    const result = await mintEphemeral({
      wireModel,
      callerUserId,
      sessionId,
      env: 'production',
      ua: req.headers.get('user-agent'),
    });
    token = { token: result.token, model: result.model };
  } catch (e) {
    Sentry.captureException(e, { extra: { op: 'sessions_open_gemini_mint', session_id: sessionId } });
    // Gemini is non-recoverable for this session — close it. The client will
    // show "Voice unavailable, try again" and tap to start a new one.
    // R3-C2 takeover guard: session belongs to another tab.
    if (!isTakeover) {
      try {
        await sb.rpc('session_close', {
          p_session_id: sessionId,
          p_end_reason: 'gemini_mint_failed',
        });
      } catch { /* already logged */ }
    }
    if (e instanceof MintError) return json(e.httpStatus, { error: e.code });
    return json(502, { error: 'gemini_mint_failed' });
  }

  // ── Mint voice ticket (cutover proxy WS auth) ─────────────────────────
  // SIMLI_WIREUP §2 — pre-mint a UA-bound, session-pinned ticket so the
  // browser can open the proxy WS without a second client RTT. Failure
  // here is non-fatal for the flag-off path: the legacy direct-Gemini
  // codepath ignores `voice_ticket`. For the flag-on cutover path a
  // missing ticket means the WS open will fail, surfaced via the
  // session-client UX shell.
  let voiceTicket: { ticket: string; expiresAt: string } | null = null;
  try {
    voiceTicket = await mintVoiceTicket({
      userId:       callerUserId,
      sessionId,
      creatorId,
      hookId,
      expectedTier: tier,
      ua:           req.headers.get('user-agent') ?? '',
    });
  } catch (e) {
    Sentry.captureException(e, { extra: { op: 'sessions_open_voice_ticket', session_id: sessionId } });
    if (e instanceof VoiceTicketMintError && e.code === 'too_many_tickets') {
      // Don't close session — user just needs to back off. The legacy
      // path (flag-off) doesn't need the ticket anyway.
    }
    // For other ticket-mint failures, log and return without ticket.
    // Cutover path will show "Service unavailable" via session-client.
  }

  // Day 4 — first_session credit via Next 15 `after()` so the work runs
  // post-response while the serverless container is kept alive (audit C2 Day
  // 4 fix — bare fire-and-forget on Vercel is killed when the response
  // stream closes, dropping the in-flight Supabase RPC). Idempotent on the
  // RPC side, so a duplicate call from a cold-start retry is safe.
  const refCookie = req.cookies.get('oak_ref')?.value;
  if (refCookie && isValidTokenPlaintext(refCookie)) {
    // Snapshot the request headers before after() runs — req object may not
    // be valid after the response has been sent.
    const ua       = req.headers.get('user-agent') ?? '';
    const accept   = req.headers.get('accept-language') ?? '';
    const xff      = req.headers.get('x-forwarded-for') ?? '';
    after(async () => {
      try {
        await creditFirstSessionFireForget(callerUserId, refCookie, { ua, accept, xff });
      } catch (err) {
        Sentry.captureException(err, { extra: { op: 'recording_referral_credit_first_session_async' } });
      }
    });
  }

  return json(200, {
    session_id: sessionId,
    tier,
    avatar,
    avatar_status: avatarStatus,
    // gemini.token kept during the flag-on/off window (R2-C3). Cleanup PR
    // after 24h-green deletes the field together with the @google/genai
    // import in use-session-pipe.
    gemini: { token: token.token, model: token.model },
    voice_ticket: voiceTicket,
    proxy_url: process.env.NEXT_PUBLIC_VOICE_PROXY_URL ?? null,
    max_duration_s: dailyLimitRemaining,
    max_session_s: GEMINI_MAX_SESSION_S,
    is_takeover: isTakeover,
  });
}

async function creditFirstSessionFireForget(
  userId: string,
  refPlaintext: string,
  reqMeta: { ua: string; accept: string; xff: string },
): Promise<void> {
  const hashes = candidateTokenHashes(refPlaintext);
  if (hashes.length === 0) return;

  const { ua, accept, xff } = reqMeta;
  const ip = xff.split(',')[0]?.trim() ?? '';
  const ipPrefix = ip.includes('.') ? ip.split('.').slice(0, 3).join('.') : ip.split(':').slice(0, 4).join(':');
  const deviceFp = createHash('sha256').update(`${ua}|${accept}|${ipPrefix}`).digest('hex').slice(0, 32);

  const admin = supabaseAdmin();
  let credited = false;
  for (const tokenHash of hashes) {
    const { data, error } = await admin.rpc('recording_referral_credit_first_session', {
      p_token_hash: tokenHash,
      p_new_user:   userId,
      p_device_fp:  deviceFp,
      p_ip_prefix:  ipPrefix,
    });
    if (error) {
      // Surface but don't throw — the user's session opened successfully.
      Sentry.captureException(error, { extra: { op: 'recording_referral_credit_first_session' } });
      continue;
    }
    if (data === true) { credited = true; break; }
  }

  // PostHog event (plan §11). Only fires on a *fresh* credit (RPC returns
  // true) — duplicate calls (idempotent at the RPC level) don't double-count.
  // distinctId = the new user's UUID so the funnel joins to their other events.
  if (credited) {
    await captureServerSafe(userId, 'referral_first_session', {
      ref_id_prefix: refPlaintext.slice(0, 6),
    });
  }
}
