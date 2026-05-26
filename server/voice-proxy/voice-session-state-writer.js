// voice-session-state-writer.js — proxy mirror of upsertSessionState from
// src/lib/voice/voice-session-state.ts.
//
// CONTRACT (Day-13 audit M4):
//   The proxy writes last_assistant_response AFTER turn_end_ack lands.
//   This is the durable-fallback path; the next turn's `kickoffRetrieval`
//   reads `lastAssistantResponse` from a proxy in-memory closure const
//   (audit C5) — NOT from this table. The DB write exists ONLY for the
//   case where the proxy WS is replaced mid-session (Gemini Live's 15-min
//   reopen, network blip → reconnect with same sessions.id).
//
// LENGTH GATE (Day-13 audit M4):
//   Only persist when text.length >= MIN_PERSIST_CHARS. A failed turn
//   (TTS partial, transcript_runaway, model error) emits a short or empty
//   outputTranscript; persisting that nukes the prior known-good context
//   and poisons turn N+1's rewrite. "Last known good" is the contract,
//   not "last attempted."
//
// FIRE-AND-FORGET:
//   This module never throws. Errors are logged via the passed-in
//   `onError` callback (which the proxy wires to Sentry) and the function
//   resolves to a typed result for telemetry.
//
// ERROR MAPPING:
//   Mirrors UpsertSessionStateResult from the TS sibling:
//     23503 → fk_violation
//     23514 → check_violation
//     other → db_error

export const VOICE_SESSION_STATE_MAX_CHARS = 4000;

/**
 * Minimum length below which we treat the input as "failed turn" and
 * DO NOT persist. 20 chars matches the proxy's `shortUtterance` filter
 * threshold elsewhere — same "is this a real reply?" heuristic.
 */
export const MIN_PERSIST_CHARS = 20;

function truncate(v, max) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return null;
  return v.length <= max ? v : v.slice(0, max);
}

/**
 * Persist last_assistant_response for a session.
 *
 * Args:
 *   supabase:    service-role client
 *   sessionId:   sessions.id (non-null required)
 *   text:        the assistant's last reply
 *   onError?:    optional error callback (Sentry capture)
 *
 * Returns:
 *   { ok: true } on success
 *   { ok: false, reason: 'null_session_id' | 'too_short' | 'fk_violation' |
 *                         'check_violation' | 'db_error', detail? }
 */
export async function persistLastAssistantResponse(
  supabase,
  sessionId,
  text,
  onError,
) {
  if (!sessionId) return { ok: false, reason: 'null_session_id' };
  if (typeof text !== 'string' || text.length < MIN_PERSIST_CHARS) {
    // Audit M4: failed turns produce empty / fragment outputs. Don't
    // overwrite the prior known-good response.
    return { ok: false, reason: 'too_short' };
  }
  const truncated = truncate(text, VOICE_SESSION_STATE_MAX_CHARS);
  try {
    const { error } = await supabase
      .from('voice_session_state')
      .upsert(
        { session_id: sessionId, last_assistant_response: truncated },
        { onConflict: 'session_id' },
      );
    if (!error) return { ok: true };
    if (error.code === '23503') {
      if (onError) onError(error, { stage: 'voice_session_state_fk' });
      return { ok: false, reason: 'fk_violation', detail: error.message };
    }
    if (error.code === '23514') {
      if (onError) onError(error, { stage: 'voice_session_state_check' });
      return { ok: false, reason: 'check_violation', detail: error.message };
    }
    if (onError) onError(error, { stage: 'voice_session_state_db' });
    return { ok: false, reason: 'db_error', detail: error.message };
  } catch (e) {
    // Network / supabase-js crash. Never throw out of this fn.
    if (onError) onError(e, { stage: 'voice_session_state_throw' });
    return { ok: false, reason: 'db_error', detail: e?.message ?? 'unknown' };
  }
}
