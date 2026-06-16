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
import { buildBrainPrefix } from '@/lib/voice/brain-prefix';
import { captureServerSafe } from '@/lib/posthog-server';
import { resolveVoiceId, pickEnvScoped, coerceNumericOrNull } from '@/lib/voice/env-scoped-voice-id';
import { getProxyVoiceConfig } from '@/lib/voice/voice-config';
import { shouldEmitBrainNotReady } from '@/lib/voice/brain-not-ready-dedupe';

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

// Audit S2 (unit-wide) — calls use coerceNumericOrNull directly; no
// local alias needed.

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

  // R3 audit C1 (brain wire-up): hook ↔ creator binding pre-check.
  // PR-2 audit C1: normalize PostgREST embed shape (object|array).
  type EmbedShape = { creator_id?: string };
  let hookBindingCreatorId: string | null = null;
  try {
    const { data: hookBinding, error: bindingErr } = await admin
      .from('hooks')
      .select('id, video:videos!inner(creator_id)')
      .eq('id', hookId)
      .maybeSingle<{ id: string; video: EmbedShape | EmbedShape[] | null }>();
    if (bindingErr) {
      Sentry.captureException(bindingErr, { extra: { op: 'sessions_rollover_hook_binding', hook_id: hookId } });
      return json(500, { error: 'hook_lookup_failed' });
    }
    if (!hookBinding) return json(400, { error: 'hook_creator_mismatch' });
    const v = hookBinding.video;
    hookBindingCreatorId = Array.isArray(v) ? (v[0]?.creator_id ?? null) : (v?.creator_id ?? null);
  } catch (e) {
    Sentry.captureException(e, { extra: { op: 'sessions_rollover_hook_binding_throw', hook_id: hookId } });
    return json(500, { error: 'hook_lookup_failed' });
  }
  if (hookBindingCreatorId !== creatorId) {
    return json(400, { error: 'hook_creator_mismatch' });
  }

  // HUME_TTS_PLAN §6.2 — SELECT both providers' env-scoped columns +
  // Hume prosody dials. The actual provider for THIS rollover session is
  // read from sessions.tts_provider_at_session below (snapshot from the
  // original /api/sessions/open call), not /voice-config.
  const { data: creatorRow, error: creatorErr } = await admin
    .from('creators')
    .select(`
      id, simli_face_id, heygen_avatar_id,
      voice_id, voice_id_preview, voice_id_dev,
      hume_voice_id, hume_voice_id_preview, hume_voice_id_dev,
      hume_voice_name, hume_voice_name_preview, hume_voice_name_dev,
      hume_tts_speed, hume_tts_speed_preview, hume_tts_speed_dev,
      hume_trailing_silence, hume_trailing_silence_preview, hume_trailing_silence_dev,
      hume_voice_description, hume_voice_description_preview, hume_voice_description_dev,
      hume_model_version, hume_model_version_preview, hume_model_version_dev,
      fish_voice_id, fish_voice_id_preview, fish_voice_id_dev,
      tts_provider,
      published_at, system_prompt, brain_status, tts_speed, brain_mode, decoupled
    `)
    .eq('id', creatorId)
    .maybeSingle<{
      id: string;
      simli_face_id: string | null;
      heygen_avatar_id: string | null;
      voice_id: string | null;
      voice_id_preview: string | null;
      voice_id_dev: string | null;
      hume_voice_id: string | null;
      hume_voice_id_preview: string | null;
      hume_voice_id_dev: string | null;
      hume_voice_name: string | null;
      hume_voice_name_preview: string | null;
      hume_voice_name_dev: string | null;
      hume_tts_speed: number | string | null;
      hume_tts_speed_preview: number | string | null;
      hume_tts_speed_dev: number | string | null;
      hume_trailing_silence: number | string | null;
      hume_trailing_silence_preview: number | string | null;
      hume_trailing_silence_dev: number | string | null;
      hume_voice_description: string | null;
      hume_voice_description_preview: string | null;
      hume_voice_description_dev: string | null;
      hume_model_version: string | null;
      hume_model_version_preview: string | null;
      hume_model_version_dev: string | null;
      // FISH_AUDIO_PHASE_1 §6 — env-scoped Fish reference_id columns
      // (TS-widening audit C1). Without these, resolveVoiceId on a fish
      // rollover returns null → 409 creator_voice_not_trained.
      fish_voice_id: string | null;
      fish_voice_id_preview: string | null;
      fish_voice_id_dev: string | null;
      // Audit M2: select tts_provider even though rollover relies on the
      // SESSION snapshot (not the creator's current value). Surfacing it
      // here makes future divergence guards possible without a re-SELECT.
      tts_provider: 'cartesia' | 'hume' | 'fish' | null;
      // C3 (FIVE_CREATOR_ONBOARDING_READINESS P0-1): gate rollover on
      // publication too, so a takedown/unpublish during a live session also
      // blocks the 15-min rollover (a rollover IS a new session).
      published_at: string | null;
      system_prompt: string | null;
      brain_status: 'pending' | 'queued' | 'training' | 'ready' | 'errored';
      // numeric → string coercion (R2 audit C3). See open route.ts:165
      // for full rationale; same shape here.
      tts_speed: number | string | null;
      // pgvector RAG plan (M2). 'drawer' | 'vector'.
      brain_mode: 'drawer' | 'vector';
      // DECOUPLED_BRAIN_PLAN P1-10. Mirrors the open route — forward
      // creators.decoupled to mintVoiceTicket so a rollover preserves
      // the decoupled state across the resumption boundary.
      decoupled: boolean;
    }>();
  if (creatorErr) return json(500, { error: 'creator_lookup_failed' });
  if (!creatorRow) return json(404, { error: 'creator_not_found' });

  // HUME_TTS_PLAN §6.2 — rollover reads sessions.tts_provider_at_session
  // from the OLD session row (snapshot at original /api/sessions/open).
  // Pre-migration sessions have NULL → fall back to 'cartesia' (the only
  // provider that existed). NEVER call getProxyVoiceConfig() for provider:
  // the env may have flipped between open and rollover, but the session is
  // locked to its open-time snapshot (CLAUDE.md "Tier routing at session-
  // open only" — same rule applies).
  const { data: oldProviderRow } = await admin
    .from('sessions')
    .select('tts_provider_at_session')
    .eq('id', oldId)
    .maybeSingle<{ tts_provider_at_session: 'cartesia' | 'hume' | 'fish' | null }>();
  // FISH_AUDIO_PHASE_1 §6 — 3-arm union for the locked-session snapshot.
  const sessionProvider: 'cartesia' | 'hume' | 'fish' =
    oldProviderRow?.tts_provider_at_session ?? 'cartesia';

  // PR-2 audit C3: pre-gate the env-scoped voice column on rollover, mirror
  // open route. Without this, a creator whose voice clone was deleted between
  // session-open and rollover dies at proxy-WS 4009/4014 mid-conversation.
  // Audit M5: 503 instead of risking a wrong-provider ticket when the proxy
  // is unreachable.
  const envVoiceId = resolveVoiceId(creatorRow, undefined, sessionProvider);
  const proxyCfgR = await getProxyVoiceConfig();
  if (proxyCfgR.failOpen) {
    return json(503, { error: 'voice_proxy_unreachable' });
  }
  const useTtsLayer = proxyCfgR.useTtsLayer;
  // Audit C4 + FISH_AUDIO_PHASE_1 — same predicate as proxy `useTts =
  // useTtsLayer || ttsProvider === 'hume' || 'fish'`. A non-cartesia
  // override creator whose env-scoped voice id is NULL must 409 here
  // too, not slip to WS-open.
  const useTts = useTtsLayer || sessionProvider === 'hume' || sessionProvider === 'fish';
  if (useTts && !envVoiceId) {
    return json(409, {
      error: 'creator_voice_not_trained',
      tts_provider: sessionProvider,
    });
  }

  // Brain readiness gate — same shape + semantics as sessions/open
  // (whole-build audit C1 loosened). Block on persona NULL or
  // brain_status='errored'; allow training/ready when persona exists.
  const brainReady =
    creatorRow.system_prompt !== null && creatorRow.brain_status !== 'errored';
  // C3 — mirror sessions/open: an unpublished creator (takedown / consent
  // withdrawal mid-session) must not get a fresh rollover session minted.
  // Admin-preview bypass preserved for both gates.
  const published = creatorRow.published_at !== null;
  if (!brainReady || !published) {
    const { data: adminRow } = await admin
      .from('admin_roles')
      .select('user_id')
      .eq('user_id', callerUserId)
      .is('revoked_at', null)
      .maybeSingle();
    if (!adminRow) {
      if (!brainReady) {
        if (shouldEmitBrainNotReady(creatorId)) {
          Sentry.captureMessage('brain.not_ready', {
            level: 'error',
            extra: {
              path: 'rollover',
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
      return json(409, {
        error: 'creator_not_published',
        creator_id: creatorId,
      });
    }
    captureServerSafe(callerUserId, 'brain_admin_preview', {
      admin_user_id: callerUserId,
      creator_id: creatorId,
      brain_status_at_open: creatorRow.brain_status,
    });
  }

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

  // Growth & Minutes Economy Phase 1 (R2-C3 — rollover was unthreaded): the
  // UNIFIED effective_remaining (free allowance + durable wallet), NOT
  // session_rollover's System-A daily_limit_remaining_s, drives the rolled
  // session's max_duration AND its 150%-fuse anchor — else a 15-min rollover
  // silently reverts the user to System-A limits and drops their earned minutes
  // mid-conversation.
  const { data: balRows, error: balErr } = await admin.rpc('voice_balance_check', {
    p_user_id: callerUserId,
  });
  if (balErr) {
    Sentry.captureException(balErr, { extra: { op: 'sessions_rollover_balance_check', user_id: callerUserId } });
  }
  const balRow = (Array.isArray(balRows) ? balRows[0] : balRows) as {
    remaining_seconds:    number | string | null;
    allowance_remaining:  number | string | null;
    wallet_remaining:     number | string | null;
    daily_cap_eff:        number | string | null;
    wallet_active_seconds: number | string | null; // M-D — had_wallet for the 409 copy
    cap_period:           'daily' | 'weekly' | 'monthly' | null; // S — was an inline cast
  } | null;
  // C1 — co-gate wallet-awareness with the proxy's wallet draw (GROWTH_LEDGER_ENABLED).
  // Ledger OFF → roll on the free allowance only, fuse anchor excludes the wallet.
  // C2 — directional deploy order (see /sessions/open for the full note): roll
  // FORWARD = proxy ON before route; roll BACK = route OFF before proxy. "route ON /
  // proxy OFF" is the unmetered-wallet leak — never roll the proxy back first.
  // S5 — NO `?? remaining_seconds` fallback in the ledger-OFF branch: allowance_
  // remaining is NOT NULL from the RPC, but if a future change made it null we must
  // NOT silently fall back to the wallet-inclusive figure in a mode that is supposed
  // to ignore the wallet (that would leak wallet minutes the proxy isn't drawing).
  const ledgerOn = process.env.GROWTH_LEDGER_ENABLED === '1';
  // S4 — a transient balance-read failure must NOT silently cap the rolled segment
  // at the 60s floor (open treats this as fatal 500; rollover is mid-conversation so
  // we degrade, not fail). Fall back to session_rollover's System-A daily_limit_
  // remaining_s (the RPC return `row`) — the user's real headroom — not 0.
  const balReadOk = !balErr && balRow != null;
  const rpcDailyRemaining = Math.max(0, Math.floor(Number(
    (row as { daily_limit_remaining_s?: number | string | null }).daily_limit_remaining_s ?? 0,
  )));
  const dailyLimitRemaining = balReadOk
    ? Math.max(0, Math.floor(Number(ledgerOn ? balRow!.remaining_seconds : balRow!.allowance_remaining) || 0))
    : rpcDailyRemaining;
  const walletRemaining = ledgerOn && balReadOk
    ? Math.max(0, Math.floor(Number(balRow!.wallet_remaining ?? 0)))
    : 0;

  // M1 — do NOT mint a dead segment. If the unified balance is already exhausted
  // (soft gate would fire on the new segment's first turn), rolling over burns a
  // Gemini ephemeral mint + a Simli/avatar mint + a voice ticket for a session that
  // can never deliver a turn — and shows the user a confusing fresh-then-instantly-
  // upsold segment. Return a terminal "tier_exhausted" so the client keeps the
  // existing in-session upsell overlay instead of swapping to a new socket. Only
  // when the balance read SUCCEEDED (a failed read degrades to the RPC figure above
  // and rolls — we never strand a paying user on a transient blip). The hard-fuse
  // latch is still enforced inside session_rollover (raises kill_switch_fired).
  if (balReadOk && dailyLimitRemaining <= 0) {
    // M-C — best-effort close of the just-minted (never-run) segment. A raw UPDATE,
    // not session_close, is sufficient here: active_seconds is 0 (no turn ran) so
    // there's nothing to accrue, and a fresh rollover row has no open pause to
    // resolve. Wrapped so a transient write failure still returns the 409 (the
    // ghost-session reaper backstops a stuck row); the user MUST be told they're out.
    try {
      await admin.from('sessions')
        .update({ ended_at: new Date().toISOString(), status: 'ended', end_reason: 'tier_exhausted' })
        .eq('id', newSessionId);
    } catch (e) {
      Sentry.captureException(e, { extra: { op: 'sessions_rollover_exhausted_close', session_id: newSessionId } });
    }
    // M-D — carry the wallet signal so a paid user who exhausts exactly at the
    // 15-min rollover boundary gets the "top up" copy, not the free "refresh" copy.
    const hadWallet = ledgerOn && Math.floor(Number(balRow!.wallet_active_seconds ?? 0)) > 0;
    return json(409, {
      error: 'tier_exhausted',
      remaining_seconds: 0,
      cap_period: balRow!.cap_period ?? null,
      wallet_exhausted: hadWallet,
    });
  }

  {
    const absoluteCeiling = Math.max(
      60,
      Math.floor(Number(process.env.ABSOLUTE_DAILY_COGS_CEILING_SECONDS ?? 14400)),
    );
    // TANDEM AUDIT C1 — same mic-headroom factor as /sessions/open: daily_quotas.
    // daily_limit_s gates mic+assistant System-A seconds, so anchor a mic-turn above
    // the assistant-only entitlement (see open/route.ts for the full rationale).
    const micHeadroom = Math.max(1, Number(process.env.VOICE_FUSE_MIC_HEADROOM ?? 2));
    const fuseAnchorSeconds = Math.min(
      Math.ceil((Math.floor(Number(balRow?.daily_cap_eff ?? 0)) + walletRemaining) * micHeadroom),
      absoluteCeiling,
    );
    const { error: anchorErr } = await admin.rpc('voice_fuse_anchor_apply', {
      p_user_id: callerUserId,
      p_anchor_seconds: fuseAnchorSeconds,
    });
    if (anchorErr) {
      Sentry.captureException(anchorErr, { extra: { op: 'sessions_rollover_fuse_anchor', user_id: callerUserId } });
    }
  }

  // HUME_TTS_PLAN §6.2 — propagate the OLD session's provider snapshot onto
  // the NEW session row. session_rollover RPC doesn't write this column;
  // we write it here so cogs_insert_turn_voice_v2 cross-checks succeed on
  // the new session's first turn.
  try {
    await admin
      .from('sessions')
      .update({ tts_provider_at_session: sessionProvider })
      .eq('id', newSessionId);
  } catch (e) {
    Sentry.captureException(e, {
      extra: { op: 'sessions_rollover_tts_provider_snapshot', session_id: newSessionId, tts_provider: sessionProvider },
    });
  }

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

  // Per-provider session-length clamp (heygen tighter default). dailyLimitRemaining
  // is the UNIFIED effective_remaining; R2-C2 removed the hardcoded 600s ceiling.
  const maxAvatarSeconds = avatarProvider === 'heygen'
    ? Math.max(60, Math.min(
        GEMINI_MAX_SESSION_S,
        dailyLimitRemaining,
        Number(process.env.LIVEAVATAR_MAX_SESSION_S ?? 300),
      ))
    : Math.max(60, Math.min(GEMINI_MAX_SESSION_S, dailyLimitRemaining));

  // AvatarEnvelope hoisted to @/lib/avatar/avatar-envelope (final-audit S1).
  let avatar: AvatarEnvelope | null = null;
  let avatarStatus: 'minted' | 'failed_mint' = 'failed_mint';

  if (avatarProvider === 'simli') {
    try {
      const result = await mintSimliSessionToken({
        faceId: providerAvatarId!,
        maxSessionLength: maxAvatarSeconds,
        // Parity with sessions/open route (2026-06-09 fix) — override
        // Simli's 120s default maxIdleTime to maxSessionLength so the
        // LiveKit room doesn't tear down mid-conversation during normal
        // turn-pause silences.
        maxIdleTime: maxAvatarSeconds,
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
  // Brain prefix build for the new session (PR-2 + pgvector RAG).
  // Drawer mode: build prefix as today. Vector mode: skip — per-turn
  // retrieval runs proxy-side; injection history starts fresh on the new
  // bridge (documented rollover regression — honest-disqualifier persona
  // clause carries any in-flight-at-rollover question).
  let brainPrefix: Awaited<ReturnType<typeof buildBrainPrefix>> = null;
  if (creatorRow.brain_mode === 'drawer') {
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
      }
    } catch (prefixErr) {
      Sentry.captureException(prefixErr, {
        extra: { op: 'sessions_rollover_brain_prefix', creator_id: creatorId, hook_id: hookId },
      });
      captureServerSafe(callerUserId, 'brain_prefix_skipped', {
        creator_id: creatorId,
        hook_id: hookId,
        reason: 'builder_error',
      });
      brainPrefix = null;
    }
  } else {
    // Audit M2: vector mode chunk-count guard (mirror sessions/open).
    try {
      const { count: chunkCount } = await admin
        .from('sample_content_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('creator_id', creatorId)
        .not('embedding', 'is', null);
      if ((chunkCount ?? 0) === 0) {
        Sentry.captureMessage('vector.no_chunks', {
          level: 'warning',
          extra: { creator_id: creatorId, hook_id: hookId, surface: 'rollover' },
        });
        captureServerSafe(callerUserId, 'vector_mode_no_chunks', {
          creator_id: creatorId,
          hook_id: hookId,
        });
      }
    } catch (chunkCountErr) {
      Sentry.captureException(chunkCountErr, {
        extra: { op: 'sessions_rollover_chunk_count', creator_id: creatorId },
      });
    }
  }

  // {{user_name}} substitution (mirror sessions/open). Persona compile emits
  // the literal placeholder; resolve from profiles.display_name here.
  let resolvedSystemPrompt: string | null = creatorRow.system_prompt;
  if (resolvedSystemPrompt && resolvedSystemPrompt.includes('{{user_name}}')) {
    const { data: profileRow } = await admin
      .from('profiles')
      .select('display_name')
      .eq('id', callerUserId)
      .maybeSingle<{ display_name: string | null }>();
    const userName = (profileRow?.display_name ?? '').trim() || 'friend';
    resolvedSystemPrompt = resolvedSystemPrompt.replaceAll('{{user_name}}', userName);
  }

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
      systemPrompt:   resolvedSystemPrompt,
      prefixTurns:    brainPrefix?.prefixTurns ?? null,
      brainMode:      creatorRow.brain_mode,
      // DECOUPLED_BRAIN_PLAN P1-10. Forward creators.decoupled to the
      // resumed ticket so the decoupled path survives a rollover (the
      // OLD ticket already snapshotted decoupled but a refresh of the
      // creator's flag between sessions should be respected on the new
      // ticket — same pattern as brain_mode forwarding above).
      decoupled:      creatorRow.decoupled ?? false,
      // Creator voice-speed (migration 20260511000006). Shared coercion
      // helper — see env-scoped-voice-id.ts.
      ttsSpeed: coerceNumericOrNull(creatorRow.tts_speed),
      // HUME_TTS_PLAN §6.3 — provider locked to the OLD session's snapshot.
      // Hume prosody pulled from creators' env-scoped columns at rollover
      // time (admin can dial speed/silence mid-creator-life; the rolled-over
      // session picks up the new value).
      ttsProvider: sessionProvider,
      humeTtsSpeed: sessionProvider === 'hume'
        ? coerceNumericOrNull(pickEnvScoped(creatorRow, 'hume_tts_speed'))
        : null,
      humeTrailingSilence: sessionProvider === 'hume'
        ? coerceNumericOrNull(pickEnvScoped(creatorRow, 'hume_trailing_silence'))
        : null,
      humeVoiceDescription: sessionProvider === 'hume'
        ? (pickEnvScoped(creatorRow, 'hume_voice_description') as string | null)
        : null,
      humeModelVersion: sessionProvider === 'hume'
        // Audit M3 (unit-wide) — default to '2' (Octave 2) when null.
        ? ((pickEnvScoped(creatorRow, 'hume_model_version') as string | null) || '2')
        : null,
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
