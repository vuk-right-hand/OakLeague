// voice-session-state.ts — per-session conversation memory client.
//
// Wraps the voice_session_state table (Day 8 MIG-4). RLS is deny-all so
// callers MUST pass a service-role Supabase client.
//
// Load-bearing contract (Day-8 MIG-4 header): the proxy must reuse the
// same sessions.id across Gemini Live reopens — only the WS cycles.
// Without that, this table's "tell me more about that" survival promise
// is broken. Day-9 wiring + Day-12 integration test must enforce.
//
// Error policy: this module does NOT silently swallow DB errors.
// CLAUDE.md "don't silently catch in voice connect" applies. upsert
// returns a typed Result; caller decides whether to fire-and-forget
// (proxy hot path) or surface a 4xxx close (admin tooling).
//
// Truncation: CHECK constraints in the DB cap both columns at 2000
// chars. We truncate client-side too so a malformed input doesn't
// burn a network round-trip on a 23514.
//
// NOT exported: clearSessionState. sessions.id ON DELETE CASCADE
// handles row cleanup; the 7-day pg_cron purge handles abandoned rows.

import type { SupabaseClient } from '@supabase/supabase-js';

// Final-cross audit M2: bumped from 2000 → 4000 to match Gemini Live's
// outputTranscript per-turn cap (CLAUDE.md OUTPUT_TRANSCRIPT_MAX_CHARS).
// At 2000 we silently truncated 30%+ of a long assistant reply, breaking
// pronoun resolution on the next "tell me more" turn. Migration
// 20260521000010 widens the DB CHECK constraints to match.
export const VOICE_SESSION_STATE_MAX_CHARS = 4000;

export type VoiceSessionStateRow = {
  lastAssistantResponse: string | null;
  lastUserQuery: string | null;
  updatedAt: string; // ISO timestamp
};

export type UpsertSessionStateResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'db_error'
        | 'fk_violation' // session_id doesn't exist in sessions
        | 'check_violation' // CHECK constraint (caller exceeded 2000 even after truncation? shouldn't happen)
        | 'null_session_id';
      detail?: string;
    };

/**
 * Read the current session state. Returns null on miss (no row written yet,
 * or row was purged by the 7-day inactivity job).
 */
export async function readSessionState(
  client: SupabaseClient,
  sessionId: string,
): Promise<VoiceSessionStateRow | null> {
  if (!sessionId) return null;

  const { data, error } = await client
    .from('voice_session_state')
    .select('last_assistant_response, last_user_query, updated_at')
    .eq('session_id', sessionId)
    .maybeSingle();

  if (error) {
    // PGRST116 (no rows) is handled by maybeSingle returning data=null.
    // Other errors propagate so callers can decide.
    throw new VoiceSessionStateError('read_failed', error.message);
  }

  if (!data) return null;

  return {
    lastAssistantResponse: data.last_assistant_response ?? null,
    lastUserQuery: data.last_user_query ?? null,
    updatedAt: data.updated_at,
  };
}

/**
 * UPSERT the session state. Truncates input to VOICE_SESSION_STATE_MAX_CHARS.
 *
 * Returns a typed Result. Caller decides what to do with failures:
 *   - proxy hot path on turn_complete: log the .ok=false case, continue
 *     (fire-and-forget — failing this once is acceptable; the next turn
 *      will overwrite)
 *   - admin tooling: surface the reason
 *
 * This function never throws. It returns ok=false on every error path.
 */
export async function upsertSessionState(
  client: SupabaseClient,
  sessionId: string,
  patch: {
    lastAssistantResponse?: string | null;
    lastUserQuery?: string | null;
  },
): Promise<UpsertSessionStateResult> {
  if (!sessionId) {
    return { ok: false, reason: 'null_session_id' };
  }

  // Build the row. Only include columns the caller explicitly set so we
  // don't accidentally NULL out a value another path wrote.
  //
  // Use `!== undefined` instead of `'key' in patch` (Day-9-final audit M3):
  // a caller passing `{ lastAssistantResponse: undefined, lastUserQuery: 'q' }`
  // would otherwise destroy memory written by the prior turn. With strict
  // undefined check, an explicit `undefined` is treated as "don't touch."
  // A caller wanting to clear a column must pass `null` explicitly.
  const row: Record<string, unknown> = { session_id: sessionId };
  if (patch.lastAssistantResponse !== undefined) {
    row.last_assistant_response = truncate(
      patch.lastAssistantResponse,
      VOICE_SESSION_STATE_MAX_CHARS,
    );
  }
  if (patch.lastUserQuery !== undefined) {
    row.last_user_query = truncate(patch.lastUserQuery, VOICE_SESSION_STATE_MAX_CHARS);
  }

  const { error } = await client
    .from('voice_session_state')
    .upsert(row, { onConflict: 'session_id' });

  if (!error) return { ok: true };

  // Map known Postgres SQLSTATE codes that surface through PostgREST.
  // - 23503: foreign_key_violation (session_id not in sessions)
  // - 23514: check_violation (post-truncation overflow — shouldn't happen)
  if (error.code === '23503') return { ok: false, reason: 'fk_violation', detail: error.message };
  if (error.code === '23514') return { ok: false, reason: 'check_violation', detail: error.message };
  return { ok: false, reason: 'db_error', detail: error.message };
}

function truncate(v: string | null | undefined, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (v.length <= max) return v;
  return v.slice(0, max);
}

export class VoiceSessionStateError extends Error {
  constructor(
    public readonly code: 'read_failed',
    message: string,
  ) {
    super(message);
    this.name = 'VoiceSessionStateError';
  }
}
