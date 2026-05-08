import { describe, expect, it } from 'vitest';
import { classifyPlatform, pickMime, priorityList } from './recording-mime';

describe('classifyPlatform', () => {
  it('detects iPhone', () => {
    expect(classifyPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'))
      .toBe('ios');
  });
  it('detects iPad (legacy UA)', () => {
    expect(classifyPlatform('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15'))
      .toBe('ios');
  });
  it('detects Android Chrome', () => {
    expect(classifyPlatform('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120'))
      .toBe('android');
  });
  it('detects desktop Chrome', () => {
    expect(classifyPlatform('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120'))
      .toBe('desktop');
  });
  it('detects desktop Safari', () => {
    expect(classifyPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Safari/605'))
      .toBe('desktop-safari');
  });
  it('falls back to unknown for empty UA', () => {
    expect(classifyPlatform('')).toBe('unknown');
  });
});

describe('priorityList', () => {
  it('iOS leads with mp4 (avc1+aac)', () => {
    const list = priorityList('ios');
    expect(list[0]).toMatch(/^video\/mp4/);
    expect(list.indexOf('video/webm;codecs=vp9,opus')).toBeGreaterThan(list.indexOf('video/mp4;codecs=avc1.42E01E,mp4a.40.2'));
  });
  it('desktop-safari also leads with mp4', () => {
    expect(priorityList('desktop-safari')[0]).toMatch(/^video\/mp4/);
  });
  it('android leads with mp4 (avc1+aac) — WhatsApp/etc refuse webm', () => {
    const list = priorityList('android');
    expect(list[0]).toMatch(/^video\/mp4/);
    // WebM still in the chain as last-resort fallback for old devices.
    expect(list).toContain('video/webm;codecs=vp9,opus');
    expect(list.indexOf('video/webm;codecs=vp9,opus')).toBeGreaterThan(list.indexOf('video/mp4;codecs=avc1.42E01E,mp4a.40.2'));
  });
  it('android falls back to webm if mp4 is not supported (degenerate browser)', () => {
    const supported = new Set(['video/webm;codecs=vp9,opus']);
    const result = pickMime(priorityList('android'), (m) => supported.has(m));
    expect(result?.container).toBe('webm');
  });
  it('android with full mp4+webm support picks mp4 (WhatsApp regression 2026-05-08)', () => {
    // Modern Android Chrome 113+ supports both — assert mp4 wins.
    const result = pickMime(priorityList('android'), () => true);
    expect(result?.container).toBe('mp4');
    expect(result?.mimeType).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
    expect(result?.extension).toBe('mp4');
  });
  it('desktop leads with webm/vp9', () => {
    expect(priorityList('desktop')[0]).toBe('video/webm;codecs=vp9,opus');
  });
  it('unknown defaults to webm priority', () => {
    expect(priorityList('unknown')[0]).toBe('video/webm;codecs=vp9,opus');
  });
});

describe('pickMime', () => {
  it('returns null when no candidate is supported', () => {
    expect(pickMime(['video/mp4', 'video/webm'], () => false)).toBeNull();
  });

  it('returns the first supported candidate', () => {
    const supported = new Set(['video/webm;codecs=vp8,opus']);
    const result = pickMime(
      ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/mp4'],
      (m) => supported.has(m),
    );
    expect(result).toEqual({
      mimeType: 'video/webm;codecs=vp8,opus',
      extension: 'webm',
      container: 'webm',
    });
  });

  it('classifies mp4 candidates correctly', () => {
    const result = pickMime(['video/mp4;codecs=avc1.42E01E,mp4a.40.2'], () => true);
    expect(result).toEqual({
      mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      extension: 'mp4',
      container: 'mp4',
    });
  });

  it('iOS path falls through to webm if mp4 is not supported (degenerate browser)', () => {
    const supported = new Set(['video/webm;codecs=vp9,opus']);
    const result = pickMime(priorityList('ios'), (m) => supported.has(m));
    expect(result?.container).toBe('webm');
  });
});
