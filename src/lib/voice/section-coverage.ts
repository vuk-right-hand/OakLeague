// section-coverage.ts — the v3 ingest "no silent word-loss" guard.
//
// RAG v3 bulletproofing (audit round 1). The v3 worker chunks each section
// via Gemini Flash (narrative-chunk.ts → units → child chunks → embeddings).
// Flash CAN fail two ways that silently drop a creator's words:
//   1. Both attempts fail (bad JSON / schema drift / transport) → null.
//   2. Flash succeeds but SUMMARIZES — returns units far shorter than the
//      source, dropping paragraphs while looking healthy.
// Either way, dropped words never become child chunks → never embedded →
// unreachable. For a cloned-voice mentor whose whole value is "exactly him,"
// a silently-dropped chapter is a product failure.
//
// This module is the single source of truth for:
//   • sectionCoverage()      — measure how much of the source survived into
//                              the units (length-ratio + trigram-containment).
//   • coveragePasses()       — gate decision against env-overridable floors.
//   • verbatimUnitsFromSection() — deterministic fallback that copies the
//                              raw section text into units (zero Flash trust),
//                              guaranteeing 100% of words are ingested.
//   • extractiveTitleAndSummary() — a routing-viable title/summary for a
//                              verbatim-fallback section (M5: a "first 480
//                              chars" summary poisons the routing vector).
//
// Pure + server-only. Imported by the narrative-chunk-section route (which
// orchestrates Flash → coverage → fallback so the route NEVER returns null)
// and unit-tested directly.

import 'server-only';

export interface NarrativeUnitLite {
  title: string;
  text: string;
}

export interface Coverage {
  /** normalized(units joined).length / normalized(source).length, capped 1.0.
   *  DELETION-sensitive: you cannot drop 20% of the words and keep 95% length.
   *  This is the axis trigram set-membership is blind to (audit M2). */
  lengthRatio: number;
  /** |source 3-grams ∩ units 3-grams| / |source 3-grams|. Content-sanity:
   *  catches "right length, wrong words" (Flash hallucinating filler). */
  trigramContainment: number;
}

export interface CoverageFloors {
  lengthFloor: number;
  trigramFloor: number;
}

// Defaults with margin above a healthy verbatim ingest (~0.97-0.99 on both
// axes). Env-overridable so the floor can be calibrated against a real book
// without a code change. Read lazily (per call) so a test/worker can set the
// env before the first call.
export function defaultFloors(): CoverageFloors {
  const lengthFloor = Number(process.env.V3_SECTION_COVERAGE_LENGTH_FLOOR ?? '0.85');
  const trigramFloor = Number(process.env.V3_SECTION_COVERAGE_TRIGRAM_FLOOR ?? '0.90');
  return {
    lengthFloor: Number.isFinite(lengthFloor) ? lengthFloor : 0.85,
    trigramFloor: Number.isFinite(trigramFloor) ? trigramFloor : 0.90,
  };
}

/** Collapse all whitespace to single spaces + lowercase. Keeps punctuation —
 *  used for the trigram axis (content sanity). Script-agnostic. */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Letters + digits only, lowercased (no whitespace, no punctuation/symbols).
 *  Used for the LENGTH axis (audit round-2 M4): measuring lengthRatio on this
 *  makes dropped WORDS dominate the signal, so a section that drops a prose
 *  paragraph but keeps similar symbol/markdown volume can't score a misleading
 *  ratio. \p{L}\p{N} keeps CJK/Cyrillic/digits; strips punctuation + spaces. */
function wordChars(s: string): string {
  return (s.toLowerCase().match(/[\p{L}\p{N}]/gu) ?? []).join('');
}

// Below this many word-characters the source is too short for the coverage
// metric to be meaningful (trigram sets degenerate, a single dropped char
// tanks containment). The route trusts Flash's units for such sections rather
// than forcing a needless verbatim fallback (audit round-2 M5). Lossless
// either way; this just avoids fallback churn + false brownout alerts.
export const MIN_MEASURABLE_WORD_CHARS = 60;

/** True if the source has enough word content for sectionCoverage to be a
 *  reliable signal. Below the floor, callers should trust Flash output. */
