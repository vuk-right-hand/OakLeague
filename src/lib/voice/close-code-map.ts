// U-C1 — WS close-code → user-facing friendly message map.
//
// Today's production session client (use-session-pipe.ts) talks directly to
// Gemini Live via @google/genai SDK and never observes the proxy's close
// codes. Once #3 (use-session-pipe.ts rewire through the Fly proxy) lands,
// the WS `onclose(ev)` handler reads `ev.code` and routes to
// `closeCodeToFriendlyMessage(code, reason)` for the toast/overlay copy.
//
// The proxy's documented close codes live in
// server/voice-proxy/index.js:11-29. Keep this map and that header in sync.

export type FriendlyKind =
  | 'reconnecting'   // transient; client may retry
  | 'cost_kill'      // quota latched; user must wait or upgrade
  | 'voice_not_ready'// creator not yet trained (4009)
  | 'misconfig'      // model gate (4010), cogs misconfig (1011 cogs_misconfig)
  | 'tts_blip'       // 4011 reconnecting, 1011 tts_failed — short retry-OK
  | 'too_slow'       // 4012 backpressure
  | 'unauthorized'   // 4001/4004
  | 'fatal';         // unhandled

export type FriendlyMessage = {
  kind: FriendlyKind;
  title: string;
  body: string;
  retryable: boolean;
};

export function closeCodeToFriendlyMessage(code: number, reason?: string): FriendlyMessage {
  const r = String(reason || '').toLowerCase();

  // 4xxx — application close codes from the proxy.
  switch (code) {
    case 4001: // invalid_ticket
      return { kind: 'unauthorized', title: 'Session token expired', body: 'Try opening this hook again.', retryable: true };
    case 4002: // session_already_active
      return { kind: 'reconnecting', title: 'Already connected', body: 'Another tab has this session open. Close it and try again.', retryable: true };
    case 4003: // kill_switch_fired
      return { kind: 'cost_kill', title: "You've hit today's voice limit", body: "Voice resets at midnight. Upgrade for more time per day.", retryable: false };
    case 4004: // bad_request
      return { kind: 'unauthorized', title: 'Session request rejected', body: 'Try refreshing the page.', retryable: true };
    case 4005: // upstream_error
      return { kind: 'reconnecting', title: 'Connection issue', body: 'The voice service hiccuped — tap to retry.', retryable: true };
    case 4006: // quota_state_inconsistent
      return { kind: 'cost_kill', title: 'Voice paused', body: "Your usage record is being rebuilt — please try again in a minute.", retryable: true };
    case 4009: // cartesia_no_voice
      return {
        kind: 'voice_not_ready',
        title: 'Voice not yet trained',
        body: "This creator hasn't recorded their voice clip yet. Check back later.",
        retryable: false,
      };
    case 4010: // model_not_compatible
      return {
        kind: 'misconfig',
        title: 'Voice service unavailable',
        body: 'The voice pipeline is being updated — please retry shortly.',
        retryable: true,
      };
    case 4011: // tts_reconnecting
      return {
        kind: 'tts_blip',
        title: 'Voice reconnecting',
        body: 'One moment — tap to talk again.',
        retryable: true,
      };
    case 4012: // backpressure
      return {
        kind: 'too_slow',
        title: 'Connection too slow',
        body: 'Your network can\'t keep up with the voice stream. Try WiFi.',
        retryable: true,
      };
  }

  // Native WS codes.
  if (code === 1000) return { kind: 'reconnecting', title: 'Disconnected', body: 'Tap to reconnect.', retryable: true };
  if (code === 1008) {
    if (r.includes('quota_exceeded') || r.includes('kill_switch')) {
      return { kind: 'cost_kill', title: "You've hit today's voice limit", body: 'Voice resets at midnight. Upgrade for more time per day.', retryable: false };
    }
    return { kind: 'reconnecting', title: 'Rate limited', body: 'Try again in a minute.', retryable: true };
  }
  if (code === 1011) {
    if (r.includes('tts_failed') || r.includes('tts_reconnecting')) {
      return { kind: 'tts_blip', title: 'Voice reconnecting', body: 'One moment — tap to talk again.', retryable: true };
    }
    if (r.includes('cogs_misconfig')) {
      return { kind: 'misconfig', title: 'Voice service unavailable', body: 'A configuration check failed. We\'ve been notified.', retryable: false };
    }
    return { kind: 'reconnecting', title: 'Connection interrupted', body: 'Tap to reconnect.', retryable: true };
  }
  if (code === 1006) return { kind: 'reconnecting', title: 'Connection dropped', body: 'Tap to reconnect.', retryable: true };

  return { kind: 'fatal', title: 'Voice unavailable', body: 'Please refresh the page.', retryable: false };
}

// R3-C2 (UX) — proxy emits `{type:'warning', code:'<x>'}` for non-fatal
// runtime hiccups (slow_connection, response_truncated). The session
// client (#3 wire-up) calls into this map from its WS message dispatcher
// to render a transient toast. Returns null when the warning shouldn't
// be user-facing (Sentry breadcrumb only).
export type WarningMessage = {
  /** When non-null, the toast copy. null = silent (breadcrumb only). */
  toast: { title: string; body: string } | null;
};

export function warningCodeToMessage(code: string): WarningMessage {
  switch (code) {
    case 'slow_connection':
      // 1MB threshold pre-disconnect: silent + breadcrumb so the user
      // doesn't get spammed if it self-corrects.
      return { toast: null };
    case 'response_truncated':
      return {
        toast: {
          title: 'Response cut off',
          body: 'The voice service was slow — try asking again.',
        },
      };
  }
  return { toast: null };
}
