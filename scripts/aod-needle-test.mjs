#!/usr/bin/env node
// aod-needle-test.mjs — Spike #2 (Vuk 2026-05-27).
//
// Promotes the synthetic Wall-B proof to LIVE evidence on real content:
//   1. Re-segment the 8 AoD modules locally.
//   2. Per-section Flash narrative-chunk (real Gemini call).
//   3. Embed every child chunk via gemini-embedding-001.
//   4. Insert into LOCAL Supabase (NOT prod) as a scratch creator's corpus
//      via _insert_chunk_v2_unsafe (same RPC the v2 worker uses).
//   5. Run topk_v2 with needle questions and compare RRF-SUM rank vs
//      vector_score-MAX rank — does v3's MAX lever change the answer on
//      real Vuk content?
//
// Read-only on PROD. Writes to LOCAL Supabase under a scratch handle
// ('aod_spike_vuk'); idempotent (deletes prior creator at start).
//
// Cost: ~$0.45 (21 Flash calls + a few hundred embeddings).
// Time: ~5–10 min (mostly Flash latency + the model's occasional 503 retries).
//
// Run: node --env-file=.env.local scripts/aod-needle-test.mjs

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const CORPUS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'aod_test_corpus',
);

// ── Config ─────────────────────────────────────────────────────────────────
const FLASH_MODEL = process.env.NARRATIVE_CHUNK_MODEL || 'gemini-2.5-flash';
const EMBED_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
const EMBED_DIM = 768;

// LOCAL Supabase only — never touches prod.
const SB_URL = 'http://127.0.0.1:54321';
const SB_KEY = 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz'; // local service role
const HANDLE = 'aod_spike_vuk';
const TOPIC = 'aod';

// Segmenter (matches segment-dry-run.mjs).
const TARGET_TOK = 7000;
const CPT = 4;
const BOOKMARK_RE = /^[\s*]*\*{0,2}\s*\d+(?:\.\d+)?\s*-?\s*\*{0,2}[\s*]*$/;
const stripBookmarks = (s) => s.split(/\r?\n/).filter((l) => !BOOKMARK_RE.test(l)).join('\n');
const estTok = (s) => Math.ceil(s.length / CPT);
const toParas = (s) => s.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
function packSections(paras) {
  const out = []; let cur = []; let curT = 0;
  for (const p of paras) {
    const pt = estTok(p);
    if (curT > 0 && curT + pt > TARGET_TOK) { out.push(cur.join('\n\n')); cur = []; curT = 0; }
    cur.push(p); curT += pt;
  }
  if (cur.length) out.push(cur.join('\n\n'));
  return out;
}

// Child chunker — minimal port of server/voice-proxy/embed-worker.js chunkSample.
// 200-token target, 50-token overlap, never split a paragraph if avoidable.
const CHILD_TARGET = 200;
const CHILD_OVERLAP = 50;
const CHILD_HARD_MAX_TOK = 2048;
const CHILD_HARD_MAX_CHARS = 8000;
function childChunkUnit(unitText) {
  const paras = toParas(unitText);
  const out = [];
  let cur = ''; let curT = 0; let tail = []; let tailT = 0;
  const flush = () => {
    if (cur.trim().length > 0) out.push(cur.trim().slice(0, CHILD_HARD_MAX_CHARS));
    cur = tail.join(' '); curT = tailT; tail = []; tailT = 0;
  };
  for (const p of paras) {
    const pt = estTok(p);
    if (pt > CHILD_HARD_MAX_TOK) {
      if (cur.trim().length > 0) flush();
      out.push(p.slice(0, CHILD_HARD_MAX_CHARS));
      cur = ''; curT = 0; tail = []; tailT = 0;
      continue;
    }
    if (curT + pt > CHILD_TARGET && curT > 0) flush();
    if (cur.length > 0) cur += ' ';
    cur += p; curT += pt;
    tail.push(p); tailT += pt;
    while (tailT > CHILD_OVERLAP && tail.length > 1) {
      const dropped = tail.shift();
      tailT -= estTok(dropped);
    }
  }
  if (cur.trim().length > 0) out.push(cur.trim().slice(0, CHILD_HARD_MAX_CHARS));
  return out.filter((t) => t.trim().length > 0);
}