export function isCoverageMeasurable(source: string): boolean {
  return wordChars(source).length >= MIN_MEASURABLE_WORD_CHARS;
}

function trigramSet(normalized: string): Set<string> {
  const set = new Set<string>();
  if (normalized.length < 3) {
    if (normalized.length > 0) set.add(normalized);
    return set;
  }
  for (let i = 0; i + 3 <= normalized.length; i++) {
    set.add(normalized.slice(i, i + 3));
  }
  return set;
}

/**
 * Measure how much of `source` survived into `unitTexts`. Pass the EXACT
 * strings the chunker will receive (audit C5) — i.e. unit.text BEFORE any
 * downstream 8000-char row truncation and BEFORE the contextual-gen prefix.
 */
export function sectionCoverage(source: string, unitTexts: string[]): Coverage {
  const normSrc = normalize(source);
  const normUnits = normalize(unitTexts.join(' '));

  if (normSrc.length === 0 || normUnits.length === 0) {
    return { lengthRatio: 0, trigramContainment: 0 };
  }

  // Length axis on word-chars only (M4) — dropped words dominate, not symbols.
  const wordSrc = wordChars(source);
  const wordUnits = wordChars(unitTexts.join(' '));
  // Source with no word chars (pure punctuation) → word coverage is vacuously
  // complete. Otherwise ratio of surviving word-chars.
  const lengthRatio = wordSrc.length === 0
    ? 1
    : Math.min(1, wordUnits.length / wordSrc.length);

  // Trigram axis on whitespace-normalized text (keeps punctuation for content sanity).
  const srcTris = trigramSet(normSrc);
  const unitTris = trigramSet(normUnits);
  let hit = 0;
  for (const t of srcTris) if (unitTris.has(t)) hit++;
  const trigramContainment = srcTris.size === 0 ? 0 : hit / srcTris.size;

  return { lengthRatio, trigramContainment };
}

/** Gate: a section's Flash units are trusted only if BOTH axes clear their
 *  floors. Below either → caller should use verbatimUnitsFromSection. */
export function coveragePasses(cov: Coverage, floors?: Partial<CoverageFloors>): boolean {
  const f = { ...defaultFloors(), ...(floors ?? {}) };
  return cov.lengthRatio >= f.lengthFloor && cov.trigramContainment >= f.trigramFloor;
}

// ── Verbatim fallback ──────────────────────────────────────────────────────
//
// When Flash fails OR summarizes, we DO NOT trust its output. We copy the raw
// section text into units ourselves — deterministically, losslessly. The
// section is "less elegantly segmented" but every word is ingested and
// retrievable, which is the entire guarantee.

// Pack target per unit. Well under the sample_content_narrative_units.text
// CHECK ceiling (8000) so a unit row is never truncated (audit C5).
export const VERBATIM_UNIT_MAX_CHARS = 6000;

// A 32K-char section (MAX_SECTION_CHARS, the route's input ceiling) packs to
// ~6 units at 6000 chars — far under the worker's unit_index stride of 10000
// (secIdx*10000). The HARD enforcement of that stride invariant lives in the
// v3 worker (embed-worker.js MAX_UNITS_PER_SECTION guard, which fails the job
// loud if ANY section — Flash or verbatim — emits ≥10000 units). This constant
// is the verbatim splitter's own documented ceiling, asserted in tests.
export const HARD_MAX_VERBATIM_UNITS = 9000;

/**
 * Split `sectionText` into verbatim units, each ≤ VERBATIM_UNIT_MAX_CHARS.
 * Deterministic (audit C4). Concatenating unit.text in order reproduces the
 * source's non-whitespace content exactly (no words lost). Returns [] for a
 * whitespace-only section (nothing to lose).
 *
 * Packing: greedily fuse paragraphs (blank-line separated) up to the cap; a
 * single paragraph larger than the cap is hard-split at the cap boundary
 * (last resort — verbatim ingest tolerates a mid-sentence cut far better than
 * losing the words entirely).
 */
