// section-segment tests — pure-text, deterministic segmentation for RAG v3.
//
// The contract this proves (RAG_SCALING_V3_PLAN.md §2.2):
//   • Structural cue present (markdown headings, "Chapter N", numbered, form-feed,
//     transcript timestamps) → split AT cues, each cue starts a section.
//   • No structural cue → paragraph-pack into ~targetTokens windows; never split
//     a paragraph mid-content.
//   • Hard rule: ZERO sections > safeMaxTokens in the output. Oversize source
//     paragraphs are sentence-split before packing; pathological single
//     sentences are hard-split as a last resort (and counted in `oversize`).
//   • char_start / char_end offsets are absolute into the *normalized* input
//     (CRLF→LF only) so per-section idempotent re-embed (audit C5) has a
//     stable identity.
//   • No LLM calls, no network, no SDK — pure function. Title/summary are the
//     downstream narrative-chunk Flash call's job, NOT this module's.

import { describe, expect, it } from 'vitest';
import { segmentDocument } from './section-segment';

// Helper: build a paragraph of approximately `tokens` tokens (chars/4 heuristic).
// Uses distinct words so token estimation isn't gamed by repetition compression
// in any future tokenizer swap; the chars/4 estimator only counts chars.
function makeParagraph(tokens: number, marker = 'word'): string {
  // ~5 chars per word incl. trailing space ≈ 1.25 tokens per word.
  // So tokens words ≈ tokens chars ≈ tokens/4 tokens — wait, recompute:
  // word = 4 chars + 1 space = 5 chars = 1.25 tokens. To hit `tokens` tokens
  // we need tokens/1.25 = tokens*0.8 words ≈ tokens*4 chars. Generate by char.
  const targetChars = tokens * 4;
  const word = `${marker} `;          // 5 chars
  const n = Math.ceil(targetChars / word.length);
  return word.repeat(n).trim();
}

describe('segmentDocument — empty + whitespace', () => {
  it('empty input → no sections', () => {
    const r = segmentDocument('');
    expect(r.sections).toEqual([]);
    expect(r.oversize).toBe(0);
  });

  it('whitespace-only input → no sections', () => {
    const r = segmentDocument('   \n\n\t\n   ');
    expect(r.sections).toEqual([]);
    expect(r.oversize).toBe(0);
  });

  it('input that normalizes to whitespace (CRLF) → no sections', () => {
    const r = segmentDocument('\r\n\r\n  \r\n');
    expect(r.sections).toEqual([]);
  });
});

describe('segmentDocument — structural mode: markdown headings', () => {
  it('splits at every markdown heading level 1-6', () => {
    const doc = [
      '# Top',
      '',
      'Intro paragraph.',
      '',
      '## Sub A',
      '',
      'Body of A.',
      '',
      '### Sub-sub',
      '',
      'Body of sub-sub.',
      '',
      '# Top Two',
      '',
      'Body of top-two.',
    ].join('\n');
    const r = segmentDocument(doc);
    expect(r.mode).toBe('structural');
    expect(r.sections).toHaveLength(4);
    expect(r.sections[0].cue).toBe('# Top');
    expect(r.sections[1].cue).toBe('## Sub A');
    expect(r.sections[2].cue).toBe('### Sub-sub');
    expect(r.sections[3].cue).toBe('# Top Two');
  });

  it('section text includes the heading line itself', () => {
    const doc = '# Heading\n\nbody text.';
    const r = segmentDocument(doc);
    expect(r.sections[0].text.startsWith('# Heading')).toBe(true);
  });

  it('char_start / char_end span the normalized input contiguously', () => {
    const doc = '# A\n\nfirst.\n\n# B\n\nsecond.';
    const r = segmentDocument(doc);
    expect(r.sections).toHaveLength(2);
    expect(r.sections[0].charStart).toBe(0);
    // section 0 ends where section 1 begins (no gap, no overlap in structural mode)
    expect(r.sections[0].charEnd).toBe(r.sections[1].charStart);
    expect(r.sections[r.sections.length - 1].charEnd).toBe(doc.length);
  });

  it('mid-line "#" is NOT a heading (anchored to line start)', () => {
    const doc = 'I tagged it #important in the channel. Just a sentence.';
    const r = segmentDocument(doc);
    expect(r.mode).toBe('paragraph-packed');
    expect(r.sections).toHaveLength(1);
  });
});