// Verbatim narrative-chunk prompt (base).
const HARD_MAX_UNIT_CHARS = 8000;
function buildPrompt(doc, title, strict) {
  const titleLine = title ? `The document title is: "${title}".\n\n` : '';
  const strictAddendum = strict
    ? `\n\nCRITICAL: your previous attempt failed JSON schema validation. You MUST return EXACTLY this shape, nothing else, no markdown fence, no prose:
{"units":[{"title":"...","text":"..."},{"title":"...","text":"..."}]}\n`
    : '';
  return `You are a content editor splitting a document into self-contained narrative units for a retrieval system.

${titleLine}Each unit should be a complete idea, story, or section that makes sense on its own when surfaced to a reader. Aim for ~100-800 tokens per unit. Give each unit a short descriptive title (≤200 chars).

HARD LIMIT: each unit's "text" field MUST be ≤${HARD_MAX_UNIT_CHARS} characters. If a single narrative beat would exceed ${HARD_MAX_UNIT_CHARS} chars, split it at a paragraph or sentence boundary into two or more consecutive units that together cover the same content. Never emit a "text" longer than ${HARD_MAX_UNIT_CHARS} chars under any circumstance.

If the document is a narrative talk, units are story beats. If it's a reference doc, units are logical sections. Mix is fine — let the document tell you.

Return JSON only. No prose, no markdown fences, no commentary.

Output schema:
{
  "units": [
    { "title": "short descriptive title", "text": "the unit's text" },
    ...
  ]
}${strictAddendum}

<document>
${doc}
</document>

Return the JSON object:`;
}

// Pre-clean input: Vuk's script uses literal `\!` and `\?` for emphasis
// (artifacts from his recording prep). Flash mirrors these into its JSON
// output, where `\!` is an invalid escape sequence → JSON.parse fails. Strip
// them from INPUT so Flash never sees them. Also strip stray standalone `\`
// followed by anything other than a valid JSON escape character.
const inputClean = (s) => s.replace(/\\([!?.,;:])/g, '$1');

// Defensive output repair — if Flash emits an invalid escape anyway, fix it
// before JSON.parse. The regex below replaces `\X` (where X is NOT a valid
// JSON escape char) with just `X`. Belt-and-suspenders to the input strip.
const repairJsonEscapes = (s) => s.replace(/\\([^"\\/bfnrtu])/g, '$1');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

async function flashNarrativeUnits(sectionText, title) {
  const cleanInput = inputClean(sectionText);
  let lastErr;
  // Up to 4 transport-retries × 2 prompt variants (base then strict). The
  // strict prompt fires only on a parse/schema failure of the base attempt,
  // matching narrative-chunk.ts's one-retry-on-schema-violation contract.
  for (let promptAttempt = 0; promptAttempt < 2; promptAttempt++) {
    const strict = promptAttempt > 0;
    for (let netAttempt = 1; netAttempt <= 4; netAttempt++) {
      try {
        const resp = await ai.models.generateContent({
          model: FLASH_MODEL,
          contents: buildPrompt(cleanInput, title, strict),
          config: {
            temperature: 0.2,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
            maxOutputTokens: 65535,
          },
        });
        const raw = resp?.text
          ?? resp?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('')
          ?? '';
        const clean = repairJsonEscapes(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim());
        const parsed = JSON.parse(clean);
        const usage = resp?.usageMetadata || {};
        return { units: parsed.units || [], usage };
      } catch (e) {
        lastErr = e;
        const msg = e?.message || String(e);
        const transient = /503|UNAVAILABLE|overloaded|temporar|RESOURCE_EXHAUSTED/i.test(msg);
        const parseErr  = /JSON|Bad escaped|Unexpected token|Schema/i.test(msg);
        if (transient && netAttempt < 4) {
          await new Promise((r) => setTimeout(r, 1500 * 2 ** (netAttempt - 1)));
          continue;
        }
        if (parseErr && !strict) {
          // Break inner loop → bump promptAttempt to use the strict prompt.
          break;
        }
        // Non-transient, not a parse error we can re-prompt on → give up.
        throw e;
      }
    }
  }
  throw lastErr ?? new Error('flashNarrativeUnits: exhausted');
}

async function embed(texts, taskType) {
  const out = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100);
    let resp;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        resp = await ai.models.embedContent({
          model: EMBED_MODEL,
          contents: batch,
          config: { outputDimensionality: EMBED_DIM, taskType },
        });
        break;
      } catch (e) {
        const transient = /503|UNAVAILABLE|RESOURCE_EXHAUSTED|temporar/i.test(e?.message || '');
        if (!transient || attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 1500 * 2 ** (attempt - 1)));
      }
    }
    for (const e of resp.embeddings ?? []) out.push(e.values);
  }
  return out;
}

