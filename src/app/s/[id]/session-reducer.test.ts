import { describe, it, expect } from 'vitest';
import {
  initialState,
  reduce,
  isPipeWarm,
  shouldShowReconnectOverlay,
  type SessionState,
} from './session-reducer';

function boot(): SessionState {
  let s = reduce(initialState, { kind: 'boot_started' });
  s = reduce(s, {
    kind: 'boot_envelope',
    sessionId: 'sess-1',
    tier: 'free',
    avatarStatus: 'pending',
    maxSessionSeconds: 900,
  });
  return s;
}

describe('session-reducer — opening gate', () => {
  it('starts idle', () => {
    expect(initialState.phase).toBe('idle');
  });

  it('boot_started transitions idle → opening', () => {
    const s = reduce(initialState, { kind: 'boot_started' });
    expect(s.phase).toBe('opening');
    expect(s.errorMessage).toBeNull();
  });

  it('boot_started is a no-op when not idle', () => {
    const s1 = reduce(initialState, { kind: 'boot_started' });
    const s2 = reduce(s1, { kind: 'boot_started' });
    expect(s2).toBe(s1);
  });

  it('needs BOTH brain_ready AND avatar_ready to reach ready', () => {
    let s = boot();
    s = reduce(s, { kind: 'brain_ready' });
    expect(s.phase).toBe('opening'); // still waiting for avatar
    s = reduce(s, { kind: 'avatar_ready' });
    expect(s.phase).toBe('ready');
    expect(s.avatarStatus).toBe('minted');
  });

  it('avatar_not_expected satisfies the avatar side of the gate', () => {
    let s = boot();
    s = reduce(s, { kind: 'brain_ready' });
    s = reduce(s, { kind: 'avatar_not_expected' });
    expect(s.phase).toBe('ready');
  });

  it('avatar_ready alone does not transition to ready', () => {
    let s = boot();
    s = reduce(s, { kind: 'avatar_ready' });
    expect(s.phase).toBe('opening');
  });
});

describe('session-reducer — turn lifecycle', () => {
  function ready(): SessionState {
    let s = boot();
    s = reduce(s, { kind: 'brain_ready' });
    s = reduce(s, { kind: 'avatar_ready' });
    return s;
  }

  it('mic_started: ready → listening', () => {
    const s = reduce(ready(), { kind: 'mic_started' });
    expect(s.phase).toBe('listening');
  });

  it('tts_audio_chunk: listening → speaking', () => {
    let s = reduce(ready(), { kind: 'mic_started' });
    s = reduce(s, { kind: 'tts_audio_chunk' });
    expect(s.phase).toBe('speaking');
  });

  it('turn_complete: speaking → ready', () => {
    let s = reduce(ready(), { kind: 'mic_started' });
    s = reduce(s, { kind: 'tts_audio_chunk' });
    s = reduce(s, { kind: 'turn_complete' });
    expect(s.phase).toBe('ready');
  });

  it('barge_in does NOT change phase (barge-in keeps pipe warm)', () => {
    let s = reduce(ready(), { kind: 'mic_started' });
    s = reduce(s, { kind: 'tts_audio_chunk' });
    const before = s.phase;
    s = reduce(s, { kind: 'barge_in' });
    expect(s.phase).toBe(before);
    // isPipeWarm invariant holds across barge-in
    expect(isPipeWarm(s)).toBe(true);
  });
});

