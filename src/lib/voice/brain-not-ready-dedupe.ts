// PR-2 audit C4: rate-limit `brain.not_ready` Sentry errors per creator.
//
// Without this, a single misconfigured creator (left in 'training' state
// while published, e.g.) sees N concurrent users tap the same hook and
// each pumps a Sentry error event. 100 users × 10/min = 1000 events/min
// for one bad creator — would exhaust the Sentry quota on the free tier
// in minutes.
//
// In-process LRU with 5-minute TTL. Per-creator (not per user) so the
// "first-seen this creator since reset" call captures, and subsequent
// calls within the window are deduped. Acceptable to drop dups since
// the PostHog `brain_prefix_skipped` event still fires (rate-limited
// dashboards), and Sentry just needs the signal that "this creator was
// unready," not 1000× the same payload.
//
// Process-local: no Redis. Multi-instance Vercel Functions will each
// have their own LRU; worst case a single bad creator generates one
// event per Vercel function instance per 5min — bounded.

const TTL_MS = 5 * 60 * 1000;
const recent = new Map<string, number>();

export function shouldEmitBrainNotReady(creatorId: string): boolean {
  const now = Date.now();
  const last = recent.get(creatorId);
  if (last !== undefined && now - last < TTL_MS) {
    return false;
  }
  recent.set(creatorId, now);
  // Bound the map; LRU-ish via insertion-order trim.
  if (recent.size > 1000) {
    const firstKey = recent.keys().next().value as string | undefined;
    if (firstKey !== undefined) recent.delete(firstKey);
  }
  return true;
}