// ── Setup: idempotent scratch creator ──────────────────────────────────────
async function setupCreator() {
  // Clean prior run by handle.
  const { data: prev } = await sb.from('creators').select('id, user_id').eq('handle', HANDLE).maybeSingle();
  if (prev) {
    console.log(`  · cleaning prior scratch creator ${prev.id.slice(0,8)}`);
    await sb.from('creators').delete().eq('id', prev.id);
    // Best-effort auth user delete via admin API.
    try {
      const adm = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
      await adm.auth.admin.deleteUser(prev.user_id);
    } catch {}
  }
  // Fresh auth user via admin API.
  const { data: created, error: userErr } = await sb.auth.admin.createUser({
    email: `${HANDLE}@test.local`,
    email_confirm: true,
  });
  if (userErr) throw userErr;
  const userId = created.user.id;
  // Application + creator + topic.
  const { data: app, error: appErr } = await sb.from('creator_applications')
    .insert({ user_id: userId, status: 'approved', display_name: 'AoD Spike Vuk', handle: HANDLE, topics: [], proof: {} })
    .select('id').single();
  if (appErr) throw appErr;
  const { data: creator, error: cErr } = await sb.from('creators')
    .insert({ user_id: userId, application_id: app.id, display_name: 'AoD Spike Vuk', handle: HANDLE, brain_status: 'ready' })
    .select('id').single();
  if (cErr) throw cErr;
  const { error: tErr } = await sb.from('creator_topics')
    .insert({ creator_id: creator.id, slug: TOPIC, title: 'Acres Of Diamonds', sort_order: 0 });
  if (tErr) throw tErr;
  return { creatorId: creator.id, userId };
}