describe('session-reducer — thinking state (P0-1)', () => {
  function thinking(): SessionState {
    let s = boot();
    s = reduce(s, { kind: 'brain_ready' });
    s = reduce(s, { kind: 'avatar_ready' });
    s = reduce(s, { kind: 'mic_started' });   // listening
    s = reduce(s, { kind: 'mic_stopped' });   // → thinking
    return s;
  }

  it('mic_stopped: listening → thinking (not ready)', () => {
    const s = thinking();
    expect(s.phase).toBe('thinking');
  });

  it('tts_audio_chunk: thinking → speaking', () => {
    const s = reduce(thinking(), { kind: 'tts_audio_chunk' });
    expect(s.phase).toBe('speaking');
  });

  it('turn_complete: thinking → ready (a turn that produced no audio never strands)', () => {
    const s = reduce(thinking(), { kind: 'turn_complete' });
    expect(s.phase).toBe('ready');
  });

  it('mic_started from thinking is a no-op (mic disabled — not a barge source)', () => {
    const t = thinking();
    const s = reduce(t, { kind: 'mic_started' });
    expect(s).toBe(t); // unchanged reference
    expect(s.phase).toBe('thinking');
  });

  it('thinking survives a stray barge_in / cartesia_reconnecting without phase change', () => {
    let s = reduce(thinking(), { kind: 'barge_in' });
    expect(s.phase).toBe('thinking');
    s = reduce(s, { kind: 'cartesia_reconnecting' });
    expect(s.phase).toBe('thinking');
    expect(s.cartesiaReconnecting).toBe(true);
  });

  it('thinking → paused on visibility_hidden, then paused → ready on visibility_visible (NOT back to thinking)', () => {
    let s = reduce(thinking(), { kind: 'visibility_hidden' });
    expect(s.phase).toBe('paused');
    s = reduce(s, { kind: 'visibility_visible' });
    expect(s.phase).toBe('ready');
  });
});

describe('session-reducer — visibility', () => {
  function ready(): SessionState {
    let s = boot();
    s = reduce(s, { kind: 'brain_ready' });
    s = reduce(s, { kind: 'avatar_ready' });
    return s;
  }

  it('hidden: ready → paused, stamps pausedAtMs', () => {
    const s = reduce(ready(), { kind: 'visibility_hidden' });
    expect(s.phase).toBe('paused');
    expect(s.pausedAtMs).not.toBeNull();
  });

  it('visible: paused → ready, clears pausedAtMs', () => {
    let s = reduce(ready(), { kind: 'visibility_hidden' });
    s = reduce(s, { kind: 'visibility_visible' });
    expect(s.phase).toBe('ready');
    expect(s.pausedAtMs).toBeNull();
  });

  it('double-hidden is idempotent', () => {
    const s1 = reduce(ready(), { kind: 'visibility_hidden' });
    const s2 = reduce(s1, { kind: 'visibility_hidden' });
    expect(s2).toBe(s1);
  });
});

describe('session-reducer — reconnection', () => {
  function ready(): SessionState {
    let s = boot();
    s = reduce(s, { kind: 'brain_ready' });
    s = reduce(s, { kind: 'avatar_ready' });
    return s;
  }

  it('pc_degraded → reconnecting, increments prompt count', () => {
    const s = reduce(ready(), { kind: 'pc_degraded' });
    expect(s.phase).toBe('reconnecting');
    expect(s.reconnectPromptCount).toBe(1);
    expect(shouldShowReconnectOverlay(s)).toBe(true);
  });

  it('ws_closed → reconnecting', () => {
    const s = reduce(ready(), { kind: 'ws_closed', wasClean: false });
    expect(s.phase).toBe('reconnecting');
  });

  it('audio_context_failed → reconnecting (iOS R3-M4)', () => {
    const s = reduce(ready(), { kind: 'audio_context_failed' });
    expect(s.phase).toBe('reconnecting');
  });

  // 2026-06-10 — exit path. Before reconnect_recovered, 'reconnecting' was a
  // roach motel (4 ways in, none out): the retry button resumed media but the
  // overlay stayed forever even when the pipes were verifiably warm.
  it('reconnect_recovered: reconnecting → ready (overlay clears after successful gesture-retry)', () => {
    let s = reduce(ready(), { kind: 'pc_degraded' });
    expect(s.phase).toBe('reconnecting');
    s = reduce(s, { kind: 'reconnect_recovered' });
    expect(s.phase).toBe('ready');
    expect(shouldShowReconnectOverlay(s)).toBe(false);
    // readiness flags were never reset by the reconnecting entry — still set.
    expect(s.brainReady).toBe(true);
    expect(s.avatarReady).toBe(true);
  });

  it('reconnect_recovered preserves reconnectPromptCount (telemetry of how many overlays user saw)', () => {
    let s = reduce(ready(), { kind: 'pc_degraded' });
    s = reduce(s, { kind: 'reconnect_recovered' });
    expect(s.reconnectPromptCount).toBe(1);
  });

  it('reconnect_recovered is a no-op outside reconnecting (stale async retry must not resurrect)', () => {
    // From ready: no-op.
    const r = ready();
    expect(reduce(r, { kind: 'reconnect_recovered' })).toBe(r);
    // From closed: no-op — a retry that resolves after a real close must
    // not flip a closed session back to ready.
    let s = reduce(ready(), { kind: 'user_close' });
    s = reduce(s, { kind: 'closed_ack' });
    const after = reduce(s, { kind: 'reconnect_recovered' });
    expect(after.phase).toBe(s.phase);
  });

  it('reconnect_recovered can cycle: degrade → recover → degrade increments count each entry', () => {
    let s = reduce(ready(), { kind: 'pc_degraded' });
    s = reduce(s, { kind: 'reconnect_recovered' });
    s = reduce(s, { kind: 'video_autoplay_lost' });
    expect(s.phase).toBe('reconnecting');
    expect(s.reconnectPromptCount).toBe(2);
  });
});

