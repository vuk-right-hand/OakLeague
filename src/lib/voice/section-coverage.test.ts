// section-coverage.test.ts — pure-logic tests for the v3 ingest "no silent
// word-loss" guard. Covers the auditor findings (RAG v3 bulletproofing audit
// round 1):
//   C5 — coverage measured on the exact strings handed to the chunker.
//   C4 — verbatim splitter is deterministic across re-runs.
//   M2 — length-ratio catches DELETION that trigram set-membership misses;
//        reorder (not loss) still passes.
//   M1 — verbatim unit count bounded; every unit ≤ HARD_MAX_UNIT_CHARS.

import { describe, it, expect } from 'vitest';
import {
  sectionCoverage,
  coveragePasses,
  isCoverageMeasurable,
  verbatimUnitsFromSection,
  extractiveTitleAndSummary,
  VERBATIM_UNIT_MAX_CHARS,
  HARD_MAX_VERBATIM_UNITS,
  MIN_MEASURABLE_WORD_CHARS,
} from './section-coverage';

describe('sectionCoverage', () => {
  it('full verbatim coverage scores ~1.0 on both axes', () => {
    const src = 'The quick brown fox jumps over the lazy dog. And then it runs away fast.';
    const cov = sectionCoverage(src, [src]);
    expect(cov.lengthRatio).toBeGreaterThanOrEqual(0.99);
    expect(cov.trigramContainment).toBeGreaterThanOrEqual(0.99);
    expect(coveragePasses(cov)).toBe(true);
  });

  it('coverage is invariant to whitespace/case normalization', () => {
    const src = 'Hello   WORLD\n\nThis  is   a test.';
    const units = ['hello world this is a test.'];
    const cov = sectionCoverage(src, units);
    expect(cov.lengthRatio).toBeGreaterThanOrEqual(0.95);
    expect(cov.trigramContainment).toBeGreaterThanOrEqual(0.95);
  });

  // M2 — the metric-choice proof. Dropping ~half the section must FAIL even
  // when the retained text shares most trigrams with the dropped text.
  it('catches deletion via length-ratio (trigram set-membership would miss it)', () => {
    // The dropped second sentence is a verbatim repeat → ALL its trigrams are
    // present in the retained sentence, so trigramContainment stays ~1.0.
    const src = 'the team must ship the feature today. the team must ship the feature today.';
    const units = ['the team must ship the feature today.'];
    const cov = sectionCoverage(src, units);
    // Trigram set-membership is fooled (retained text covers the source trigrams):
    expect(cov.trigramContainment).toBeGreaterThanOrEqual(0.9);
    // Length-ratio is NOT fooled — half the chars are gone:
    expect(cov.lengthRatio).toBeLessThan(0.85);
    expect(coveragePasses(cov)).toBe(false);
  });

  // M2 — reorder is NOT loss: every word is still present/retrievable, so it
  // must PASS (we do not fail a section just because units were reordered).
  it('reordered-but-complete units pass (reorder is not word-loss)', () => {
    const src = 'First paragraph here. Second paragraph here. Third paragraph here.';
    const units = ['Third paragraph here.', 'First paragraph here.', 'Second paragraph here.'];
    const cov = sectionCoverage(src, units);
    expect(cov.lengthRatio).toBeGreaterThanOrEqual(0.9);
    expect(cov.trigramContainment).toBeGreaterThanOrEqual(0.9);
    expect(coveragePasses(cov)).toBe(true);
  });

  it('summarization (Flash compressed the section) fails on length-ratio', () => {
    const src =
      'He drove all night, ten hours straight, then went directly to the gym at eight in the morning. ' +
      'He thought it was discipline. It was identity. Bodybuilders do not need discipline to train; not training would be the punishment.';
    const units = ['The author describes a friend who drove all night and went to the gym, arguing it is identity not discipline.'];
    const cov = sectionCoverage(src, units);
    expect(cov.lengthRatio).toBeLessThan(0.85);
    expect(coveragePasses(cov)).toBe(false);
  });

  it('empty source or empty units → does not pass (defensive)', () => {
    expect(coveragePasses(sectionCoverage('', ['x']))).toBe(false);
    expect(coveragePasses(sectionCoverage('some real content here', []))).toBe(false);
  });

  it('respects env-overridable floors', () => {
    const src = 'aaaa bbbb cccc dddd eeee ffff';
    const units = ['aaaa bbbb cccc']; // ~half length
    const cov = sectionCoverage(src, units);
    expect(coveragePasses(cov, { lengthFloor: 0.1, trigramFloor: 0.1 })).toBe(true);
    expect(coveragePasses(cov, { lengthFloor: 0.85, trigramFloor: 0.9 })).toBe(false);
  });
});

