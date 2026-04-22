// Single source of truth for the COGS viewer's service/operation dropdowns
// AND the `/api/admin/cogs/historical` filter allowlist. Whenever a new op
// starts being written to cogs_log, add it here — otherwise the filter
// dropdown silently drops it (rows still aggregate via server-side grouping,
// but admins can't slice by the new op).
//
// Why a static allowlist and not `SELECT DISTINCT operation FROM cogs_log`:
//  - Bounds the filter surface for PostgREST (one free-text operation string
//    reaching `eq()` is fine, but a cap here is cheap defence-in-depth).
//  - Keeps the UI predictable even when cogs_log has zero rows.
//  - Forces a code change when the cost model changes — that change should
//    also update pricing in `.claude_learnings.md` and COST_QUOTED_AT pins.

export const ALLOWED_COGS_SERVICES = [
  'gemini',
  'cartesia',
  'simli',
  'tavus',
  'mux',
] as const;

export const ALLOWED_COGS_OPERATIONS = [
  // Pipeline α' — 4 voice legs (see CLAUDE.md § voice).
  'voice_audio_input_seconds',   // gemini
  'voice_audio_out_tokens',      // gemini
  'voice_tts_characters',        // cartesia
  'voice_tts_audio_seconds',     // cartesia (cost=0, drives minutes-per-day cap)
  // Avatar + video.
  'avatar_session_token_mint',
  'video_asset_create',
  'video_playback_seconds',
] as const;

export type CogsService = (typeof ALLOWED_COGS_SERVICES)[number];
export type CogsOperation = (typeof ALLOWED_COGS_OPERATIONS)[number];

export const ALLOWED_COGS_SERVICES_SET: ReadonlySet<string> = new Set(ALLOWED_COGS_SERVICES);
export const ALLOWED_COGS_OPERATIONS_SET: ReadonlySet<string> = new Set(ALLOWED_COGS_OPERATIONS);
