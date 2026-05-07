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
export type OpenEnvelope = {
  session_id: string;
  tier: 'free' | 'premium' | 'boardroom';
  avatar_provider: AvatarProvider | null;
  avatar: AvatarEnvelope | null;
  avatar_status: AvatarStatus;
  gemini: { token: string; model: string };
  voice_ticket: { ticket: string; expiresAt: string } | null;
  proxy_url: string | null;
  max_duration_s: number;
  max_session_s: number;
  is_takeover?: boolean;
};
