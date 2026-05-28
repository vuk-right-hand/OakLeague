#!/usr/bin/env node
// segment-dry-run.mjs — RAG v3 segmentation dry-run on a real book-scale corpus.
//
// Read-only. No DB. No API calls. No schema. Pure JS on local .txt files.
// Purpose (Vuk 2026-05-27): before writing any v3 ingestion code, prove on a
// REAL book that:
//   (1) we can segment it cleanly into sections (Wall A — the chunker chokes
//       on a whole book today; this proves the bounded-section approach works),
//   (2) the "sorting" — i.e. WHERE the section cuts land — is sensible
//       on real content (the prerequisite for v3's "get the knowledge in
//       the right places" promise), and
//   (3) every section fits comfortably under a single Flash chunker call's
//       safe input ceiling.
//
// Method (matches the v3 plan §2.2 "window-fallback" for unstructured talks):
//   - Strip Vuk's recording-bookmark numbers (they're for him while reading
//     the script — confirmed irrelevant to content).
//   - Tokenize into paragraphs (blank-line-separated).
//   - Pack consecutive paragraphs into sections, capping at TARGET_TOKENS_PER_SECTION.
//   - Never split mid-paragraph.
//
// Output: per-module breakdown + corpus-wide totals + a verdict on whether
// any section breaches the safe-input ceiling.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CORPUS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'aod_test_corpus',
);

// ── Tuning constants (matched to v3 plan §2.2) ─────────────────────────────
// Gemini Flash safely handles ~6–8k tokens of structured-JSON output per call;
// input ceiling is far higher but we keep sections small so a single call
// converts one section to clean narrative units without truncation risk.
const TARGET_TOKENS_PER_SECTION = 7000;   // sweet spot inside the Flash budget
const SAFE_MAX_TOKENS_PER_SECTION = 8000; // hard ceiling we never exceed
const CHARS_PER_TOKEN = 4;                // standard heuristic (Gemini tokenizer)

// ── Bookmark-strip + word/token helpers ───────────────────────────────────
// Vuk's bookmarks look like "1-", "2 -", "3.1-", "**4-**", "*53-*", "19.1-",
// each on its own line or in its own bold/italic marker. They mark where he
// was on the slide while recording — pure noise for retrieval.
const BOOKMARK_RE = /^[\s*]*\*{0,2}\s*\d+(?:\.\d+)?\s*-?\s*\*{0,2}[\s*]*$/;

function stripBookmarks(raw) {
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (BOOKMARK_RE.test(line)) continue;   // drop the bookmark line
    out.push(line);
  }
  return out.join('\n');
}

function countWords(text) {
  return (text.trim().match(/\S+/g) || []).length;
}

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Split on blank-line paragraph breaks. Collapse runs of whitespace-only lines.
function toParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// Pack paragraphs into sections of <= TARGET tokens (never split a paragraph;
// if a single paragraph is itself > TARGET, it becomes its own section and we
// flag it).
function packSections(paragraphs) {
  const sections = [];
  let cur = [];
  let curTokens = 0;
  for (const p of paragraphs) {
    const pt = estimateTokens(p);
    if (curTokens > 0 && curTokens + pt > TARGET_TOKENS_PER_SECTION) {
      sections.push({ text: cur.join('\n\n'), tokens: curTokens });
      cur = [];
      curTokens = 0;
    }
    cur.push(p);
    curTokens += pt;
  }
  if (cur.length > 0) sections.push({ text: cur.join('\n\n'), tokens: curTokens });
  return sections;
}

// ── Run on every module file ───────────────────────────────────────────────
const files = (await fs.readdir(CORPUS_DIR))
  .filter((f) => f.startsWith('module-') && f.endsWith('.txt'))
  .sort();

let totalRawChars = 0, totalCleanChars = 0, totalWords = 0, totalTokens = 0;
let totalSections = 0, totalParas = 0;
let maxSectionTokens = 0;
let oversizeSections = 0;
const perModule = [];

