import { describe, expect, it } from 'vitest';
import { SENSITIVE_KEY_RE, scrub } from './posthog-scrub';

describe('posthog-scrub', () => {
  it('drops keys matching sensitive substrings (case-insensitive)', () => {
    const out = scrub({
      token: 'abc',
      Token: 'abc',
      access_token: 'abc',
      ephemeral_token: 'abc',
      api_key: 'abc',
      API_KEY: 'abc',
      password: 'pw',
      Password: 'pw',
      bearer_creds: 'abc',
      jwt: 'eyJ…',
      Authorization: 'Bearer …',
      credential: 'abc',
      session_id: 'ok',
      hook_id: 'ok',
    });
    expect(out).toEqual({ session_id: 'ok', hook_id: 'ok' });
  });

  it('returns undefined for undefined input', () => {
    expect(scrub(undefined)).toBeUndefined();
  });

  it('returns an empty object if every prop is scrubbed', () => {
    expect(scrub({ token: 'x', jwt: 'y' })).toEqual({});
  });

  it('preserves values for safe keys', () => {
    expect(scrub({ creator_id: 'c1', lesson_number: 3, latency_ms: 420 }))
      .toEqual({ creator_id: 'c1', lesson_number: 3, latency_ms: 420 });
  });

  it('loose-matches author / monkey by design (false positive is acceptable)', () => {
    // R4-S4: tightening this regex to rescue these keys is a regression.
    // If one of these becomes legitimately load-bearing analytics, add an
    // allowlist exception — don't tune the regex.
    const out = scrub({ author: 'Vuk', monkey_count: 2, note: 'ok' });
    // Both author and monkey_count drop (author/auth; monkey/key). That's
    // the whole point — see the regex comment.
    expect(out).toEqual({ note: 'ok' });
    expect(SENSITIVE_KEY_RE.test('author')).toBe(true);
    expect(SENSITIVE_KEY_RE.test('monkey_count')).toBe(true); // matches /key/
    expect(SENSITIVE_KEY_RE.test('keyboard')).toBe(true);     // matches /key/
  });
});
