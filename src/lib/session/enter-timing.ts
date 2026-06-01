// Shared timing for the "enter a private room" session-open mask (Feature A).
// Both Ask surfaces (hook-panel feed + /v/[id] long-form) show the room overlay
// the instant the user taps, run /api/sessions/open in parallel, and hold the
// overlay for a MINIMUM beat so a fast connection doesn't flash the room away —
// the deliberate "walking somewhere private" feel. After the beat AND the
// envelope are both ready, the caller navigates to /s/[id], where the black
// "Starting the call…" stage takes over until the avatar is live.

/** Minimum time the room overlay is shown, even if /open returns faster. */
export const MIN_ENTER_ROOM_MS = 3500;

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
