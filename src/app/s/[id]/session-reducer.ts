// Pure reducer for the session-pipe state machine. NO side effects here —
// the hook in use-session-pipe.ts reacts to state transitions and drives
// real DOM + network calls. Splitting this out lets us unit-test every
// transition without mocking React, audio, or WebRTC.
//
// States: idle → opening → ready → speaking | listening | paused | reconnecting
//         → closing → closed. Terminal: closed | error.
//
// Order is load-bearing: 'opening' waits for BOTH brain-ready (proxy WS
// setup-complete) AND avatar onReady (when avatar was minted). Missing
// either keeps us in 'opening' until timeout → 'reconnecting' or 'closed'.
//
// PR-2 (use-session-pipe rewire) renames the brain-side action kinds away
// from the `gemini_*` prefix — the proxy emits these signals, not Gemini
// directly, and CLAUDE.md forbids provider names leaking past the bridge.

export type PipeState =
  | 'idle'
  | 'opening'
  | 'ready'        // idle mid-conversation (neither side speaking)
  | 'listening'    // mic is streaming to brain
  | 'speaking'     // brain pipe is streaming TTS audio to the avatar bridge
  | 'paused'       // visibilitychange=hidden; mic stopped; pipes kept warm
  | 'reconnecting' // PC or WS degraded; user-gesture required
  | 'closing'
  | 'closed';

// Mutable counters / IDs live in state so the reducer is the single source
// of truth (tests can assert on them directly). Tokens are NOT stored here —
// they live in the hook's ref and never enter React state (R3-S2 surface).
export type SessionState = {
  phase: PipeState;
  sessionId: string | null;
  tier: 'free' | 'premium' | 'boardroom' | null;
  avatarStatus: 'pending' | 'minted' | 'skipped_tier' | 'failed_mint' | 'failed_connect' | 'not_applicable';
  // Whether the brain pipe (proxy WS) has completed its setup AND
  // (avatar is minted AND onReady fired) OR avatar not expected.
  // Renamed from `geminiReady` (PR-2) — reducer is provider-agnostic.
  brainReady: boolean;
  avatarReady: boolean;
  // Terminal error display string. Never contains tokens.
  errorMessage: string | null;
  // Count of user-visible reconnect prompts. For PostHog. Never decremented.
  reconnectPromptCount: number;
  // Server tells us the hard Gemini audio cap (default 900s). Client ticker
  // uses this to trigger rollover.
  maxSessionSeconds: number;
  // Absolute ms timestamp when session_open RPC returned. Null until 'opening'
  // succeeds. Used by the ticker to decide when to call /api/sessions/rollover.
  openedAtMs: number | null;
  // When paused began (performance.now()), cleared on resume. Pure bookkeeping
  // for the reducer; paused_seconds_total lives server-side.
  pausedAtMs: number | null;
  // R3-Missing-6 — Cartesia upstream is mid-reconnect. Avatar pipe stays
  // warm; UI surfaces a "Voice catching up…" banner. Cleared on
  // cartesia_reconnected.
  cartesiaReconnecting: boolean;
};

