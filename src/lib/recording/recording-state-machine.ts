// Pure state-machine reducer for the React/duet capture controller (Plan §2).
// The hook (recording-controller.ts) wraps this with refs to the AudioContext,
// AvatarBridge, AudioMixer, Compositor, MediaRecorder, etc. — but the actual
// state transitions live here so we can unit-test every path in vitest's node
// env without a React renderer.
//
// State machine (Plan §2, uncapped rework 2026-06-10):
//
//   IDLE ──tap React──▶ PRIMING (~200ms cam+mic acquire) ──▶ ARMED
//   ARMED ──tap React again──▶ STOPPING (1.5s end-card outro) ──OUTRO_DONE──▶ STOPPED ──▶ PREVIEW
//   ARMED ──swipe vertically──▶ STOPPED (reason: 'swipe')
//   ARMED ──safety ceiling elapsed──▶ STOPPED (reason: 'cap') [5min mobile / 15min desktop]
//   ARMED ──app backgrounds──▶ STOPPED (reason: 'background')
//   ARMED ──track.onended──▶ STOPPED (reason: 'rtc_track_ended')
//   ARMED ──camera revoked──▶ STOPPED (reason: 'permission_revoked')
//   STOPPING ──any interrupt (background/swipe/revoke/track/session-end)──▶ STOPPED
//             with the INTERRUPT's reason (outro abandoned, blob still finalizes)
//   PRIMING ──getUserMedia denied──▶ DISABLED (reason: permission_denied)
//   PRIMING ──cap-hit on open-check──▶ DISABLED (reason: 'voice_cap_hit'|'daily_cap_hit')
//   PRIMING ──any other error──▶ ERROR (carries error code, exposes retry)
//   STOPPED ──user dismisses preview──▶ IDLE
//
// STOPPING (uncapped rework): user-tap stops route through a 1.5s outro so
// the compositor draws the referral end-card into the recording's tail.
// Pre-rework, the end-card only rendered on cap-stop — a user-tap stop
// shipped with NO share CTA burned in, and with the cap effectively gone
// every stop is a user stop. Non-user stops (background/revoke/...) cannot
// draw a meaningful outro (tab hidden / track dead) and go straight to
// STOPPED, as does the safety cap (its end-card is drawn by the
// endCardArmed TIMER_TICK backstop in the final 1.5s before the deadline).
//
// DISABLED is a terminal-for-now state that consumers render via the
// ReactButton's disabled visual; calling reset() returns to IDLE.

import type { Platform } from './recording-mime';

