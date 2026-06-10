// Pure helpers backing <ReactButton/>. Extracted so the label/aria/countdown
// logic is unit-testable without a React renderer (the repo doesn't use
// testing-library / jsdom — vitest runs in node env). The component itself
// is a thin presentational shell over these helpers.
//
// State machine surface (Plan §2, uncapped rework 2026-06-10):
//   idle      → neutral "React" CTA
//   priming   → ~200ms cam+mic acquisition (parent owns the timer)
//   armed     → recording, red pill + pulsing dot, count-UP elapsed clock;
//               flips to a red "ends in m:ss" warning in the final 30s
//               before the platform safety ceiling
//   stopping  → 1.5s end-card outro after the user taps stop — non-tappable,
//               "Saving…" label (uncapped rework; mapping this to idle would
//               flash a tappable "React" mid-finalize)
//   disabled  → kill-switch off, cap-hit, permission denied, etc.
//
// The old MAX_RECORDING_SECONDS=60 product cap is gone — the remaining
// ceiling is a client-memory safety bound owned by the state machine
// (maxRecordingMsForPlatform); the button layer has no cap constant.

export type ReactButtonState = 'idle' | 'priming' | 'armed' | 'stopping' | 'disabled';

/** Final-30s window in which the armed label switches from the elapsed
 *  count-up to a red "ends in m:ss" safety-ceiling warning (plan audit M3 —
 *  without a heads-up the cap reads as an unexplained crash). */
export const CAP_WARNING_SECONDS = 30;

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
 *
 * NOTE: NEXT_PUBLIC_* env vars are inlined by Next.js at BUILD time, so
 * this function returns a value baked into the bundle. A Vercel runtime
 * flip without redeploy will NOT take effect on already-shipped chunks —
 * a redeploy is required. Reading this at render time (as ReactButton
 * does) is fine because Next inlines `process.env.NEXT_PUBLIC_*` as a
 * literal at build, not a runtime lookup. Don't poll it in useEffect
 * expecting runtime flips (audit S3 integration).
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
 *  - armed     → count-UP elapsed like "0:42" (uncapped rework); in the
 *                final CAP_WARNING_SECONDS before the safety ceiling it
 *                becomes "ends in 0:29"
 *  - stopping  → "Saving…" (1.5s end-card outro; distinct from priming's
 *                "…" so the two non-tappable states don't read identically)
 *  - disabled  → "React" with disabled styling — the why goes in the tooltip
 */
export function resolveLabel(
  state: ReactButtonState,
  armedSecondsElapsed: number | undefined,
  armedSecondsRemaining?: number,
): string {
  switch (state) {
    case 'idle':     return 'React';
    case 'priming':  return '...';
    case 'armed': {
      if (
        armedSecondsRemaining !== undefined &&
        Number.isFinite(armedSecondsRemaining) &&
        armedSecondsRemaining <= CAP_WARNING_SECONDS
      ) {
        return `ends in ${formatCountdown(armedSecondsRemaining)}`;
      }
      // Count-up fallback 0:00 — the truthful "just armed" render. The old
      // ellipsis fallback collided visually with priming (audit Small,
      // uncapped rework).
      return formatCountdown(armedSecondsElapsed ?? 0);
    }
    case 'stopping': return 'Saving…';
    case 'disabled': return 'React';
    default: {
      // Exhaustiveness — adding a sixth state without updating this switch
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
    armedSecondsElapsed?: number;
  },
): string {
  const subject = args.creatorHandle ? ` with @${args.creatorHandle}` : '';
  switch (state) {
    case 'idle':
      return `Record a duet${subject}`;
    case 'priming':
      return 'Starting recording — camera and microphone preparing';
    case 'armed': {
      const s = args.armedSecondsElapsed;
      const time = s === undefined ? 'just started' : `${formatCountdown(s)} elapsed`;
      return `Recording in progress — ${time}. Tap to finish.`;
    }
    case 'stopping':
      return 'Finishing recording';
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
 * triggers a STOP on a session that hasn't even ARMED yet, and false during
 * STOPPING because the recording is finalizing its end-card outro (the
 * controller's phaseRef guard also drops the tap — both layers intentional).
 * Centralized so the React component, the unit tests, and any future
 * automation (e.g. an E2E harness simulating taps) all share one source of
 * truth.
 */
export function isTappable(state: ReactButtonState): boolean {
  return state === 'idle' || state === 'armed';
}
