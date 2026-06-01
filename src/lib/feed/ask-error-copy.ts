// Pure, framework-free classification of /api/sessions/open error codes into
// the user-facing Ask-pill copy. Kept SEPARATE from ask-error-pill.tsx so it can
// be unit-tested in the node vitest env without pulling next/link or a DOM —
// same pure-logic-split pattern as session-reducer.ts.
//
// P0-2 (whole-build UX audit 2026-06-01): the pill used to interpolate the raw
// API error code into "Couldn't start session: {error}". A freshly-flipped v3
// creator with an uncompiled brain surfaced the literal `brain_not_ready`; ~30
// codes from the open route could leak this way. The rule now: a known code maps
// to human copy, and EVERYTHING ELSE falls to a generic fallback that NEVER
// prints a raw machine code.

export const CAP_HIT_CODES: ReadonlySet<string> = new Set([
  'rate_limited',
  'kill_switch_blocked',
  // Defensive: the legacy string the prior dead conditional checked, kept so a
  // stale server build doesn't break the friendly cap copy.
  'kill_switch_fired',
  // use-session-pipe rewire PR-1: /api/sessions/open returns 429
  // error:'daily_cap_hit' before the session_open RPC creates a row.
  'daily_cap_hit',
]);

// Known, user-plausible codes from /api/sessions/open → human copy. Anything NOT
// here (and not a cap code) falls to GENERIC_ASK_ERROR_COPY.
const ERROR_COPY: Readonly<Record<string, string>> = {
  // R3-C1 — Pipeline α' pre-WS gate: the creator's voice clone isn't uploaded.
  creator_voice_not_trained: "This creator's voice isn't ready yet — check back soon.",
  creator_not_ready: "This creator isn't fully set up yet — check back soon.",
  // Creator-side not ready (brain uncompiled / unpublished / lookup miss). A
  // freshly-flipped v3 creator whose brain hasn't compiled lands here, NOT on a
  // raw `brain_not_ready`.
  brain_not_ready: "This creator isn't ready to chat yet — check back soon.",
  creator_not_published: "This creator isn't ready to chat yet — check back soon.",
  creator_not_found: "This creator isn't ready to chat yet — check back soon.",
  creator_lookup_failed: "This creator isn't ready to chat yet — check back soon.",
  // Caller's own profile isn't finished (onboarding incomplete).
  profile_not_ready: 'Finish setting up your profile to start a session.',
  // A live session is already open for this user (possibly another creator).
  live_session_other_creator: "You've got another session open — close it and try again.",
  session_takeover_inconsistent: "You've got another session open — close it and try again.",
};

// The catch-all. Covers proxy/mint/integrity/500/network codes — anything we
// haven't given specific copy. Must NEVER contain an interpolated raw code.
export const GENERIC_ASK_ERROR_COPY = "Couldn't start the session. Please try again.";

export type AskErrorDisplay = { kind: 'cap' } | { kind: 'message'; text: string };

/**
 * Classify an Ask-CTA error into a render directive.
 *   - null/empty → null (pill hidden)
 *   - a cap code → { kind: 'cap' } (component renders cap copy + upgrade link)
 *   - a known code → { kind: 'message', text } (mapped human copy)
 *   - anything else → { kind: 'message', text: GENERIC } (never the raw code)
 */
export function resolveAskErrorDisplay(
  error: string | null | undefined,
): AskErrorDisplay | null {
  if (!error) return null;
  if (CAP_HIT_CODES.has(error)) return { kind: 'cap' };
  return { kind: 'message', text: ERROR_COPY[error] ?? GENERIC_ASK_ERROR_COPY };
}