describe('segmentDocument — structural mode: Chapter N', () => {
  it('splits at "Chapter N" lines', () => {
    const doc = [
      'Chapter 1',
      '',
      'Opening paragraph.',
      '',
      'Chapter 2',
      '',
      'Second chapter body.',
      '',
      'Chapter 3',
      '',
      'Third.',
    ].join('\n');
    const r = segmentDocument(doc);
    expect(r.mode).toBe('structural');
    expect(r.sections).toHaveLength(3);
    expect(r.sections[0].cue).toBe('Chapter 1');
    expect(r.sections[2].cue).toBe('Chapter 3');
  });

  it('case-insensitive Chapter match ("CHAPTER 1", "chapter 1")', () => {
    const doc = 'CHAPTER 1\n\nfirst body.\n\nchapter 2\n\nsecond body.';
    const r = segmentDocument(doc);
    expect(r.sections).toHaveLength(2);
    expect(r.sections[0].cue).toMatch(/chapter 1/i);
  });

  it('mid-line "Chapter 1" is NOT a cue', () => {
    const doc = 'In Chapter 1 of the book, the author argues that effort compounds.';
    const r = segmentDocument(doc);
    expect(r.mode).toBe('paragraph-packed');
    expect(r.sections).toHaveLength(1);
  });
});

describe('segmentDocument — structural mode: transcript timestamps', () => {
  it('splits at "[HH:MM:SS]" line-start timestamps', () => {
    const doc = [
      '[00:00:00] Welcome',
      '',
      'This is the intro paragraph.',
      '',
      '[00:05:30] Topic one',
      '',
      'Body of topic one.',
      '',
      '[00:12:45] Topic two',
      '',
      'Body of topic two.',
    ].join('\n');
    const r = segmentDocument(doc);
    expect(r.mode).toBe('structural');
    expect(r.sections).toHaveLength(3);
    expect(r.sections[0].cue).toMatch(/^\[00:00:00\]/);
  });

  it('also splits at bare "MM:SS" line-starts without brackets', () => {
    const doc = '0:00 intro\n\nfirst.\n\n12:45 next topic\n\nsecond.';
    const r = segmentDocument(doc);
    expect(r.sections).toHaveLength(2);
  });

  it('does NOT split on mid-line "12:45 PM" (not at line-start with content)', () => {
    const doc = 'The meeting is at 12:45 PM today, please be there.';
    const r = segmentDocument(doc);
    expect(r.mode).toBe('paragraph-packed');
  });
});