describe('session-reducer — rollover (15-min cap)', () => {
  function ready(): SessionState {
    let s = boot();
    s = reduce(s, { kind: 'brain_ready' });
    s = reduce(s, { kind: 'avatar_ready' });
    return s;
  }

  it('rollover_complete resets readiness and phase to opening', () => {
    let s = ready();
    expect(s.phase).toBe('ready');
    s = reduce(s, {
      kind: 'rollover_complete',
      newSessionId: 'sess-2',
      tier: 'free',
      avatarStatus: 'minted',
      maxSessionSeconds: 900,
    });
    expect(s.phase).toBe('opening');
    expect(s.sessionId).toBe('sess-2');
    expect(s.brainReady).toBe(false);
    expect(s.avatarReady).toBe(false);
  });

  it('rollover_complete with avatar_status=skipped_tier does not block ready-gate', () => {
    let s = ready();
    s = reduce(s, {
      kind: 'rollover_complete',
      newSessionId: 'sess-2',
      tier: 'free',
      avatarStatus: 'skipped_tier',
      maxSessionSeconds: 900,
    });
    expect(s.avatarReady).toBe(true);
    // Gemini still needs to re-setup.
    s = reduce(s, { kind: 'brain_ready' });
    expect(s.phase).toBe('ready');
  });

  it('rollover_failed closes the session with error message', () => {
    const s = reduce(ready(), { kind: 'rollover_failed', message: 'gemini_rollover_failed' });
    expect(s.phase).toBe('closed');
    expect(s.errorMessage).toBe('gemini_rollover_failed');
  });
});

describe('session-reducer — close', () => {
  function ready(): SessionState {
    let s = boot();
    s = reduce(s, { kind: 'brain_ready' });
    s = reduce(s, { kind: 'avatar_ready' });
    return s;
  }

  it('user_close → closing → closed_ack → closed', () => {
    let s = reduce(ready(), { kind: 'user_close' });
    expect(s.phase).toBe('closing');
    s = reduce(s, { kind: 'closed_ack' });
    expect(s.phase).toBe('closed');
  });

  it('fatal_error → closed with message', () => {
    const s = reduce(ready(), { kind: 'fatal_error', message: 'boom' });
    expect(s.phase).toBe('closed');
    expect(s.errorMessage).toBe('boom');
  });

  it('all events after closed are no-ops', () => {
    let s = reduce(ready(), { kind: 'fatal_error', message: 'boom' });
    const before = s;
    s = reduce(s, { kind: 'brain_ready' });
    expect(s.phase).toBe('closed');
    s = reduce(s, { kind: 'visibility_hidden' });
    expect(s.phase).toBe('closed');
    s = reduce(s, { kind: 'pc_degraded' });
    expect(s.phase).toBe('closed');
    // errorMessage preserved
    expect(s.errorMessage).toBe(before.errorMessage);
  });
});

