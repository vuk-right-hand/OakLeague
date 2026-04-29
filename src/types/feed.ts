// Shared feed contract. The column list must match the RETURNS TABLE in
// supabase/migrations/20260503000010_feed_ranked_page_rpc.sql (and the
// anon variant in 20260503000014_d4_pre_cleanup.sql). If one moves, the
// other must move.

import { z } from 'zod';

// Runtime-validated feed hook shape. Matches the RETURNS TABLE of
// feed_ranked_page / feed_ranked_anon_page. Validated at the API boundary
// (S2) so a silent RPC column rename fails fast with a 500 at the edge
// instead of shipping broken data to the client.
export const feedHookSchema = z.object({
  hook_id: z.string(),
  video_id: z.string(),
  creator_id: z.string(),
  creator_handle: z.string(),
  creator_name: z.string(),
  creator_avatar: z.string().nullable(),
  video_title: z.string(),
  lesson_number: z.number(),
  hook_title: z.string().nullable(),
  hook_caption: z.string().nullable(),
  hook_transcript: z.string().nullable(),
  topic_tags: z.array(z.string()),
  mux_playback_id: z.string(),
  mux_aspect_ratio: z.string().nullable(),
  mux_duration_ms: z.number().nullable(),
  duration_seconds: z.number().nullable(),
  opening_prompt: z.string().nullable(),
  question_seeds: z.unknown(),
  hook_created_at: z.string(),
  score_total: z.number(),
  score_breakdown: z.record(z.unknown()).nullable(),
  served_rank: z.number(),
  cursor_epoch: z.number(),
  // Long-form viewer (plan §1.3 / §1.4). True iff the parent video has a
  // ready + published long-form asset. Drives the "Chat with @handle"
  // pill render in the feed; hook-only videos never show the pill.
  long_form_available: z.boolean(),
});

export type FeedHook = z.infer<typeof feedHookSchema>;

// welcome_hooks_public view shape. SSR-only read (not exposed via /api).
// Validated at the boundary for consistency with feedHookSchema (N2).
export const welcomeHookSchema = z.object({
  id: z.string(),
  creator_id: z.string(),
  video_id: z.string().nullable(),
  mux_playback_id: z.string(),
  mux_aspect_ratio: z.string().nullable(),
  mux_duration_ms: z.number().nullable(),
  duration_seconds: z.number().nullable(),
  transcript: z.string().nullable(),
  active: z.boolean(),
});

export type WelcomeHookRow = z.infer<typeof welcomeHookSchema>;

export type FeedPageResponse = {
  items: FeedHook[];
  cursor_epoch: number | null;
  has_more: boolean;
};

// ---- Event ingest contract -------------------------------------------------
//
// `feed_event_name` enum — see migration 0503-01. The RPC accepts a batch of
// at most 50 events per call; validation here mirrors the server-side checks
// so bad payloads 400 at the edge instead of round-tripping to Postgres.

export const FEED_EVENT_NAMES = [
  'hook_impression',
  'hook_dwell_end',
  'hook_swipe',
  'full_video_open',
  'full_video_quartile',
  'creator_carousel_open',
  'creator_carousel_hook_open',
  'mic_tap',
] as const;

export type FeedEventName = (typeof FEED_EVENT_NAMES)[number];

// M5: must mirror the mic_tap_outcome enum in migration 0503-01. Any value
// outside this set would be silently ignored by the scorer's cooldown CTE
// (payload->>'mic_tap_outcome' = 'session_opened') — but letting it through
// the API just makes it easier for a client to forge a cooldown against
// itself. Validate at the boundary.
export const MIC_TAP_OUTCOMES = [
  'session_opened',
  'kill_switch_blocked',
  'auth_required',
  'creator_not_ready',
  'unknown_error',
] as const;

// Long-form viewer event payload validation. The DB has a
// full_video_open_source enum (migration 0503-01) but feed_events_raw.payload
// is plain jsonb with no column-level enum check — zod is the contract.
// 'pill' is the new long-form viewer entry point.
export const FULL_VIDEO_OPEN_SOURCES = [
  'swipe',
  'carousel_hook',
  'creator_profile',
  'pill',
] as const;

// Quartile crossings emitted by <LongFormPlayer>. The cooldown CTE in
// 20260504000003 keys on (payload->>'quartile')::int — accepting anything
// other than these four values would either silently no-op (q!=25/50/75/100)
// or, in the case of bare q=25 within 60s of full_video_open, incorrectly
// suppress the 24h cooldown. Enforce here so a malformed client write
// never reaches Postgres's int coercion.
export const FULL_VIDEO_QUARTILES = [25, 50, 75, 100] as const;

const uuidString = z.string().uuid();

export const feedEventSchema = z
  .object({
    event_name: z.enum(FEED_EVENT_NAMES),
    idempotency_key: uuidString,
    hook_id: uuidString.optional(),
    video_id: uuidString.optional(),
    creator_id: uuidString.optional(),
    session_id: uuidString.optional(),
    session_id_if_opened: uuidString.optional(),
    payload: z.record(z.unknown()).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.event_name === 'mic_tap') {
      const outcome = val.payload?.mic_tap_outcome;
      if (outcome === undefined) return;
      if (typeof outcome !== 'string'
          || !(MIC_TAP_OUTCOMES as readonly string[]).includes(outcome)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payload', 'mic_tap_outcome'],
          message: `mic_tap_outcome must be one of ${MIC_TAP_OUTCOMES.join('|')}`,
        });
      }
      return;
    }
    if (val.event_name === 'full_video_open') {
      const source = val.payload?.source;
      if (source === undefined) return;
      if (typeof source !== 'string'
          || !(FULL_VIDEO_OPEN_SOURCES as readonly string[]).includes(source)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payload', 'source'],
          message: `full_video_open.source must be one of ${FULL_VIDEO_OPEN_SOURCES.join('|')}`,
        });
      }
      return;
    }
    if (val.event_name === 'full_video_quartile') {
      const q = val.payload?.quartile;
      if (typeof q !== 'number'
          || !(FULL_VIDEO_QUARTILES as readonly number[]).includes(q)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payload', 'quartile'],
          message: `full_video_quartile.quartile must be one of ${FULL_VIDEO_QUARTILES.join('|')}`,
        });
      }
      return;
    }
  });

export const feedEventsRequestSchema = z.object({
  events: z.array(feedEventSchema).min(1).max(50),
});

export type FeedEvent = z.infer<typeof feedEventSchema>;
export type FeedEventsRequest = z.infer<typeof feedEventsRequestSchema>;

export type FeedEventsResponse = {
  inserted: number;
  deduped: number;
  dead_zoned: number;
};
