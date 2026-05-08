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

export class VoiceTicketMintError extends Error {
  readonly code:
    | 'bad_ua'
    | 'bad_avatar_provider'
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
  // are within bounds (≤2000 octets / encodedBytes < 90KB) when set,
  // so the DB CHECKs are defense-in-depth and won't fire.
  systemPrompt?: string | null;
  prefixTurns?: PrefixTurn[] | null;
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
      // pipeline_kind defaults to 'native_audio' per migration 0045 — the
      // α' wire format is native_audio + Cartesia layered server-side.
      // purpose defaults to 'voice_session'.
      expires_at:      expiresAt,
      // Brain wire-up (PR-2). Per-session payload riding the ticket so
      // the proxy gets system_prompt + paired prefix_turns in the same
      // atomic consume — no extra Supabase read inside the WS open hot
      // path. NULL when missing; the proxy will pass undefined to the
      // Gemini bridge and falls back to DEFAULT_SYSTEM (degraded mode;
      // route emits brain_not_ready 409 before reaching mint when the
      // creator is unready, so this NULL path is rare).
      system_prompt:   args.systemPrompt ?? null,
      prefix_turns:    args.prefixTurns  ?? null,
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
