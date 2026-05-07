// Avatar envelope — the wire shape returned by /api/sessions/open and
// /api/sessions/rollover, consumed by use-session-pipe and the bridge
// factory.
//
// Provider-discriminated. Single source of truth — duplicating this
// type across server routes + client hook (final-audit S1) drifts the
// moment a server-side rename happens; a stale client variant compiles
// green but the bridge fails at runtime with `undefined` boot data.

import type { AvatarProvider } from './avatar-bridge';

// HeyGen-only boot envelope. The `livekitClientToken` here is PRIVILEGED
// (canPublish:true) — see avatar-bridge.ts heygenSessionBoot comment for
// the trust model. Same-origin HTTPS only; never persisted.
export type HeygenSessionBoot = {
  wsUrl: string;
  livekitUrl: string;
  livekitClientToken: string;
  livekitRoom: string;
  livekitIdentity: string;
  maxSessionDurationSeconds: number;
};

// Discriminated union — `provider` field selects the variant. Simli and
// Tavus carry the legacy compose-token shape; HeyGen carries the boot
// envelope the bridge consumes via opts.heygenSessionBoot.
export type AvatarEnvelope =
  | {
      provider: 'simli' | 'tavus';
      session_token: string;
      expires_at: string;
      face_id: string;
    }
  | {
      provider: 'heygen';
      expires_at: string;
      face_id: string;
      heygen_session_id: string;
      heygen_session_boot: HeygenSessionBoot;
    };

// Avatar status — mirrors the column on `public.sessions`. 'minted' =
// avatar provider responded successfully; the bridge can attempt open().
export type AvatarStatus =
  | 'pending'
  | 'minted'
  | 'skipped_tier'
  | 'failed_mint'
  | 'failed_connect'
  | 'not_applicable';

// The full /api/sessions/open + /rollover response shape.
//
// use-session-pipe rewire (PR-2): legacy direct-Gemini path is gone, so
// `gemini.token` is no longer in the envelope (the proxy holds the Gemini
// API key server-side and the voice_ticket auths the WS). Only the model
// wire-form is needed client-side, which is renamed `voice.model`.
//
// `voice_ticket` and `proxy_url` are required — the proxy WS is the ONLY
// path. /api/sessions/open closes the session row on ticket-mint failure
// and returns an error status; the success envelope therefore always has
// both. /rollover does the same, with a 503 retry contract that includes
// the new session_id so the client can clean up on second-failure.
export type OpenEnvelope = {
  session_id: string;
  tier: 'free' | 'premium' | 'boardroom';
  avatar_provider: AvatarProvider | null;
  avatar: AvatarEnvelope | null;
  avatar_status: AvatarStatus;
  voice: { model: string };
  voice_ticket: { ticket: string; expiresAt: string };
  proxy_url: string;
  max_duration_s: number;
  max_session_s: number;
  is_takeover?: boolean;
};

// Stale-envelope shape guard. Catches envelopes written by an old client
// build still running in a pre-deploy tab — old shape has `gemini.token`
// but no `voice.model`. Wired into session-client.tsx readEnvelope so a
// stale envelope surfaces the existing "Session expired" screen instead
// of crashing the hook with `args.envelope.voice.model` reads.
const VALID_TIERS = new Set(['free', 'premium', 'boardroom']);
const VALID_AVATAR_STATUSES = new Set([
  'pending', 'minted', 'skipped_tier', 'failed_mint', 'failed_connect', 'not_applicable',
]);
export function isValidEnvelope(env: unknown): env is OpenEnvelope {
  if (!env || typeof env !== 'object') return false;
  const e = env as Record<string, unknown>;
  if (typeof e.session_id !== 'string') return false;
  if (typeof e.tier !== 'string' || !VALID_TIERS.has(e.tier)) return false;
  if (typeof e.avatar_status !== 'string' || !VALID_AVATAR_STATUSES.has(e.avatar_status)) return false;
  const voice = e.voice as { model?: unknown } | undefined;
  if (!voice || typeof voice.model !== 'string') return false;
  const ticket = e.voice_ticket as { ticket?: unknown; expiresAt?: unknown } | undefined;
  if (!ticket || typeof ticket.ticket !== 'string' || typeof ticket.expiresAt !== 'string') return false;
  if (typeof e.proxy_url !== 'string') return false;
  return true;
}