describe('segmentDocument — paragraph-pack mode (no structure)', () => {
  it('returns a single section when total < targetTokens', () => {
    const doc = 'Short doc.\n\nWith two paragraphs.';
    const r = segmentDocument(doc);
    expect(r.mode).toBe('paragraph-packed');
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0].text).toContain('Short doc');
    expect(r.sections[0].text).toContain('two paragraphs');
  });

  it('packs paragraphs into sections at ~targetTokens', () => {
    // 4 paragraphs of ~2000 tokens each = 8000 total at target=3500 →
    // expect ~3 sections (2k+2k+2k+2k packs into 4k/4k or 4k/2k+2k depending on greedy).
    const paras = [0, 1, 2, 3].map((i) => makeParagraph(2000, `mark${i}`));
    const doc = paras.join('\n\n');
    const r = segmentDocument(doc, { targetTokens: 3500, safeMaxTokens: 4500 });
    expect(r.mode).toBe('paragraph-packed');
    expect(r.sections.length).toBeGreaterThanOrEqual(2);
    // No section may exceed safeMaxTokens (the hard guarantee).
    for (const s of r.sections) {
      expect(s.estTokens).toBeLessThanOrEqual(4500);
    }
  });

  it('NEVER splits a paragraph that fits under safeMaxTokens', () => {
    // One ~3000-token paragraph with target=2000 — must stay whole because
    // splitting it would require sentence-splitting and it's under safeMax.
    const p = makeParagraph(3000, 'whole');
    const r = segmentDocument(p, { targetTokens: 2000, safeMaxTokens: 4000 });
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0].text).toBe(p);
  });

  it('contiguous char offsets across the whole document (no chars lost)', () => {
    const paras = [0, 1, 2].map((i) => makeParagraph(1500, `tag${i}`));
    const doc = paras.join('\n\n');
    const r = segmentDocument(doc, { targetTokens: 2000, safeMaxTokens: 3000 });
    // First section starts at 0, last section ends at doc length, and each
    // adjacent pair's charEnd == charStart (paragraph-pack has no overlap by default).
    expect(r.sections[0].charStart).toBe(0);
    expect(r.sections[r.sections.length - 1].charEnd).toBe(doc.length);
    for (let i = 0; i < r.sections.length - 1; i++) {
      expect(r.sections[i].charEnd).toBe(r.sections[i + 1].charStart);
    }
  });
});

describe('segmentDocument — oversize handling (hard guarantee: zero sections > safeMax)', () => {
  it('sentence-splits a paragraph that exceeds safeMaxTokens', () => {
    // One paragraph of ~6000 tokens with safeMax=2000. Must split into
    // multiple sections at sentence boundaries.
    const sentences: string[] = [];
    for (let i = 0; i < 30; i++) {
      // Each sentence ≈ 200 tokens ≈ 800 chars. 30 sentences ≈ 6000 tokens.
      sentences.push(makeParagraph(200, `sent${i}`) + '.');
    }
    const huge = sentences.join(' ');
    const r = segmentDocument(huge, { targetTokens: 1500, safeMaxTokens: 2000 });
    expect(r.sections.length).toBeGreaterThan(1);
    for (const s of r.sections) {
      expect(s.estTokens).toBeLessThanOrEqual(2000);
    }
    expect(r.oversize).toBe(0);
  });

  it('hard-splits a single sentence that exceeds safeMaxTokens, counting it as oversize-handled', () => {
    // One sentence of ~4000 tokens (no period mid-stream) with safeMax=1500.
    // No sentence boundary exists → hard-split required.
    const huge = makeParagraph(4000, 'nopunc');   // no terminator
    const r = segmentDocument(huge, { targetTokens: 1000, safeMaxTokens: 1500 });
    expect(r.sections.length).toBeGreaterThan(1);
    for (const s of r.sections) {
      expect(s.estTokens).toBeLessThanOrEqual(1500);
    }
    // oversize counts source segments we had to hard-split (telemetry signal,
    // not a failure — the output is still safe).
    expect(r.oversize).toBeGreaterThan(0);
  });

  it('structural mode also enforces safeMax: oversize chapter is sub-packed', () => {
    // Chapter 1 contains a paragraph-pack-worthy body of ~5400 tokens with
    // safeMax=2000. Mode is still "structural" overall (chapter cue drove the
    // first cut), but Chapter 1's body further sub-packs.
    // (Per-paragraph 1800 tok leaves headroom for the heading to ride on sub #1.)
    const bigBody = [0, 1, 2].map((i) => makeParagraph(1800, `c1p${i}`)).join('\n\n');
    const doc = `Chapter 1\n\n${bigBody}\n\nChapter 2\n\nshort body two.`;
    const r = segmentDocument(doc, { targetTokens: 1500, safeMaxTokens: 2000 });
    expect(r.mode).toBe('structural');
    // Chapter 1 expands into ≥2 sections; chapter 2 stays as 1.
    expect(r.sections.length).toBeGreaterThanOrEqual(3);
    for (const s of r.sections) {
      expect(s.estTokens).toBeLessThanOrEqual(2000);
    }
  });
});

