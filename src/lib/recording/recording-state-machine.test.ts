// Unit coverage for the recording-controller state machine. Pure reducer +
// selectors — vitest's node env runs every transition without a renderer.

import { describe, expect, it } from 'vitest';
import {
  END_CARD_MS,
  MAX_RECORDING_MS,
  type RecordingPhase,
  recordingReducer,
  selectArmedSecondsRemaining,
  selectButtonState,
} from './recording-state-machine';

const idle = { kind: 'idle' as const };
function priming(t = 0) { return { kind: 'priming' as const, armRequestedAtMs: t }; }
function armed(t = 0) {
  return {
    kind: 'armed' as const,
    armedAtMs: t,
    capDeadlineMs: t + MAX_RECORDING_MS,
    endCardArmed: false,
  };
}

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

  it('ignores unrelated events', () => {
    expect(recordingReducer(idle, { type: 'TIMER_TICK', nowMs: 1 })).toBe(idle);
    expect(recordingReducer(idle, { type: 'BACKGROUND', nowMs: 1 })).toBe(idle);
  });
});

// ── PRIMING ────────────────────────────────────────────────────────────

describe('reducer — PRIMING', () => {
  it('PERMISSION_GRANTED arms with a 60s deadline anchored at nowMs', () => {
    const next = recordingReducer(priming(100), { type: 'PERMISSION_GRANTED', nowMs: 200 });
    expect(next).toEqual({
      kind: 'armed',
      armedAtMs: 200,
      capDeadlineMs: 200 + MAX_RECORDING_MS,
      endCardArmed: false,
    });
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
  it('TAP stops with reason=user', () => {
    const next = recordingReducer(armed(0), { type: 'TAP', nowMs: 5000 });
    expect(next.kind).toBe('stopped');
    if (next.kind === 'stopped') {
      expect(next.stopReason).toBe('user');
      expect(next.armedAtMs).toBe(0);
      expect(next.stoppedAtMs).toBe(5000);
    }
  });

  it('TIMER_TICK at the cap deadline stops with reason=cap (clamps stoppedAt to deadline)', () => {
    const a = armed(0);
    // Tick a smidge past the deadline — the stoppedAtMs should be clamped
    // to capDeadlineMs so analytics see exactly 60_000ms duration.
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

  it('TAP after end-card flag still stops cleanly', () => {
    const a = armed(0);
    const withFlag = recordingReducer(a, { type: 'TIMER_TICK', nowMs: a.capDeadlineMs - END_CARD_MS });
    const next = recordingReducer(withFlag, { type: 'TAP', nowMs: a.capDeadlineMs - 100 });
    expect(next.kind).toBe('stopped');
    if (next.kind === 'stopped') expect(next.stopReason).toBe('user');
  });
});

// ── STOPPED → PREVIEW ──────────────────────────────────────────────────

describe('reducer — STOPPED → PREVIEW', () => {
  it('PREVIEW_ARRIVED carries durationMs', () => {
    const stopped = recordingReducer(armed(0), { type: 'TAP', nowMs: 5000 });
    const next = recordingReducer(stopped, { type: 'PREVIEW_ARRIVED', nowMs: 5500, durationMs: 5000 });
    expect(next.kind).toBe('preview');
    if (next.kind === 'preview') {
      expect(next.stopReason).toBe('user');
      expect(next.durationMs).toBe(5000);
    }
  });

  it('RESET returns STOPPED to IDLE', () => {
    const stopped = recordingReducer(armed(0), { type: 'TAP', nowMs: 5000 });
    expect(recordingReducer(stopped, { type: 'RESET', nowMs: 1 })).toEqual(idle);
  });

  it('PREVIEW_DISMISSED from STOPPED returns to IDLE (audit C1 cross-cutting Day-4)', () => {
    // Repro: user taps X on a barely-armed countdown so STOP fires before
    // recorder.onstop, then dismisses. Without this transition, the reducer
    // is stuck in 'stopped' and the surface can never record again.
    const stopped = recordingReducer(armed(0), { type: 'TAP', nowMs: 5000 });
    expect(recordingReducer(stopped, { type: 'PREVIEW_DISMISSED', nowMs: 1 })).toEqual(idle);
  });

  it('PREVIEW_DISMISSED returns PREVIEW to IDLE', () => {
    const stopped = recordingReducer(armed(0), { type: 'TAP', nowMs: 5000 });
    const preview = recordingReducer(stopped, { type: 'PREVIEW_ARRIVED', nowMs: 5500, durationMs: 5000 });
    expect(recordingReducer(preview, { type: 'PREVIEW_DISMISSED', nowMs: 1 })).toEqual(idle);
  });

  it('PREVIEW does not accept TAP — must dismiss first', () => {
    const stopped = recordingReducer(armed(0), { type: 'TAP', nowMs: 5000 });
    const preview = recordingReducer(stopped, { type: 'PREVIEW_ARRIVED', nowMs: 5500, durationMs: 5000 });
    expect(recordingReducer(preview, { type: 'TAP', nowMs: 6000 })).toBe(preview);
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

describe('selectArmedSecondsRemaining', () => {
  it('returns undefined off-armed', () => {
    expect(selectArmedSecondsRemaining(idle, 1)).toBeUndefined();
    expect(selectArmedSecondsRemaining(priming(), 1)).toBeUndefined();
  });

  it('returns full cap at armedAt', () => {
    expect(selectArmedSecondsRemaining(armed(0), 0)).toBe(MAX_RECORDING_MS / 1000);
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
