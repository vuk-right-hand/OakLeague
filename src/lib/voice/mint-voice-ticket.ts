// SIMLI_WIREUP §2 / R3-C2 / R4-C2 — server-only voice-ticket mint for the
// /s/[id] cutover path. Called by /api/sessions/open and
// /api/sessions/rollover, never by the client.
//
// Differs from /api/voice/spike-a/ticket in two ways:
//   1. Bound to a pre-opened session_id (cutover discriminator).
//   2. NOT admin-gated — caller has already run getCallerUserId().
//
// Bumped TTL = 120s (R4-S). Slow-LTE mint+WS-open round-trips can
// approach 60s on a cold mobile network; 120s leaves buffer without
// becoming a hoarding window.
//
// Defense-in-depth on session ownership: this lib trusts `userId` and
// `sessionId` arguments. The voice_tickets_session_user_match trigger
// (migration 20260507000001) re-checks at INSERT time and raises
// 23503/check_violation if the (userId, sessionId) pair is invalid.

import 'server-only';
import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AvatarProvider } from '@/lib/avatar/avatar-bridge';
import type { PrefixTurn } from '@/lib/voice/brain-prefix';
import { currentVoiceIdEnv } from '@/lib/voice/env-scoped-voice-id';

export class VoiceTicketMintError extends Error {
  readonly code:
    | 'bad_ua'
    | 'bad_avatar_provider'
    | 'bad_tts_provider'
    | 'hume_prosody_missing'
    | 'creator_not_found'
    | 'session_not_owned'
    | 'ticket_mint_failed'
    | 'too_many_tickets';
  readonly httpStatus: number;
  constructor(code: VoiceTicketMintError['code'], httpStatus: number, msg?: string) {
    super(msg ?? code);
    this.name = 'VoiceTicketMintError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export type MintVoiceTicketArgs = {
  userId: string;
  sessionId: string;
  creatorId: string;
  hookId: string | null;
  expectedTier: 'free' | 'premium' | 'boardroom';
  // Audit round 2 / C1 — load-bearing field for the voice-proxy's
  // Cartesia per-session sample-rate selection. Simli/Tavus → 16kHz;
  // HeyGen → 24kHz. NULL is rejected at the boundary because the
  // voice_tickets_avatar_provider_purpose_match CHECK enforces NOT NULL
  // for purpose='voice_session' (this mint helper only mints
  // voice_session — voice_clone has its own mint path).
  avatarProvider: AvatarProvider;
  ua: string;
  // Brain wire-up (PR-2). Both optional; null/undefined when:
  //   * Persona missing on creator (creator pre-compile)
  //   * Hook has no overlapping sample_content
  //   * Builder errored (Sentry breadcrumb upstream)
  // Pre-DB length+size guards live in the route — by contract these
  // are within bounds (≤2000 octets / encodedBytes < 60KB) when set,
  // so the DB CHECKs are defense-in-depth and won't fire.
  systemPrompt?: string | null;
  prefixTurns?: PrefixTurn[] | null;
  // Creator voice-speed knob (migration 20260511000006). Cartesia
  // Sonic 3 generation_config.speed multiplier in [0.6, 1.5]. NULL
  // means "use Cartesia default" — passes through to the proxy and
  // ultimately the CartesiaTTSBridge, which omits the field when
  // NULL or 1.0. DB CHECK gate on voice_tickets ensures we never
  // insert out-of-range values; this typing is the route-side
  // contract.
  ttsSpeed?: number | null;
  // HUME_TTS_PLAN §6.3 — session's resolved TTS provider. Computed by the
  // caller (route) as `creator.tts_provider ?? proxyCfg.ttsProvider`. Defaults
  // to 'cartesia' for back-compat when the caller is a path that has not been
  // updated yet (spike-a admin ticket). DB column is NOT NULL DEFAULT 'cartesia'
  // (migration 0002) — explicit value here is the writer-discipline contract
  // (CI grep enforced by scripts/check-tts-provider-writes.sh).
  ttsProvider?: 'cartesia' | 'hume';
  // HUME_TTS_PLAN §6.3 — Hume prosody dials snapshotted from creator at mint
  // time, persisted on the ticket so the proxy's consumeTicket() is the only
  // DB read per session. All four required when ttsProvider='hume' (route is
  // responsible for the env-scoped resolution before calling here); ignored
  // when ttsProvider='cartesia'. Mint hard-rejects ttsProvider='hume' with
  // any of these NULL (HUME_TTS_PLAN unit-wide audit M-defensive).
  humeTtsSpeed?: number | null;
  humeTrailingSilence?: number | null;
  humeVoiceDescription?: string | null;
  humeModelVersion?: string | null;
  // pgvector RAG plan (M6). Snapshot of creators.brain_mode at session-open.
  // 'drawer' = legacy. 'vector' = per-turn pgvector retrieval injection.
  // DB invariant voice_tickets_brain_mode_prefix_chk requires
  //   (brain_mode='vector' → prefix_turns IS NULL) ∧ (brain_mode='drawer' → any)
  // Caller responsibility: route gates buildBrainPrefix on 'drawer'.
  brainMode?: 'drawer' | 'vector' | null;
  // DECOUPLED_BRAIN_PLAN P1-2. Snapshot of creators.decoupled at
  // session-open. false = legacy (drawer/vector mid-session injection);
  // true = off-Live paraphrase→RAG generateContent→Hume. D7 fail-safe:
  // undefined/null → false. DB invariant
  // voice_tickets_decoupled_requires_vector_chk requires
  //   decoupled=true → brain_mode='vector'. Caller must pass brainMode
  //   'vector' whenever decoupled true (route responsibility).
  decoupled?: boolean | null;
};

export type MintVoiceTicketResult = {
  ticket: string;
  expiresAt: string; // ISO
};

const TTL_SECONDS = 120;

export async function mintVoiceTicket(args: MintVoiceTicketArgs): Promise<MintVoiceTicketResult> {
  if (!args.ua || args.ua.length < 1 || args.ua.length > 2048) {
    throw new VoiceTicketMintError('bad_ua', 400);
  }
  // AvatarProvider type guard. Belt-and-suspenders: TS already constrains
  // the arg, but a misuse from JS via npm/Babel transpilation could slip
  // a bad value past — the DB CHECK would catch it (CHECK on enum), but
  // surfacing 400 here is cleaner than a 500 from a deferred PG error.
  if (args.avatarProvider !== 'simli' && args.avatarProvider !== 'tavus' && args.avatarProvider !== 'heygen') {
    throw new VoiceTicketMintError('bad_avatar_provider', 400);
  }
  // HUME_TTS_PLAN §6.3 — validate TTS provider + paired hume prosody.
  // Provider defaults to 'cartesia' (back-compat); 'hume' requires the four
  // prosody fields to be non-null so the bridge constructor never sees a
  // half-resolved ticket. The DB CHECK on voice_tickets is the last line of
  // defense; this is the first.
  const ttsProvider = args.ttsProvider ?? 'cartesia';
  if (ttsProvider !== 'cartesia' && ttsProvider !== 'hume') {
    throw new VoiceTicketMintError('bad_tts_provider', 400);
  }
  if (ttsProvider === 'hume') {
    // Audit M3 (unit-wide, 2026-05-13) — only model_version is required;
    // speed and trailing_silence are optional dials. NULL on either =
    // "use Hume default" (1.0 / 0.3 respectively), same contract as
    // Cartesia's tts_speed (null/1.0 → omit). Mint will pass NULL through;
    // bridge's shouldSendSpeed / shouldSendTrailingSilence already gates
    // emission on the wire. modelVersion DOES need a value because the
    // bridge constructor validates the URL query param.
    const modelOk = typeof args.humeModelVersion === 'string' && args.humeModelVersion.length > 0;
    if (!modelOk) {
      throw new VoiceTicketMintError(
        'hume_prosody_missing',
        500,
        `hume requires model_version (got model=${args.humeModelVersion})`,
      );
    }
  }
  const uaHash = createHash('sha256').update(args.ua).digest('hex');

  const admin = supabaseAdmin();

  // Rate-limit: 5 live tickets per user. Same threshold as the admin route
  // (spike-a/ticket). A normal flow has 1 outstanding.
  const { count: liveCount, error: countErr } = await admin
    .from('voice_tickets')
    .select('ticket_id', { count: 'exact', head: true })
    .eq('user_id', args.userId)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString());
  if (countErr) {
    throw new VoiceTicketMintError('ticket_mint_failed', 500, countErr.message);
  }
  if ((liveCount ?? 0) >= 5) {
    throw new VoiceTicketMintError('too_many_tickets', 429);
  }

  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000).toISOString();

  const { data, error } = await admin
    .from('voice_tickets')
    .insert({
      user_id:         args.userId,
      bound_ua_hash:   uaHash,
      creator_id:      args.creatorId,
      session_id:      args.sessionId,
      hook_id:         args.hookId,
      expected_tier:   args.expectedTier,
      avatar_provider: args.avatarProvider,
      // HUME_TTS_PLAN §6.3 (2026-05-13): tts_provider resolved by the caller
      // (route) as `creator.tts_provider ?? proxyCfg.ttsProvider`. CI grep
      // (scripts/check-tts-provider-writes.sh) enforces every voice_tickets
      // insert carries tts_provider literally — keep the key visible here.
      tts_provider:    ttsProvider,
      // HUME_TTS_PLAN §6.3 — paired Hume prosody. NULL on cartesia tickets
      // (CHECK constraints on migration 0005 are permissive — NULL allowed
      // — so cartesia stays clean).
      hume_tts_speed:         ttsProvider === 'hume' ? args.humeTtsSpeed         ?? null : null,
      hume_trailing_silence:  ttsProvider === 'hume' ? args.humeTrailingSilence  ?? null : null,
      hume_voice_description: ttsProvider === 'hume' ? args.humeVoiceDescription ?? null : null,
      hume_model_version:     ttsProvider === 'hume' ? args.humeModelVersion     ?? null : null,
      // HUME_TTS_PLAN §6 audit M1 — pin VERCEL_ENV onto the ticket so the
      // proxy reads which env-scoped voice column to use (cartesia voice_id*
      // OR hume_voice_id*). Proxy no longer depends on a separate Fly
      // VOICE_ID_ENV secret; ticket-as-contract pattern (Vuk-M5 precedent).
      voice_id_env:    currentVoiceIdEnv(),
      // pipeline_kind defaults to 'native_audio' per migration 0045 — the
      // α' wire format is native_audio + Cartesia layered server-side.
      // purpose defaults to 'voice_session'.
      expires_at:      expiresAt,
      // Brain wire-up (PR-2). Per-session payload riding the ticket so
      // the proxy gets system_prompt + single-user-turn prefix_turns in
      // the same atomic consume — no extra Supabase read inside the WS
      // open hot path. NULL when missing; the proxy will pass undefined to the
      // Gemini bridge and falls back to DEFAULT_SYSTEM (degraded mode;
      // route emits brain_not_ready 409 before reaching mint when the
      // creator is unready, so this NULL path is rare).
      system_prompt:   args.systemPrompt ?? null,
      prefix_turns:    args.prefixTurns  ?? null,
      // Creator voice-speed (migration 20260511000006). DB CHECK is
      // [0.6, 1.5]; route already pulls from creators.tts_speed which
      // is bounded by the same range. Defensive boundary: drop to NULL
      // if a non-finite value somehow slipped through (proxy treats
      // NULL as "use Cartesia default" via shouldSendSpeed()).
      tts_speed:       typeof args.ttsSpeed === 'number' && Number.isFinite(args.ttsSpeed)
                          ? args.ttsSpeed
                          : null,
      // pgvector RAG plan (M6). 'vector' mode triggers proxy-side per-turn
      // retrieval injection. Default 'drawer' = legacy path. DB invariant
      // ensures prefix_turns is null when brain_mode='vector'.
      brain_mode:      args.brainMode ?? 'drawer',
      // DECOUPLED_BRAIN_PLAN P1-2. D7 fail-safe: undefined/null → false
      // (legacy). DB CHECK voice_tickets_decoupled_requires_vector_chk
      // rejects decoupled=true unless brain_mode='vector'.
      decoupled:       args.decoupled ?? false,
    })
    .select('ticket_id, expires_at')
    .single<{ ticket_id: string; expires_at: string }>();

  if (error || !data) {
    // SQLSTATE map (post-PR-2):
    //   23503 = FK miss (session_id → sessions)
    //   23514 = check_violation. Three sources:
    //     * voice_tickets_session_user_match trigger (legacy session_id mismatch)
    //     * voice_tickets_system_prompt_len_chk (pre-DB-guarded; should never fire)
    //     * voice_tickets_prefix_turns_size_chk (pre-DB-guarded; should never fire)
    //   The CHECK constraints can ONLY trip if the route's pre-DB size
    //   guards drift out of sync with the DB constraints — at which point
    //   "session_not_owned" is misleading but tolerable, since the right
    //   answer (drop the prefix and retry) is the same correctness fix.
    //   When that drift surfaces, see brain-prefix.ts ENCODED_BYTE_CAP and
    //   creators_system_prompt_len_chk in migration 20260511000001 to
    //   re-align.
    const code = (error as { code?: string } | null)?.code;
    if (code === '23503' || code === '23514') {
      throw new VoiceTicketMintError('session_not_owned', 403, error?.message);
    }
    throw new VoiceTicketMintError('ticket_mint_failed', 500, error?.message);
  }

  return { ticket: data.ticket_id, expiresAt: data.expires_at };
}
