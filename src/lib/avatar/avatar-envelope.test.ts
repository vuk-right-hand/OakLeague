// Shape-guard coverage for the use-session-pipe rewire (PR-2).
// `isValidEnvelope` is wired into session-client.tsx readEnvelope so a
// stale envelope from a pre-deploy tab surfaces "Session expired" instead
// of crashing the hook on `args.envelope.voice.model` reads.

import { describe, it, expect } from 'vitest';
import { isValidEnvelope } from './avatar-envelope';

describe('isValidEnvelope (PR-2 stale-shape guard)', () => {
  function valid() {
    return {
      session_id: 'a1234567-1234-4abc-8def-fedcba987654',
      tier: 'free',
      avatar_provider: 'simli',
      avatar: null,
      avatar_status: 'minted',
      voice: { model: 'gemini-3.1-flash-live-preview' },
      voice_ticket: { ticket: 't', expiresAt: '2099-01-01T00:00:00Z' },
      proxy_url: 'wss://proxy.example/voice/spike-a',
      max_duration_s: 600,
      max_session_s: 900,
    };
  }

  it('accepts a fully-formed new-shape envelope', () => {
    expect(isValidEnvelope(valid())).toBe(true);
  });

  it('rejects null / non-object', () => {
    expect(isValidEnvelope(null)).toBe(false);
    expect(isValidEnvelope(undefined)).toBe(false);
    expect(isValidEnvelope('hello')).toBe(false);
    expect(isValidEnvelope(42)).toBe(false);
  });

  it('rejects pre-PR-2 shape with `gemini` instead of `voice`', () => {
    const old = valid() as Record<string, unknown>;
    delete old.voice;
    old.gemini = { token: 'tok', model: 'gemini-3.1-flash-live-preview' };
    expect(isValidEnvelope(old)).toBe(false);
  });

  it('rejects pre-PR-2 shape with nullable voice_ticket', () => {
    const old = valid() as Record<string, unknown>;
    old.voice_ticket = null;
    expect(isValidEnvelope(old)).toBe(false);
  });

  it('rejects pre-PR-2 shape with nullable proxy_url', () => {
    const old = valid() as Record<string, unknown>;
    old.proxy_url = null;
    expect(isValidEnvelope(old)).toBe(false);
  });

  it('rejects malformed voice (missing model)', () => {
    const env = valid() as Record<string, unknown>;
    env.voice = {};
    expect(isValidEnvelope(env)).toBe(false);
  });

  it('rejects malformed voice_ticket (missing expiresAt)', () => {
    const env = valid() as Record<string, unknown>;
    env.voice_ticket = { ticket: 't' };
    expect(isValidEnvelope(env)).toBe(false);
  });

  it('rejects missing session_id', () => {
    const env = valid() as Record<string, unknown>;
    delete env.session_id;
    expect(isValidEnvelope(env)).toBe(false);
  });

  it('rejects bogus tier (round-2 audit C3)', () => {
    const env = valid() as Record<string, unknown>;
    env.tier = 'enterprise';
    expect(isValidEnvelope(env)).toBe(false);
  });

  it('rejects missing tier (round-2 audit C3)', () => {
    const env = valid() as Record<string, unknown>;
    delete env.tier;
    expect(isValidEnvelope(env)).toBe(false);
  });

  it('rejects bogus avatar_status (round-2 audit C3)', () => {
    const env = valid() as Record<string, unknown>;
    env.avatar_status = 'connecting';
    expect(isValidEnvelope(env)).toBe(false);
  });

  it('accepts all six valid avatar_status enum values', () => {
    for (const s of ['pending', 'minted', 'skipped_tier', 'failed_mint', 'failed_connect', 'not_applicable']) {
      const env = { ...valid(), avatar_status: s };
      expect(isValidEnvelope(env)).toBe(true);
    }
  });
});
