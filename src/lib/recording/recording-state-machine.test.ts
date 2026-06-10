// Unit coverage for the recording-controller state machine. Pure reducer +
// selectors — vitest's node env runs every transition without a renderer.
//
// Uncapped rework (2026-06-10): the 60s product cap became a platform
// SAFETY ceiling (5min mobile / 15min desktop, client-RAM bound) and
// user-tap stops route through a 1.5s 'stopping' end-card outro.

import { describe, expect, it } from 'vitest';
import {
  END_CARD_MS,
  MAX_RECORDING_MS_DESKTOP,
  MAX_RECORDING_MS_MOBILE,
  maxRecordingMsForPlatform,
  type RecordingPhase,
  recordingReducer,
  selectArmedSecondsElapsed,
  selectArmedSecondsRemaining,
  selectButtonState,
} from './recording-state-machine';

// Tests run with the mobile ceiling — the reducer is platform-blind (capMs
// arrives on PERMISSION_GRANTED), so one value exercises every transition.
const CAP_MS = MAX_RECORDING_MS_MOBILE;

const idle = { kind: 'idle' as const };
function priming(t = 0) { return { kind: 'priming' as const, armRequestedAtMs: t }; }
function armed(t = 0) {
  return {
    kind: 'armed' as const,
    armedAtMs: t,
    capDeadlineMs: t + CAP_MS,
    endCardArmed: false,
  };
}
function stopping(t = 0, tapAt = 5000) {
  return {
    kind: 'stopping' as const,
    stopReason: 'user' as const,
    armedAtMs: t,
    capDeadlineMs: t + CAP_MS,
    stopRequestedAtMs: tapAt,
  };
}
/** armed → (user TAP) → stopping → OUTRO_DONE → stopped. The canonical
 *  user-stop path post-rework. */
function userStopped(tapAt = 5000, outroAt = tapAt + END_CARD_MS) {
  const s = recordingReducer(armed(0), { type: 'TAP', nowMs: tapAt });
  return recordingReducer(s, { type: 'OUTRO_DONE', nowMs: outroAt });
}

// ── platform ceiling ───────────────────────────────────────────────────

describe('maxRecordingMsForPlatform', () => {
  it('desktop surfaces get 15 minutes', () => {
    expect(maxRecordingMsForPlatform('desktop')).toBe(MAX_RECORDING_MS_DESKTOP);
    expect(maxRecordingMsForPlatform('desktop-safari')).toBe(MAX_RECORDING_MS_DESKTOP);
    expect(MAX_RECORDING_MS_DESKTOP).toBe(900_000);
  });

  it('mobile + unknown get 5 minutes (fail safe on the RAM-constrained side)', () => {
    expect(maxRecordingMsForPlatform('ios')).toBe(MAX_RECORDING_MS_MOBILE);
    expect(maxRecordingMsForPlatform('android')).toBe(MAX_RECORDING_MS_MOBILE);
    expect(maxRecordingMsForPlatform('unknown')).toBe(MAX_RECORDING_MS_MOBILE);
    expect(MAX_RECORDING_MS_MOBILE).toBe(300_000);
  });
});

// ── IDLE ───────────────────────────────────────────────────────────────

describe('reducer — IDLE', () => {
  it('TAP transitions to PRIMING', () => {
    const next = recordingReducer(idle, { type: 'TAP', nowMs: 1000 });
    expect(next).toEqual({ kind: 'priming', armRequestedAtMs: 1000 });
  });

  it('PERMISSION_REVOKED transitions to DISABLED (revoked)', () => {
    const next = recordingReducer(idle, { type: 'PERMISSION_REVOKED', nowMs: 1 });
    expect(next.kind).toBe('disabled');
    if (next.kind === 'disabled') expect(next.reason).toBe('permission_revoked');
  });

  it('ignores unrelated events including a stale OUTRO_DONE', () => {
    expect(recordingReducer(idle, { type: 'TIMER_TICK', nowMs: 1 })).toBe(idle);
    expect(recordingReducer(idle, { type: 'BACKGROUND', nowMs: 1 })).toBe(idle);
    expect(recordingReducer(idle, { type: 'OUTRO_DONE', nowMs: 1 })).toBe(idle);
  });
});

// ── PRIMING ────────────────────────────────────────────────────────────