export const STOP_REASONS = [
  'user',                // user tapped React again
  'cap',                 // platform RAM safety ceiling (5min mobile / 15min desktop)
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
  // Uncapped rework — user-tap outro window. stopRequestedAtMs is the tap
  // time (tap→tap telemetry); the eventual stopped.stoppedAtMs is the
  // OUTRO_DONE time, which matches the blob's real tail.
  | { kind: 'stopping'; stopReason: StopReason; armedAtMs: number; capDeadlineMs: number; stopRequestedAtMs: number }
  | { kind: 'stopped'; stopReason: StopReason; armedAtMs: number; stoppedAtMs: number }
  | { kind: 'preview'; stopReason: StopReason; armedAtMs: number; stoppedAtMs: number; durationMs: number }
  | { kind: 'disabled'; reason: DisabledReason; message?: string }
  | { kind: 'error'; code: string; message: string };

/**
 * Uncapped rework (2026-06-10): the old 60s product cap is gone — recording
 * runs until the user taps stop. What remains is a SAFETY ceiling, and it is
 * a CLIENT-MEMORY bound, not a cost bound: MediaRecorder chunks accumulate
 * in RAM (~16MB/min at 2Mbps+128kbps) and the finalize step concatenates
 * them into one contiguous Blob. Mobile Safari OOM-reloads the tab well
 * before 240MB — losing the recording at the exact moment the user wanted
 * it. Desktop tabs tolerate far more.
 *   mobile (ios/android/unknown): 5 min ≈ 80MB worst case
 *   desktop (+desktop-safari):    15 min ≈ 240MB
 * 'unknown' is treated as mobile — fail safe on the constrained side.
 * Native iOS/Android apps stream to disk (AVAssetWriter / MediaMuxer) and
 * need NO ceiling — this is a web-MediaRecorder artifact only.
 * Ask-mode note: the underlying voice session's own caps close the session
 * first where applicable; signalAskSessionEnded stops the recording then.
 */
export const MAX_RECORDING_MS_DESKTOP = 900_000;
export const MAX_RECORDING_MS_MOBILE = 300_000;

export function maxRecordingMsForPlatform(platform: Platform): number {
  return platform === 'desktop' || platform === 'desktop-safari'
    ? MAX_RECORDING_MS_DESKTOP
    : MAX_RECORDING_MS_MOBILE;
}

/** Plan §8: 1.5s end-card overlay at the tail of the recording. Canonical
 *  definition lives HERE (composite-canvas re-exports it) so the reducer's
 *  outro window and the compositor's draw window cannot desync. */
export const END_CARD_MS = 1_500;

// Discriminated event union. The controller's effect layer dispatches these
// in response to user input, timer ticks, browser events, and bridge callbacks.
export type RecordingEvent =
  | { type: 'TAP'; nowMs: number }
  // capMs = maxRecordingMsForPlatform(probeRecording().platform), passed by
  // the controller so the pure reducer stays platform-blind.
  | { type: 'PERMISSION_GRANTED'; nowMs: number; capMs: number }
  // Outro window elapsed (controller setTimeout END_CARD_MS after entering
  // 'stopping'). Only meaningful in 'stopping'; ignored everywhere else so a
  // stale timeout that survives an interrupt cannot corrupt a later phase.
  | { type: 'OUTRO_DONE'; nowMs: number }
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
          capDeadlineMs: ev.nowMs + ev.capMs,
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
      // Ask-mode pre-arm failure: the avatar video never became drawable
      // (first-frame wait timed out, or the askEnabled-fix audit C2 gate
      // found no live video track at ARM). Pre-fix this event was silently
      // IGNORED in 'priming' — the controller dispatched it (Day-3 code,
      // line ~590) but the reducer had no arm, stranding the button at "…"
      // forever. Back to idle: the user simply re-taps once the avatar is
      // back.
      if (ev.type === 'ASK_OPEN_TIMEOUT') return { kind: 'idle' };
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
        // Uncapped rework: user-tap stops route through the 1.5s outro so
        // the end-card (share CTA) is drawn into the recording's tail.
        return {
          kind: 'stopping',
          stopReason: 'user',
          armedAtMs: phase.armedAtMs,
          capDeadlineMs: phase.capDeadlineMs,
          stopRequestedAtMs: ev.nowMs,
        };
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

    // ── STOPPING (outro window) ───────────────────────────────────────
    case 'stopping': {
      if (ev.type === 'OUTRO_DONE') {
        return {
          kind: 'stopped',
          stopReason: phase.stopReason,
          armedAtMs: phase.armedAtMs,
          stoppedAtMs: ev.nowMs,
        };
      }
      // Interrupts abandon the outro and finalize immediately, carrying the
      // INTERRUPT's reason (a background/revoke during the outro is the
      // truthful story for telemetry; the blob still finalizes with whatever
      // tail was drawn). The compositor cannot draw meaningful frames once
      // the tab is hidden / the track is dead, so waiting out the outro
      // would only pad the recording with garbage.
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
      if (ev.type === 'ASK_SESSION_ENDED') {
        return { kind: 'stopped', stopReason: 'ask_session_ended', armedAtMs: phase.armedAtMs, stoppedAtMs: ev.nowMs };
      }
      if (ev.type === 'RECORDER_ERROR') {
        return { kind: 'stopped', stopReason: 'recorder_error', armedAtMs: phase.armedAtMs, stoppedAtMs: ev.nowMs };
      }
      if (ev.type === 'UNMOUNT') {
        return { kind: 'stopped', stopReason: 'unmount', armedAtMs: phase.armedAtMs, stoppedAtMs: ev.nowMs };
      }
      if (ev.type === 'RESET') return { kind: 'idle' };
      // TAP during the outro is ignored (recording is finishing — audit M6:
      // onTap's phaseRef guard also drops it; both layers intentional).
      // TIMER_TICK is ignored — the cap interval is armed-only (audit M6);
      // a straggler tick that fires before the effect cleanup runs lands here.
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
  state: 'idle' | 'priming' | 'armed' | 'stopping' | 'disabled';
  disabledReason?: string;
} {
  switch (phase.kind) {
    case 'idle':     return { state: 'idle' };
    case 'priming':  return { state: 'priming' };
    case 'armed':    return { state: 'armed' };
    // Plan audit C2 (uncapped rework): 'stopping' MUST surface as its own
    // non-tappable button state — mapping it to 'idle' (like stopped/preview
    // below) would flash a tappable "React" label for the 1.5s outro after
    // every stop. The phaseRef guard in onTap would drop the tap, but the
    // visual invitation to tap is itself the regression.
    case 'stopping': return { state: 'stopping' };
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

/** Elapsed seconds since ARM — drives the count-UP label (uncapped rework;
 *  the user sees how long they've been recording, not a countdown). */
export function selectArmedSecondsElapsed(phase: RecordingPhase, nowMs: number): number | undefined {
  if (phase.kind !== 'armed') return undefined;
  return Math.max(0, (nowMs - phase.armedAtMs) / 1000);
}

/** Remaining seconds before the SAFETY ceiling. The button only surfaces
 *  this in the final 30s (plan audit M3 — without a heads-up, the safety
 *  cap reads as an unexplained crash to a long-talker). */
export function selectArmedSecondsRemaining(phase: RecordingPhase, nowMs: number): number | undefined {
  if (phase.kind !== 'armed') return undefined;
  return Math.max(0, (phase.capDeadlineMs - nowMs) / 1000);
}
