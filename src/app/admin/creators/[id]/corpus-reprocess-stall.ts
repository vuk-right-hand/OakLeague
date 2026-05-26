// Corpus reprocess worker stall detection (FIVE_CREATOR_ONBOARDING_READINESS
// P0-2). Surfaces GAP-3: the in-proxy corpus_reprocess worker is env-gated
// (GEMINI_API_KEY + INTERNAL_API_BASE_URL + INTERNAL_API_SECRET≥32 — see
// server/voice-proxy/index.js). If those aren't set on the deployed proxy, the
// admin's "Re-process v2" enqueues jobs that sit `pending` forever with no
// error — an indefinite spinner. This pure helper lets the panel show a
// "worker may be offline" warning instead.
//
// Signal: pending jobs exist, NOTHING is processing (a live worker claims a
// job within a poll cycle → status flips to 'processing'), and that state has
// persisted past the threshold. We key off "how long pending-with-no-processing
// has persisted" rather than row timestamps because force-reprocess resets
// status without resetting created_at, which would false-alarm.

export const STALL_THRESHOLD_SECONDS = 30;

export function isWorkerLikelyStalled(
  counts: { pending: number; processing: number },
  secondsPendingWithoutProcessing: number,
  thresholdSeconds: number = STALL_THRESHOLD_SECONDS,
): boolean {
  if (counts.pending <= 0) return false;        // nothing waiting → not stalled
  if (counts.processing > 0) return false;       // a worker is actively claiming
  return secondsPendingWithoutProcessing >= thresholdSeconds;
}