describe('reducer — PRIMING', () => {
  it('PERMISSION_GRANTED arms with the event-supplied capMs anchored at nowMs', () => {
    const next = recordingReducer(priming(100), { type: 'PERMISSION_GRANTED', nowMs: 200, capMs: CAP_MS });
    expect(next).toEqual({
      kind: 'armed',
      armedAtMs: 200,
      capDeadlineMs: 200 + CAP_MS,
      endCardArmed: false,
    });
  });

  it('PERMISSION_GRANTED honors a desktop capMs too (reducer is platform-blind)', () => {
    const next = recordingReducer(priming(0), {
      type: 'PERMISSION_GRANTED', nowMs: 0, capMs: MAX_RECORDING_MS_DESKTOP,
    });
    expect(next.kind).toBe('armed');
    if (next.kind === 'armed') expect(next.capDeadlineMs).toBe(MAX_RECORDING_MS_DESKTOP);
  });

  it('PERMISSION_DENIED transitions to DISABLED', () => {
    const next = recordingReducer(priming(), { type: 'PERMISSION_DENIED', nowMs: 1 });
    expect(next.kind).toBe('disabled');
    if (next.kind === 'disabled') expect(next.reason).toBe('permission_denied');
  });

  it('CAP_HIT transitions to DISABLED with the supplied reason', () => {
    const next = recordingReducer(priming(), {
      type: 'CAP_HIT', reason: 'voice_cap_hit', nowMs: 1,
    });
    expect(next.kind).toBe('disabled');
    if (next.kind === 'disabled') expect(next.reason).toBe('voice_cap_hit');
  });

  it('RECORDER_ERROR escalates to ERROR', () => {
    const next = recordingReducer(priming(), {
      type: 'RECORDER_ERROR', nowMs: 1, message: 'boom',
    });
    expect(next.kind).toBe('error');
    if (next.kind === 'error') expect(next.message).toBe('boom');
  });

  it('RESET cancels back to IDLE', () => {
    expect(recordingReducer(priming(), { type: 'RESET', nowMs: 1 })).toEqual(idle);
  });

  it('ignores TAP while priming (double-tap protection lives at the button too)', () => {
    const p = priming(100);
    expect(recordingReducer(p, { type: 'TAP', nowMs: 200 })).toBe(p);
  });
});

// ── ARMED ──────────────────────────────────────────────────────────────

describe('reducer — ARMED', () => {
  it('TAP enters the STOPPING outro (NOT stopped directly) carrying tap time', () => {
    const next = recordingReducer(armed(0), { type: 'TAP', nowMs: 5000 });
    expect(next.kind).toBe('stopping');
    if (next.kind === 'stopping') {
      expect(next.stopReason).toBe('user');
      expect(next.armedAtMs).toBe(0);
      expect(next.stopRequestedAtMs).toBe(5000);
    }
  });

  it('TIMER_TICK at the safety ceiling stops DIRECTLY with reason=cap (no outro — the endCardArmed backstop already drew the card)', () => {
    const a = armed(0);
    // Tick a smidge past the deadline — the stoppedAtMs should be clamped
    // to capDeadlineMs so analytics see exactly the ceiling duration.
    const next = recordingReducer(a, { type: 'TIMER_TICK', nowMs: a.capDeadlineMs + 50 });
    expect(next.kind).toBe('stopped');
    if (next.kind === 'stopped') {
      expect(next.stopReason).toBe('cap');
      expect(next.stoppedAtMs).toBe(a.capDeadlineMs);
    }
  });

  it('TIMER_TICK arms the end-card flag END_CARD_MS before deadline', () => {
    const a = armed(0);
    // Just BEFORE the threshold — flag stays false.
    const before = recordingReducer(a, { type: 'TIMER_TICK', nowMs: a.capDeadlineMs - END_CARD_MS - 1 });
    expect(before.kind).toBe('armed');
    if (before.kind === 'armed') expect(before.endCardArmed).toBe(false);
    // AT the threshold — flag flips.
    const at = recordingReducer(a, { type: 'TIMER_TICK', nowMs: a.capDeadlineMs - END_CARD_MS });
    expect(at.kind).toBe('armed');
    if (at.kind === 'armed') expect(at.endCardArmed).toBe(true);
  });

  it('TIMER_TICK is idempotent on the end-card flag', () => {
    const a = armed(0);
    const first = recordingReducer(a, { type: 'TIMER_TICK', nowMs: a.capDeadlineMs - END_CARD_MS });
    const second = recordingReducer(first, { type: 'TIMER_TICK', nowMs: a.capDeadlineMs - END_CARD_MS + 100 });
    expect(second).toBe(first); // same reference — no transition emitted
  });

  it.each([
    ['BACKGROUND', 'background'],
    ['SWIPE', 'swipe'],
    ['TRACK_ENDED', 'rtc_track_ended'],
    ['PERMISSION_REVOKED', 'permission_revoked'],
    ['ASK_OPEN_TIMEOUT', 'ask_open_timeout'],
    ['ASK_SESSION_ENDED', 'ask_session_ended'],
    ['UNMOUNT', 'unmount'],
  ] as const)('%s stops with reason=%s', (eventType, expectedReason) => {
    const next = recordingReducer(armed(0), { type: eventType, nowMs: 5000 });
    expect(next.kind).toBe('stopped');
    if (next.kind === 'stopped') {
      expect(next.stopReason).toBe(expectedReason);
      expect(next.stoppedAtMs).toBe(5000);
    }
  });

  it('RECORDER_ERROR stops with reason=recorder_error', () => {
    const next = recordingReducer(armed(0), {
      type: 'RECORDER_ERROR', nowMs: 5000, message: 'boom',
    });
    expect(next.kind).toBe('stopped');
    if (next.kind === 'stopped') expect(next.stopReason).toBe('recorder_error');
  });

  it('stale OUTRO_DONE in ARMED is ignored', () => {
    const a = armed(0);
    expect(recordingReducer(a, { type: 'OUTRO_DONE', nowMs: 1 })).toBe(a);
  });

  it('TAP after end-card flag still enters the outro cleanly', () => {
    const a = armed(0);
    const withFlag = recordingReducer(a, { type: 'TIMER_TICK', nowMs: a.capDeadlineMs - END_CARD_MS });
    const next = recordingReducer(withFlag, { type: 'TAP', nowMs: a.capDeadlineMs - 100 });
    expect(next.kind).toBe('stopping');
    if (next.kind === 'stopping') expect(next.stopReason).toBe('user');
  });
});