// ── Ingest ─────────────────────────────────────────────────────────────────
async function ingest(creatorId) {
  const files = (await fs.readdir(CORPUS_DIR)).filter((f) => f.startsWith('module-') && f.endsWith('.txt')).sort();
  let totalUnits = 0, totalChildren = 0;
  let flashIn = 0, flashOut = 0, embedTok = 0;
  const t0 = Date.now();
  for (const file of files) {
    const raw = await fs.readFile(path.join(CORPUS_DIR, file), 'utf8');
    const sections = packSections(toParas(stripBookmarks(raw)));
    const title = file.replace(/^module-\d+-/, '').replace(/\.txt$/, '').replace(/-/g, ' ');
    // Insert a sample_content per MODULE (one row).
    const { data: sample, error: sErr } = await sb.from('sample_content')
      .insert({
        creator_id: creatorId, source_type: 'transcript',
        title: file, raw_text: raw,
        topic_tags: [TOPIC], fetch_status: 'ready',
      })
      .select('id').single();
    if (sErr) throw sErr;

    process.stdout.write(`  · ${file.padEnd(40)} → ${sections.length} sections, units: `);
    let unitsThisModule = 0; let childrenThisModule = 0;
    let unitIdx = 0;
    for (let si = 0; si < sections.length; si++) {
      const sec = sections[si];
      const { units, usage } = await flashNarrativeUnits(sec, title);
      flashIn += usage.promptTokenCount || 0;
      flashOut += usage.candidatesTokenCount || 0;
      for (const u of units) {
        const text = String(u.text || '').slice(0, HARD_MAX_UNIT_CHARS);
        if (text.length === 0) continue;
        const tokenCount = Math.min(2048, Math.max(1, estTok(text)));
        const { data: unit, error: uErr } = await sb.from('sample_content_narrative_units')
          .insert({
            sample_id: sample.id, creator_id: creatorId, unit_index: unitIdx,
            title: String(u.title || '(untitled)').slice(0, 200),
            text, token_count: tokenCount, topic_tags: [TOPIC],
          })
          .select('id').single();
        if (uErr) throw uErr;
        unitIdx++;
        // Children + embed + insert.
        const children = childChunkUnit(text);
        if (children.length === 0) continue;
        const vecs = await embed(children, 'RETRIEVAL_DOCUMENT');
        embedTok += children.reduce((a, t) => a + estTok(t), 0);
        for (let ci = 0; ci < children.length; ci++) {
          const child = children[ci];
          const childTok = Math.min(2048, Math.max(1, estTok(child)));
          const { error: cErr } = await sb.rpc('_insert_chunk_v2_unsafe', {
            p_parent_unit_id: unit.id,
            p_chunk_index: totalChildren + childrenThisModule + ci,
            p_text: child,
            p_chunk_context: null,
            p_token_count: childTok,
            p_topic_tags: [TOPIC],
            p_embedding: `[${vecs[ci].join(',')}]`,
            p_embedding_model: EMBED_MODEL,
          });
          if (cErr) throw cErr;
        }
        childrenThisModule += children.length;
        unitsThisModule++;
      }
      process.stdout.write('.');
    }
    process.stdout.write(` ${unitsThisModule} units / ${childrenThisModule} chunks\n`);
    totalUnits += unitsThisModule;
    totalChildren += childrenThisModule;
  }
  const ms = Date.now() - t0;
  return { totalUnits, totalChildren, flashIn, flashOut, embedTok, ms };
}

// ── Needle queries: SUM vs MAX rank ────────────────────────────────────────
async function needleRank(creatorId, query) {
  const vecs = await embed([query], 'RETRIEVAL_QUERY');
  const qVec = `[${vecs[0].join(',')}]`;
  const { data: tsq } = await sb.rpc('try_build_tsquery', { p_text: query.slice(0, 4000) });
  const { data: rows, error } = await sb.rpc('creator_knowledge_topk_v2', {
    p_creator_id: creatorId, p_query_vec: qVec, p_query_tsq: tsq,
    p_k_child: 30, p_k_parent: 50, p_min_sim: 0.0,
  });
  if (error) throw error;
  return rows;
}

function ranked(rows, scoreKey) {
  return [...rows]
    .map((r) => ({ ...r, _score: Number(r[scoreKey]) }))
    .sort((a, b) => b._score - a._score);
}

