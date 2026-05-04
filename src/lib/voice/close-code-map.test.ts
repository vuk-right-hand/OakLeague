import { describe, it, expect } from 'vitest';
import { closeCodeToFriendlyMessage } from './close-code-map';

describe('closeCodeToFriendlyMessage', () => {
  it('4009 → voice_not_ready, non-retryable', () => {
    const m = closeCodeToFriendlyMessage(4009);
    expect(m.kind).toBe('voice_not_ready');
    expect(m.retryable).toBe(false);
    expect(m.body).toContain('voice clip');
  });

  it('4011 → tts_blip, retryable', () => {
    expect(closeCodeToFriendlyMessage(4011).kind).toBe('tts_blip');
    expect(closeCodeToFriendlyMessage(4011).retryable).toBe(true);
  });

  it('4012 → too_slow, retryable, network hint', () => {
    const m = closeCodeToFriendlyMessage(4012);
    expect(m.kind).toBe('too_slow');
    expect(m.body).toMatch(/wifi/i);
  });

  it('4010 → misconfig, retryable', () => {
    expect(closeCodeToFriendlyMessage(4010).kind).toBe('misconfig');
  });

  it('1008 quota_exceeded → cost_kill, non-retryable', () => {
    const m = closeCodeToFriendlyMessage(1008, 'quota_exceeded');
    expect(m.kind).toBe('cost_kill');
    expect(m.retryable).toBe(false);
  });

  it('1008 kill_switch_fired → cost_kill', () => {
    expect(closeCodeToFriendlyMessage(1008, 'kill_switch_fired').kind).toBe('cost_kill');
  });

  it('1008 with unknown reason → reconnecting', () => {
    expect(closeCodeToFriendlyMessage(1008, 'foo').kind).toBe('reconnecting');
  });

  it('1011 cogs_misconfig → misconfig non-retryable', () => {
    const m = closeCodeToFriendlyMessage(1011, 'cogs_misconfig');
    expect(m.kind).toBe('misconfig');
    expect(m.retryable).toBe(false);
  });

  it('1011 tts_failed → tts_blip', () => {
    expect(closeCodeToFriendlyMessage(1011, 'tts_failed').kind).toBe('tts_blip');
  });

  it('unknown code → fatal', () => {
    expect(closeCodeToFriendlyMessage(9999).kind).toBe('fatal');
  });
});

import { warningCodeToMessage } from './close-code-map';

describe('warningCodeToMessage', () => {
  it('slow_connection → silent (breadcrumb only)', () => {
    expect(warningCodeToMessage('slow_connection').toast).toBeNull();
  });
  it('response_truncated → user toast', () => {
    const m = warningCodeToMessage('response_truncated');
    expect(m.toast).not.toBeNull();
    expect(m.toast!.title).toMatch(/cut off/i);
  });
  it('unknown warning → silent', () => {
    expect(warningCodeToMessage('something_new').toast).toBeNull();
  });
});