// ── STOPPING (outro) ───────────────────────────────────────────────────

describe('reducer — STOPPING', () => {
  it('OUTRO_DONE finalizes to STOPPED with reason=user and outro-end stoppedAt', () => {
    const next = recordingReducer(stopping(0, 5000), { type: 'OUTRO_DONE', nowMs: 6500 });
    expect(next).toEqual({
      kind: 'stopped',
      stopReason: 'user',
      armedAtMs: 0,
      stoppedAtMs: 6500,
    });
  });

  it.each([
    ['BACKGROUND', 'background'],
    ['SWIPE', 'swipe'],
    ['TRACK_ENDED', 'rtc_track_ended'],
    ['PERMISSION_REVOKED', 'permission_revoked'],
    ['ASK_SESSION_ENDED', 'ask_session_ended'],
    ['UNMOUNT', 'unmount'],
  ] as const)('%s aborts the outro and stops immediately with reason=%s', (eventType, expectedReason) => {
    const next = recordingReducer(stopping(0, 5000), { type: eventType, nowMs: 5400 });
    expect(next.kind).toBe('stopped');
    if (next.kind === 'stopped') {
      expect(next.stopReason).toBe(expectedReason);
      expect(next.stoppedAtMs).toBe(5400);
    }
  });

  it('RECORDER_ERROR aborts the outro with reason=recorder_error', () => {
    const next = recordingReducer(stopping(), { type: 'RECORDER_ERROR', nowMs: 5400, message: 'boom' });
    expect(next.kind).toBe('stopped');
    if (next.kind === 'stopped') expect(next.stopReason).toBe('recorder_error');
  });

  it('TAP during the outro is ignored', () => {
    const s = stopping();
    expect(recordingReducer(s, { type: 'TAP', nowMs: 5600 })).toBe(s);
  });

  it('TIMER_TICK stragglers are ignored (cap interval is armed-only)', () => {
    const s = stopping();
    expect(recordingReducer(s, { type: 'TIMER_TICK', nowMs: s.capDeadlineMs + 1 })).toBe(s);
  });

  it('RESET escapes to IDLE', () => {
    expect(recordingReducer(stopping(), { type: 'RESET', nowMs: 1 })).toEqual(idle);
  });
});

// ── STOPPED → PREVIEW ──────────────────────────────────────────────────

describe('reducer — STOPPED → PREVIEW', () => {
  it('PREVIEW_ARRIVED carries durationMs', () => {
    const stopped = userStopped(5000);
    const next = recordingReducer(stopped, { type: 'PREVIEW_ARRIVED', nowMs: 7000, durationMs: 6500 });
    expect(next.kind).toBe('preview');
    if (next.kind === 'preview') {
      expect(next.stopReason).toBe('user');
      expect(next.durationMs).toBe(6500);
    }
  });

  it('RESET returns STOPPED to IDLE', () => {
    expect(recordingReducer(userStopped(), { type: 'RESET', nowMs: 1 })).toEqual(idle);
  });

  it('PREVIEW_DISMISSED from STOPPED returns to IDLE (audit C1 cross-cutting Day-4)', () => {
    // Repro: user dismisses so fast that STOP fires before recorder.onstop.
    // Without this transition, the reducer is stuck in 'stopped' and the
    // surface can never record again.
    expect(recordingReducer(userStopped(), { type: 'PREVIEW_DISMISSED', nowMs: 1 })).toEqual(idle);
  });

  it('PREVIEW_DISMISSED returns PREVIEW to IDLE', () => {
    const preview = recordingReducer(userStopped(), { type: 'PREVIEW_ARRIVED', nowMs: 7000, durationMs: 6500 });
    expect(recordingReducer(preview, { type: 'PREVIEW_DISMISSED', nowMs: 1 })).toEqual(idle);
  });

  it('PREVIEW does not accept TAP — must dismiss first', () => {
    const preview = recordingReducer(userStopped(), { type: 'PREVIEW_ARRIVED', nowMs: 7000, durationMs: 6500 });
    expect(recordingReducer(preview, { type: 'TAP', nowMs: 8000 })).toBe(preview);
  });
});

