// ReactButton — the tap target mounted in 4 surfaces (hook-panel feed,
// /v/[id] long-form viewer, /s/[id] Ask scene, lesson rail row). Plan §13
// file list, §2 state machine. Presentational only: state + onTap come
// from the recording-controller hook the parent owns; the button just
// renders the right look + dispatches taps.
//
// State machine logic, label resolution, and the count-up elapsed-clock
// formatting live in ./react-button-state so the helpers are unit-testable
// in vitest's node env without a React renderer (no testing-library in the
// repo).
//
// Kill-switch: short-circuits to null when NEXT_PUBLIC_REACT_CAPTURE_ENABLED
// !== '1'. Same flag gates the crossOrigin attribute on Mux video elements
// (Plan §20.2 — unified per R3 M5). Build-time only — never read in
// useEffect to "re-check" at runtime; that would risk hydration divergence
// with the SSR'd parent.

'use client';

import { type JSX } from 'react';
import {
  CAP_WARNING_SECONDS,
  type ReactButtonState,
  isReactCaptureEnabled,
  isTappable,
  resolveAriaLabel,
  resolveLabel,
} from './react-button-state';

export type { ReactButtonState };

// Discriminated union: armedSecondsRemaining is required ONLY when the
// state is 'armed' so a parent that forgets to thread the timer is a
// compile error, not a silent permanent "1:00" label (audit M4).
type CommonProps = {
  /** Tap handler. Called for both ARM (idle→armed) and STOP (armed→stopped) —
   *  the parent disambiguates using its own state, not the click event.
   *  Taps are dropped silently during PRIMING and DISABLED via the central
   *  isTappable() guard, NOT via the native `disabled` attribute (which
   *  would prevent stopPropagation from running and leak the tap to the
   *  underlying scroll-snap container / Ask-scene overlay). */
  onTap: () => void;
  /** "vuk" — included in aria-label so screen-readers announce the subject.
   *  Pass without leading '@' (the helper prefixes one). */
  creatorHandle?: string;
  /** Optional className for layout (caller positions absolutely on the
   *  feed surface; we don't bake position styles into the component). */
  className?: string;
};

export type ReactButtonProps =
  | (CommonProps & { state: 'idle' | 'priming' | 'stopping' })
  | (CommonProps & {
      state: 'armed';
      /** Count-UP elapsed seconds (uncapped rework — drives the "0:42" label). */
      armedSecondsElapsed: number;
      /** Seconds left before the platform SAFETY ceiling. Only surfaced in
       *  the final CAP_WARNING_SECONDS ("ends in 0:29" red warning); pass
       *  Infinity to never warn. */
      armedSecondsRemaining: number;
    })
  | (CommonProps & { state: 'disabled'; disabledReason?: string });

// Inlined keyframe + focus styles for the ARMED red-dot pulse and the
// keyboard focus ring. Shipping inside the component keeps the scaffold
// self-contained. React 19 dedupes <style href precedence> across mounts
// and hoists to <head> — without the href/precedence pair, mounting in N
// feed items would emit N identical <style> nodes (audit M1).
//
// `prefers-reduced-motion` honored on the pulse; `:focus-visible` ring on
// the button (audit M2 — keyboard users on disabled state otherwise had
// zero focus feedback under pure inline styles).
const PULSE_STYLE = `
@keyframes oakl-recording-pulse {
  0%, 100% { transform: scale(1);   opacity: 1; }
  50%      { transform: scale(0.6); opacity: 0.5; }
}
@media (prefers-reduced-motion: reduce) {
  .oakl-rec-dot { animation: none !important; }
}
button[data-recording-state]:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
`;

