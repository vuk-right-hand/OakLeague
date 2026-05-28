#!/usr/bin/env node
// aod-flash-spike.mjs — Spike #1 (Vuk 2026-05-27).
//
// One Flash call on the FIRST SECTION of module 4 of Acres Of Diamonds (the
// biggest module — most likely to surface a problem). Uses the EXACT same
// Gemini config as src/lib/voice/narrative-chunk.ts so this is a faithful
// test of the per-section call the v3 worker will make.
//
// Read-only. No DB. One paid API call (~6,500 input tok + ~2k output ≈ $0.01).
//
// Run: node --env-file=.env.local scripts/aod-flash-spike.mjs

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';

const CORPUS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'aod_test_corpus',
);
const TARGET_TOKENS = 7000;
const CHARS_PER_TOKEN = 4;
const MODEL = process.env.NARRATIVE_CHUNK_MODEL || 'gemini-2.5-flash';

// Same bookmark + segmentation logic as segment-dry-run.mjs.
const BOOKMARK_RE = /^[\s*]*\*{0,2}\s*\d+(?:\.\d+)?\s*-?\s*\*{0,2}[\s*]*$/;
const stripBookmarks = (s) => s.split(/\r?\n/).filter((l) => !BOOKMARK_RE.test(l)).join('\n');
const estTok = (s) => Math.ceil(s.length / CHARS_PER_TOKEN);
const toParas = (s) => s.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
function packSections(paras) {
  const out = []; let cur = []; let curT = 0;
  for (const p of paras) {
    const pt = estTok(p);
    if (curT > 0 && curT + pt > TARGET_TOKENS) { out.push(cur.join('\n\n')); cur = []; curT = 0; }
    cur.push(p); curT += pt;
  }
  if (cur.length) out.push(cur.join('\n\n'));
  return out;
}

// Verbatim from src/lib/voice/narrative-chunk.ts buildPrompt() (base, non-strict).
const HARD_MAX_UNIT_CHARS = 8000;
const HARD_MAX_TITLE_CHARS = 200;
function buildPrompt(sanitizedDocument, sampleTitle) {
  const titleLine = sampleTitle ? `The document title is: "${sampleTitle}".\n\n` : '';
  return `You are a content editor splitting a document into self-contained narrative units for a retrieval system.

${titleLine}Each unit should be a complete idea, story, or section that makes sense on its own when surfaced to a reader. Aim for ~100-800 tokens per unit. Give each unit a short descriptive title (≤${HARD_MAX_TITLE_CHARS} chars).

HARD LIMIT: each unit's "text" field MUST be ≤${HARD_MAX_UNIT_CHARS} characters. If a single narrative beat would exceed ${HARD_MAX_UNIT_CHARS} chars, split it at a paragraph or sentence boundary into two or more consecutive units that together cover the same content. Never emit a "text" longer than ${HARD_MAX_UNIT_CHARS} chars under any circumstance.

If the document is a narrative talk, units are story beats. If it's a reference doc, units are logical sections. Mix is fine — let the document tell you.

Return JSON only. No prose, no markdown fences, no commentary.

Output schema:
{
  "units": [
    { "title": "short descriptive title", "text": "the unit's text" },
    ...
  ]
}

<document>
${sanitizedDocument}
</document>

Return the JSON object:`;
}

// ── Run ────────────────────────────────────────────────────────────────────
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('FATAL: GEMINI_API_KEY missing from env'); process.exit(1); }

const moduleFile = 'module-04-fabric-of-reality.txt';
const raw = await fs.readFile(path.join(CORPUS_DIR, moduleFile), 'utf8');
const clean = stripBookmarks(raw);
const sections = packSections(toParas(clean));
const sec0 = sections[0];

console.log('═'.repeat(96));
console.log(`  FLASH SPIKE — ${moduleFile} · section 1 of ${sections.length}`);
console.log('═'.repeat(96));
console.log(`  input:  ${sec0.length.toLocaleString()} chars · ~${estTok(sec0).toLocaleString()} tokens`);
console.log(`  model:  ${MODEL}`);
console.log();

