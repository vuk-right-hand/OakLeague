// Pure helpers for the long-form quartile tracker. Extracted from
// long-form-player.tsx so the cross/baseline logic is unit-testable in
// pure node (no jsdom).
//
// Behavior:
//   • crossedQuartiles(args) returns the quartiles that should fire
//     based on a small forward step from prev → curr (audit M3 scrub-
//     forward gate at 2.0s tolerance).
//   • takeBfcacheBaseline(args) is called on the first timeupdate where
//     prev === null and the baseline hasn't been taken yet. It returns
//     the set of quartiles to PRE-MARK as fired (without emitting),
//     closing the audit M5 bfcache-restore phantom-emit hole.

export const QUARTILES = [25, 50, 75, 100] as const;
export type Quartile = (typeof QUARTILES)[number];

export type CrossArgs = {
  duration: number;
  prev: number;
  curr: number;
  fired: ReadonlySet<Quartile>;
};

// Returns the quartiles to fire in order (25 < 50 < 75). q=100 fires on
// `ended`, never on a timeupdate cross — the player wires onEnded
// directly. Skipping 100 here keeps the tracker a single source of
// truth for "natural playback crossings".
export function crossedQuartiles(args: CrossArgs): Quartile[] {
  const { duration, prev, curr, fired } = args;
  if (!Number.isFinite(duration) || duration <= 0) return [];
  // Audit M3: scrub-forward gate. Only count crossings on small forward
  // steps (natural playback). 2.0s tolerance — long-form timeupdate
  // fires ~4×/sec on iOS so a natural step is ~0.25s; 2.0s catches
  // mild OS scheduling jitter without admitting scrub jumps.
  if (curr <= prev) return [];
  if (curr - prev >= 2.0) return [];

  const out: Quartile[] = [];
  for (const q of [25, 50, 75] as const) {
    const threshold = duration * (q / 100);
    if (prev < threshold && curr >= threshold && !fired.has(q)) {
      out.push(q);
    }
  }
  return out;
}

export type BfcacheArgs = {
  duration: number;
  curr: number;
};

// Audit M5: on bfcache restore (or route-stack-pop landing mid-video),
// the first timeupdate has prev === null and curr possibly mid-stream.
// Pre-mark all already-passed quartiles so the natural-playback gate
// doesn't fire phantom q=25/50 events for content the user already
// watched in the prior session (which already emitted real quartile
// events to feed_events_raw — the cooldown record persists durably).
export function takeBfcacheBaseline(args: BfcacheArgs): Quartile[] {
  const { duration, curr } = args;
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const passedPct = (curr / duration) * 100;
  return QUARTILES.filter((q) => passedPct >= q);
}

// Audit M6: pagehide / visibilitychange backstop for the q=100 case
// where iOS doesn't fire `ended` because the tab dies in the last few
// seconds. Returns true iff currentTime is within the final 3% of
// duration AND q=100 hasn't fired yet.
export function shouldFinalizeOnPagehide(args: {
  duration: number;
  curr: number;
  fired: ReadonlySet<Quartile>;
}): boolean {
  const { duration, curr, fired } = args;
  if (!Number.isFinite(duration) || duration <= 0) return false;
  if (fired.has(100)) return false;
  return curr / duration >= 0.97;
}
