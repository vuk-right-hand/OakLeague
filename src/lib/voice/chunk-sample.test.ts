// chunk-sample tests — pure-function chunker for sample_content.raw_text.

import { describe, expect, it } from 'vitest';
import { chunkSample } from './chunk-sample';

describe('chunkSample', () => {
  it('returns empty array for null/empty/whitespace input', () => {
    expect(chunkSample({ rawText: '', topicTags: ['t1'] })).toEqual([]);
    expect(chunkSample({ rawText: '   \n  \n', topicTags: ['t1'] })).toEqual([]);
  });

  it('returns one chunk for short text', () => {
    const text = 'This is a short paragraph that should fit in one chunk.';
    const chunks = chunkSample({ rawText: text, topicTags: ['mindset'] });
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain('short paragraph');
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].topicTags).toEqual(['mindset']);
    expect(chunks[0].tokenCount).toBeGreaterThan(0);
  });

  it('splits long text into multiple ~500-token chunks with overlap', () => {
    // ~3000 tokens of content (≈12000 chars). Should split into multiple chunks.
    const paragraph = 'This sentence has roughly twelve tokens worth of typical English prose. '.repeat(150);
    const chunks = chunkSample({ rawText: paragraph, topicTags: ['habits'] });
    expect(chunks.length).toBeGreaterThan(3);
    // Every chunk should respect the hard cap.
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(8000);
      expect(c.tokenCount).toBeLessThanOrEqual(2048);
    }
    // Chunks should have monotonic increasing indexes starting at 0.
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('propagates topic_tags unchanged on every chunk', () => {
    const tags = ['mindset', 'discipline', 'habits'];
    const longText = 'foo bar baz '.repeat(2000);
    const chunks = chunkSample({ rawText: longText, topicTags: tags });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.topicTags).toEqual(tags);
    }
  });

  it('hard-splits a single paragraph that exceeds 2048 tokens', () => {
    // Make a single paragraph (no double-newlines) that's >2048 tokens.
    const giant = 'lorem ipsum '.repeat(3000); // ~33K chars ≈ 8K tokens
    const chunks = chunkSample({ rawText: giant, topicTags: ['x'] });
    // Forced split should produce >= 2 chunks, none exceeding 2048 tokens.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(2048);
      expect(c.text.length).toBeLessThanOrEqual(8000);
    }
  });

  it('handles paragraph and sentence boundaries', () => {
    const text = [
      'First paragraph. Second sentence in first paragraph.',
      'Second paragraph with one sentence.',
      'Third paragraph. Fourth sentence here.',
    ].join('\n\n');
    const chunks = chunkSample({ rawText: text, topicTags: ['t'] });
    expect(chunks.length).toBeGreaterThan(0);
    // Each chunk's text should appear in the source after normalization.
    const normalized = text.replace(/\s+/g, ' ');
    for (const c of chunks) {
      const ct = c.text.replace(/\s+/g, ' ');
      // Allow substring match (chunks are concat'd segments)
      expect(normalized).toContain(ct.slice(0, 30));
    }
  });
});