const ai = new GoogleGenAI({ apiKey });
async function callFlash() {
  return ai.models.generateContent({
    model: MODEL,
    contents: buildPrompt(sec0, '4. The Fabric Of Reality'),
    config: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 },
      maxOutputTokens: 65535,
    },
  });
}
const t0 = Date.now();
let resp;
let attempt = 0;
for (;;) {
  attempt++;
  try { resp = await callFlash(); break; }
  catch (e) {
    const msg = e?.message || String(e);
    const transient = /503|UNAVAILABLE|overloaded|temporar/i.test(msg);
    if (!transient || attempt >= 4) { console.error(`Flash call failed (attempt ${attempt}):`, msg); process.exit(1); }
    const backoff = 1000 * Math.pow(2, attempt - 1);
    console.warn(`  · attempt ${attempt} got transient ${msg.slice(0, 80)}…  retrying in ${backoff}ms`);
    await new Promise((r) => setTimeout(r, backoff));
  }
}
const ms = Date.now() - t0;
if (attempt > 1) console.log(`  · succeeded on attempt ${attempt}`);

const raw_text = resp?.text
  ?? resp?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('')
  ?? '';
const usage = resp?.usageMetadata || {};

console.log(`  latency: ${ms.toLocaleString()} ms`);
console.log(`  usage:   prompt=${usage.promptTokenCount ?? '?'} candidates=${usage.candidatesTokenCount ?? '?'} total=${usage.totalTokenCount ?? '?'}`);
console.log();

let parsed;
try { parsed = JSON.parse(raw_text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()); }
catch (e) { console.error('JSON parse FAIL:', e.message); console.error('First 400 chars of response:\n', raw_text.slice(0, 400)); process.exit(1); }

if (!parsed?.units || !Array.isArray(parsed.units)) {
  console.error('Schema FAIL — no .units array. Got keys:', Object.keys(parsed || {}));
  process.exit(1);
}

console.log(`  ✅ ${parsed.units.length} narrative units returned`);
console.log();
console.log('  unit            chars  title                                            preview');
console.log('  ' + '─'.repeat(94));
parsed.units.forEach((u, i) => {
  const title = (u.title || '(untitled)').slice(0, 48);
  const preview = (u.text || '').slice(0, 60).replace(/\s+/g, ' ');
  const charsCol = String((u.text || '').length).padStart(6);
  const oversize = (u.text || '').length > HARD_MAX_UNIT_CHARS;
  console.log('  ' + `#${(i + 1).toString().padStart(2)}`.padEnd(14) + charsCol + '  ' + title.padEnd(49) + preview.slice(0, 30) + (oversize ? ' ⚠ OVERSIZE' : ''));
});
console.log();
const sizes = parsed.units.map((u) => (u.text || '').length);
console.log(`  unit sizes (chars): min=${Math.min(...sizes)} avg=${Math.round(sizes.reduce((a,b)=>a+b,0)/sizes.length)} max=${Math.max(...sizes)}`);
const oversizeCount = sizes.filter((s) => s > HARD_MAX_UNIT_CHARS).length;
console.log(`  oversize units (>${HARD_MAX_UNIT_CHARS} chars): ${oversizeCount}${oversizeCount === 0 ? ' ✅' : ' ⚠'}`);
console.log();
console.log('  Cost (estimate, gemini-2.5-flash @ $0.30/M input + $2.50/M output):');
const inCost  = (usage.promptTokenCount     ?? 0) * 0.30  / 1_000_000;
const outCost = (usage.candidatesTokenCount ?? 0) * 2.50  / 1_000_000;
console.log(`    in: $${inCost.toFixed(5)}  out: $${outCost.toFixed(5)}  total: $${(inCost+outCost).toFixed(5)}`);
console.log('═'.repeat(96));