describe('verbatimUnitsFromSection', () => {
  it('preserves all non-whitespace content (no words lost)', () => {
    const src = 'Para one with words.\n\nPara two with more words.\n\nPara three closes it out.';
    const units = verbatimUnitsFromSection(src);
    const norm = (s: string) => s.replace(/\s+/g, '');
    const joined = units.map((u) => u.text).join('');
    expect(norm(joined)).toBe(norm(src));
    expect(units.length).toBeGreaterThanOrEqual(1);
    for (const u of units) {
      expect(u.text.length).toBeGreaterThan(0);
      expect(u.text.length).toBeLessThanOrEqual(VERBATIM_UNIT_MAX_CHARS);
      expect(u.title.length).toBeGreaterThan(0);
    }
  });

  // C4 — deterministic across re-runs (idempotent re-embed requirement).
  it('is deterministic: same input → byte-identical units', () => {
    const src = 'A'.repeat(5000) + '\n\n' + 'B'.repeat(5000) + '\n\n' + 'C'.repeat(5000);
    const a = verbatimUnitsFromSection(src);
    const b = verbatimUnitsFromSection(src);
    expect(a).toEqual(b);
  });

  // M1 / C5 — a single huge paragraph with no breaks must still split into
  // units each ≤ cap, and never exceed the unit-count guard.
  it('hard-splits a single oversized paragraph; every unit ≤ cap', () => {
    const src = 'x'.repeat(VERBATIM_UNIT_MAX_CHARS * 3 + 123); // no whitespace at all
    const units = verbatimUnitsFromSection(src);
    expect(units.length).toBeGreaterThanOrEqual(3);
    expect(units.length).toBeLessThanOrEqual(HARD_MAX_VERBATIM_UNITS);
    for (const u of units) expect(u.text.length).toBeLessThanOrEqual(VERBATIM_UNIT_MAX_CHARS);
    const joined = units.map((u) => u.text).join('');
    expect(joined.replace(/\s+/g, '')).toBe(src);
  });

  it('whitespace-only section yields zero units', () => {
    expect(verbatimUnitsFromSection('   \n\n  \t ')).toEqual([]);
  });

  // M2 — punctuation-only (no word char) yields [] too, matching the worker
  // pre-screen so the section-count backstop denominator can't drift.
  it('punctuation/symbol-only section yields zero units (matches worker pre-screen)', () => {
    expect(verbatimUnitsFromSection('--- *** ... === \n\n ||| ')).toEqual([]);
  });

  it('a short word-bearing aphorism still yields a unit (not skipped)', () => {
    const units = verbatimUnitsFromSection('Sell the trip, not the plane.');
    expect(units.length).toBe(1);
    expect(units[0]!.text).toContain('Sell the trip');
  });

  it('full coverage round-trips through sectionCoverage as PASS', () => {
    const src =
      'The devil is your old character living inside of you. It has one job: to ensure its own existence.\n\n' +
      'And the only way it can be sure of that is by ensuring you never change.';
    const units = verbatimUnitsFromSection(src).map((u) => u.text);
    expect(coveragePasses(sectionCoverage(src, units))).toBe(true);
  });
});

describe('isCoverageMeasurable (M5)', () => {
  it('false for a section below the word-char floor', () => {
    expect(isCoverageMeasurable('Sell the trip, not the plane.')).toBe(false);
    expect(MIN_MEASURABLE_WORD_CHARS).toBeGreaterThan(20);
  });

  it('true for a normal-length section', () => {
    const long = 'This is a normal section with plenty of real prose content to measure against reliably and then some.';
    expect(isCoverageMeasurable(long)).toBe(true);
  });

  it('counts only word characters, not punctuation/whitespace', () => {
    // Lots of symbols but few letters → not measurable.
    expect(isCoverageMeasurable('--- *** | | | --- *** | | | --- *** ...')).toBe(false);
  });
});

describe('extractiveTitleAndSummary', () => {
  it('uses the cue for the title when present', () => {
    const { title, summary } = extractiveTitleAndSummary(
      'Chapter 3 — The Reality Screen\n\nImagine reality as a person, a man named Mr. Reality. He holds a screen.',
      'Chapter 3 — The Reality Screen',
      2,
    );
    expect(title.toLowerCase()).toContain('reality');
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain('Mr. Reality');
  });

  it('falls back to a Section N title when no cue', () => {
    const { title, summary } = extractiveTitleAndSummary('Some opening sentence here. More text.', null, 4);
    expect(title).toBe('Section 5');
    expect(summary.length).toBeGreaterThan(0);
  });

  it('summary never exceeds the section-summary cap', () => {
    const src = 'word '.repeat(2000);
    const { summary } = extractiveTitleAndSummary(src, null, 0);
    expect(summary.length).toBeLessThanOrEqual(2000);
  });
});
