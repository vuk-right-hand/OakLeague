// Pure state-machine reducer for the React/duet capture controller (Plan §2).
// The hook (recording-controller.ts) wraps this with refs to the AudioContext,
// AvatarBridge, AudioMixer, Compositor, MediaRecorder, etc. — but the actual
// state transitions live here so we can unit-test every path in vitest's node
// env without a React renderer.
//
// State machine (Plan §2):
//
//   IDLE ──tap React──▶ PRIMING (~200ms cam+mic acquire) ──▶ ARMED
//   ARMED ──tap React again──▶ STOPPED ──▶ PREVIEW
//   ARMED ──swipe vertically──▶ STOPPED (reason: 'swipe')
//   ARMED ──60s elapsed──▶ STOPPED (reason: 'cap')
//   ARMED ──app backgrounds──▶ STOPPED (reason: 'background')
//   ARMED ──track.onended──▶ STOPPED (reason: 'rtc_track_ended')
//   ARMED ──camera revoked──▶ STOPPED (reason: 'permission_revoked')
//   PRIMING ──getUserMedia denied──▶ DISABLED (reason: permission_denied)
//   PRIMING ──cap-hit on open-check──▶ DISABLED (reason: 'voice_cap_hit'|'daily_cap_hit')
//   PRIMING ──any other error──▶ ERROR (carries error code, exposes retry)
//   STOPPED ──user dismisses preview──▶ IDLE
//
// DISABLED is a terminal-for-now state that consumers render via the
// ReactButton's disabled visual; calling reset() returns to IDLE.

