// Shared timing for the "enter a private room" session-open mask (Feature A).
// Both Ask surfaces (hook-panel feed + /v/[id] long-form) show the room overlay
// the instant the user taps, run /api/sessions/open in parallel, and hold the
// overlay for a MINIMUM beat so a fast connection doesn't flash the room away —
// the deliberate "walking somewhere private" feel. After the beat AND the
// envelope are both ready, the caller navigates to /s/[id], where the black
// "Starting the call…" stage takes over until the avatar is live.

/**
 * Minimum time the room overlay is shown, even if /open returns faster.
 * 2026-06-10 latency plan: 3500 → 2000. The original 3500 masked a
 * strictly-serial /open (~3.0-3.2s measured); after the route's Phase A/C
 * parallelization /open lands ~1.5-2s, so 2000 still fully masks it while
 * cutting ~1.5s off the user-visible stage-1 wait (route nav adds ~1.2s on
 * top before the "Starting the call…" stage takes over). Shortening the
 * hold also INCREASES voice-ticket TTL headroom (ticket minted in /open,
 * consumed at WS-open on /s/[id]).
 */
export const MIN_ENTER_ROOM_MS = 2000;

/**
 * Await whatever remains of MIN_ENTER_ROOM_MS given when the overlay was first
 * shown (`startedAtMs` MUST be from performance.now() — same clock as here; a
 * Date.now() value would produce a garbage `remaining`). Resolves immediately if
 * the beat has already elapsed. Caller navigates after this resolves on success.
 *
 * Self-limiting by design: the hold is max(0, MIN − fetchTime), so on a SLOW
 * network (where the voice-ticket TTL budget is tight) the /open fetch already
 * ate the beat and the added hold ≈ 0; the artificial delay only appears on a
 * FAST network where the budget is ample. (mint-voice-ticket TTL carries a small
 * cushion for the fast-network case regardless.)
 */
export async function holdEnterRoomBeat(startedAtMs: number): Promise<void> {
  const remaining = MIN_ENTER_ROOM_MS - (performance.now() - startedAtMs);
  if (remaining > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }
}