export function ReactButton(props: ReactButtonProps): JSX.Element | null {
  if (!isReactCaptureEnabled()) return null;

  const { state, onTap, creatorHandle, className } = props;
  const armedSecondsElapsed = state === 'armed' ? props.armedSecondsElapsed : undefined;
  const armedSecondsRemaining = state === 'armed' ? props.armedSecondsRemaining : undefined;
  const disabledReason = state === 'disabled' ? props.disabledReason : undefined;

  const label = resolveLabel(state, armedSecondsElapsed, armedSecondsRemaining);
  const aria = resolveAriaLabel(state, { creatorHandle, disabledReason, armedSecondsElapsed });
  const tappable = isTappable(state);

  const isArmed    = state === 'armed';
  const isPriming  = state === 'priming';
  const isStopping = state === 'stopping';
  const isDisabled = state === 'disabled';
  // Final-30s safety-ceiling warning — brighter red + the "ends in m:ss"
  // label from resolveLabel (plan audit M3).
  const isCapWarning =
    isArmed &&
    armedSecondsRemaining !== undefined &&
    Number.isFinite(armedSecondsRemaining) &&
    armedSecondsRemaining <= CAP_WARNING_SECONDS;

  function handleClick(e: React.MouseEvent<HTMLButtonElement>): void {
    // ALWAYS stopPropagation so the tap never leaks through to the surface
    // beneath (audit C1) — even when the button is non-tappable, we must
    // capture the event so a feed scroll-snap or Ask-scene backdrop doesn't
    // misinterpret it. The internal `tappable` guard then decides whether
    // to dispatch onTap.
    e.stopPropagation();
    if (!tappable) return;
    // PostHog autocapture — match the existing hook-panel convention
    // (Plan §13). SSR-safe: handler only runs on client, but the typeof
    // guard documents intent and survives any future server-side test
    // that imports the file.
    if (typeof window !== 'undefined') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as unknown as { posthog?: { capture?: (e: string, p?: any) => void } })
          .posthog?.capture?.('react_button_tap', { state });
      } catch { /* posthog threw — never block the tap */ }
    }
    onTap();
  }

  return (
    <>
      {/* href + precedence let React 19 dedupe + hoist to <head> across N
          mounted instances. Without them, every feed item emits its own
          identical <style> node (audit M1). */}
      <style href="oakl-react-button" precedence="default">{PULSE_STYLE}</style>
      <button
        type="button"
        // aria-disabled, NOT the native `disabled` attribute (audit C1):
        // native disabled prevents the click event from firing entirely,
        // which means stopPropagation never runs and the tap leaks to
        // the surface below.
        aria-disabled={!tappable || undefined}
        onClick={handleClick}
        aria-label={aria}
        data-recording-state={state}
        data-testid="react-button"
        className={className}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 14px',
          borderRadius: 16,
          background: isCapWarning
            ? 'rgba(239,68,68,1)'
            : isArmed
            ? 'rgba(220,38,38,0.92)'
            : isDisabled
            ? 'rgba(255,255,255,0.06)'
            : 'rgba(255,255,255,0.12)',
          border: `1px solid ${isArmed ? 'rgba(220,38,38,0.95)' : 'rgba(255,255,255,0.3)'}`,
          color: isDisabled ? 'rgba(255,255,255,0.5)' : '#fff',
          fontSize: 12,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          cursor: tappable ? 'pointer' : 'default',
          opacity: isPriming || isStopping ? 0.6 : 1,
          transition: 'background 120ms ease, border-color 120ms ease',
          userSelect: 'none',
          WebkitTapHighlightColor: 'transparent',
          // touchAction: 'manipulation' suppresses iOS double-tap-to-zoom
          // on the button itself (300ms ghost-click delay too).
          touchAction: 'manipulation',
        }}
        title={isDisabled && disabledReason ? disabledReason : undefined}
      >
        {isArmed && (
          <span
            aria-hidden="true"
            className="oakl-rec-dot"
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: '#fff',
              animation: 'oakl-recording-pulse 1.2s ease-in-out infinite',
            }}
          />
        )}
        <span>{label}</span>
      </button>
    </>
  );
}
