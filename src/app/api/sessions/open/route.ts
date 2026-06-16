// POST /api/sessions/open — production session lifecycle entry point.
//
// Flow (re-phased 2026-06-10 latency plan — tap→avatar was ~10s, /open was
// a ~3s strictly-serial chain; phases cut it to ~1.5-2s with identical
// gate semantics):
//   1. Same-origin + getCallerUserId (NOT admin — regular user cookie),
//      then parse body (creator_id, hook_id, model wire-form). Translate
//      model wire → enum via WIRE_TO_ENUM BEFORE calling the RPC (R3-C3).
//   2. PHASE A — six independent pure reads in ONE Promise.all (rate-limit
//      RPC, hook binding, creator row, proxy config probe, cookie client,
//      cap check), then gates evaluated SERIALLY in the legacy order:
//      rate-limit 429 (R5-M4) → hook mismatch 400 → creator 404 →
//      brain/published 409 → proxy-unreachable 503 → cap 429.
//   3. PHASE B (serial) — session_open RPC (tier snapshot + kill-switch +
//      quota upsert in the BEFORE trigger; 23505 → takeover branch) →
//      tts_provider_at_session snapshot UPDATE → voice-trained gate →
//      avatar provider resolution.
//   4. PHASE C — avatar mint ∥ brain-payload assembly (Promise.all). If
//      FORCE_AVATAR_REQUIRED=1 and mint fails, close the freshly-created
//      session row via session_close(…, 'force_required_mint_failed')
//      BEFORE returning 503 (R4-C2) — otherwise the one-active-per-user
//      partial-unique index blocks the user's immediate retry until the
//      reaper runs 60s later. Gemini ephemeral mint stays SERIAL behind
//      that gate (mintEphemeral writes the COGS audit row internally
//      R4-M1; mintSimli writes its own symmetrically R5-S4).
//   5. PHASE D (serial) — voice ticket mint (strictly after the Phase-B
//      snapshot UPDATE — Audit M4) → envelope with avatar.session_token
//      (consumed client-side via SimliBridge.preMintedSessionToken —
//      R3-C2/P0-5).

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
import { buildUserContext } from '@/lib/voice/user-context';
import { shouldEmitBrainNotReady } from '@/lib/voice/brain-not-ready-dedupe';
import { resolveVoiceId, pickEnvScoped, coerceNumericOrNull } from '@/lib/voice/env-scoped-voice-id';
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

// Audit S2 (unit-wide) — `coerceNumericOrNull` is the canonical helper;
// no local alias needed. Earlier draft had a local `coerceNumOrNull`
// shorthand; calls below now use the import directly.

type Body = {
  creator_id?: unknown;
  hook_id?: unknown;
  model?: unknown;
};

// Resolve the creator's simli_face_id + env-scoped voice_id + brain
// payload before opening the session. No row → 404 (at the consuming
// gate). We read with the service-role client because `creators` public
// SELECT is "published only" — drafts still need to route (admin preview).
//
// R3-Missing-1 / R4-M6 — three voice_id columns scoped by VERCEL_ENV.
// resolveVoiceId() picks the env-appropriate value.
//
// Brain wire-up (PR-2): SELECT system_prompt + brain_status alongside
// existing columns so the route can hard-fail unready creators with
// 409 brain_not_ready (R3 audit M1).
// HUME_TTS_PLAN §6.2 — creators carries env-scoped voice-id columns for
// both providers PLUS per-creator override + Hume prosody dials. SELECT
// them all so resolveVoiceId(row, env, provider) can route on the result.
type CreatorRow = {
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
  // FISH_AUDIO_PHASE_1 §6 — env-scoped Fish reference_id columns.
  // Audit C1: must be in BOTH the SELECT list AND the row type or
  // resolveVoiceId(row, env, 'fish') sees undefined → null → every
  // Fish session 409s creator_voice_not_trained.
  fish_voice_id: string | null;
  fish_voice_id_preview: string | null;
  fish_voice_id_dev: string | null;
  // Per-creator override. NULL = inherit env (proxyCfg.ttsProvider).
  // FISH_AUDIO_PHASE_1 §6 — 3-arm union; mint helper widened in lockstep.
  tts_provider: 'cartesia' | 'hume' | 'fish' | null;
  published_at: string | null;
  system_prompt: string | null;
  brain_status: 'pending' | 'queued' | 'training' | 'ready' | 'errored';
  // numeric arrives as string from supabase-js — coerce at boundary
  // (R2 audit C3). DB CHECK is [0.6, 1.5]; mint helper drops to NULL
  // on non-finite values as defense in depth.
  tts_speed: number | string | null;
  // pgvector RAG plan (M2). 'drawer' | 'vector'. Default 'drawer'.
  brain_mode: 'drawer' | 'vector';
  // DECOUPLED_BRAIN_PLAN P1-10. Snapshot of creators.decoupled at
  // session-open. Forwarded to mintVoiceTicket so the voice_tickets row
  // is in sync with the creator's current flag. Pre-P1-10 this was
  // provably inert at the route layer (whole-build audit "route writer
  // cannot reach decoupled today").
  decoupled: boolean;
};