describe('segmentDocument — defaults match shipped code (target 7000 / safe 7500)', () => {
  it('plan-default target ≈ 7000 tokens, safe ≈ 7500 tokens (audit round-4 small: 8000 → 7500 for Flash responseSchema headroom)', () => {
    // A doc of ~14000 tokens with NO structure should pack into ~2 sections
    // under defaults.
    const big = [0, 1].map((i) => makeParagraph(7000, `bulk${i}`)).join('\n\n');
    const r = segmentDocument(big);
    expect(r.mode).toBe('paragraph-packed');
    expect(r.sections).toHaveLength(2);
    for (const s of r.sections) {
      expect(s.estTokens).toBeLessThanOrEqual(7500);
    }
  });
});

describe('segmentDocument — determinism (resumability prerequisite, audit C5)', () => {
  it('same input → identical char_start / char_end / estTokens on two calls', () => {
    const doc =
      '# A\n\n' +
      makeParagraph(500) +
      '\n\n# B\n\n' +
      makeParagraph(500);
    const a = segmentDocument(doc);
    const b = segmentDocument(doc);
    expect(a.sections.map((s) => [s.charStart, s.charEnd, s.estTokens])).toEqual(
      b.sections.map((s) => [s.charStart, s.charEnd, s.estTokens]),
    );
  });
});

// ── Audit (round-4) coverage — invariants the first-cut tests missed ───────

describe('segmentDocument — audit C2: section.text === source.slice(charStart, charEnd)', () => {
  it('structural mode: every section is a literal slice of the source', () => {
    const doc =
      '# A\n\nfirst para.\n\nsecond para.\n\n# B\n\nthird.\n\nfourth.';
    const r = segmentDocument(doc);
    for (const s of r.sections) {
      expect(s.text).toBe(doc.slice(s.charStart, s.charEnd));
    }
  });

  it('paragraph-pack mode: every section is a literal slice of the source', () => {
    const paras = [0, 1, 2, 3].map((i) => makeParagraph(800, `slice${i}`));
    const doc = paras.join('\n\n');
    const r = segmentDocument(doc, { targetTokens: 1500, safeMaxTokens: 2500 });
    for (const s of r.sections) {
      expect(s.text).toBe(doc.slice(s.charStart, s.charEnd));
    }
  });

  it('oversize sub-packed chapter: each sub-section is a literal slice', () => {
    const bigBody = [0, 1, 2].map((i) => makeParagraph(1800, `c1p${i}`)).join('\n\n');
    const doc = `Chapter 1\n\n${bigBody}\n\nChapter 2\n\nshort.`;
    const r = segmentDocument(doc, { targetTokens: 1500, safeMaxTokens: 2000 });
    for (const s of r.sections) {
      expect(s.text).toBe(doc.slice(s.charStart, s.charEnd));
    }
  });
});

describe('segmentDocument — audit C1: form-feed line-anchored (no fake-cue shatter)', () => {
  it('mid-paragraph form-feed does NOT promote that line into a cue', () => {
    // Common PDF→text artifact: `\f` lands inside a sentence, not on its own line.
    const doc = 'End of one paragraph.\fStart of next paragraph immediately.';
    const r = segmentDocument(doc);
    expect(r.mode).toBe('paragraph-packed');
    expect(r.sections).toHaveLength(1);
  });

  it('line-start form-feed IS a structural cue', () => {
    const doc = 'First paragraph.\n\n\fNew page heading\n\nSecond paragraph.';
    const r = segmentDocument(doc);
    expect(r.mode).toBe('structural');
  });
});

