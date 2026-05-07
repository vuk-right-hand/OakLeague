// Tier router — deterministic, session-open only. See SPIKE_B_PLAN.md Rev 5:
//
// Reads from the PROFILE tier (or sessions.tier_at_session snapshot in Day-5
// production). Returns the provider env var for that tier. Never reads mid-
// session; never swaps on error; never escalates a free user onto premium.
//
// On primary failure, the AvatarBridge emits a taxonomy error code and
// closes the session — the caller MUST show a visible error, not silently
// re-resolve. Silent cross-tier swap = unconsented cost event
// (free user at $0.01/min suddenly on $0.37/min Tavus).
//
// Rev 5 retires the Rev 4 primary→secondary runtime-swap concept. See
// Decisions-locked item 12 in the plan.

import 'server-only';
import type { AvatarProvider } from './avatar-bridge';

export type UserTier = 'free' | 'premium' | 'boardroom';

const ALLOWED: ReadonlySet<AvatarProvider> = new Set(['simli', 'tavus', 'heygen']);

function coerceProvider(envValue: string | undefined, tier: UserTier): AvatarProvider | null {
  if (!envValue) return null;
  const v = envValue.toLowerCase().trim();
  if (v === 'none' || v === 'off' || v === '') return null;
  if (!ALLOWED.has(v as AvatarProvider)) {
    // Loud in dev so a typo in AVATAR_PROVIDER_FREE=simlii surfaces at boot,
    // not at first free session. In prod, fall through to null (avatar off)
    // rather than crash the request — voice-only is a legitimate v1.1 state.
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(
        `resolveAvatarProvider: invalid provider "${envValue}" for tier "${tier}". ` +
          `Expected one of: simli, tavus, heygen, none.`,
      );
    }
    return null;
  }
  return v as AvatarProvider;
}

export function resolveAvatarProvider(tier: UserTier): AvatarProvider | null {
  switch (tier) {
    case 'free':
      return coerceProvider(process.env.AVATAR_PROVIDER_FREE, tier);
    case 'premium':
      return coerceProvider(process.env.AVATAR_PROVIDER_PREMIUM, tier);
    case 'boardroom':
      return coerceProvider(process.env.AVATAR_PROVIDER_BOARDROOM, tier);
    default:
      return null;
  }
}
