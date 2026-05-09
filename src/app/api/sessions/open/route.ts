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
import { mintHeygenSessionToken, HeygenMintError } from '@/lib/avatar/mint-heygen';
import { resolveAvatarProvider } from '@/lib/avatar/resolver';
import type { AvatarProvider } from '@/lib/avatar/avatar-bridge';
import type { AvatarEnvelope } from '@/lib/avatar/avatar-envelope';
import { mintVoiceTicket, VoiceTicketMintError } from '@/lib/voice/mint-voice-ticket';
import { buildBrainPrefix } from '@/lib/voice/brain-prefix';
import { shouldEmitBrainNotReady } from '@/lib/voice/brain-not-ready-dedupe';
import { resolveVoiceId } from '@/lib/voice/env-scoped-voice-id';
import { createHash, randomUUID } from 'node:crypto';
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

  // Phase C B3.5: tag every Sentry event in this request with the caller's
  // user id. Sentry v10 isolation scope is per-request in the Next.js App
  // Router integration, so this attaches to all subsequent captureException
  // calls in the handler without per-call extras edits.
  Sentry.setUser({ id: callerUserId });

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

  // R3 audit C1 (brain wire-up): hook ↔ creator binding pre-check.
  // session_open RPC also enforces this at migration 20260511000000;
  // doing it here as well returns a clean 400 typed error before the
  // RPC round-trip.
  //
  // PR-2 audit C1: PostgREST `videos!inner` embed can return the joined
  // resource as either an object OR an array depending on FK cardinality
  // detection. hooks.video_id → videos.id is many-to-one so we expect
  // an object today, but normalize defensively. Wrapped in try/catch so
  // a future schema regression surfaces as 500 with Sentry context, not
  // a TypeError leaking through.
  type EmbedShape = { creator_id?: string };
  let hookBindingCreatorId: string | null = null;
  try {
    const { data: hookBinding, error: bindingErr } = await admin
      .from('hooks')
      .select('id, video:videos!inner(creator_id)')
      .eq('id', hookId)
      .maybeSingle<{ id: string; video: EmbedShape | EmbedShape[] | null }>();
    if (bindingErr) {
      Sentry.captureException(bindingErr, { extra: { op: 'sessions_open_hook_binding', hook_id: hookId } });
      return json(500, { error: 'hook_lookup_failed' });
    }
    if (!hookBinding) {
      return json(400, { error: 'hook_creator_mismatch' });
    }
    const v = hookBinding.video;
    hookBindingCreatorId = Array.isArray(v) ? (v[0]?.creator_id ?? null) : (v?.creator_id ?? null);
  } catch (e) {
    Sentry.captureException(e, { extra: { op: 'sessions_open_hook_binding_throw', hook_id: hookId } });
    return json(500, { error: 'hook_lookup_failed' });
  }
  if (hookBindingCreatorId !== creatorId) {
    return json(400, { error: 'hook_creator_mismatch' });
  }

  // Resolve the creator's simli_face_id + env-scoped voice_id + brain
  // payload before opening the session. No row → 404 early. We read with
  // the service-role client because `creators` public SELECT is
  // "published only" — drafts still need to route (admin preview).
  //
  // R3-Missing-1 / R4-M6 — three voice_id columns scoped by VERCEL_ENV.
  // resolveVoiceId() picks the env-appropriate value.
  //
  // Brain wire-up (PR-2): SELECT system_prompt + brain_status alongside
  // existing columns so the route can hard-fail unready creators with
  // 409 brain_not_ready (R3 audit M1).
  const { data: creatorRow, error: creatorErr } = await admin
    .from('creators')
    .select('id, simli_face_id, heygen_avatar_id, voice_id, voice_id_preview, voice_id_dev, published_at, system_prompt, brain_status')
    .eq('id', creatorId)
    .maybeSingle<{
      id: string;
      simli_face_id: string | null;
      heygen_avatar_id: string | null;
      voice_id: string | null;
      voice_id_preview: string | null;
      voice_id_dev: string | null;
      published_at: string | null;
      system_prompt: string | null;
      brain_status: 'pending' | 'queued' | 'training' | 'ready' | 'errored';
    }>();
  if (creatorErr) return json(500, { error: 'creator_lookup_failed' });
  if (!creatorRow) return json(404, { error: 'creator_not_found' });

  // Brain readiness gate (R3 audit M1 — hard-fail decision; whole-build
  // audit C1 — loosened semantic).
  //
  // Goal: prevent the generic-mentor fallback that would let a cloned
  // voice speak a generic AI script. The gate's job is "persona loadable
  // and not in an error state." Voice clone (creator_voice_not_trained
  // 409 above) and avatar provider readiness (creator_not_ready 409
  // below) gate SEPARATELY at the points where they matter — they don't
  // need to also block on brain_status here.
  //
  // Originally this required `brain_status === 'ready'`, but no v1
  // code path flips 'training' → 'ready' (the v1.1 `creator_publish`
  // RPC is deferred). approve_creator_application leaves brain_status
  // at 'training' (R2 audit M1 — persona compile decoupled from
  // publish-readiness), so a strict 'ready' gate would 409 every real
  // session until manual SQL.
  //
  // Block: persona NULL (compile never ran) OR brain_status='errored'
  //   (training pipeline explicitly failed; admin must investigate).
  // Allow: persona populated AND brain_status IN ('pending','queued',
  //   'training','ready'). 'pending'/'queued' allow because if a
  //   persona row exists for those states, it's an admin/recompile
  //   artifact and the persona itself is the source of truth.
  //
  // Admin-preview escape still applies for caller with active admin role.
  const brainReady =
    creatorRow.system_prompt !== null && creatorRow.brain_status !== 'errored';
  if (!brainReady) {
    const { data: adminRow } = await admin
      .from('admin_roles')
      .select('user_id')
      .eq('user_id', callerUserId)
      .is('revoked_at', null)
      .maybeSingle();
    if (!adminRow) {
      // PR-2 audit C4: dedupe per-creator with 5min TTL so a single
      // misconfigured creator can't pump 1000 Sentry events/min.
      if (shouldEmitBrainNotReady(creatorId)) {
        Sentry.captureMessage('brain.not_ready', {
          level: 'error',
          extra: {
            creator_id: creatorId,
            brain_status: creatorRow.brain_status,
            system_prompt_present: creatorRow.system_prompt !== null,
          },
        });
      }
      return json(409, {
        error: 'brain_not_ready',
        creator_id: creatorId,
        brain_status: creatorRow.brain_status,
      });
    }
    Sentry.addBreadcrumb({
      category: 'brain',
      level: 'info',
      message: 'admin_preview',
      data: { creator_id: creatorId, brain_status: creatorRow.brain_status },
    });
    captureServerSafe(callerUserId, 'brain_admin_preview', {
      admin_user_id: callerUserId,
      creator_id: creatorId,
      brain_status_at_open: creatorRow.brain_status,
    });
  }
  // Avatar provider readiness is checked AFTER tier resolution below —
  // a free-tier user routed through Simli needs simli_face_id; a heygen
  // user needs heygen_avatar_id. Don't block here on a missing simli id
  // when the user might be on heygen.
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

  // Pre-mint daily/weekly/monthly cap check (use-session-pipe rewire R2-C1).
  // voice_usage_ticket_check takes p_user_id only — runs BEFORE session_open
  // so a capped user never creates a session row we'd then have to close.
  // Surfaces a structured 429 instead of falling through to the proxy-WS-side
  // 4006 close after a wasted mint round-trip.
  //
  // Auditor C1: the migration REVOKEs EXECUTE from `authenticated`. Call
  // via the service-role admin client — the function's SECURITY DEFINER body
  // short-circuits the auth.uid() check when JWT role is service_role, and
  // we already authenticated the caller via getCallerUserId() above.
  const { data: capRows, error: capErr } = await admin.rpc('voice_usage_ticket_check', {
    p_user_id: callerUserId,
  });
  if (capErr) {
    // Map the function's P0002 'user not found' (raised when no profiles
    // row matches p_user_id) to 409 — a brand-new auth user whose profile
    // trigger hasn't materialised yet should retry, not see a 500.
    const pgCode = (capErr as { code?: string }).code;
    if (pgCode === 'P0002') {
      return json(409, { error: 'profile_not_ready' });
    }
    Sentry.captureException(capErr, { extra: { op: 'sessions_open_cap_check', user_id: callerUserId } });
    return json(500, { error: 'cap_check_failed' });
  }
  // Auditor S1: numeric columns deserialise as string in supabase-js. Coerce
  // every numeric so the wire response is consistent and client comparisons
  // don't fail string-vs-number.
  type CapRowRaw = {
    remaining_seconds: number | string | null;
    daily_used:   number | string | null; daily_cap:   number | null;
    weekly_used:  number | string | null; weekly_cap:  number | null;
    monthly_used: number | string | null; monthly_cap: number | null;
  };
  const capRowRaw = (Array.isArray(capRows) ? capRows[0] : capRows) as CapRowRaw | null;
  if (!capRowRaw) {
    return json(500, { error: 'cap_check_empty' });
  }
  const numOrNull = (v: number | string | null | undefined): number | null =>
    v == null ? null : (typeof v === 'number' ? v : Number(v));
  const remainingSeconds = Math.max(0, Math.floor(Number(capRowRaw.remaining_seconds ?? 0)));
  if (remainingSeconds <= 0) {
    // Whole-build audit C4: emit telemetry so we can compare HTTP-layer
    // pre-mint cap firing rate (PR-1) against the legacy proxy-WS-side
    // 4006 cap close, and correlate to /upgrade?source=cap_hit clicks.
    captureServerSafe(callerUserId, 'daily_cap_hit_fired', {
      surface:      'sessions_open',
      daily_used:   numOrNull(capRowRaw.daily_used),
      daily_cap:    capRowRaw.daily_cap,
      weekly_used:  numOrNull(capRowRaw.weekly_used),
      weekly_cap:   capRowRaw.weekly_cap,
      monthly_used: numOrNull(capRowRaw.monthly_used),
      monthly_cap:  capRowRaw.monthly_cap,
    });
    return json(429, {
      error: 'daily_cap_hit',
      remaining_seconds: 0,
      daily_used:   numOrNull(capRowRaw.daily_used),
      daily_cap:    capRowRaw.daily_cap,
      weekly_used:  numOrNull(capRowRaw.weekly_used),
      weekly_cap:   capRowRaw.weekly_cap,
      monthly_used: numOrNull(capRowRaw.monthly_used),
      monthly_cap:  capRowRaw.monthly_cap,
    });
  }

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
    // Auditor M1: cap RPC ran above against the same caller. Use its
    // remaining_seconds as the takeover-path estimate so the loser tab's
    // max_duration_s reflects actual headroom, not a 900s overestimate.
    // Server-side kill-switch backstops anyway, but a tighter client clamp
    // surfaces the limit earlier and avoids a wasted in-session kill.
    dailyLimitRemaining = Math.min(GEMINI_MAX_SESSION_S, remainingSeconds);
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
    // Final-audit C2: takeover re-mints HeyGen below and overwrites the
    // session_private row, orphaning the old HeyGen-side session. Stop
    // the old one server-side before the re-mint clobbers our handle to
    // its token. Idempotent per Phase 0 §11. Fire-and-forget — even if
    // the stop call fails, the new session re-mint shouldn't block.
    try {
      const { data: oldPriv } = await admin
        .from('sessions_private')
        .select('heygen_session_id, heygen_session_token')
        .eq('session_id', sessionId)
        .maybeSingle<{ heygen_session_id: string | null; heygen_session_token: string | null }>();
      if (oldPriv?.heygen_session_id && oldPriv?.heygen_session_token) {
        await fetch('https://api.liveavatar.com/v1/sessions/stop', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': `Bearer ${oldPriv.heygen_session_token}`,
          },
          body: JSON.stringify({ session_id: oldPriv.heygen_session_id, reason: 'USER_CLOSED' }),
        }).catch(() => { /* non-fatal */ });
      }
    } catch (e) {
      Sentry.captureException(e, { extra: { op: 'sessions_open_takeover_heygen_stop', session_id: sessionId } });
    }
  } else {
    const openRow = Array.isArray(openRows) ? openRows[0] : openRows;
    if (!openRow?.session_id) return json(500, { error: 'session_open_empty' });
    sessionId = openRow.session_id as string;
    tier = openRow.tier as 'free' | 'premium' | 'boardroom';
    dailyLimitRemaining = (openRow.daily_limit_remaining_s as number) ?? 0;
  }

  // ── Resolve avatar provider for this tier (audit-r1 C1) ────────────────
  // Tier locks the provider for the session's duration (CLAUDE.md
  // §Voice — "tier routing at session-open only, never mid-session").
  const avatarProvider: AvatarProvider | null = resolveAvatarProvider(tier);

  // Per-provider face/avatar id readiness. Each provider has its own column
  // on creators (simli_face_id vs heygen_avatar_id). NULL means the creator
  // hasn't trained this provider's avatar yet → 'creator_not_ready' parity
  // with the prior Simli-only check.
  const providerAvatarId: string | null =
    avatarProvider === 'simli'  ? creatorRow.simli_face_id :
    avatarProvider === 'heygen' ? creatorRow.heygen_avatar_id :
    avatarProvider === 'tavus'  ? creatorRow.simli_face_id : // Tavus deprecated; reuse simli for legacy paths
    null;
  if (avatarProvider !== null && !providerAvatarId) {
    return json(409, { error: 'creator_not_ready', avatar_provider: avatarProvider });
  }

  // Session length clamp. Provider-aware:
  //   simli/tavus: min(15min Gemini cap, dailyLimitRemaining, 600s).
  //   heygen:      min(LIVEAVATAR_MAX_SESSION_S env or 300s default,
  //                    Gemini cap, dailyLimitRemaining).
  // Heygen Lite docs cap at 1200s; we keep the per-session clamp tighter.
  // (Audit-r2 C4 — kill-switch must use clamped seconds, not the
  // provider's max — and r2 S1 — heygen default 300 to keep one runaway
  // session from burning ~7 of 10 free-tier credits.)
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
  let avatarError: string | null = null;

  if (avatarProvider === null) {
    // Voice-only mode (env AVATAR_PROVIDER_<tier>=none / unset). No avatar
    // mint attempt; downstream FORCE_AVATAR_REQUIRED gate decides 503.
    avatarStatus = 'failed_mint';
    avatarError = 'avatar_provider_disabled';
  } else if (avatarProvider === 'simli') {
    try {
      const result = await mintSimliSessionToken({
        faceId: providerAvatarId!,
        maxSessionLength: maxAvatarSeconds,
        audit: {
          userId: callerUserId,
          sessionId,
          env: 'production',
          ua: req.headers.get('user-agent'),
        },
      });
      avatar = {
        provider: 'simli',
        session_token: result.sessionToken,
        expires_at: result.expiresAt,
        face_id: result.faceId,
      };
      avatarStatus = 'minted';
      // Snapshot provider so a future env flip doesn't silently swap
      // providers on rollover (post-build audit M1).
      try {
        await admin
          .from('sessions')
          .update({ avatar_provider: 'simli' })
          .eq('id', sessionId);
      } catch (e) {
        Sentry.captureException(e, { extra: { op: 'sessions_open_simli_snapshot', session_id: sessionId } });
      }
    } catch (e) {
      Sentry.captureException(e, { extra: { op: 'sessions_open_simli_mint', session_id: sessionId } });
      avatarError = e instanceof SimliMintError ? e.code : 'simli_unknown';
    }
  } else if (avatarProvider === 'heygen') {
    try {
      const result = await mintHeygenSessionToken({
        avatarId: providerAvatarId!,
        // Production traffic — never sandbox here. Sandbox is admin-gated
        // through /api/spike-b/session.
        isSandbox: false,
        maxSessionDurationSeconds: maxAvatarSeconds,
        audit: {
          userId: callerUserId,
          sessionId,
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
          // Privileged token by design — see avatar-bridge.ts heygenSessionBoot
          // comment block. Same trust model as Simli compose token.
          livekitClientToken: result.livekitClientToken,
          livekitRoom: result.sessionId,
          // Collision-safe identity (audit-r2 M1) — second tab takeover
          // gets a distinct LiveKit identity so neither tab gets kicked.
          livekitIdentity: `oak:${callerUserId}:${sessionId}:${randomUUID().slice(0, 8)}`,
          maxSessionDurationSeconds: result.maxSessionDurationSeconds,
        },
      };
      avatarStatus = 'minted';

      // Snapshot provider on the public sessions row + privileged tokens
      // on the service-role-only sibling sessions_private (final post-fix
      // audit C1: column-level RLS doesn't exist in Postgres, so privileged
      // tokens MUST live on a sibling with zero policies).
      try {
        await admin
          .from('sessions')
          .update({ avatar_provider: 'heygen' })
          .eq('id', sessionId);
        await admin
          .from('sessions_private')
          .upsert({
            session_id: sessionId,
            heygen_session_id: result.sessionId,
            heygen_session_token: result.sessionToken,
          }, { onConflict: 'session_id' });
      } catch (e) {
        // Non-fatal: voice-only path still works (heygen heartbeat just
        // can't fire, session won't survive past ~120s without keep-alive).
        Sentry.captureException(e, { extra: { op: 'sessions_open_heygen_snapshot', session_id: sessionId } });
      }
    } catch (e) {
      Sentry.captureException(e, { extra: { op: 'sessions_open_heygen_mint', session_id: sessionId } });
      avatarError = e instanceof HeygenMintError ? e.code : 'heygen_unknown';
    }
  } else {
    // Tavus deprecated (CLAUDE.md project memory). resolveAvatarProvider
    // still tolerates the value for env-flag flexibility but no mint path
    // exists today. Surface as failed_mint with a distinct code.
    avatarStatus = 'failed_mint';
    avatarError = 'tavus_scrapped';
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

  // ── Brain prefix build (PR-2) ───────────────────────────────────────
  // Pulls sample_content rows whose topic_tags overlap hook.topic_tags
  // and packages them as paired user/model `prefixTurns`. Server-only
  // (sample_content can carry PII; never reaches the client). On any
  // error, degrade to persona-only (system_prompt without prefix) and
  // breadcrumb so we can find detachment in production.
  let brainPrefix: Awaited<ReturnType<typeof buildBrainPrefix>> = null;
  try {
    brainPrefix = await buildBrainPrefix({
      supabaseAdmin: admin,
      creatorId,
      hookId,
    });
    if (brainPrefix) {
      captureServerSafe(callerUserId, 'brain_prefix_built', {
        creator_id: creatorId,
        hook_id: hookId,
        source_count: brainPrefix.sourceCount,
        total_raw_chars: brainPrefix.totalRawChars,
        encoded_bytes: brainPrefix.encodedBytes,
        selected_topic_count: brainPrefix.selectedTopicSlugs.length,
      });
    } else {
      captureServerSafe(callerUserId, 'brain_prefix_skipped', {
        creator_id: creatorId,
        hook_id: hookId,
        reason: 'no_overlap',
      });
      Sentry.addBreadcrumb({
        category: 'brain',
        level: 'info',
        message: 'partial_prefix',
        data: { creator_id: creatorId, hook_id: hookId },
      });
    }
  } catch (prefixErr) {
    Sentry.captureException(prefixErr, {
      extra: { op: 'sessions_open_brain_prefix', creator_id: creatorId, hook_id: hookId },
    });
    captureServerSafe(callerUserId, 'brain_prefix_skipped', {
      creator_id: creatorId,
      hook_id: hookId,
      reason: 'builder_error',
    });
    brainPrefix = null;
  }

  // ── Mint voice ticket (proxy WS auth — fatal on failure) ─────────────
  // SIMLI_WIREUP §2 — pre-mint a UA-bound, session-pinned ticket so the
  // browser can open the proxy WS without a second client RTT.
  //
  // Failure is FATAL after use-session-pipe rewire (round-2 audit). A
  // session without a voice_ticket cannot reach the proxy WS, so leaving
  // a session row open without a ticket only orphans the row and burns
  // the user's one-active slot. Close the session before returning.
  let voiceTicket: { ticket: string; expiresAt: string };
  try {
    voiceTicket = await mintVoiceTicket({
      userId:        callerUserId,
      sessionId,
      creatorId,
      hookId,
      expectedTier:  tier,
      // Drives the voice-proxy's per-session Cartesia sample-rate
      // selection (audit-r2 C1). When avatarProvider is null (voice-only
      // tier or kill-switch), we fall back to 'simli' as the safest
      // historical default — the voice-proxy will use 16kHz, matching
      // the legacy attach-path behavior.
      avatarProvider: avatarProvider ?? 'simli',
      ua:            req.headers.get('user-agent') ?? '',
      // Brain wire-up (PR-2). Both already pre-validated:
      //   * system_prompt: octet_length ≤ 2000 enforced by creators
      //     CHECK at compile time
      //   * prefixTurns: encodedBytes < 90KB enforced by buildBrainPrefix
      //     before return
      // The DB CHECKs on voice_tickets are defense-in-depth.
      systemPrompt: creatorRow.system_prompt,
      prefixTurns:  brainPrefix?.prefixTurns ?? null,
    });
  } catch (e) {
    Sentry.captureException(e, { extra: { op: 'sessions_open_voice_ticket', session_id: sessionId } });
    // Close the orphaned session row so the user's one-active slot frees
    // for an immediate retry. R3-C2 takeover guard: skip close on a row
    // that belongs to another tab.
    if (!isTakeover) {
      try {
        await sb.rpc('session_close', {
          p_session_id: sessionId,
          p_end_reason: 'voice_ticket_mint_failed',
        });
      } catch (closeErr) {
        Sentry.captureException(closeErr, {
          extra: { op: 'sessions_open_voice_ticket_close', session_id: sessionId },
        });
      }
    }
    // Auditor C3: defensive instanceof — Next 15 server bundling can produce
    // separate class identities. Match on the error name as a fallback so a
    // bundle re-shape doesn't silently downgrade specific codes to a generic
    // 502.
    const isVTM = e instanceof VoiceTicketMintError
      || (e != null && typeof e === 'object'
          && (e as { name?: unknown }).name === 'VoiceTicketMintError'
          && typeof (e as { httpStatus?: unknown }).httpStatus === 'number');
    if (isVTM) {
      const ve = e as VoiceTicketMintError;
      // Auditor C2: bad_ua / bad_avatar_provider fire only when the route
      // failed to pass valid args — programmer-error, not user-error. Mask
      // them as 500 so the client doesn't see a 400 they cannot recover from.
      if (ve.code === 'bad_ua' || ve.code === 'bad_avatar_provider') {
        Sentry.captureException(e, {
          extra: { op: 'sessions_open_voice_ticket_programmer_error', code: ve.code, session_id: sessionId },
        });
        return json(500, { error: 'voice_ticket_mint_failed' });
      }
      return json(ve.httpStatus, { error: ve.code });
    }
    return json(502, { error: 'voice_ticket_mint_failed' });
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

  // Proxy URL is required after the use-session-pipe rewire — the only
  // path is via the proxy WS. If the env var is unset, refuse to open
  // rather than ship a half-formed envelope the client can't act on.
  const proxyUrl = process.env.NEXT_PUBLIC_VOICE_PROXY_URL;
  if (!proxyUrl) {
    Sentry.captureMessage('sessions_open_proxy_url_unconfigured', {
      level: 'error',
      extra: { session_id: sessionId },
    });
    if (!isTakeover) {
      try {
        await sb.rpc('session_close', {
          p_session_id: sessionId,
          p_end_reason: 'proxy_url_unconfigured',
        });
      } catch (e) {
        Sentry.captureException(e, { extra: { op: 'sessions_open_proxy_url_close', session_id: sessionId } });
      }
    }
    return json(503, { error: 'proxy_url_unconfigured' });
  }

  return json(200, {
    session_id: sessionId,
    tier,
    // avatar_provider discriminator — client uses this to pick the bridge
    // factory. avatar.provider holds the same value but is also discriminated
    // for the typed envelope; avatar_provider is the top-level signal that's
    // present even when avatar mint failed.
    avatar_provider: avatarProvider,
    avatar,
    avatar_status: avatarStatus,
    // Wire-form model name only — proxy holds the Gemini API key server-
    // side and the voice_ticket auths the WS, so no token leaks past
    // /api/sessions/open. The wire-form is what proxy-client passes as
    // `modelWire` when opening the WS.
    voice: { model: token.model },
    voice_ticket: voiceTicket,
    proxy_url: proxyUrl,
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