export type Action =
  // Initial boot — session_open envelope received, DOM elements wired.
  | { kind: 'boot_started' }
  | {
      kind: 'boot_envelope';
      sessionId: string;
      tier: 'free' | 'premium' | 'boardroom';
      avatarStatus: SessionState['avatarStatus'];
      maxSessionSeconds: number;
    }
  | { kind: 'brain_ready' }                  // proxy WS setup-complete
  | { kind: 'avatar_ready' }
  | { kind: 'avatar_not_expected' }          // skipped_tier | failed_mint | not_applicable
  | { kind: 'mic_started' }                  // user tapped mic / VAD activity
  | { kind: 'mic_stopped' }                  // user released / activityEnd
  | { kind: 'tts_audio_chunk' }              // first chunk of a model response
  | { kind: 'turn_complete' }
  | { kind: 'barge_in' }                     // brain cancels in-flight TTS — bridge.cancel happens in hook
  | { kind: 'visibility_hidden' }
  | { kind: 'visibility_visible' }
  | { kind: 'pc_degraded' }                  // iceConnectionState disconnected|failed
  | { kind: 'ws_closed'; wasClean: boolean }
  | { kind: 'audio_context_failed' }         // 300ms check after resume (R3-M4)
  | { kind: 'rollover_requested' }           // hit maxSessionSeconds
  | { kind: 'rollover_complete'; newSessionId: string; tier: 'free' | 'premium' | 'boardroom'; avatarStatus: SessionState['avatarStatus']; maxSessionSeconds: number }
  | { kind: 'rollover_failed'; message: string }
  | { kind: 'user_close' }
  | { kind: 'closed_ack' }
  | { kind: 'fatal_error'; message: string }
  // Proxy closed WS with 1011 reason=cogs_rpc_failed. Distinct from
  // fatal_error so analytics can count it; surfaces a retry-friendly copy.
  | { kind: 'cogs_failed' }
  // R3-Missing-6 — Cartesia upstream momentarily disconnected; proxy
  // auto-reconnects. Avatar stays visible muted; UI shows a banner.
  | { kind: 'cartesia_reconnecting' }
  | { kind: 'cartesia_reconnected' }
  // R4-M5 — silent <video>.play() rejection on iOS WebKit after a track
  // rebind without a fresh user activation. UX shows tap-to-resume overlay.
  | { kind: 'video_autoplay_lost' };

export const initialState: SessionState = {
  phase: 'idle',
  sessionId: null,
  tier: null,
  avatarStatus: 'pending',
  brainReady: false,
  avatarReady: false,
  errorMessage: null,
  reconnectPromptCount: 0,
  maxSessionSeconds: 900,
  openedAtMs: null,
  pausedAtMs: null,
  cartesiaReconnecting: false,
};

function bothPipesReady(s: SessionState): boolean {
  if (!s.brainReady) return false;
  // Avatar may be intentionally skipped — tier not eligible, or failed mint
  // with FORCE_AVATAR_REQUIRED=0 (voice-only fallback). In those cases
  // 'avatar_not_expected' sets avatarReady=true (treat as satisfied).
  return s.avatarReady;
}

