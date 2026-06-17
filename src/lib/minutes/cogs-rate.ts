// Growth & Minutes Economy — Phase 7 blended COGS rate (plan §9 / R3-#5).
//
// The all-in cost of a minute of avatar talk is MONEY, so it is a PINNED env
// (MINUTES_BLENDED_COGS_USD_PER_MIN + _QUOTED_AT), following the *_QUOTED_AT
// convention used everywhere else COGS is priced (CLAUDE.md). The reconcile
// viewer + script read it to turn granted/consumed SECONDS into an implied $.
//
// Seeded from the verified ~$0.028/avatar-talk-min all-in (2026-06-16):
//   Fish TTS $0.013 + Simli Trinity-1 ~$0.010 + decoupled brain ~$0.005
//   (Gemini audio-out neutered to ~$0 via maxOutputTokens=24).
//
// The constant below is the SEED/FALLBACK only. Prod pins the env so updating
// the rate is a config flip with an audit trail. When the env is unset we fall
// back to the seed but report `configured: false` so the viewer shows the rate
// is not pinned (never a silent hardcoded literal driving a money figure).

// NOTE (audit M1): scripts/minutes-reconcile.mjs hardcodes this same 0.028
// literal (a plain .mjs can't import this .ts module). If you change the seed
// here, change it there too — a cron alerting on a stale seed is a silent
// wrong-number generator.
export const DEFAULT_BLENDED_COGS_USD_PER_MIN = 0.028;
export const DEFAULT_BLENDED_COGS_QUOTED_AT = '2026-06-16';

export interface BlendedCogsRate {
  usdPerMin: number;
  quotedAt: string | null;
  /** true ⇒ the value came from the pinned env; false ⇒ the seed fallback. */
  configured: boolean;
}

export function blendedCogsRate(): BlendedCogsRate {
  const raw = process.env.MINUTES_BLENDED_COGS_USD_PER_MIN;
  const quotedAt = process.env.MINUTES_BLENDED_COGS_QUOTED_AT?.trim() || null;
  const parsed = raw == null ? NaN : Number(raw);

  // Must be finite and strictly positive — a zero/negative/NaN rate would make
  // every implied-COGS figure meaningless, so we ignore it and use the seed.
  if (Number.isFinite(parsed) && parsed > 0) {
    return { usdPerMin: parsed, quotedAt, configured: true };
  }
  return {
    usdPerMin: DEFAULT_BLENDED_COGS_USD_PER_MIN,
    quotedAt: DEFAULT_BLENDED_COGS_QUOTED_AT,
    configured: false,
  };
}

/** seconds → implied USD at the given $/min rate. Non-finite/negative ⇒ 0. */
export function impliedUsd(seconds: number, usdPerMin: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  if (!Number.isFinite(usdPerMin) || usdPerMin <= 0) return 0;
  return (seconds / 60) * usdPerMin;
}

/** Round a USD figure to whole cents for display (banker-free, half-up). */
export function roundUsd(usd: number): number {
  if (!Number.isFinite(usd)) return 0;
  return Math.round(usd * 100) / 100;
}
