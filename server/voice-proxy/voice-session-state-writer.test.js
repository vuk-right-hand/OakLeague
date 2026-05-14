// voice-session-state-writer.test.js — Day-13 audit M4.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  persistLastAssistantResponse,
  VOICE_SESSION_STATE_MAX_CHARS,
  MIN_PERSIST_CHARS,
} from './voice-session-state-writer.js';

function mockSupabase(upsertResult) {
  const upsertSpy = async () => upsertResult;
  return {
    upsertCalls: [],
    from(_table) {
      return {
        upsert: (row, opts) => {
          this.upsertCalls.push({ row, opts });
          return upsertSpy();
        },
      };
    },
  };
}

test('returns null_session_id when sessionId missing — no DB call', async () => {
  const sb = mockSupabase({ error: null });
  const r = await persistLastAssistantResponse(sb, null, 'hello world long enough');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'null_session_id');
  assert.equal(sb.upsertCalls.length, 0);
});

test('returns too_short when text below MIN_PERSIST_CHARS — no DB call', async () => {
  const sb = mockSupabase({ error: null });
  const r = await persistLastAssistantResponse(sb, 'sess-1', 'too short');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too_short');
  assert.equal(sb.upsertCalls.length, 0);
});

test('boundary: text exactly MIN_PERSIST_CHARS long persists', async () => {
  const sb = mockSupabase({ error: null });
  const text = 'x'.repeat(MIN_PERSIST_CHARS);
  const r = await persistLastAssistantResponse(sb, 'sess-1', text);
  assert.equal(r.ok, true);
  assert.equal(sb.upsertCalls.length, 1);
});

test('truncates to VOICE_SESSION_STATE_MAX_CHARS', async () => {
  const sb = mockSupabase({ error: null });
  const huge = 'y'.repeat(VOICE_SESSION_STATE_MAX_CHARS + 1000);
  const r = await persistLastAssistantResponse(sb, 'sess-1', huge);
  assert.equal(r.ok, true);
  assert.equal(
    sb.upsertCalls[0].row.last_assistant_response.length,
    VOICE_SESSION_STATE_MAX_CHARS,
  );
});

test('upsert uses onConflict: session_id', async () => {
  const sb = mockSupabase({ error: null });
  const text = 'x'.repeat(MIN_PERSIST_CHARS);
  await persistLastAssistantResponse(sb, 'sess-1', text);
  assert.equal(sb.upsertCalls[0].opts.onConflict, 'session_id');
});

test('maps 23503 → fk_violation, fires onError', async () => {
  const sb = mockSupabase({ error: { code: '23503', message: 'fk' } });
  let captured = null;
  const r = await persistLastAssistantResponse(
    sb,
    'sess-1',
    'long enough reply text here',
    (err, ctx) => (captured = { err, ctx }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'fk_violation');
  assert.equal(captured.ctx.stage, 'voice_session_state_fk');
});

test('maps 23514 → check_violation', async () => {
  const sb = mockSupabase({ error: { code: '23514', message: 'check' } });
  const r = await persistLastAssistantResponse(
    sb,
    'sess-1',
    'long enough reply text here',
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'check_violation');
});

test('maps other errors → db_error', async () => {
  const sb = mockSupabase({ error: { code: '08000', message: 'conn err' } });
  const r = await persistLastAssistantResponse(
    sb,
    'sess-1',
    'long enough reply text here',
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'db_error');
});

test('does not throw on supabase-js crash', async () => {
  const sb = {
    from() {
      return {
        upsert: () => {
          throw new Error('boom');
        },
      };
    },
  };
  let captured = null;
  const r = await persistLastAssistantResponse(
    sb,
    'sess-1',
    'long enough reply text here',
    (err, ctx) => (captured = { err, ctx }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'db_error');
  assert.equal(captured.ctx.stage, 'voice_session_state_throw');
});
