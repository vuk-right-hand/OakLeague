// PostHog event registry — single source of truth for event names.
//
// Phase C B3.1: pre-rewire there were 20+ bare string literals across 7
// files calling captureSafe / captureServerSafe. One typo silently dropped
// a metric to the floor with no compile error and no runtime warning. The
// scrub regex catches accidental PII in PROPS but not in the EVENT NAME.
//
// This file enumerates every event we emit. captureSafe / captureServerSafe
// type their `event` parameter against the union below — a typo in a callsite
// fails typecheck. Adding a new event requires registering it here first.
//
// To add an event:
//   1. Pick the right group below (or add a new commented group).
//   2. Add the literal to the const object — key MUST equal value.
//   3. Caller can pass the literal directly; TypeScript narrows it.

// Session lifecycle (use-session-pipe + session-client) -----------------------
export const SessionLifecycleEvents = {
  session_open:             'session_open',
  session_ready:            'session_ready',
  session_close:            'session_close',
  ws_close:                 'ws_close',
  envelope_shape_mismatch:  'envelope_shape_mismatch',
} as const;

// Voice pipeline health (proxy + bridges) -------------------------------------
export const VoicePipelineEvents = {
  proxy_warning:         'proxy_warning',
  cartesia_reconnecting: 'cartesia_reconnecting',
  cartesia_reconnected:  'cartesia_reconnected',
} as const;

// Avatar (Simli) lipsync + RTC health -----------------------------------------
export const AvatarHealthEvents = {
  simli_video_stats:             'simli_video_stats',
  simli_clock_drift_ms:          'simli_clock_drift_ms',
  simli_lipsync_latency_ms:      'simli_lipsync_latency_ms',
  simli_video_paused_with_track: 'simli_video_paused_with_track',
} as const;

// User-experience signals -----------------------------------------------------
export const UxEvents = {
  user_perceived_response_ms: 'user_perceived_response_ms',
  daily_cap_hit:              'daily_cap_hit',
} as const;

// Feed / funnel surface (hook impressions, quartiles, ask-click, welcome) ---
// Pre-rewire these fired through `(window as any).posthog.capture` directly,
// bypassing scrub() and the registry. Migrated through captureSafe in the
// B3.1 audit-fix pass.
export const FeedFunnelEvents = {
  hook_view_start:       'hook_view_start',
  hook_ask_clicked:      'hook_ask_clicked',
  welcome_dismissed:     'welcome_dismissed',
  long_form_open:        'long_form_open',
  long_form_quartile:    'long_form_quartile',
  long_form_ask_clicked: 'long_form_ask_clicked',
} as const;

// Recording / React-button surface --------------------------------------------
export const RecordingEvents = {
  react_tap:                       'react_tap',
  react_armed:                     'react_armed',
  react_stopped:                   'react_stopped',
  react_capture_error:             'react_capture_error',
  react_permission_denied:         'react_permission_denied',
  react_recorder_construct_failed: 'react_recorder_construct_failed',
  react_save_clicked:              'react_save_clicked',
  react_share_opened:              'react_share_opened',
  react_share_completed:           'react_share_completed',
  react_ask_recording_stop:        'react_ask_recording_stop',
} as const;

// Server-only events (fired via captureServerSafe) ----------------------------
export const ServerEvents = {
  daily_cap_hit_fired:    'daily_cap_hit_fired',
  referral_first_session: 'referral_first_session',
  referral_landing:       'referral_landing',
} as const;

// ── Type unions ─────────────────────────────────────────────────────────────
// Client and server share a single combined union because both wrappers go
// through the same scrub() — the split is for code-organization, not
// authorization. A future captureClientOnly variant could narrow if needed.

export type ClientPostHogEvent =
  | (typeof SessionLifecycleEvents)[keyof typeof SessionLifecycleEvents]
  | (typeof VoicePipelineEvents)[keyof typeof VoicePipelineEvents]
  | (typeof AvatarHealthEvents)[keyof typeof AvatarHealthEvents]
  | (typeof UxEvents)[keyof typeof UxEvents]
  | (typeof FeedFunnelEvents)[keyof typeof FeedFunnelEvents]
  | (typeof RecordingEvents)[keyof typeof RecordingEvents];

export type ServerPostHogEvent =
  (typeof ServerEvents)[keyof typeof ServerEvents];

export type PostHogEvent = ClientPostHogEvent | ServerPostHogEvent;
