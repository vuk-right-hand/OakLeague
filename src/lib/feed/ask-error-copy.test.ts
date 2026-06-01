import { describe, it, expect } from 'vitest';
import {
  resolveAskErrorDisplay,
  GENERIC_ASK_ERROR_COPY,
  CAP_HIT_CODES,
} from './ask-error-copy';

describe('resolveAskErrorDisplay', () => {
  it('returns null for falsy error (pill hidden)', () => {
    expect(resolveAskErrorDisplay(null)).toBeNull();
    expect(resolveAskErrorDisplay(undefined)).toBeNull();
    expect(resolveAskErrorDisplay('')).toBeNull();
  });

  it('maps every cap code to the cap render (upgrade link)', () => {
    for (const code of CAP_HIT_CODES) {
      expect(resolveAskErrorDisplay(code)).toEqual({ kind: 'cap' });
    }
  });

  it('maps creator-not-ready codes to friendly creator copy', () => {
    for (const code of [
      'brain_not_ready',
      'creator_not_published',
      'creator_not_found',
      'creator_lookup_failed',
    ]) {
      const d = resolveAskErrorDisplay(code);
      expect(d?.kind).toBe('message');
      expect(d && d.kind === 'message' && d.text).toMatch(/isn.t ready to chat yet/i);
      // P0-2 invariant: the raw code never appears in the copy.
      expect(d && d.kind === 'message' && d.text).not.toContain(code);
    }
  });

  it('maps profile + busy-elsewhere codes to their own copy', () => {
    const profile = resolveAskErrorDisplay('profile_not_ready');
    expect(profile).toEqual({ kind: 'message', text: expect.stringMatching(/profile/i) });

    for (const code of ['live_session_other_creator', 'session_takeover_inconsistent']) {
      const d = resolveAskErrorDisplay(code);
      expect(d?.kind).toBe('message');
      expect(d && d.kind === 'message' && d.text).toMatch(/another session open/i);
    }
  });

  it('preserves the existing distinct voice/creator copy', () => {
    expect(resolveAskErrorDisplay('creator_voice_not_trained')).toEqual({
      kind: 'message',
      text: expect.stringMatching(/voice isn.t ready/i),
    });
    expect(resolveAskErrorDisplay('creator_not_ready')).toEqual({
      kind: 'message',
      text: expect.stringMatching(/isn.t fully set up/i),
    });
  });

  it('NEVER prints a raw code — every unmapped code falls to the generic fallback', () => {
    for (const code of [
      'voice_proxy_unreachable',
      'proxy_url_unconfigured',
      'voice_ticket_mint_failed',
      'gemini_mint_failed',
      'tts_provider_snapshot_read_failed',
      'session_open_empty',
      'avatar_unavailable',
      'bad_origin',
      'unauthorized',
      'network',
      'some_brand_new_code_we_never_saw',
    ]) {
      const d = resolveAskErrorDisplay(code);
      expect(d).toEqual({ kind: 'message', text: GENERIC_ASK_ERROR_COPY });
      // The raw machine code must be absent from what the user sees.
      expect(d && d.kind === 'message' && d.text).not.toContain(code);
    }
  });
});