export function verbatimUnitsFromSection(sectionText: string): NarrativeUnitLite[] {
  // Emptiness = no word character (audit round-2 M2). Matches the v3 worker's
  // pre-screen (`[\p{L}\p{N}]`) EXACTLY so the two can't drift: a punctuation-
  // only section ("--- ***") yields zero units here just as the worker skips it,
  // keeping the section-count backstop denominator consistent. Nothing to lose
  // (no words), so [] is correct.
  if (!sectionText || !/[\p{L}\p{N}]/u.test(sectionText)) return [];

  const paragraphs = sectionText
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  // No blank-line structure → treat the whole thing as one block.
  const blocks = paragraphs.length > 0 ? paragraphs : [sectionText.trim()];

  // Hard-split any block larger than the cap into ≤cap pieces.
  const pieces: string[] = [];
  for (const block of blocks) {
    if (block.length <= VERBATIM_UNIT_MAX_CHARS) {
      pieces.push(block);
      continue;
    }
    for (let i = 0; i < block.length; i += VERBATIM_UNIT_MAX_CHARS) {
      pieces.push(block.slice(i, i + VERBATIM_UNIT_MAX_CHARS));
    }
  }

  // Greedily pack pieces into units up to the cap.
  const units: NarrativeUnitLite[] = [];
  let cur = '';
  const flush = () => {
    const t = cur.trim();
    if (t.length > 0) {
      units.push({ title: `Verbatim segment ${units.length + 1}`, text: t });
    }
    cur = '';
  };
  for (const piece of pieces) {
    if (cur.length === 0) {
      cur = piece;
    } else if (cur.length + 2 + piece.length <= VERBATIM_UNIT_MAX_CHARS) {
      cur = `${cur}\n\n${piece}`;
    } else {
      flush();
      cur = piece;
    }
  }
  flush();

  return units;
}

// ── Extractive title/summary for a verbatim-fallback section (M5) ──────────
//
// The section summary is embedded as the Doc→Section ROUTING vector. A naive
// "first 480 chars" of a section is usually throat-clearing intro, not the
// section's payload — embedding that makes the rescued section near-invisible
// to routing (the words are ingested but unreachable in practice). We build a
// title from the structural cue (the heading that started the section) and a
// summary from the section's leading sentences, which typically introduce the
// topic and proper nouns a query would match.

const SECTION_SUMMARY_CAP = 2000; // matches sample_content_sections.summary CHECK
const SECTION_TITLE_CAP = 200; // matches sample_content_sections.title CHECK

function cleanCue(cue: string): string {
  // Strip leading markdown hashes / "Chapter N —" decoration to a readable label.
  return cue
    .replace(/^#{1,6}\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SECTION_TITLE_CAP);
}

export function extractiveTitleAndSummary(
  sectionText: string,
  cue: string | null,
  sectionIndex: number,
): { title: string; summary: string } {
  const cleanedCue = cue ? cleanCue(cue) : '';
  const title = cleanedCue.length > 0 ? cleanedCue : `Section ${sectionIndex + 1}`;

  // Take the first few sentences (or up to the cap) as the routing summary.
  // Slice by the sentence END OFFSET (not by re-joining matches) so original
  // inter-sentence spacing is preserved verbatim.
  const flat = sectionText.replace(/\s+/g, ' ').trim();
  let summary = '';
  const sentenceRe = /[^.!?]+[.!?]+(\s+|$)/g;
  let m: RegExpExecArray | null;
  let sentences = 0;
  let endOffset = 0;
  while ((m = sentenceRe.exec(flat)) !== null && sentences < 4) {
    const candidateEnd = m.index + m[0].length;
    if (candidateEnd > SECTION_SUMMARY_CAP) break;
    endOffset = candidateEnd;
    sentences++;
  }
  summary = (endOffset > 0 ? flat.slice(0, endOffset) : flat.slice(0, SECTION_SUMMARY_CAP)).trim();
  // Prepend the cue so proper nouns in the heading are part of the routing
  // vector even when the body opens vaguely.
  if (cleanedCue.length > 0 && !summary.toLowerCase().startsWith(cleanedCue.toLowerCase())) {
    summary = `${cleanedCue}. ${summary}`.slice(0, SECTION_SUMMARY_CAP);
  }

  return { title, summary: summary.slice(0, SECTION_SUMMARY_CAP) || title };
}
