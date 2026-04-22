// Per-provider avatar rates + kill-switch ceilings. The numbers below are
// pinned to QUOTED_AT so a future reader (or auditor) can see when they were
// sourced and how stale they are.
//
// TWO rate concepts, kept separate:
//   1. BEST_ESTIMATE_USD_PER_MIN — what we expect to actually pay, used for
//      informational cost readouts in the spike UI.
//   2. CEILING_USD_PER_MIN — worst-case bound, used by the kill-switch
//      pre-run gate and by the post-run clamp in /api/spike-b/record.
//      Defaults overridable via env so ops can tighten them without a deploy.
//
// SPIKE_B_PLAN.md Rev 5 §Economics + §Kill-switch.

import type { AvatarProvider } from './avatar-bridge';

export const QUOTED_AT = '2026-04-21' as const;

// Best-estimate rates. Sources (all verified 2026-04-21):
//   Simli: public pay-as-you-go is ~$0.01/min; conservative $0.015 until
//          written quote from support@simli.com lands (email drafted in
//          docs/_planning/SIMLI_SUPPORT_EMAIL.md).
//   Tavus: $0.32–$0.37/min for Phoenix-4 echo mode on Starter tier.
export const BEST_ESTIMATE_USD_PER_MIN: Record<AvatarProvider, number> = {
  simli: 0.015,
  tavus: 0.35,
};

// Ceiling rates. Env-overridable; defaults match SPIKE_B_PLAN.md §Kill-switch.
// Kept as functions (not top-level constants) so Next.js server routes pick up
// env changes on hot-reload without restart — important when tightening caps
// mid-spike.
export function ceilingUsdPerMin(provider: AvatarProvider): number {
  if (provider === 'tavus') {
    return Number(process.env.TAVUS_CEILING_USD_PER_MIN ?? 0.5);
  }
  return Number(process.env.SIMLI_CEILING_USD_PER_MIN ?? 0.05);
}

// Pre-run estimate used by /api/spike-b/session kill-switch. The plan pins
// MAX_RUN_SECS=60 (longest planned clip + buffer). We multiply by the ceiling,
// not the best estimate, so the gate fails CLOSED.
export function estimatedRunCostUsd(provider: AvatarProvider, maxRunSeconds = 60): number {
  return (maxRunSeconds / 60) * ceilingUsdPerMin(provider);
}

// Post-run clamp used by /api/spike-b/record. The reported cost from the
// bridge is best-estimate; we clamp DOWN to the ceiling × actual duration so
// a runaway provider cannot blow past the hard cap by mis-reporting.
export function clampReportedCostUsd(
  provider: AvatarProvider,
  reportedUsd: number,
  durationSeconds: number,
): number {
  const ceiling = (durationSeconds / 60) * ceilingUsdPerMin(provider);
  const safe = Math.max(0, Math.min(reportedUsd, ceiling));
  return Number(safe.toFixed(6));
}