function creatorSelect(admin: ReturnType<typeof supabaseAdmin>, creatorId: string) {
  return admin
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
    .maybeSingle<CreatorRow>();
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });

  const callerUserId = await getCallerUserId();
  if (!callerUserId) return json(401, { error: 'unauthorized' });

  // Phase C B3.5: tag every Sentry event in this request with the caller's
  // user id. Sentry v10 isolation scope is per-request in the Next.js App
  // Router integration, so this attaches to all subsequent captureException
  // calls in the handler without per-call extras edits.
  Sentry.setUser({ id: callerUserId });

  const admin = supabaseAdmin();

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

  // ── Phase A — independent reads in parallel (latency plan 2026-06-10) ──
  // Previously a strictly-serial chain of ~6 roundtrips — the bulk of /open's
  // measured ~3.0-3.2s (PostHog prod timeline). Every member is a pure read
  // (voice_usage_ticket_check verified read-only — zero INSERT/UPDATE in
  // 20260510000001) and none consumes another's output, so they run
  // concurrently. Results are evaluated SERIALLY below in the exact order of
  // the old chain, preserving every error status, body, and precedence.
  // One deliberate shift: body-shape 400s (bad_json/bad_creator_id/
  // bad_hook_id) now fire before the rate-limit check — parsing is local,
  // zero I/O, strictly cheaper than the old RPC-before-parse order.
  // NO paid mint happens in Phase A or B — mints stay behind the rate-limit,
  // cap, brain-readiness, and proxy-health gates exactly as before.
  type EmbedShape = { creator_id?: string };
  const [rlRes, hookBindingRes, creatorRes, proxyCfg, sb, capRes] = await Promise.all([
    // R5-M4: per-user rate-limit gates the paid provider mints (Phase C).
    // Normal use is <1 open per 5min (session length). 10/min is >10×
    // headroom but caps a run-away client loop at ~$0.05/min of Simli mint
    // spend per attacker.
    admin.rpc('rate_limit_hit', {
      p_scope: 'sessions_open',
      p_key: callerUserId,
      p_window: '1 minute',
      p_limit: 10,
    }),
    // Hook ↔ creator binding pre-check (R3 audit C1) — full rationale at the
    // gate that consumes this result below.
    admin
      .from('hooks')
      .select('id, video:videos!inner(creator_id)')
      .eq('id', hookId)
      .maybeSingle<{ id: string; video: EmbedShape | EmbedShape[] | null }>(),
    // Creator row — columns + rationale documented at the consuming gate.
    creatorSelect(admin, creatorId),
    // HUME_TTS_PLAN §6.2 (Vuk-M5 fix) — freeze the proxy config ONCE per
    // handler invocation; the frozen local is the single source of truth
    // through mintVoiceTicket. (60s cache; cold probe has a 2s timeout, so
    // a cache-miss request pays up to +2s here — same as the old chain.)
    getProxyVoiceConfig(),
    supabaseServer(),
    // Pre-mint UNIFIED balance check (Growth & Minutes Economy Phase 1) —
    // consumed below, BEFORE session_open, so a capped user never creates a
    // session row. effective_remaining = free allowance + durable wallet, so a
    // user at free-cap=0 with bought/earned minutes now PASSES the gate (R1-C1).
    // Also feeds the max_duration_s clamp and the 150%-fuse anchor (R2-C1).
    admin.rpc('voice_balance_check', { p_user_id: callerUserId }),
  ]);

  // Gate 1 — rate-limit (R5-M4).
  const { data: allowed, error: rlErr } = rlRes;
  if (rlErr) return json(500, { error: 'rate_limit_failed' });
  if (allowed === false) return json(429, { error: 'rate_limited' });

  // Gate 2 — hook ↔ creator binding pre-check.
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
  let hookBindingCreatorId: string | null = null;
  try {
    const { data: hookBinding, error: bindingErr } = hookBindingRes;
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

  // Gate 3 — creator row. No row → 404. Full rationale on creatorSelect().
  const { data: creatorRow, error: creatorErr } = creatorRes;
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
  // C3 (FIVE_CREATOR_ONBOARDING_READINESS P0-1): an UNPUBLISHED creator must
  // not be servable to non-admins, even when brain_status='ready'. Removing
  // the hooks from the feed (RLS published_at gate) is not enough — a
  // takedown / consent-withdrawal (admin_set_creator_published(…, false))
  // must actually STOP new sessions, not just hide the entry point. The
  // admin-preview bypass below applies to BOTH the brain-not-ready and
  // not-published gates so admins can still open an unpublished creator.
  const published = creatorRow.published_at !== null;
  if (!brainReady || !published) {
    const { data: adminRow } = await admin
      .from('admin_roles')
      .select('user_id')
      .eq('user_id', callerUserId)
      .is('revoked_at', null)
      .maybeSingle();
    if (!adminRow) {
      // brain_not_ready takes precedence over not_published — a creator with
      // no persona is a harder failure than one merely awaiting publish.
      if (!brainReady) {
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
      return json(409, {
        error: 'creator_not_published',
        creator_id: creatorId,
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
  // Gate 5 — proxy health. proxyCfg was frozen ONCE in Phase A (HUME_TTS_PLAN
  // §6.2 Vuk-M5 fix: without the freeze, a 60s-cache refresh OR a parallel
  // Fly env flip between reads can race — the frozen local is the single
  // source of truth from Phase A through mintVoiceTicket(); we never re-read
  // the cache mid-handler).
  // Audit M5 — proxy unreachable. We can't know whether the env defaults
  // to cartesia or hume, so routing this session on the failOpen fallback
  // would risk a 4009 close at WS-open for a hume-overridden creator
  // (cartesia ticket against a creator with only hume_voice_id set).
  // 503 instead — the client retries and the next request re-probes.
  if (proxyCfg.failOpen) {
    return json(503, { error: 'voice_proxy_unreachable' });
  }
  const useTtsLayer = proxyCfg.useTtsLayer;
  // Per-creator override wins, else inherit the frozen proxy env.
  // FISH_AUDIO_PHASE_1 §6 — 3-arm union.
  const sessionProvider: 'cartesia' | 'hume' | 'fish' =
    creatorRow.tts_provider ?? proxyCfg.ttsProvider;
  // Audit C4 + FISH_AUDIO_PHASE_1 wiring audit C1 — the proxy activates
  // the TTS bridge when the env layer flag is on OR the session's provider
  // is non-cartesia (per-creator override). The pre-WS voice-trained gate
  // must use the SAME predicate (mirror proxy index.js's `useTts`) — it is
  // computed as `useTtsForGate` against the LOCKED snapshotProvider below.
  // (Latency-diff audit M3: a sessionProvider-based `useTts` local sat here
  // dead since the gate moved — deleted, don't reintroduce it.)

  // §6.2 — pre-WS gate runs LATER (post-session_open, below the takeover
  // snapshot read) so the takeover path can lock onto the original
  // session's snapshotProvider. Premature gating here would let a
  // diverging-env takeover slip past with the wrong provider's voice
  // column check (audit C2). Audit S20 (unit-wide) — line ref dropped;
  // grep `creator_voice_not_trained` to find the relocated gate.


  // Gate 6 — pre-mint daily/weekly/monthly cap check (use-session-pipe
  // rewire R2-C1). The RPC ran in Phase A (verified pure-read) but its
  // result is evaluated HERE, before session_open, so a capped user never
  // creates a session row we'd then have to close. Surfaces a structured
  // 429 instead of falling through to the proxy-WS-side 4006 close after a
  // wasted mint round-trip.
  //
  // R1-S3: voice_balance_check REVOKEs EXECUTE from `authenticated`. Called via
  // the service-role admin client — the SECURITY DEFINER body short-circuits the
  // auth.uid() self-check when JWT role is service_role, and we already
  // authenticated the caller via getCallerUserId() above.
  const { data: capRows, error: capErr } = capRes;
  if (capErr) {
    // Map the function's P0002 'user not found' (raised when no profiles
    // row matches p_user_id) to 409 — a brand-new auth user whose profile
    // trigger hasn't materialised yet should retry, not see a 500.
    const pgCode = (capErr as { code?: string }).code;
    if (pgCode === 'P0002') {
      return json(409, { error: 'profile_not_ready' });
    }
    Sentry.captureException(capErr, { extra: { op: 'sessions_open_balance_check', user_id: callerUserId } });
    return json(500, { error: 'cap_check_failed' });
  }
  // Auditor S1: numeric columns deserialise as string in supabase-js. Coerce
  // every numeric so the wire response is consistent and client comparisons
  // don't fail string-vs-number.
  type CapRowRaw = {
    remaining_seconds:   number | string | null;    // = effective_remaining (free allowance + wallet)
    allowance_remaining: number | string | null;    // free pool only (no wallet)
    wallet_remaining:    number | string | null;
    daily_cap_eff:       number | string | null;    // daily_cap + recruiter bonus (fuse anchor)
    cap_period:          string | null;             // 'daily'|'weekly'|'monthly' (binding free cap)
    daily_used:   number | string | null; daily_cap:   number | null;
    weekly_used:  number | string | null; weekly_cap:  number | null;
    monthly_used: number | string | null; monthly_cap: number | null;
  };
  const capRowRaw = (Array.isArray(capRows) ? capRows[0] : capRows) as CapRowRaw | null;
  if (!capRowRaw) {
    return json(500, { error: 'cap_check_empty' });
  }
  // Deliberately distinct from the imported coerceNumericOrNull (diff audit
  // S1): numOrNull preserves null/undefined as null and Number()s the rest
  // for the cap-row wire response; coerceNumericOrNull additionally drops
  // non-finite values for DB-bound numerics. Don't merge them.
  const numOrNull = (v: number | string | null | undefined): number | null =>
    v == null ? null : (typeof v === 'number' ? v : Number(v));
  // C1 — co-gate wallet-awareness with the proxy's wallet DRAW (also behind
  // GROWTH_LEDGER_ENABLED). If the route extended entitlement using wallet minutes
  // while the proxy (flag off / not yet redeployed) did NOT draw them down, the
  // user would get free unbounded minutes. When the ledger is OFF we admit on the
  // FREE allowance only and the fuse anchor never includes the wallet — identical
  // to pre-Phase-1 behavior. When ON, effective_remaining (allowance + wallet) is
  // used and a user at free-cap=0 with wallet minutes PASSES (R1-C1).
  //
  // TANDEM AUDIT C2 — DEPLOY-ORDER IS DIRECTIONAL, both ways (the flag lives in TWO
  // env stores — this Vercel route + the Fly proxy — and skews during a rolling
  // deploy):
  //   ROLL FORWARD (turning the ledger ON): migrations live on prod FIRST, then flip
  //     the FLY proxy ON (starts drawing the wallet), THEN flip this Vercel route ON.
  //     The transient "route OFF / proxy ON" state under-delivers (safe); the
  //     dangerous "route ON / proxy OFF" state (the leak) never occurs.
  //   ROLL BACK (turning the ledger OFF): reverse order — flip this Vercel route OFF
  //     FIRST, then the Fly proxy. Rolling the PROXY back first lands in "route ON /
  //     proxy OFF" = the leak. Never roll the proxy back before the route.
  const ledgerOn = process.env.GROWTH_LEDGER_ENABLED === '1';
  // S5 — NO `?? remaining_seconds` fallback in the ledger-OFF branch (allowance_
  // remaining is NOT NULL from the RPC, but a future change must never silently
  // fall back to the wallet-inclusive figure in a mode that ignores the wallet).
  const remainingSeconds = Math.max(0, Math.floor(Number(
    (ledgerOn ? capRowRaw.remaining_seconds : capRowRaw.allowance_remaining) ?? 0,
  )));
  const walletRemaining = ledgerOn
    ? Math.max(0, Math.floor(Number(capRowRaw.wallet_remaining ?? 0)))
    : 0;
  if (remainingSeconds <= 0) {
    // Whole-build audit C4: emit telemetry so we can compare HTTP-layer
    // pre-mint cap firing rate (PR-1) against the legacy proxy-WS-side
    // 4006 cap close, and correlate to /upgrade?source=cap_hit clicks.
    await captureServerSafe(callerUserId, 'daily_cap_hit_fired', {
      surface:      'sessions_open',
      cap_period:   capRowRaw.cap_period,
      wallet_remaining: walletRemaining,
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
      wallet_remaining: 0,
      // R4-M5: which free cap bound — client renders period-correct reset copy
      // ("resets in 24h" daily vs "~27 days" monthly) instead of always-daily.
      cap_period:   capRowRaw.cap_period,
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
    // Use the UNIFIED effective_remaining (free allowance + durable wallet) for
    // the session's max_duration, not session_open's System-A daily_limit_remaining_s.
    dailyLimitRemaining = remainingSeconds;
  }

  // R2-C1 — raise today's 150%-fuse anchor (daily_quotas.daily_limit_s) to this
  // session's real entitlement so a wallet/paid user isn't hard-killed at 150%
  // of the base free cap. GREATEST-only in the RPC, never retro-latches. Runs for
  // BOTH the fresh and takeover paths (sessionId resolved above). Non-fatal —
  // the base-cap fuse still protects COGS if this write fails.
  //
  // TANDEM AUDIT M4 — the anchor is a PER-DAY, cross-session HIGH-WATER MARK, not a
  // per-session value: daily_quotas is keyed by (user, date), and the RPC only ever
  // GREATEST-raises it. So a 2nd tab (takeover) or a later session the same day can
  // raise today's anchor using a fresher wallet snapshot than an earlier still-live
  // session was sized against. That only ever LOOSENS the COGS fuse (never tightens
  // protection) and stays bounded by the absolute ceiling, so it's acceptable — but
  // don't read daily_limit_s as "this session's entitlement"; it's the day's max.
  //
  // TANDEM AUDIT C1 — UNIT MISMATCH (load-bearing): daily_quotas.daily_limit_s
  // gates daily_quotas.seconds_used, which the proxy accumulates as
  // mic-input + assistant-audio seconds (System A, index.js accumulateSeconds).
  // But daily_cap_eff / wallet are in AVATAR-TALK (assistant-only) seconds
  // (System B, the soft gate's unit). Anchoring the fuse at exactly
  // (daily_cap_eff + wallet) puts an assistant-unit value into a mic+assistant-
  // unit field, so for a chatty free user the 150% HARD fuse (450s) fires BEFORE
  // the 100% SOFT gate (300s assistant) — a jarring "come back tomorrow" kill
  // instead of the graceful upsell, defeating Phase 2 for its primary audience.
  // The pre-2026-05-10 CASE encoded this headroom implicitly (free=600=2×cap);
  // de-staling it to the raw cap (migration 0003) dropped it. VOICE_FUSE_MIC_
  // HEADROOM (default 2) restores it: the fuse sits a mic-turn above the soft
  // gate. The proxy ALSO soft-gates at System-A 100% (decideQuotaGate) so the
  // graceful-before-hard ordering is GUARANTEED even for >2:1 mic:assistant
  // ramblers, not merely statistical. Absolute runaway ceiling still caps it.
  {
    const absoluteCeiling = Math.max(
      60,
      Math.floor(Number(process.env.ABSOLUTE_DAILY_COGS_CEILING_SECONDS ?? 14400)),
    );
    const micHeadroom = Math.max(1, Number(process.env.VOICE_FUSE_MIC_HEADROOM ?? 2));
    const fuseAnchorSeconds = Math.min(
      Math.ceil((Math.floor(Number(capRowRaw.daily_cap_eff ?? 0)) + walletRemaining) * micHeadroom),
      absoluteCeiling,
    );
    const { error: anchorErr } = await admin.rpc('voice_fuse_anchor_apply', {
      p_user_id: callerUserId,
      p_anchor_seconds: fuseAnchorSeconds,
    });
    if (anchorErr) {
      Sentry.captureException(anchorErr, { extra: { op: 'sessions_open_fuse_anchor', user_id: callerUserId } });
    }
  }

  // HUME_TTS_PLAN §6.2 — snapshot the resolved TTS provider onto the session
  // row. cogs_insert_turn_voice_v2 cross-checks this column against the
  // ticket's tts_provider on every turn — a missing snapshot would fail the
  // first turn and tear the WS down.
  //
  // Audit M4 — ORDERING INVARIANT (load-bearing, do not reorder):
  // `session_open` RPC creates the row, THEN this block writes
  // tts_provider_at_session, THEN (further below, ~line 887) the voice
  // ticket is minted, THEN the browser opens the WS with that ticket. The
  // cogs double-bill backstop in cogs_insert_turn_voice_v2 only enforces
  // when the snapshot is NON-NULL, so a turn landing before this UPDATE
  // completes would bypass it. That cannot happen ONLY because the ticket
  // (the WS's auth) is minted strictly AFTER this awaited UPDATE — there is
  // no path for the proxy to consume a ticket and run a turn before the
  // snapshot exists. If you move ticket mint earlier, or make this write
  // non-blocking, you reopen the NULL-snapshot double-bill window. The
  // stronger hardening (fold this write INTO the session_open RPC so it's
  // atomic with row creation, eliminating the window structurally) is a
  // tracked follow-up — not done here because session_open is a shared
  // core RPC and the awaited-ordering invariant already closes the gap.
  //
  // Takeover path: the EXISTING snapshot is the authority (CLAUDE.md "Tier
  // routing at session-open only" — same principle for tts_provider). If a
  // tab opens a fresh session at t=0 with provider=cartesia, and creators
  // .tts_provider flips to hume at t=1, then a second tab joining at t=2
  // must inherit the original cartesia (else the bridge instantiated for tab
  // 2 wouldn't match the in-flight session 's cogs accounting). Read the
  // snapshot and reuse it; only write if it's NULL (pre-migration row).
  // FISH_AUDIO_PHASE_1 §6 — 3-arm union for the locked-session snapshot.
  let snapshotProvider: 'cartesia' | 'hume' | 'fish' = sessionProvider;
  if (isTakeover) {
    try {
      const { data: snap } = await admin
        .from('sessions')
        .select('tts_provider_at_session')
        .eq('id', sessionId)
        .maybeSingle<{ tts_provider_at_session: 'cartesia' | 'hume' | 'fish' | null }>();
      if (snap?.tts_provider_at_session) {
        snapshotProvider = snap.tts_provider_at_session;
      } else {
        // Pre-migration session with no snapshot — fix forward.
        await admin
          .from('sessions')
          .update({ tts_provider_at_session: sessionProvider })
          .eq('id', sessionId);
      }
    } catch (e) {
      // Audit M6 — on takeover snapshot read failure, surface 500 rather
      // than silently falling through to sessionProvider. The silent
      // fallback hits the same diverging-env hazard as C2 through a
      // different door; failing loud is the safer default.
      Sentry.captureException(e, {
        extra: { op: 'sessions_open_takeover_snapshot_read', session_id: sessionId },
      });
      return json(500, { error: 'tts_provider_snapshot_read_failed' });
    }
  } else {
    // Audit C1 (unit-wide) — fail loud on snapshot UPDATE failure. A
    // Sentry-only log left the cross-check at cogs_insert_turn_voice_v2
    // silently disabled (NULL snapshot → permissive). Better to 500 here
    // and force the user to retry than let the session continue without
    // its provider-mismatch backstop.
    try {
      const { error: snapErr } = await admin
        .from('sessions')
        .update({ tts_provider_at_session: sessionProvider })
        .eq('id', sessionId);
      if (snapErr) throw snapErr;
    } catch (e) {
      Sentry.captureException(e, {
        extra: { op: 'sessions_open_tts_provider_snapshot', session_id: sessionId, tts_provider: sessionProvider },
      });
      // Close the orphaned session row before returning so the user's
      // one-active slot frees for an immediate retry.
      try {
        await sb.rpc('session_close', {
          p_session_id: sessionId,
          p_end_reason: 'snapshot_write_failed',
        });
      } catch {}
      return json(500, { error: 'tts_provider_snapshot_write_failed' });
    }
  }

  // U-C1 / HUME_TTS_PLAN §6.2 (audit C2 fix) + FISH_AUDIO_PHASE_1 wiring
  // TS-widening audit M1 — pre-WS voice-trained gate runs against the
  // LOCKED snapshotProvider, not sessionProvider. On takeover, the
  // snapshot is the source of truth — the gate must check the column for
  // THAT provider, not the env-currently-derived one. Otherwise an env
  // flip between the original open and the takeover could green-light a
  // creator missing the locked provider's voice column and the proxy
  // would close 4009/4014 immediately at WS-open.
  //
  // Audit M1: useTts was computed from sessionProvider above, but the
  // snapshot is what the proxy will route on. Recompute against
  // snapshotProvider so a takeover whose snapshot is hume/fish always
  // engages the gate even if the current-env sessionProvider is
  // cartesia (post-flip env).
  const useTtsForGate = useTtsLayer || snapshotProvider === 'hume' || snapshotProvider === 'fish';
  //
  // Side-effect to handle: by the time this gate runs, `session_open` RPC
  // has already inserted a row (or takeover attached to an existing one).
  // A fresh-open 409 leaks that row — close it. A takeover 409 must NOT
  // close the row (it belongs to another tab).
  const envVoiceId = resolveVoiceId(creatorRow, undefined, snapshotProvider);
  if (useTtsForGate && !envVoiceId) {
    if (!isTakeover) {
      try {
        await sb.rpc('session_close', {
          p_session_id: sessionId,
          p_end_reason: 'creator_voice_not_trained',
        });
      } catch (closeErr) {
        Sentry.captureException(closeErr, {
          extra: { op: 'sessions_open_voice_gate_close', session_id: sessionId },
        });
      }
    }
    return json(409, {
      error: 'creator_voice_not_trained',
      tts_provider: snapshotProvider,
    });
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
    // Tavus deprecated (Spike B). Reusing simli_face_id keeps legacy env
    // values from 500ing, but the mint switch below has NO tavus arm — it
    // falls to failed_mint('tavus_scrapped'), so a stray 'tavus' env never
    // silently routes a session on a Simli id (diff audit S2).
    avatarProvider === 'tavus'  ? creatorRow.simli_face_id :
    null;
  if (avatarProvider !== null && !providerAvatarId) {
    return json(409, { error: 'creator_not_ready', avatar_provider: avatarProvider });
  }

  // Session length clamp. Provider-aware. dailyLimitRemaining is now the UNIFIED
  // effective_remaining (free allowance + durable wallet), so the session is
  // bounded by what the user can actually afford this session.
  //   simli/tavus: min(15min Gemini cap, effective_remaining).
  //   heygen:      min(LIVEAVATAR_MAX_SESSION_S env or 300s default, Gemini cap,
  //                    effective_remaining).
  // R2-C2: the old hardcoded 600s (10-min) ceiling is REMOVED — once minutes are
  // purchasable/earnable, capping every session at 10 min broke the whole payoff
  // (a 3600s wallet user got a 600s session). The kill-switch/Gemini-cap still
  // backstop runaway. (Audit-r2 C4 — kill-switch uses clamped seconds, not the
  // provider's max — and r2 S1 — heygen default 300.)
  const maxAvatarSeconds = avatarProvider === 'heygen'
    ? Math.max(60, Math.min(
        GEMINI_MAX_SESSION_S,
        dailyLimitRemaining,
        Number(process.env.LIVEAVATAR_MAX_SESSION_S ?? 300),
      ))
    : Math.max(60, Math.min(GEMINI_MAX_SESSION_S, dailyLimitRemaining));

  // ── Phase C — avatar mint ∥ brain-payload assembly (latency plan
  // 2026-06-10). The avatar mint (external API, the longest single leg) and
  // the brain assembly (DB reads + local substitution) share no data, so
  // they run concurrently. DELIBERATELY NOT in this Promise.all: the Gemini
  // ephemeral mint — it must stay BEHIND the FORCE_AVATAR_REQUIRED gate
  // below (plan audit C1: hoisting it would mint a live Google-side token
  // on the forced-avatar 503 path that nothing reaps). Each IIFE catches
  // internally and never rejects; both only mutate their own outer lets.
  // Order shift vs the old serial chain: brain assembly now runs (reads +
  // telemetry only, no paid calls) even when the FORCE gate or Gemini mint
  // later fails the request — acceptable speculative work.
  // Takeover note (plan audit C4 + diff audit M2): the fire-and-forget
  // HeyGen stop in the takeover branch races the HeyGen re-mint below
  // exactly as it did serially — Phase C starts at the same point in the
  // handler; only the Gemini/brain legs moved relative to it. On takeover
  // the avatar leg also overwrites sessions.avatar_provider and the
  // sessions_private HeyGen row that the OTHER tab is heart-beating.
  // ASSUMPTION this rides on: HeyGen stays dormant in prod (Simli-only —
  // both tabs resolve 'simli', making the clobber benign). Re-derive this
  // race before any HeyGen prod flip.

  // AvatarEnvelope hoisted to @/lib/avatar/avatar-envelope (final-audit S1).
  // Both IIFEs RETURN their results (not outer-let mutation) so TS
  // control-flow analysis sees the post-await values.
  const avatarMintPromise = (async (): Promise<{
    avatar: AvatarEnvelope | null;
    avatarStatus: 'minted' | 'failed_mint';
    avatarError: string | null;
  }> => {
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
        // 2026-06-09 — Simli's default maxIdleTime is 120s (2 min), which
        // tears down the LiveKit room mid-conversation when the user
        // listens to a long avatar answer and then thinks for a moment
        // before the next question (observed twice on prod with Fish +
        // 1.1x speed: avatar keeps talking briefly from WebRTC buffer,
        // UI flips to "reconnect"). Match maxSessionLength so the only
        // cap is the total session length, not arbitrary turn-silence.
        maxIdleTime: maxAvatarSeconds,
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
  return { avatar, avatarStatus, avatarError };
  })();

  const brainAssemblyPromise = (async (): Promise<{
    brainPrefix: Awaited<ReturnType<typeof buildBrainPrefix>>;
    resolvedSystemPrompt: string | null;
    userContext: string | null;
  }> => {
  let brainPrefix: Awaited<ReturnType<typeof buildBrainPrefix>> = null;
  let resolvedSystemPrompt: string | null = creatorRow.system_prompt;
  let userContext: string | null = null;
  // ── Brain prefix build (PR-2 + pgvector RAG) ────────────────────────
  // Drawer mode: pulls sample_content rows whose topic_tags overlap
  // hook.topic_tags and packages them as a single user-role `prefixTurns`
  // Content entry (existing behavior).
  // Vector mode: skips the prefix build entirely — per-turn retrieval
  // injection runs proxy-side via the audio gate. DB invariant
  // voice_tickets_brain_mode_prefix_chk enforces prefix_turns IS NULL when
  // brain_mode='vector' (defense-in-depth — this is the pre-DB gate).
  if (creatorRow.brain_mode === 'drawer') {
    try {
      brainPrefix = await buildBrainPrefix({
        supabaseAdmin: admin,
        creatorId,
        hookId,
      });
      // Diff audit M4 — capture calls inside this IIFE are AWAITED: the
      // shared Promise.all keeps the handler alive until they flush
      // (~5-20ms, parallel to the much longer avatar mint), where a
      // floating promise would race the Vercel response-close kill.
      if (brainPrefix) {
        await captureServerSafe(callerUserId, 'brain_prefix_built', {
          creator_id: creatorId,
          hook_id: hookId,
          source_count: brainPrefix.sourceCount,
          total_raw_chars: brainPrefix.totalRawChars,
          encoded_bytes: brainPrefix.encodedBytes,
          selected_topic_count: brainPrefix.selectedTopicSlugs.length,
        });
      } else {
        await captureServerSafe(callerUserId, 'brain_prefix_skipped', {
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
      await captureServerSafe(callerUserId, 'brain_prefix_skipped', {
        creator_id: creatorId,
        hook_id: hookId,
        reason: 'builder_error',
      });
      brainPrefix = null;
    }
  } else {
    // Vector mode — no prefix build. Per-turn retrieval runs proxy-side.
    await captureServerSafe(callerUserId, 'brain_mode_vector_session', {
      creator_id: creatorId,
      hook_id: hookId,
    });
    // Audit M2: chunk-count guard. A vector-mode creator with zero embedded
    // chunks looks UX-identical to a healthy session (persona-only fallback),
    // so the operator never learns the backfill was skipped. One Sentry
    // warning + one PostHog event makes the misconfiguration visible.
    try {
      const { count: chunkCount } = await admin
        .from('sample_content_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('creator_id', creatorId)
        .not('embedding', 'is', null);
      if ((chunkCount ?? 0) === 0) {
        Sentry.captureMessage('vector.no_chunks', {
          level: 'warning',
          extra: { creator_id: creatorId, hook_id: hookId },
        });
        await captureServerSafe(callerUserId, 'vector_mode_no_chunks', {
          creator_id: creatorId,
          hook_id: hookId,
        });
      }
    } catch (chunkCountErr) {
      // Non-fatal — count is observability, not correctness. Log only.
      Sentry.captureException(chunkCountErr, {
        extra: { op: 'sessions_open_chunk_count', creator_id: creatorId },
      });
    }
  }

  // ── profiles read: {{user_name}} + user-context inputs (Unit 1a) ─────
  // Persona compile (M10) emits a literal {{user_name}} placeholder.
  // Resolve using profiles.display_name (collected at signup); falls back
  // to 'friend' if null/empty. The substituted string lands on
  // voice_tickets.system_prompt; proxy passes it to Gemini Live verbatim.
  // Latency-plan audit M2 + MEMORY_BREADTH R1-M1 reconciled: the read is
  // gated on (placeholder present OR user-context flag on) — flag-off
  // sessions keep main's no-extra-roundtrip behavior, flag-on sessions get
  // goals/obstacles from the SAME read. Runs inside this Phase-C IIFE, in
  // parallel with the avatar mint → zero wall-time either way.
  const wantsUserName =
    !!resolvedSystemPrompt && resolvedSystemPrompt.includes('{{user_name}}');
  const wantsUserContext = process.env.BRAIN_USER_CONTEXT_ENABLED === '1';
  if (wantsUserName || wantsUserContext) {
    const { data: profileRow } = await admin
      .from('profiles')
      .select('display_name, goals, obstacles')
      .eq('id', callerUserId)
      .maybeSingle<{ display_name: string | null; goals: string[] | null; obstacles: string[] | null }>();
    if (wantsUserName && resolvedSystemPrompt) {
      const userName = (profileRow?.display_name ?? '').trim() || 'friend';
      resolvedSystemPrompt = resolvedSystemPrompt.replaceAll('{{user_name}}', userName);
    }

    // ── user_context build (Units 1a + 1b, both flag-gated) ────────────
    // BRAIN_USER_CONTEXT_ENABLED gates goals/obstacles injection;
    // BRAIN_USER_MEMORY_ENABLED gates the memory read + open loop (the
    // SAME env name is also read on the Fly side to gate extraction —
    // co-flip, audit R1-S1). All inputs are user-derived/untrusted:
    // buildUserContext sanitizes + octet-caps; the proxy folds the result
    // into the deep-answer QUESTION turn as a DATA block. It NEVER reaches
    // the Gemini Live systemInstruction (resumption-bound).
    if (wantsUserContext) {
      let memorySummary: string | null = null;
      let openLoop: string | null = null;
      let includeOpenLoop = false;
      if (process.env.BRAIN_USER_MEMORY_ENABLED === '1') {
        try {
          const { data: memRow } = await admin
            .from('user_creator_memory')
            .select('summary, open_loop')
            .eq('user_id', callerUserId)
            .eq('creator_id', creatorId)
            .maybeSingle<{ summary: string; open_loop: string | null }>();
          memorySummary = memRow?.summary ?? null;
          openLoop = memRow?.open_loop ?? null;
          // R1-S5 — the 20h check-in gate reads the SESSIONS table (robust
          // even when the last extraction died): only check in when the
          // user's last ENDED session with this creator is > 20h old.
          // Covered by sessions_user_creator_ended_idx (R2-M2, partial).
          if (openLoop) {
            const { data: lastSess } = await admin
              .from('sessions')
              .select('ended_at')
              .eq('user_id', callerUserId)
              .eq('creator_id', creatorId)
              .not('ended_at', 'is', null)
              .order('ended_at', { ascending: false })
              .limit(1)
              .maybeSingle<{ ended_at: string }>();
            const lastEnded = lastSess?.ended_at ? Date.parse(lastSess.ended_at) : NaN;
            includeOpenLoop = Number.isFinite(lastEnded)
              ? Date.now() - lastEnded > 20 * 3600 * 1000
              : false;
          }
        } catch (memErr) {
          // Memory is an enhancement, never a session-open blocker.
          Sentry.captureException(memErr, {
            extra: { op: 'sessions_open_memory_read', creator_id: creatorId },
          });
        }
      }
      userContext = buildUserContext({
        goals: profileRow?.goals ?? null,
        obstacles: profileRow?.obstacles ?? null,
        memorySummary,
        openLoop,
        includeOpenLoop,
      });
    }
  }
  return { brainPrefix, resolvedSystemPrompt, userContext };
  })();

  const [
    { avatar, avatarStatus, avatarError },
    { brainPrefix, resolvedSystemPrompt, userContext },
  ] = await Promise.all([avatarMintPromise, brainAssemblyPromise]);

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

  // ── Mint Gemini ephemeral ──────────────────────────────────────────────
  // Kept SERIAL, strictly behind the FORCE_AVATAR_REQUIRED gate above (plan
  // audit C1) — parallelizing it with the avatar mint would mint a live
  // Google-side token on the forced-avatar 503 path that nothing reaps.
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

  // ── Mint voice ticket (proxy WS auth — fatal on failure) ─────────────
  // ORDERING INVARIANT (Audit M4, restated at the phase boundary per the
  // latency-plan audit): this mint MUST stay strictly AFTER the awaited
  // tts_provider_at_session snapshot UPDATE in Phase B — the ticket is the
  // WS's auth, and minting it before the snapshot lands reopens the
  // NULL-snapshot double-bill window in cogs_insert_turn_voice_v2/v3. Do
  // not fold this into a parallel phase.
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
      //   * prefixTurns: encodedBytes < 60KB enforced by buildBrainPrefix
      //     before return
      // The DB CHECKs on voice_tickets are defense-in-depth.
      systemPrompt: resolvedSystemPrompt,
      // MEMORY_BREADTH_PLAN U1a — sanitized + octet-capped by
      // buildUserContext (the route owns the cap, R1-S2); DB CHECK is
      // defense-in-depth. NULL when flags off or nothing to say.
      userContext,
      prefixTurns:  brainPrefix?.prefixTurns ?? null,
      brainMode:    creatorRow.brain_mode,
      // DECOUPLED_BRAIN_PLAN P1-10. Forward the creator's decoupled
      // flag → ticket → bridge. The DB CHECK
      // voice_tickets_decoupled_requires_vector_chk rejects
      // decoupled=true with brain_mode != 'vector'; the admin RPC
      // admin_set_creator_decoupled auto-aligns the two AND
      // admin_set_creator_brain_mode (20260523000002 hardening) now
      // refuses to drawer-flip a decoupled=true creator. So if both
      // RPCs are the only path that mutates these columns, the pair
      // stays in sync. Defense-in-depth retained: if a future code
      // path desyncs them (a direct UPDATE, a buggy new RPC), the
      // ticket INSERT fires 23514 and the mint fails loudly rather
      // than silently mismatching.
      decoupled:    creatorRow.decoupled ?? false,
      // Creator voice-speed (migration 20260511000006). supabase-js
      // returns `numeric` as JS string; coerce at the boundary (R2 audit
      // C3). DB DEFAULT 1.0 guarantees a value, but defensive on
      // non-finite to avoid sending bad data through to Cartesia.
      ttsSpeed: coerceNumericOrNull(creatorRow.tts_speed),
      // HUME_TTS_PLAN §6.3 — pass the session's snapshot provider (takeover
      // honors the original session's lock; fresh open uses the computed
      // sessionProvider) + env-scoped Hume prosody. Hume params are null on
      // cartesia tickets; the bridge skips them.
      ttsProvider: snapshotProvider,
      humeTtsSpeed: snapshotProvider === 'hume'
        ? coerceNumericOrNull(pickEnvScoped(creatorRow, 'hume_tts_speed'))
        : null,
      humeTrailingSilence: snapshotProvider === 'hume'
        ? coerceNumericOrNull(pickEnvScoped(creatorRow, 'hume_trailing_silence'))
        : null,
      humeVoiceDescription: snapshotProvider === 'hume'
        ? (pickEnvScoped(creatorRow, 'hume_voice_description') as string | null)
        : null,
      humeModelVersion: snapshotProvider === 'hume'
        // Audit M3 (unit-wide) — default to '2' (Octave 2) when the env-
        // scoped column is unset. Migration 0002 declares DEFAULT '2' but
        // a creator inserted before that default landed could hold NULL.
        ? ((pickEnvScoped(creatorRow, 'hume_model_version') as string | null) || '2')
        : null,
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