describe('segmentDocument — audit C3: sentence-split handles dialog + EOF terminators', () => {
  it('dialog with closing-quote+space splits at sentence boundaries (no hard-split)', () => {
    // Dialog-heavy prose — every sentence ends with ." or ?" or !"
    const dialog =
      '"First line of dialog." "Second line spoken aloud." "Third." "Fourth." ' +
      '"Fifth piece of dialogue here." "Sixth, with comma." "Seventh."';
    // Repeat to force size > safeMax (1 token), trigger sentence-split.
    const big = (dialog + ' ').repeat(20);
    const r = segmentDocument(big, { targetTokens: 50, safeMaxTokens: 100 });
    // Must NOT hard-split — every sentence ends cleanly.
    expect(r.oversize).toBe(0);
  });

  it('paragraph ending with period at EOF (no trailing whitespace) still segments cleanly', () => {
    const doc = 'A single short paragraph ending in a period.';
    const r = segmentDocument(doc);
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0].text).toBe(doc);
  });
});

describe('segmentDocument — audit C4: CJK content does not silently overrun safeMax', () => {
  it('auto-detects CJK and adjusts chars/token so estTokens reflects real budget', () => {
    // 800 × 10-char CJK strings = 8000 chars. Under chars/4 → 2000 tokens.
    // Under CJK auto-detect chars/1.5 → ~5334 tokens. Test the detected
    // heuristic is the one applied, not the English default.
    const cjk = '我的故事是这样的开始。'.repeat(800);
    const r = segmentDocument(cjk);
    // Sum of estTokens across sections must reflect the CJK heuristic.
    const total = r.sections.reduce((a, s) => a + s.estTokens, 0);
    expect(total).toBeGreaterThan(2000);
  });

  it('large CJK document splits into multiple sections, none over safeMax', () => {
    // ~24000 CJK chars → ~16000 tokens at chars/1.5 → must split with
    // default safeMax=7500.
    const cjk = '我的故事是这样的开始。'.repeat(2000);
    const r = segmentDocument(cjk);
    expect(r.sections.length).toBeGreaterThanOrEqual(2);
    for (const s of r.sections) {
      expect(s.estTokens).toBeLessThanOrEqual(7500);
    }
  });

  it('explicit charsPerToken option overrides auto-detection (even when value equals default)', () => {
    const cjk = '我的故事是这样的开始。'.repeat(200);   // 11*200 = 2200 chars
    // Auto-detect would pick 1.5 (CJK) → ~1467 tokens. Explicit 4 → ~550 tokens.
    // The override must defeat auto-detect even when the value equals
    // DEFAULT_CHARS_PER_TOKEN (4) — earlier bug had it falling through.
    const r = segmentDocument(cjk, { charsPerToken: 4 });
    expect(r.sections).toHaveLength(1);
    // 2200/4 = 550 tokens. Cap test at 600 to allow heuristic rounding.
    expect(r.sections[0].estTokens).toBeLessThanOrEqual(600);
  });
});

describe('segmentDocument — audit M1: numbered headings (with blank-line guard)', () => {
  it('splits at top-level numbered headings ("1. Introduction" / "2. Methods")', () => {
    const doc =
      '1. Introduction\n\nFirst body.\n\n2. Methods\n\nSecond body.\n\n3. Results\n\nThird body.';
    const r = segmentDocument(doc);
    expect(r.mode).toBe('structural');
    expect(r.sections).toHaveLength(3);
    expect(r.sections[0].cue).toBe('1. Introduction');
  });

  it('numbered list items inside prose do NOT split (no blank line before each item)', () => {
    const doc =
      'The three reasons:\n1. First reason\n2. Second reason\n3. Third reason\n\nThat wraps it up.';
    const r = segmentDocument(doc);
    expect(r.mode).toBe('paragraph-packed');
  });

  it('lowercase-titled numbered item ("1. first reason") is NOT a heading', () => {
    const doc = '1. first reason\n\n2. second reason';
    const r = segmentDocument(doc);
    expect(r.mode).toBe('paragraph-packed');
  });

  it('numbered item with blank-above but consecutive item below → filtered (real AoD mod-04 case)', () => {
    // The line `1.  Judge others and live in fear of being judged` in the
    // Acres-Of-Diamonds book sits below a blank line (prose paragraph ended)
    // but ABOVE `2. Never invest...` with no blank between. Without the
    // blank-below guard, item #1 would split prose at an arbitrary point.
    const doc =
      'Some prose paragraph that ends here.\n\n' +
      '1.  Judge others and live in fear of being judged\n' +
      '2.  Never invest in yourself\n' +
      '3.  Be afraid to make decisions\n\n' +
      'And the prose continues from here.';
    const r = segmentDocument(doc);
    expect(r.mode).toBe('paragraph-packed');
  });
});