describe('session-reducer — invariants', () => {
  it('isPipeWarm holds for ready/listening/thinking/speaking/paused, false for opening/reconnecting/closed', () => {
    let s = boot();
    expect(isPipeWarm(s)).toBe(false); // opening
    s = reduce(s, { kind: 'brain_ready' });
    s = reduce(s, { kind: 'avatar_ready' });
    expect(isPipeWarm(s)).toBe(true); // ready
    s = reduce(s, { kind: 'mic_started' });
    expect(isPipeWarm(s)).toBe(true); // listening
    s = reduce(s, { kind: 'mic_stopped' });
    expect(s.phase).toBe('thinking');
    expect(isPipeWarm(s)).toBe(true); // thinking (P0-1)
    s = reduce(s, { kind: 'tts_audio_chunk' });
    expect(isPipeWarm(s)).toBe(true); // speaking
    s = reduce(s, { kind: 'pc_degraded' });
    expect(isPipeWarm(s)).toBe(false); // reconnecting
  });
});

describe('cartesia reconnecting (R3-Missing-6)', () => {
  function ready(): SessionState {
    let s = boot();
    s = reduce(s, { kind: 'brain_ready' });
    s = reduce(s, { kind: 'avatar_ready' });
    return s;
  }
  it('sets cartesiaReconnecting flag without changing phase', () => {
    let s = ready();
    expect(s.phase).toBe('ready');
    s = reduce(s, { kind: 'cartesia_reconnecting' });
    expect(s.cartesiaReconnecting).toBe(true);
    expect(s.phase).toBe('ready');
    s = reduce(s, { kind: 'cartesia_reconnected' });
    expect(s.cartesiaReconnecting).toBe(false);
    expect(s.phase).toBe('ready');
  });

  // FISH_AUDIO_PHASE_1 §6 round-3 C4 (audit M4) — auto-fallback mid-session
  // swap badge. Subtle banner only; phase unchanged.
  it('sets ttsProviderSwitching flag without changing phase', () => {
    let s = ready();
    expect(s.phase).toBe('ready');
    s = reduce(s, { kind: 'tts_provider_switching', from: 'fish', to: 'cartesia' });
    expect(s.ttsProviderSwitching).toBe(true);
    expect(s.phase).toBe('ready'); // audit S3 — phase preserved through switching
    expect(s.cartesiaReconnecting).toBe(false);
    s = reduce(s, { kind: 'tts_provider_switched' });
    expect(s.ttsProviderSwitching).toBe(false);
    expect(s.phase).toBe('ready'); // audit S3 — phase preserved through switched
  });

  // Audit M1 — short-circuit when flag already false. Dispatch on every
  // tts_audio_done in non-fallback sessions; reducer must return the SAME
  // state reference (no new object allocation) to avoid per-turn re-renders.
  it('tts_provider_switched returns same reference when flag already false (M1)', () => {
    const s = ready();
    expect(s.ttsProviderSwitching).toBe(false);
    const s2 = reduce(s, { kind: 'tts_provider_switched' });
    // identity check — reducer must short-circuit, not spread.
    expect(s2).toBe(s);
    expect(s2.phase).toBe('ready');
    expect(s2.cartesiaReconnecting).toBe(false);
  });
});

describe('video_autoplay_lost (R4-M5)', () => {
  function ready(): SessionState {
    let s = boot();
    s = reduce(s, { kind: 'brain_ready' });
    s = reduce(s, { kind: 'avatar_ready' });
    return s;
  }
  it('flips phase to reconnecting + bumps prompt count', () => {
    let s = ready();
    const before = s.reconnectPromptCount;
    s = reduce(s, { kind: 'video_autoplay_lost' });
    expect(s.phase).toBe('reconnecting');
    expect(s.reconnectPromptCount).toBe(before + 1);
  });
  it('is no-op when already closed', () => {
    let s = boot();
    s = reduce(s, { kind: 'fatal_error', message: 'x' });
    const before = s;
    s = reduce(s, { kind: 'video_autoplay_lost' });
    expect(s).toBe(before);
  });
});