// ── Run ────────────────────────────────────────────────────────────────────
console.log('═'.repeat(96));
console.log('  AoD NEEDLE TEST — full corpus → real ingest → SUM vs MAX rank divergence');
console.log('═'.repeat(96));
console.log();
console.log('1. Setup scratch creator (local DB)');
const { creatorId, userId } = await setupCreator();
console.log(`   creator=${creatorId.slice(0,8)} user=${userId.slice(0,8)} handle=@${HANDLE}`);
console.log();
console.log('2. Ingest 8 modules → per-section Flash → narrative units → children → embed');
const stats = await ingest(creatorId);
console.log();
console.log(`   ✅ ingest complete in ${(stats.ms/1000).toFixed(1)}s`);
console.log(`      ${stats.totalUnits} narrative units · ${stats.totalChildren} child chunks`);
const flashCostIn  = stats.flashIn  * 0.30 / 1_000_000;
const flashCostOut = stats.flashOut * 2.50 / 1_000_000;
const embedCost    = stats.embedTok * 0.15 / 1_000_000;
console.log(`      Flash: in=${stats.flashIn} out=${stats.flashOut} ($${(flashCostIn+flashCostOut).toFixed(3)})`);
console.log(`      Embed: ${stats.embedTok} tok ($${embedCost.toFixed(4)})`);
console.log();
console.log('3. Needle queries — same RPC the live retrieval uses (topk_v2, k_parent=50)');
console.log('   For each query: compute rank under SUM(rrf) [today] vs MAX(vector_score) [v3 lever].');
console.log();

const queries = [
  'tell me the story about your best friend who went to the gym after driving all night',
  'what happens to your dopamine receptors when you scroll social media',
  'the lumberjack and the guitar player example',
  'who is twin A and twin B and what happens after two years',
  'what is the loop of manifestation',
];

for (const q of queries) {
  const rows = await needleRank(creatorId, q);
  if (rows.length === 0) { console.log(`   "${q}" → 0 rows`); continue; }
  const bySum = ranked(rows, 'rrf_score');
  const byMax = ranked(rows, 'vector_score');
  const sumTop = bySum[0];
  const maxTop = byMax[0];
  const sameWinner = sumTop.parent_unit_id === maxTop.parent_unit_id;
  console.log(`   Q: "${q}"`);
  console.log(`      rows=${rows.length}`);
  console.log(`      SUM-RRF #1: "${(sumTop.parent_title || '').slice(0,60)}"  rrf=${Number(sumTop.rrf_score).toFixed(4)}  vec=${Number(sumTop.vector_score).toFixed(4)}`);
  console.log(`      MAX-VEC #1: "${(maxTop.parent_title || '').slice(0,60)}"  vec=${Number(maxTop.vector_score).toFixed(4)}  rrf=${Number(maxTop.rrf_score).toFixed(4)}`);
  if (sameWinner) {
    console.log(`      → same winner (both methods agree)`);
  } else {
    // Find rank of MAX-#1 under SUM, and SUM-#1 under MAX.
    const sumRankOfMaxWinner = bySum.findIndex((r) => r.parent_unit_id === maxTop.parent_unit_id) + 1;
    const maxRankOfSumWinner = byMax.findIndex((r) => r.parent_unit_id === sumTop.parent_unit_id) + 1;
    console.log(`      → DIVERGENCE: MAX-#1 ranks #${sumRankOfMaxWinner} under SUM · SUM-#1 ranks #${maxRankOfSumWinner} under MAX`);
  }
  // Top-5 by SUM, with their MAX ranks.
  console.log(`      top-5 by SUM (with MAX-rank in parens):`);
  bySum.slice(0, 5).forEach((r, i) => {
    const maxR = byMax.findIndex((x) => x.parent_unit_id === r.parent_unit_id) + 1;
    console.log(`         #${i+1}  "${(r.parent_title || '').slice(0,58)}"  rrf=${Number(r.rrf_score).toFixed(4)}  vec=${Number(r.vector_score).toFixed(4)}  (max-rank #${maxR})`);
  });
  console.log();
}
console.log('═'.repeat(96));
console.log(`  Scratch creator left in local DB as @${HANDLE} (id=${creatorId.slice(0,8)}).`);
console.log(`  Re-run this script to refresh; \`supabase db reset\` to wipe everything.`);
console.log('═'.repeat(96));
