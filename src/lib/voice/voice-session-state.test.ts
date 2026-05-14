// voice-session-state.test.ts — vitest for the per-session memory client.
//
// Coverage:
//   read:
//     1. Empty session_id → null
//     2. Miss (PGRST116-equivalent: maybeSingle returns data=null) → null
//     3. Hit returns mapped row shape
//     4. DB error (non-miss) → throws VoiceSessionStateError
//   upsert:
//     5. Empty session_id → ok:false reason:null_session_id (no DB call)
//     6. Both fields present + within cap → ok:true
//     7. Only assistant set → only that column written (no NULL on user side)
//     8. Truncation: 2500-char input → DB sees 2000-char payload
//     9. FK violation (23503) → ok:false reason:fk_violation
//    10. CHECK violation (23514) → ok:false reason:check_violation
//    11. Generic DB error → ok:false reason:db_error
//   vanilla-Node import:
//    12. The module loads outside the Next.js runtime (no 'server-only').

import { describe, it, expect, vi } from 'vitest';
import {
  readSessionState,
  upsertSessionState,
  VoiceSessionStateError,
  VOICE_SESSION_STATE_MAX_CHARS,
} from './voice-session-state';

// Minimal SupabaseClient stand-in. We only need .from(...) returning a
// chainable that resolves to { data, error }.
type FromHandler = (table: string) => Record<string, unknown>;
function mockClient(impl: FromHandler) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: vi.fn(impl) } as any;
}

describe('readSessionState', () => {
  it('returns null for empty sessionId without hitting the client', async () => {
    const client = mockClient(() => {
      throw new Error('should not be called');
    });
    expect(await readSessionState(client, '')).toBeNull();
  });

  it('returns null on miss (maybeSingle returns data=null)', async () => {
    const client = mockClient(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }));
    expect(await readSessionState(client, 'sess-1')).toBeNull();
  });

  it('returns mapped row on hit', async () => {
    const client = mockClient(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              last_assistant_response: 'hello there',
              last_user_query: 'tell me more',
              updated_at: '2026-05-14T10:00:00Z',
            },
            error: null,
          }),
        }),
      }),
    }));
    expect(await readSessionState(client, 'sess-1')).toEqual({
      lastAssistantResponse: 'hello there',
      lastUserQuery: 'tell me more',
      updatedAt: '2026-05-14T10:00:00Z',
    });
  });

  it('throws VoiceSessionStateError on non-miss DB error', async () => {
    const client = mockClient(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: null,
            error: { code: '08000', message: 'connection_exception' },
          }),
        }),
      }),
    }));
    await expect(readSessionState(client, 'sess-1')).rejects.toBeInstanceOf(
      VoiceSessionStateError,
    );
  });
});

describe('upsertSessionState', () => {
  function makeUpsertClient(error: { code?: string; message: string } | null) {
    const upsertSpy = vi.fn(async () => ({ data: null, error }));
    const client = mockClient(() => ({ upsert: upsertSpy }));
    return { client, upsertSpy };
  }

  it('returns null_session_id without hitting the client', async () => {
    const client = mockClient(() => {
      throw new Error('should not be called');
    });
    const r = await upsertSessionState(client, '', { lastAssistantResponse: 'x' });
    expect(r).toEqual({ ok: false, reason: 'null_session_id' });
  });

  it('writes both fields on success', async () => {
    const { client, upsertSpy } = makeUpsertClient(null);
    const r = await upsertSessionState(client, 'sess-1', {
      lastAssistantResponse: 'A',
      lastUserQuery: 'Q',
    });
    expect(r).toEqual({ ok: true });
    expect(upsertSpy).toHaveBeenCalledWith(
      {
        session_id: 'sess-1',
        last_assistant_response: 'A',
        last_user_query: 'Q',
      },
      { onConflict: 'session_id' },
    );
  });

  it('only writes columns the caller set (in-object check)', async () => {
    const { client, upsertSpy } = makeUpsertClient(null);
    await upsertSessionState(client, 'sess-1', { lastAssistantResponse: 'A' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = (upsertSpy.mock.calls as any[])[0][0] as Record<string, unknown>;
    expect(row).toHaveProperty('last_assistant_response', 'A');
    expect(row).not.toHaveProperty('last_user_query');
  });

  it('truncates oversize input to VOICE_SESSION_STATE_MAX_CHARS', async () => {
    const { client, upsertSpy } = makeUpsertClient(null);
    const long = 'x'.repeat(VOICE_SESSION_STATE_MAX_CHARS + 500);
    await upsertSessionState(client, 'sess-1', { lastAssistantResponse: long });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = (upsertSpy.mock.calls as any[])[0][0] as Record<string, unknown>;
    expect((row.last_assistant_response as string).length).toBe(
      VOICE_SESSION_STATE_MAX_CHARS,
    );
  });

  it('maps 23503 to fk_violation', async () => {
    const { client } = makeUpsertClient({
      code: '23503',
      message: 'fk violation on session_id',
    });
    const r = await upsertSessionState(client, 'orphan', { lastUserQuery: 'q' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('fk_violation');
      expect(r.detail).toContain('fk violation');
    }
  });

  it('maps 23514 to check_violation', async () => {
    const { client } = makeUpsertClient({
      code: '23514',
      message: 'check violation on column',
    });
    const r = await upsertSessionState(client, 'sess', { lastUserQuery: 'q' });
    if (!r.ok) expect(r.reason).toBe('check_violation');
    else throw new Error('expected ok:false');
  });

  it('maps unknown error to db_error', async () => {
    const { client } = makeUpsertClient({
      code: '08006',
      message: 'connection failure',
    });
    const r = await upsertSessionState(client, 'sess', { lastUserQuery: 'q' });
    if (!r.ok) expect(r.reason).toBe('db_error');
    else throw new Error('expected ok:false');
  });
});

describe('module is vanilla-Node-importable (no server-only)', () => {
  // The Day-9 audit (C3) flagged this as a deferred-time-bomb. If someone
  // adds `import 'server-only'` to this file, this test fails at vitest
  // time — not at first-prod-session.
  it('exports the expected surface and was loaded in a Node-only test runtime', () => {
    expect(typeof readSessionState).toBe('function');
    expect(typeof upsertSessionState).toBe('function');
    expect(VOICE_SESSION_STATE_MAX_CHARS).toBe(2000);
  });
});
