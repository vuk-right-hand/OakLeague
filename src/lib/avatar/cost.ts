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
// HeyGen rate sourced 2026-05-06 from docs.liveavatar.com/docs/faq/credits
// + verified Phase 0 §14: 1 credit/min Lite, $100/1000 credits = $0.10/min.
export const HEYGEN_QUOTED_AT = '2026-05-06' as const;

// Best-estimate rates. Sources (verified at QUOTED_AT / HEYGEN_QUOTED_AT):
//   Simli:  $0.01/min on Hobby Plan ($10 / 1000 min). Empirically confirmed
//           2026-05-27 by cross-ref of cogs_log bridge_close rows vs Simli
//           console session-duration table — match within 1-3% (clock drift).
//           Estimate set to $0.011 = real rate + 10% buffer for clock-skew,
//           plan-downgrade safety, and small silent price changes. CEILING
//           stays at $0.05 (env-overridable) — different concern, different
//           knob: that one is the buggy-adapter tripwire, not the bill.
//   Tavus:  $0.32–$0.37/min Phoenix-4 echo mode on Starter tier.
//   HeyGen: $0.10/min Lite mode (1 credit/min on the credit-pack tier).
export const BEST_ESTIMATE_USD_PER_MIN: Record<AvatarProvider, number> = {
  simli: 0.011,
  tavus: 0.35,
  heygen: 0.10,
};

// Ceiling rates. Env-overridable; defaults match SPIKE_B_PLAN.md §Kill-switch
// for simli/tavus; PHASE_0_HEYGEN.md §14 + audit-round-2-C4 for heygen.
// Kept as functions (not top-level constants) so Next.js server routes pick up
// env changes on hot-reload without restart — important when tightening caps
// mid-spike.
//
// Audit round 2 / C4: heygen sessions can run up to 1200s (20 min) per
// Phase 0 §2. Callers MUST pass an explicit `maxRunSeconds` clamp into
// estimatedRunCostUsd — the 60s default below is the legacy spike-b
// short-clip default and is wrong for heygen production sessions by ~20×.
export function ceilingUsdPerMin(provider: AvatarProvider): number {
  if (provider === 'tavus') {
    return Number(process.env.TAVUS_CEILING_USD_PER_MIN ?? 0.5);
  }
  if (provider === 'heygen') {
    // Default 0.20 = 2× published $0.10/min, mirroring the 2× headroom
    // posture for Simli/Tavus. Matches the cap in
    // cogs_insert_avatar_turn (migration 20260509000003).
    return Number(process.env.HEYGEN_CEILING_USD_PER_MIN ?? 0.20);
  }
  return Number(process.env.SIMLI_CEILING_USD_PER_MIN ?? 0.05);
}

// Pre-run estimate used by /api/spike-b/session and /api/sessions/open
// kill-switches. We multiply by the ceiling (not best estimate) so the
// gate fails CLOSED.
//
// Audit round 2 / C4: callers should pass the actual max-allowed session
// seconds for the provider+tier. simli short-clip spikes pass 60s;
// heygen production sessions pass max_session_duration from the response
// (typically 300–1200s). The 60s default exists for the spike-b harness
// but is unsafe for production paths.
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