describe('segmentDocument — audit M2: cueMode "book" suppresses timestamps', () => {
  it('default cueMode allows timestamp cues', () => {
    const doc = '[00:00:00] intro\n\nbody.\n\n[00:05:00] next\n\nmore.';
    const r = segmentDocument(doc);
    expect(r.mode).toBe('structural');
    expect(r.sections).toHaveLength(2);
  });

  it('cueMode "book" suppresses bracketed timestamps (false-positive defense)', () => {
    // A textbook quoting a log excerpt — `[09:15:00]` in prose should NOT
    // shatter the chapter into sub-sections.
    const doc =
      'In the log we observed:\n\n[09:15:00] daemon started\n\nThis is just an example for the reader.';
    const r = segmentDocument(doc, { cueMode: 'book' });
    expect(r.mode).toBe('paragraph-packed');
  });

  it('cueMode "book" suppresses bare timestamps', () => {
    const doc = 'Body content.\n\n12:45 PM is meeting time.\n\nMore body.';
    const r = segmentDocument(doc, { cueMode: 'book' });
    expect(r.mode).toBe('paragraph-packed');
  });

  it('cueMode "book" still honors markdown + chapter cues', () => {
    const doc = '# Heading\n\nBody.\n\nChapter 1\n\nMore.';
    const r = segmentDocument(doc, { cueMode: 'book' });
    expect(r.mode).toBe('structural');
    expect(r.sections.length).toBeGreaterThanOrEqual(2);
  });
});

describe('segmentDocument — audit M5: leading whitespace is owned by the first section', () => {
  it('document with leading blank lines before first cue → section 0 starts at offset 0', () => {
    const doc = '\n\n\n# Heading\n\nbody.';
    const r = segmentDocument(doc);
    expect(r.sections[0].charStart).toBe(0);
    expect(r.sections[r.sections.length - 1].charEnd).toBe(doc.length);
    // Slice invariant still holds.
    expect(r.sections[0].text).toBe(doc.slice(0, r.sections[0].charEnd));
  });

  it('document with leading body content before first cue → cue-less leading section', () => {
    const doc = 'Some intro paragraph.\n\n# Heading\n\nbody.';
    const r = segmentDocument(doc);
    expect(r.sections[0].charStart).toBe(0);
    expect(r.sections[0].cue).toBeNull();
    expect(r.sections[1].cue).toBe('# Heading');
  });
});

describe('segmentDocument — degenerate config (target ≥ safeMax)', () => {
  it('target === safeMax: packer still produces non-empty sections', () => {
    const paras = [0, 1, 2].map((i) => makeParagraph(800, `t${i}`));
    const doc = paras.join('\n\n');
    const r = segmentDocument(doc, { targetTokens: 1000, safeMaxTokens: 1000 });
    expect(r.sections.length).toBeGreaterThan(0);
    for (const s of r.sections) {
      expect(s.estTokens).toBeLessThanOrEqual(1000);
    }
  });
});

describe('segmentDocument — performance sanity', () => {
  it('thousands of structural cues complete in well under 1s', () => {
    // 5000 markdown headings + tiny body each. Stresses findCues + dedup.
    const doc = '# h\n\nx\n\n'.repeat(5000);
    const t0 = Date.now();
    const r = segmentDocument(doc);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(1000);
    expect(r.mode).toBe('structural');
    // Sections collapse together because each one is 1 token; greedy packs
    // them to target. Just assert we produced SOME result without blowing up.
    expect(r.sections.length).toBeGreaterThan(0);
  });
});