// ── DISABLED / ERROR ───────────────────────────────────────────────────

describe('reducer — DISABLED + ERROR', () => {
  it('RESET escapes DISABLED', () => {
    const dis = recordingReducer(priming(), { type: 'PERMISSION_DENIED', nowMs: 1 });
    expect(recordingReducer(dis, { type: 'RESET', nowMs: 1 })).toEqual(idle);
  });

  it('RESET escapes ERROR', () => {
    const err = recordingReducer(priming(), { type: 'RECORDER_ERROR', nowMs: 1, message: 'x' });
    expect(recordingReducer(err, { type: 'RESET', nowMs: 1 })).toEqual(idle);
  });
});

// ── selectors ──────────────────────────────────────────────────────────

describe('selectButtonState', () => {
  it('idle → idle', () => expect(selectButtonState({ kind: 'idle' }).state).toBe('idle'));
  it('priming → priming', () => expect(selectButtonState(priming()).state).toBe('priming'));
  it('armed → armed', () => expect(selectButtonState(armed()).state).toBe('armed'));
  it('stopping → stopping (plan audit C2 — NOT idle; a tappable "React" mid-outro is the regression)', () => {
    expect(selectButtonState(stopping()).state).toBe('stopping');
  });
  it('stopped → idle (audit C4 — avoids "spinner during teardown" visual lie)', () => {
    const s: RecordingPhase = { kind: 'stopped', stopReason: 'user', armedAtMs: 0, stoppedAtMs: 1 };
    expect(selectButtonState(s).state).toBe('idle');
  });
  it('preview → idle (preview UI replaces button)', () => {
    const p: RecordingPhase = { kind: 'preview', stopReason: 'user', armedAtMs: 0, stoppedAtMs: 1, durationMs: 1 };
    expect(selectButtonState(p).state).toBe('idle');
  });
  it('disabled carries a human-readable disabledReason', () => {
    const d: RecordingPhase = { kind: 'disabled', reason: 'permission_denied' };
    const sel = selectButtonState(d);
    expect(sel.state).toBe('disabled');
    expect(sel.disabledReason).toMatch(/permission/i);
  });
  it('error reuses the disabled visual', () => {
    const e: RecordingPhase = { kind: 'error', code: 'x', message: 'boom' };
    expect(selectButtonState(e).state).toBe('disabled');
    expect(selectButtonState(e).disabledReason).toBe('boom');
  });
});

describe('selectArmedSecondsElapsed (count-up)', () => {
  it('returns undefined off-armed', () => {
    expect(selectArmedSecondsElapsed(idle, 1)).toBeUndefined();
    expect(selectArmedSecondsElapsed(priming(), 1)).toBeUndefined();
    expect(selectArmedSecondsElapsed(stopping(), 1)).toBeUndefined();
  });

  it('returns 0 at armedAt and counts up', () => {
    expect(selectArmedSecondsElapsed(armed(0), 0)).toBe(0);
    expect(selectArmedSecondsElapsed(armed(0), 42_000)).toBe(42);
  });

  it('clamps negative (clock skew) to 0', () => {
    expect(selectArmedSecondsElapsed(armed(1000), 500)).toBe(0);
  });
});

describe('selectArmedSecondsRemaining (safety-ceiling warning)', () => {
  it('returns undefined off-armed', () => {
    expect(selectArmedSecondsRemaining(idle, 1)).toBeUndefined();
    expect(selectArmedSecondsRemaining(priming(), 1)).toBeUndefined();
  });

  it('returns full ceiling at armedAt', () => {
    expect(selectArmedSecondsRemaining(armed(0), 0)).toBe(CAP_MS / 1000);
  });

  it('returns 0 at the deadline', () => {
    const a = armed(0);
    expect(selectArmedSecondsRemaining(a, a.capDeadlineMs)).toBe(0);
  });

  it('clamps to 0 past the deadline', () => {
    const a = armed(0);
    expect(selectArmedSecondsRemaining(a, a.capDeadlineMs + 5000)).toBe(0);
  });
});