export const STOP_REASONS = [
  'user',                // user tapped React again
  'cap',                 // 60s ceiling
  'background',          // app backgrounded (visibilitychange / pagehide)
  'swipe',               // feed swipe-up tear-down
  'rtc_track_ended',     // avatar video/audio track ended (Plan §20.11)
  'permission_revoked',  // mid-session getUserMedia track ended/muted
  'ask_open_timeout',    // Plan §20.10 — 5s without onVideoTrack OR hidden-video loadedmetadata never fires
  'ask_session_ended',   // Day 3 — Ask scene's session pipe closed gracefully (user_ended / closed)
  'recorder_error',      // MediaRecorder onerror
  'unmount',             // surface unmounted (route change)
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const DISABLED_REASONS = [
  'permission_denied',
  'permission_revoked',
  'voice_cap_hit',
  'daily_cap_hit',
  'unsupported',         // MediaRecorder or required surfaces unavailable
  'feature_disabled',    // NEXT_PUBLIC_REACT_CAPTURE_ENABLED off
] as const;
export type DisabledReason = (typeof DISABLED_REASONS)[number];

export type RecordingPhase =
  | { kind: 'idle' }
  | { kind: 'priming'; armRequestedAtMs: number }
  | { kind: 'armed'; armedAtMs: number; capDeadlineMs: number; endCardArmed: boolean }
  | { kind: 'stopped'; stopReason: StopReason; armedAtMs: number; stoppedAtMs: number }
  | { kind: 'preview'; stopReason: StopReason; armedAtMs: number; stoppedAtMs: number; durationMs: number }
  | { kind: 'disabled'; reason: DisabledReason; message?: string }
  | { kind: 'error'; code: string; message: string };

/** Plan §2: hard 60s ceiling per duet in v1. */
export const MAX_RECORDING_MS = 60_000;
/** Plan §8: 1.5s end-card overlay at the tail of the recording. */
export const END_CARD_MS = 1_500;

// Discriminated event union. The controller's effect layer dispatches these
// in response to user input, timer ticks, browser events, and bridge callbacks.
export type RecordingEvent =
  | { type: 'TAP'; nowMs: number }
  | { type: 'PERMISSION_GRANTED'; nowMs: number }
  | { type: 'PERMISSION_DENIED'; nowMs: number }
  | { type: 'PERMISSION_REVOKED'; nowMs: number }
  | { type: 'CAP_HIT'; reason: 'voice_cap_hit' | 'daily_cap_hit' | 'unsupported' | 'feature_disabled'; nowMs: number }
  | { type: 'TIMER_TICK'; nowMs: number }
  | { type: 'BACKGROUND'; nowMs: number }
  | { type: 'SWIPE'; nowMs: number }
  | { type: 'TRACK_ENDED'; nowMs: number }
  | { type: 'ASK_OPEN_TIMEOUT'; nowMs: number }
  | { type: 'ASK_SESSION_ENDED'; nowMs: number }
  | { type: 'RECORDER_ERROR'; nowMs: number; message: string }
  | { type: 'UNMOUNT'; nowMs: number }
  | { type: 'PREVIEW_ARRIVED'; nowMs: number; durationMs: number }
  | { type: 'PREVIEW_DISMISSED'; nowMs: number }
  | { type: 'RESET'; nowMs: number };

// Pure reducer — no side effects. The controller's effect layer runs the
// actual ARM/STOP machinery in response to phase transitions.
export function recordingReducer(phase: RecordingPhase, ev: RecordingEvent): RecordingPhase {
  switch (phase.kind) {
    // ── IDLE ──────────────────────────────────────────────────────────
    case 'idle': {
      if (ev.type === 'TAP') {
        return { kind: 'priming', armRequestedAtMs: ev.nowMs };
      }
      // Permission revoke surfaces while idle just disables the next tap.
      if (ev.type === 'PERMISSION_REVOKED') {
        return { kind: 'disabled', reason: 'permission_revoked' };
      }
      return phase;
    }

    // ── PRIMING ───────────────────────────────────────────────────────
    case 'priming': {
      if (ev.type === 'PERMISSION_GRANTED') {
        return {
          kind: 'armed',
          armedAtMs: ev.nowMs,
          capDeadlineMs: ev.nowMs + MAX_RECORDING_MS,
          endCardArmed: false,
        };
      }
      if (ev.type === 'PERMISSION_DENIED') {
        return { kind: 'disabled', reason: 'permission_denied' };
      }
      if (ev.type === 'CAP_HIT') {
        return { kind: 'disabled', reason: ev.reason };
      }
      if (ev.type === 'RECORDER_ERROR') {
        return { kind: 'error', code: 'recorder_init', message: ev.message };
      }
      // Plan §20.10: tapping React again during PRIMING is silently dropped
      // (the ReactButton's isTappable() also drops it client-side). The
      // priming window is bounded by getUserMedia — no timeout here; if
      // the controller wants to abort, it dispatches RESET.
      if (ev.type === 'RESET') return { kind: 'idle' };
      return phase;
    }

    // ── ARMED ─────────────────────────────────────────────────────────
    case 'armed': {
      if (ev.type === 'TAP') {
        return { kind: 'stopped', stopReason: 'user', armedAtMs: phase.armedAtMs, stoppedAtMs: ev.nowMs };
      }
      if (ev.type === 'TIMER_TICK') {
        if (ev.nowMs >= phase.capDeadlineMs) {
          return { kind: 'stopped', stopReason: 'cap', armedAtMs: phase.armedAtMs, stoppedAtMs: phase.capDeadlineMs };
        }
        // End-card scheduling: arm the flag END_CARD_MS before cap so the
        // controller's effect layer calls compositor.enableEndCard() at the
        // right moment. State doesn't track when END_CARD_MS was reached
        // beyond the boolean — the effect runs once on the rising edge.
        if (!phase.endCardArmed && ev.nowMs >= phase.capDeadlineMs - END_CARD_MS) {
          return { ...phase, endCardArmed: true };
        }
        return phase;
      }
      if (ev.type === 'BACKGROUND') {
        return { kind: 'stopped', stopReason: 'background', armedAtMs: phase.armedAtMs, stoppedAtMs: ev.nowMs };
      }
      if (ev.type === 'SWIPE') {
        return { kind: 'stopped', stopReason: 'swipe', armedAtMs: phase.armedAtMs, stoppedAtMs: ev.nowMs };
      }
      if (ev.type === 'TRACK_ENDED') {
        return { kind: 'stopped', stopReason: 'rtc_track_ended', armedAtMs: phase.armedAtMs, stoppedAtMs: ev.nowMs };
      }
      if (ev.type === 'PERMISSION_REVOKED') {
        return { kind: 'stopped', stopReason: 'permission_revoked', armedAtMs: phase.armedAtMs, stoppedAtMs: ev.nowMs };
      }
      if (ev.type === 'ASK_OPEN_TIMEOUT') {
        return { kind: 'stopped', stopReason: 'ask_open_timeout', armedAtMs: phase.armedAtMs, stoppedAtMs: ev.nowMs };
      }
      if (ev.type === 'ASK_SESSION_ENDED') {
        return { kind: 'stopped', stopReason: 'ask_session_ended', armedAtMs: phase.armedAtMs, stoppedAtMs: ev.nowMs };
      }
      if (ev.type === 'RECORDER_ERROR') {
        return { kind: 'stopped', stopReason: 'recorder_error', armedAtMs: phase.armedAtMs, stoppedAtMs: ev.nowMs };
      }
      if (ev.type === 'UNMOUNT') {
        return { kind: 'stopped', stopReason: 'unmount', armedAtMs: phase.armedAtMs, stoppedAtMs: ev.nowMs };
      }
      return phase;
    }

    // ── STOPPED ───────────────────────────────────────────────────────
    case 'stopped': {
      if (ev.type === 'PREVIEW_ARRIVED') {
        return {
          kind: 'preview',
          stopReason: phase.stopReason,
          armedAtMs: phase.armedAtMs,
          stoppedAtMs: phase.stoppedAtMs,
          durationMs: ev.durationMs,
        };
      }
      if (ev.type === 'RESET' || ev.type === 'UNMOUNT') return { kind: 'idle' };
      // Audit C1 cross-cutting: dismissPreview / discardByUser racing the
      // recorder.onstop seq guard would strand the surface in 'stopped'
      // forever. Accept PREVIEW_DISMISSED from stopped and treat as RESET
      // — equivalent because the recorder is dead and no preview blob will
      // ever materialize.
      if (ev.type === 'PREVIEW_DISMISSED') return { kind: 'idle' };
      return phase;
    }

    // ── PREVIEW ───────────────────────────────────────────────────────
    case 'preview': {
      if (ev.type === 'PREVIEW_DISMISSED' || ev.type === 'RESET') return { kind: 'idle' };
      // No new TAP path from PREVIEW — user must dismiss first. Plan §2.
      return phase;
    }

    // ── DISABLED ──────────────────────────────────────────────────────
    case 'disabled': {
      if (ev.type === 'RESET') return { kind: 'idle' };
      // permission_revoked → permission_denied is a one-way escalation in
      // v1; recovery requires the user to fix the underlying issue and
      // call reset() (which the ReactButton's "settings" CTA path triggers).
      return phase;
    }

    // ── ERROR ─────────────────────────────────────────────────────────
    case 'error': {
      if (ev.type === 'RESET') return { kind: 'idle' };
      return phase;
    }

    default: {
      // Exhaustiveness — adding a new phase becomes a compile error.
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}

// Convenience selector for the ReactButton — maps the phase to the button's
// state surface so the consumer can pass props directly without a switch
// statement at every call site.
export function selectButtonState(phase: RecordingPhase): {
  state: 'idle' | 'priming' | 'armed' | 'disabled';
  armedSecondsRemaining?: number;
  disabledReason?: string;
} {
  switch (phase.kind) {
    case 'idle':     return { state: 'idle' };
    case 'priming':  return { state: 'priming' };
    case 'armed':    return {
      state: 'armed',
      // Caller passes wall-clock now() into a derived selector; the reducer
      // doesn't track per-tick remaining. Default = full cap if the caller
      // doesn't recompute (matches the ReactButton ellipsis fallback).
      armedSecondsRemaining: undefined,
    };
    case 'stopped':
      // Brief window between recorder.stop() and PREVIEW_ARRIVED. Render
      // as 'idle' visually so the user sees a stable label rather than a
      // "preparing camera" spinner during teardown (audit C4 day-2). The
      // controller's onTap drops taps in this phase via phaseRef check —
      // visual idle is OK because tap is gated at the handler level.
      return { state: 'idle' };
    case 'preview':  return { state: 'idle' };    // preview UI replaces the button visually
    case 'disabled': return { state: 'disabled', disabledReason: explainDisabled(phase.reason) };
    case 'error':    return { state: 'disabled', disabledReason: phase.message };
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}

function explainDisabled(reason: DisabledReason): string {
  switch (reason) {
    case 'permission_denied':  return 'Camera or microphone permission denied';
    case 'permission_revoked': return 'Camera or microphone access lost';
    case 'voice_cap_hit':      return 'Daily voice cap reached';
    case 'daily_cap_hit':      return 'Daily recording cap reached';
    case 'unsupported':        return 'Recording is not supported on this browser';
    case 'feature_disabled':   return 'Recording is not available right now';
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/** Compute remaining seconds for the ARMED countdown. Returns undefined
 *  when not armed — callers pass to ReactButton's armedSecondsRemaining. */
export function selectArmedSecondsRemaining(phase: RecordingPhase, nowMs: number): number | undefined {
  if (phase.kind !== 'armed') return undefined;
  return Math.max(0, (phase.capDeadlineMs - nowMs) / 1000);
}