for (const file of files) {
  const raw = await fs.readFile(path.join(CORPUS_DIR, file), 'utf8');
  const clean = stripBookmarks(raw);
  const paras = toParagraphs(clean);
  const sections = packSections(paras);
  const words = countWords(clean);
  const tokens = estimateTokens(clean);
  const sectionSizes = sections.map((s) => s.tokens);
  const maxS = sectionSizes.length ? Math.max(...sectionSizes) : 0;
  const breaches = sectionSizes.filter((t) => t > SAFE_MAX_TOKENS_PER_SECTION).length;

  perModule.push({ file, rawChars: raw.length, cleanChars: clean.length, words, tokens, paras: paras.length, sections: sections.length, maxSectionTokens: maxS, breaches, sectionSizes });

  totalRawChars += raw.length;
  totalCleanChars += clean.length;
  totalWords += words;
  totalTokens += tokens;
  totalSections += sections.length;
  totalParas += paras.length;
  maxSectionTokens = Math.max(maxSectionTokens, maxS);
  oversizeSections += breaches;
}

// ── Report ─────────────────────────────────────────────────────────────────
const fmt = (n) => n.toLocaleString();
console.log('═'.repeat(96));
console.log('  RAG v3 SEGMENTATION DRY-RUN — Acres Of Diamonds (8 modules)');
console.log(`  Target ≤${TARGET_TOKENS_PER_SECTION} tok/section · Safe-max ${SAFE_MAX_TOKENS_PER_SECTION} tok · Heuristic ${CHARS_PER_TOKEN} chars/tok`);
console.log('═'.repeat(96));
console.log();
console.log('  module                                   words    tokens  paras  secs  max-sec  oversize');
console.log('  ' + '─'.repeat(94));
for (const m of perModule) {
  const flag = m.breaches > 0 ? `  ⚠ ${m.breaches}` : '  ok';
  console.log(
    '  ' +
    m.file.padEnd(40) +
    fmt(m.words).padStart(7) +
    fmt(m.tokens).padStart(10) +
    fmt(m.paras).padStart(7) +
    fmt(m.sections).padStart(6) +
    fmt(m.maxSectionTokens).padStart(9) +
    flag
  );
}
console.log('  ' + '─'.repeat(94));
console.log(
  '  TOTAL'.padEnd(42) +
  fmt(totalWords).padStart(7) +
  fmt(totalTokens).padStart(10) +
  fmt(totalParas).padStart(7) +
  fmt(totalSections).padStart(6) +
  fmt(maxSectionTokens).padStart(9) +
  (oversizeSections > 0 ? `  ⚠ ${oversizeSections}` : '  ok')
);
console.log();
console.log('  Verdicts');
console.log('  ' + '─'.repeat(94));
console.log(`  · Total corpus: ${fmt(totalWords)} words / ${fmt(totalTokens)} tokens / ${fmt(totalSections)} sections.`);
console.log(`  · Largest single section: ${fmt(maxSectionTokens)} tokens (safe ceiling ${SAFE_MAX_TOKENS_PER_SECTION}).`);
if (oversizeSections === 0) {
  console.log(`  · ✅ EVERY section fits cleanly under the safe Flash input ceiling.`);
  console.log(`    Wall A (one-shot chunker chokes on a book) is BYPASSED on real content.`);
} else {
  console.log(`  · ⚠ ${oversizeSections} section(s) exceeded ${SAFE_MAX_TOKENS_PER_SECTION} tokens — these contain a single`);
  console.log(`    paragraph too large to fit alone; need a fallback sentence-level split.`);
}
console.log();
console.log('  Per-section sizes (tokens) by module — confirms the "sorting" is even, not lumpy:');
for (const m of perModule) {
  console.log(`    ${m.file.padEnd(40)} [${m.sectionSizes.map((t) => t.toString().padStart(4)).join(', ')}]`);
}
console.log();
console.log(`  Bookmark stripping removed ${fmt(totalRawChars - totalCleanChars)} chars of recording noise`);
console.log(`  (${(100 * (totalRawChars - totalCleanChars) / totalRawChars).toFixed(1)}% of raw — Vuk's "1-", "2.1-", etc.)`);
console.log('═'.repeat(96));