export function reduce(state: SessionState, action: Action): SessionState {
  switch (action.kind) {
    case 'boot_started':
      if (state.phase !== 'idle') return state;
      return { ...state, phase: 'opening', errorMessage: null };

    case 'boot_envelope':
      return {
        ...state,
        sessionId: action.sessionId,
        tier: action.tier,
        avatarStatus: action.avatarStatus,
        maxSessionSeconds: action.maxSessionSeconds,
        openedAtMs: Date.now(),
      };

    case 'brain_ready': {
      if (state.phase === 'closed' || state.phase === 'closing') return state;
      const next = { ...state, brainReady: true };
      if (next.phase === 'opening' && bothPipesReady(next)) {
        return { ...next, phase: 'ready' };
      }
      return next;
    }

    case 'avatar_ready': {
      if (state.phase === 'closed' || state.phase === 'closing') return state;
      const next = { ...state, avatarReady: true, avatarStatus: 'minted' as const };
      if (next.phase === 'opening' && bothPipesReady(next)) {
        return { ...next, phase: 'ready' };
      }
      return next;
    }

    case 'avatar_not_expected': {
      // Voice-only path: treat avatar side of the gate as satisfied.
      if (state.phase === 'closed' || state.phase === 'closing') return state;
      const next = { ...state, avatarReady: true };
      if (next.phase === 'opening' && bothPipesReady(next)) {
        return { ...next, phase: 'ready' };
      }
      return next;
    }

    case 'mic_started':
      if (state.phase !== 'ready' && state.phase !== 'speaking') return state;
      return { ...state, phase: 'listening' };

    case 'mic_stopped':
      if (state.phase !== 'listening') return state;
      return { ...state, phase: 'ready' };

    case 'tts_audio_chunk':
      // Transitions listening → speaking on first model chunk; ignored mid-pause.
      if (state.phase === 'listening' || state.phase === 'ready') {
        return { ...state, phase: 'speaking' };
      }
      return state;

    case 'turn_complete':
      if (state.phase === 'speaking') return { ...state, phase: 'ready' };
      return state;

    case 'barge_in':
      // Brain cancels in-flight TTS. Hook calls bridge.cancel().
      // We stay in whatever phase we were in — if user is holding the mic
      // we're 'listening'; else 'ready'.
      return state;

    case 'visibility_hidden':
      if (state.phase === 'paused' || state.phase === 'closing' || state.phase === 'closed') return state;
      return { ...state, phase: 'paused', pausedAtMs: performance.now() };

    case 'visibility_visible':
      if (state.phase !== 'paused') return state;
      return { ...state, phase: 'ready', pausedAtMs: null };

    case 'pc_degraded':
    case 'ws_closed':
      if (state.phase === 'closed' || state.phase === 'closing') return state;
      return {
        ...state,
        phase: 'reconnecting',
        reconnectPromptCount: state.reconnectPromptCount + 1,
      };

    case 'audio_context_failed':
      // iOS WebKit: visibilitychange is not a user gesture; AudioContext stays
      // suspended. Prompt user to tap to reconnect (R3-M4).
      if (state.phase === 'closed' || state.phase === 'closing') return state;
      return {
        ...state,
        phase: 'reconnecting',
        reconnectPromptCount: state.reconnectPromptCount + 1,
      };

    case 'rollover_requested':
      // Don't flip phase here — the rollover fetch is in flight. Hook will
      // render a "Reconnecting…" overlay keyed off an internal isRollingOver
      // flag. We only flip on ack.
      return state;

    case 'rollover_complete':
      return {
        ...state,
        sessionId: action.newSessionId,
        tier: action.tier,
        avatarStatus: action.avatarStatus,
        maxSessionSeconds: action.maxSessionSeconds,
        openedAtMs: Date.now(),
        // New WS + new avatar session — reset readiness; the hook will wait
        // for brain_ready and avatar_ready again.
        brainReady: false,
        avatarReady: action.avatarStatus !== 'minted' && action.avatarStatus !== 'pending',
        phase: 'opening',
      };

    case 'rollover_failed':
      return {
        ...state,
        phase: 'closed',
        errorMessage: action.message,
      };

    case 'user_close':
      if (state.phase === 'closed' || state.phase === 'closing') return state;
      return { ...state, phase: 'closing' };

    case 'closed_ack':
      return { ...state, phase: 'closed' };

    case 'fatal_error':
      return { ...state, phase: 'closed', errorMessage: action.message };

    case 'cogs_failed':
      return {
        ...state,
        phase: 'closed',
        errorMessage: 'Cost accounting is unavailable. Please retry in a moment.',
      };

    case 'cartesia_reconnecting':
      // R3-Missing-6 — momentary upstream blip. Avatar pipe stays warm
      // (Simli RTC unaffected); UI surfaces a banner. Phase unchanged —
      // forcing 'reconnecting' would surface a tap-to-reconnect overlay
      // for what's actually a sub-second blip.
      return { ...state, cartesiaReconnecting: true };

    case 'cartesia_reconnected':
      return { ...state, cartesiaReconnecting: false };

    case 'video_autoplay_lost':
      // R4-M5 — silent <video>.play() rejection on iOS WebKit after a
      // track rebind. Surface tap-to-resume overlay via 'reconnecting'
      // — same UX shape, distinct telemetry already captured by the
      // session-client watcher.
      if (state.phase === 'closed' || state.phase === 'closing') return state;
      return {
        ...state,
        phase: 'reconnecting',
        reconnectPromptCount: state.reconnectPromptCount + 1,
      };
  }
}

// Pure helper for tests / UI. Does NOT live in state — caller derives.
export function shouldShowReconnectOverlay(state: SessionState): boolean {
  return state.phase === 'reconnecting';
}

export function isPipeWarm(state: SessionState): boolean {
  // Pipe-stays-warm invariant: once we reached 'ready' (or beyond) and have
  // not hit 'reconnecting' / 'closed', the avatar RTC + brain WS are both
  // live. Barge-in does NOT break this; interruption leaves both open.
  return (
    state.phase === 'ready' ||
    state.phase === 'listening' ||
    state.phase === 'speaking' ||
    state.phase === 'paused'
  );
}
