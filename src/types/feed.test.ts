import { describe, it, expect } from 'vitest';
import {
  feedHookSchema,
  feedEventSchema,
  FULL_VIDEO_OPEN_SOURCES,
  FULL_VIDEO_QUARTILES,
} from './feed';

describe('feedHookSchema — long_form_available', () => {
  const baseHook = {
    hook_id: '00000000-0000-0000-0000-000000000001',
    video_id: '00000000-0000-0000-0000-000000000002',
    creator_id: '00000000-0000-0000-0000-000000000003',
    creator_handle: 'handle',
    creator_name: 'Name',
    creator_avatar: null,
    video_title: 'V',
    lesson_number: 1,
    hook_title: null,
    hook_caption: null,
    hook_transcript: null,
    topic_tags: ['x'],
    mux_playback_id: 'pb',
    mux_aspect_ratio: '9:16',
    mux_duration_ms: 30000,
    duration_seconds: 30,
    opening_prompt: null,
    question_seeds: null,
    hook_created_at: new Date().toISOString(),
    score_total: 0.5,
    score_breakdown: null,
    served_rank: 0,
    cursor_epoch: 1234567890,
  };

  it('accepts long_form_available: true', () => {
    const r = feedHookSchema.safeParse({ ...baseHook, long_form_available: true });
    expect(r.success).toBe(true);
  });

  it('accepts long_form_available: false', () => {
    const r = feedHookSchema.safeParse({ ...baseHook, long_form_available: false });
    expect(r.success).toBe(true);
  });

  it('rejects missing long_form_available', () => {
    const r = feedHookSchema.safeParse(baseHook);
    expect(r.success).toBe(false);
  });

  it('rejects long_form_available as string', () => {
    const r = feedHookSchema.safeParse({ ...baseHook, long_form_available: 'true' });
    expect(r.success).toBe(false);
  });
});

describe('feedEventSchema — full_video_open source', () => {
  const baseEvent = {
    idempotency_key: '00000000-0000-0000-0000-000000000099',
    video_id: '00000000-0000-0000-0000-000000000002',
  };

  it('accepts source: pill', () => {
    const r = feedEventSchema.safeParse({
      ...baseEvent,
      event_name: 'full_video_open',
      payload: { source: 'pill' },
    });
    expect(r.success).toBe(true);
  });

  it.each(FULL_VIDEO_OPEN_SOURCES)('accepts source: %s', (src) => {
    const r = feedEventSchema.safeParse({
      ...baseEvent,
      event_name: 'full_video_open',
      payload: { source: src },
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown source', () => {
    const r = feedEventSchema.safeParse({
      ...baseEvent,
      event_name: 'full_video_open',
      payload: { source: 'unknown' },
    });
    expect(r.success).toBe(false);
  });

  it('accepts no source field (optional)', () => {
    const r = feedEventSchema.safeParse({
      ...baseEvent,
      event_name: 'full_video_open',
      payload: {},
    });
    expect(r.success).toBe(true);
  });
});

describe('feedEventSchema — full_video_quartile', () => {
  const baseEvent = {
    idempotency_key: '00000000-0000-0000-0000-00000000009a',
    video_id: '00000000-0000-0000-0000-000000000002',
  };

  it.each(FULL_VIDEO_QUARTILES)('accepts quartile: %i', (q) => {
    const r = feedEventSchema.safeParse({
      ...baseEvent,
      event_name: 'full_video_quartile',
      payload: { quartile: q, source: 'pill' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects quartile: 99', () => {
    const r = feedEventSchema.safeParse({
      ...baseEvent,
      event_name: 'full_video_quartile',
      payload: { quartile: 99, source: 'pill' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects quartile as string', () => {
    const r = feedEventSchema.safeParse({
      ...baseEvent,
      event_name: 'full_video_quartile',
      payload: { quartile: '50', source: 'pill' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects payload without quartile', () => {
    const r = feedEventSchema.safeParse({
      ...baseEvent,
      event_name: 'full_video_quartile',
      payload: { source: 'pill' },
    });
    expect(r.success).toBe(false);
  });
});
