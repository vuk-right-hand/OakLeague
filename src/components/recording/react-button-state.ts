// Pure helpers backing <ReactButton/>. Extracted so the label/aria/countdown
// logic is unit-testable without a React renderer (the repo doesn't use
// testing-library / jsdom — vitest runs in node env). The component itself
// is a thin presentational shell over these helpers.
//
// State machine surface (Plan §2):
//   idle      → neutral "React" CTA
//   priming   → ~200ms cam+mic acquisition (parent owns the timer)
//   armed     → recording, red dot, 60s countdown
//   disabled  → kill-switch off, cap-hit, permission denied, etc.

export type ReactButtonState = 'idle' | 'priming' | 'armed' | 'disabled';

/** Plan §2: hard 60s ceiling per duet in v1 (long-form duets are post-YC).
 *  Orthogonal to `profiles.voice_*_cap_seconds` — those are per-user voice
 *  minute budgets gated by voice_usage_ticket_check. Don't merge them. */
export const MAX_RECORDING_SECONDS = 60;

/**
 * Server-flag-gated UI mount. The same NEXT_PUBLIC_REACT_CAPTURE_ENABLED
 * flag gates the crossOrigin attribute on Mux video elements AND the
 * ReactButton mount (Plan §20.2 — flag is unified per R3 M5 — there is no
 * flag-level separation between them).
 *
 * Caller decides whether to read the flag itself or rely on this helper —
 * exposing it here lets the button short-circuit at the leaf rather than
 * threading conditional rendering through every surface (hook-panel,
 * long-form, Ask scene, lesson row).
 */
export function isReactCaptureEnabled(): boolean {
  return process.env.NEXT_PUBLIC_REACT_CAPTURE_ENABLED === '1';
}

/** "0:42" / "1:00" — only the seconds remaining, no leading zero on minutes. */
export function formatCountdown(secondsRemaining: number): string {
  // Defensive NaN guard — a parent computing `cap - elapsed` with a stale
  // perf.now() can produce NaN; we render "0:00" rather than "NaN:NaN".
  if (!Number.isFinite(secondsRemaining)) return '0:00';
  const s = Math.max(0, Math.floor(secondsRemaining));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

/**
 * Visible button label — what the user reads.
 *  - idle      → "React"
 *  - priming   → "…"  (the actual capture is starting in ms; we don't say
 *                      "Starting" because the word lingers visually)
 *  - armed     → countdown like "0:42" so the user knows the cap
 *  - disabled  → "React" with disabled styling — the why goes in the tooltip
 */
export function resolveLabel(
  state: ReactButtonState,
  armedSecondsRemaining: number | undefined,
): string {
  switch (state) {
    case 'idle':     return 'React';
    case 'priming':  return '...';
    case 'armed':
      // Don't mask a parent bug with a full-cap fallback (audit M5) — a
      // frozen "1:00" while the underlying recording is actually 30s in
      // is a debugging black hole. Render an obviously-wrong placeholder
      // so the missing prop is visible. The discriminated-union types
      // make this unreachable in correct callers.
      return armedSecondsRemaining === undefined ? '...' : formatCountdown(armedSecondsRemaining);
    case 'disabled': return 'React';
    default: {
      // Exhaustiveness — adding a fifth state without updating this switch
      // becomes a compile error rather than a silent fall-through.
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/**
 * aria-label — screen-reader text. More verbose than the visible label so
 * the disabled reason is read aloud, and "React" alone (which a screen
 * reader could mistake for the React JS framework) gets contextual prefix.
 */
export function resolveAriaLabel(
  state: ReactButtonState,
  args: {
    creatorHandle?: string;
    disabledReason?: string;
    armedSecondsRemaining?: number;
  },
): string {
  const subject = args.creatorHandle ? ` with @${args.creatorHandle}` : '';
  switch (state) {
    case 'idle':
      return `Record a duet${subject}`;
    case 'priming':
      return 'Starting recording — camera and microphone preparing';
    case 'armed': {
      const s = args.armedSecondsRemaining;
      const time = s === undefined ? 'unknown time' : `${formatCountdown(s)} remaining`;
      return `Recording in progress — ${time}. Tap to stop.`;
    }
    case 'disabled':
      return args.disabledReason
        ? `Recording unavailable: ${args.disabledReason}`
        : 'Recording unavailable';
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/**
 * Whether the button should respond to a tap. We return false during PRIMING
 * because a double-tap during the ~200ms cam-acquisition window otherwise
 * triggers a STOP on a session that hasn't even ARMED yet. Centralized so
 * the React component, the unit tests, and any future automation (e.g. an
 * E2E harness simulating taps) all share one source of truth.
 */
export function isTappable(state: ReactButtonState): boolean {
  return state === 'idle' || state === 'armed';
}
