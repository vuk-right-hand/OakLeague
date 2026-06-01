#!/usr/bin/env node
// diag-eval-v3.mjs — RAG v3 eval harness (RAG_SCALING_V3_PLAN.md §7-8).
// Methodology + every auditor-round-1 fix: docs/_planning/EVAL_V3_HARNESS_DESIGN.md §9.
//
// READ-ONLY ON PROD. Local Supabase only (127.0.0.1:54321). Drives the REAL
// worker (server/voice-proxy/embed-worker.js makeCorpusReprocessWorker) so the
// frozen constants reflect what ships — NOT a reimplemented pipeline.
//
// Produces the prod-gate constants: route_min_sim, per-mode topk_min_sim map,
// lambda, top-S, winning rank_mode, inject-K, and (last) inject_min_rerank_score.
//
// PREREQ: `npm run dev` running (Next) so /api/internal/contextual-gen is
// reachable at http://localhost:3000 (worker dev-exception allows http-localhost).
//
// Sub-commands (node --env-file=.env.local scripts/diag-eval-v3.mjs <cmd> [opts]):
//   ingest   --corpus aod|book --version 2|3        build a scratch creator + drive worker
//   preflight --corpus aod|book --version 3         resolve needles -> unit_id; assert off-topic empty
//   metrics  --corpus aod|book                      recall@k, reach-reranker(v2+v3), routing, latency, COGS, no-regression
//   sweep    --corpus aod|book                      grid: rank_mode x S x lambda x topk_min_sim x route_min_sim
//   export-rubric --corpus book                     CSV question sheet for the human "exactly him" rubric
//   cleanup  [--corpus aod|book]                    delete scratch creators
//   all      --corpus aod                           ingest(v2+v3)+preflight+metrics+sweep (validation convenience)
//
// Every paid call accrues to a running USD tally; the harness HARD-STOPS before
// any batch that would cross EVAL_MAX_USD (default $8) — a backstop independent
// of the worker's own pre-flight cap, so a runaway can't blow the $10 ceiling.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import { makeCorpusReprocessWorker } from '../server/voice-proxy/embed-worker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AOD_CORPUS_DIR = path.resolve(HERE, 'aod_test_corpus');
const NEEDLES_PATH = path.resolve(HERE, 'eval-v3', 'needles.json');
const OUT_DIR = path.resolve(HERE, 'eval-v3', 'out');

// ── Config (pinned to prod values; see CLAUDE.md + the bridges) ──────────────
const SB_URL = process.env.EVAL_SB_URL || 'http://127.0.0.1:54321';
const SB_KEY = process.env.EVAL_SB_SERVICE_KEY || 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';
const INTERNAL_API_BASE_URL = process.env.EVAL_INTERNAL_API_BASE_URL || 'http://localhost:3000';
const EMBED_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
// Mirrors the prod default pinned in src/lib/voice/query-rewrite.ts (2026-05-30:
// gemini-2.5-flash → gemini-3.1-flash-lite). Keep in lockstep or the harness's
// cost-per-query deltas compare against a baseline prod no longer runs.
const REWRITE_MODEL = process.env.QUERY_REWRITE_MODEL || 'gemini-3.1-flash-lite';
const VOYAGE_RERANK_MODEL = process.env.VOYAGE_RERANK_MODEL || 'rerank-2.5';
const VOYAGE_RERANK_URL = 'https://api.voyageai.com/v1/rerank';
const EMBED_DIM = 768;

// Pricing pins (USD per 1M tokens unless noted) — mirror embed-worker.js + rerank.ts.
const EMBED_USD_PER_M = Number(process.env.EMBEDDING_USD_PER_M || '0.15');
const FLASH_USD_PER_M_IN = Number(process.env.FLASH_USD_PER_M_INPUT || '0.25'); // 3.1-flash-lite (was 2.5 $0.30); mirror embed-worker.js
const VOYAGE_USD_PER_M = Number(process.env.VOYAGE_RERANK_USD_PER_M || '0.05');
const EVAL_MAX_USD = Number(process.env.EVAL_MAX_USD || '8');

// Read-path defaults (mirror retrieve-knowledge.ts).
const DEFAULT_K_CHILD = 30;
const DEFAULT_TOP_S = 6; // frozen prod value (was 4 during the §8 sweep that derived it)
const DEFAULT_N_PARENT = 5;
const DEFAULT_RANK_MODE = 'max_blend';
const DEFAULT_LAMBDA = 0.1;
const DEFAULT_MIN_SIM_BY_MODE = { max: 0.20, max_blend: 0.20, best_child: 0.20, vec_max: 0.40 };
const RANK_MODES = ['max', 'max_blend', 'vec_max', 'best_child'];
const INJECT_K_SET = [1, 2];
const RERANK_WINDOW = 5; // recall@5 = pre-inject rerank window
const V2_MIN_SIM = 0.30; // v2's tuned floor (no-regression baseline runs v2 at its own floor, design §9 C5)

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

// ── Tiny utilities ───────────────────────────────────────────────────────────
const log = (...a) => console.log(...a);
const hr = (c = '=') => log(c.repeat(96));
const estTok = (s) => Math.ceil((s?.length ?? 0) / 4);
const normSub = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const vecToPg = (v) => `[${v.join(',')}]`;
// Best (lowest) rank of ANY acceptable unit in a ranked id list; Infinity if none present.
const bestRank = (rankedIds, acceptableIds) => {
  let best = Infinity;
  for (const u of acceptableIds) { const i = rankedIds.indexOf(u); if (i >= 0 && i < best) best = i; }
  return best;
};
const anyIn = (list, acceptableIds) => acceptableIds.some((u) => list.includes(u));
const pctl = (arr, p) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[i];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else out._.push(a);
  }
  return out;
}

// ── Cost tally + hard backstop ───────────────────────────────────────────────
const cost = { embed: 0, voyage: 0, rewrite: 0, ingest: 0 };
const totalUsd = () => cost.embed + cost.voyage + cost.rewrite + cost.ingest;
function assertBudget(label) {
  if (totalUsd() >= EVAL_MAX_USD) {
    log(`\n  ✋ EVAL_MAX_USD ($${EVAL_MAX_USD}) reached before "${label}". Spent $${totalUsd().toFixed(4)}. Stopping.`);
    log('     Raise with EVAL_MAX_USD=<n> (ping Vuk if >$10 total).');
    process.exit(2);
  }
}

if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY required (run with --env-file=.env.local)');
if (!VOYAGE_API_KEY) throw new Error('VOYAGE_API_KEY required');
if (!INTERNAL_API_SECRET || INTERNAL_API_SECRET.length < 32) throw new Error('INTERNAL_API_SECRET missing or <32 chars');

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

// ── Provider helpers (mirror the prod bridges) ───────────────────────────────
const _embedCache = new Map(); // (taskType|text) -> vector. Query embeddings are
// deterministic for fixed model+input, so caching across the sweep saves hundreds
// of identical RTTs + counts the token cost exactly once (cache hit = $0).
async function embedOne(text, taskType, skipCache = false) {
  const key = `${taskType}|${text}`;
  if (!skipCache && _embedCache.has(key)) return _embedCache.get(key);
  let resp;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      resp = await ai.models.embedContent({
        model: EMBED_MODEL, contents: [text],
        config: { outputDimensionality: EMBED_DIM, taskType },
      });
      break;
    } catch (e) {
      const transient = /503|UNAVAILABLE|RESOURCE_EXHAUSTED|temporar/i.test(e?.message || '');
      if (!transient || attempt >= 4) throw e;
      await sleep(1500 * 2 ** (attempt - 1));
    }
  }
  cost.embed += (estTok(text) * EMBED_USD_PER_M) / 1_000_000;
  const vec = resp.embeddings[0].values;
  _embedCache.set(key, vec);
  return vec;
}

// Representative query-rewrite call — for the M5 full-turn latency leg only.
// Mirrors query-rewrite.ts model + temp 0 + thinkingBudget 0 (gemini-2.5-flash).
// We don't reuse the exact prompt (TS); latency is RTT-dominated for short
// prompts, so a representative short call is a fair proxy. Documented in design M5.
async function rewriteLatencyProbe(utterance) {
  const t0 = Date.now();
  try {
    const resp = await ai.models.generateContent({
      model: REWRITE_MODEL,
      contents: `Rewrite this spoken question into a concise search query. Return ONLY the query.\n\nQuestion: ${utterance}`,
      config: { temperature: 0.0, thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 64 },
    });
    const u = resp?.usageMetadata || {};
    cost.rewrite += ((u.promptTokenCount || estTok(utterance)) * FLASH_USD_PER_M_IN) / 1_000_000;
  } catch {
    return null; // audit-2 M6: a failed/timed-out rewrite must NOT enter the latency
    // distribution as if it were a successful call (its wall time would inflate p95).
  }
  return Date.now() - t0;
}

// Gentle global throttle so a tight sweep loop doesn't burst past Voyage's
// requests-per-minute cap (the sweep fires hundreds of reranks back-to-back).
// Env-tunable; 0 to disable.
const VOYAGE_THROTTLE_MS = Number(process.env.EVAL_VOYAGE_THROTTLE_MS || '350');
const VOYAGE_MAX_ATTEMPTS = Number(process.env.EVAL_VOYAGE_MAX_ATTEMPTS || '7');

async function voyageRerank(query, documents, topK) {
  const t0 = Date.now();
  if (VOYAGE_THROTTLE_MS > 0) await sleep(VOYAGE_THROTTLE_MS);
  let resp;
  for (let attempt = 1; attempt <= VOYAGE_MAX_ATTEMPTS; attempt++) {
    try {
      resp = await fetch(VOYAGE_RERANK_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${VOYAGE_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: VOYAGE_RERANK_MODEL, query, documents,
          top_k: topK, truncation: true, return_documents: false,
        }),
      });
      if (resp.status === 429 || resp.status >= 500) {
        // Honor Retry-After when present; else exponential backoff capped at 30s.
        const ra = Number(resp.headers.get('retry-after'));
        const waitMs = Number.isFinite(ra) && ra > 0
          ? Math.min(ra * 1000, 30_000)
          : Math.min(1000 * 2 ** (attempt - 1), 30_000);
        throw Object.assign(new Error(`voyage_${resp.status}`), { waitMs });
      }
      break;
    } catch (e) {
      if (attempt >= VOYAGE_MAX_ATTEMPTS) throw e;
      await sleep(e?.waitMs ?? Math.min(1000 * 2 ** (attempt - 1), 30_000));
    }
  }
  const json = await resp.json();
  // Authoritative token count (design §5). Warn loudly if Voyage omits usage so
  // the $-ceiling decision is never silently made on an estimate (audit-2 M7).
  let used = json?.usage?.total_tokens;
  if (used == null) { used = documents.reduce((a, d) => a + estTok(d), 0); log(`  ⚠ voyage usage.total_tokens missing — COST ESTIMATED (~${used} tok), not authoritative`); }
  cost.voyage += (used * VOYAGE_USD_PER_M) / 1_000_000;
  // results: [{ index, relevance_score }] sorted desc by score.
  const results = (json?.data || json?.results || []).map((r) => ({
    index: r.index, score: r.relevance_score ?? r.score,
  }));
  return { results, ms: Date.now() - t0 };
}

// ── Scratch creator (idempotent by handle) ───────────────────────────────────
function handleFor(corpus, version) { return `evalv3_${corpus}_v${version}`; }

async function setupCreator(corpus, version) {
  const handle = handleFor(corpus, version);
  const { data: prev } = await sb.from('creators').select('id, user_id').eq('handle', handle).maybeSingle();
  if (prev) {
    log(`  · cleaning prior scratch creator @${handle} (${prev.id.slice(0, 8)})`);
    await sb.from('creators').delete().eq('id', prev.id);
    try { await sb.auth.admin.deleteUser(prev.user_id); } catch { /* best-effort */ }
  }
  const { data: created, error: uErr } = await sb.auth.admin.createUser({ email: `${handle}@test.local`, email_confirm: true });
  if (uErr) throw uErr;
  const userId = created.user.id;
  const { data: app, error: aErr } = await sb.from('creator_applications')
    .insert({ user_id: userId, status: 'approved', display_name: `eval ${corpus} v${version}`, handle, topics: [], proof: {} })
    .select('id').single();
  if (aErr) throw aErr;
  const { data: creator, error: cErr } = await sb.from('creators')
    .insert({ user_id: userId, application_id: app.id, display_name: `eval ${corpus} v${version}`, handle, brain_status: 'ready', retrieval_version: version })
    .select('id').single();
  if (cErr) throw cErr;
  const tag = needlesFor(corpus).topic_tag;
  const { error: tErr } = await sb.from('creator_topics').insert({ creator_id: creator.id, slug: tag, title: tag, sort_order: 0 });
  if (tErr) throw tErr;
  return creator.id;
}

async function getCreator(corpus, version) {
  const { data } = await sb.from('creators').select('id').eq('handle', handleFor(corpus, version)).maybeSingle();
  return data?.id || null;
}

// AoD's transcript carries `\!` / `\?` recording-prep emphasis marks. Flash echoes
// them into its JSON output where `\!` is an INVALID escape -> JSON.parse fails ->
// zero units for that section -> section skipped -> creator_v3_ready=false (hit
// modules 7+8 on the 2026-05-29 book run). These marks are not content; strip the
// stray backslash before punctuation so ingest is reliable + reproducible. Mirrors
// scripts/aod-needle-test.mjs inputClean. (A clean book without such marks no-ops.)
const inputClean = (s) => s.replace(/\\([!?.,;:'"])/g, '$1');

// ── Corpus loading (chapter-as-sample) ───────────────────────────────────────
async function loadCorpusChapters(corpus) {
  if (corpus === 'aod') {
    const files = (await fs.readdir(AOD_CORPUS_DIR)).filter((f) => f.startsWith('module-') && f.endsWith('.txt')).sort();
    const out = [];
    for (const f of files) out.push({ title: f, text: inputClean(await fs.readFile(path.join(AOD_CORPUS_DIR, f), 'utf8')) });
    return out;
  }
  if (corpus === 'book') {
    const bookDir = path.resolve(HERE, 'eval-v3', 'book');
    const files = (await fs.readdir(bookDir)).filter((f) => f.endsWith('.txt')).sort();
    if (files.length === 0) throw new Error(`No book chapters in ${bookDir} — drop chapter .txt files (one per chapter) there first.`);
    const out = [];
    for (const f of files) out.push({ title: f, text: inputClean(await fs.readFile(path.join(bookDir, f), 'utf8')) });
    return out;
  }
  throw new Error(`unknown corpus ${corpus}`);
}

// ── Ingest driver: insert samples (trigger enqueues) + drive the REAL worker ──
async function ingest(corpus, version) {
  assertBudget(`ingest ${corpus} v${version}`);
  const tag = needlesFor(corpus).topic_tag;
  const creatorId = await setupCreator(corpus, version);
  log(`  creator=${creatorId.slice(0, 8)} @${handleFor(corpus, version)} retrieval_version=${version}`);

  const chapters = await loadCorpusChapters(corpus);
  log(`  inserting ${chapters.length} chapter-samples (trigger auto-enqueues target_version=${version})`);
  for (const ch of chapters) {
    const { error } = await sb.from('sample_content').insert({
      creator_id: creatorId, source_type: 'transcript', title: ch.title,
      raw_text: ch.text, topic_tags: [tag], fetch_status: 'ready',
    });
    if (error) throw new Error(`sample insert failed (${ch.title}): ${error.message}`);
  }

  // corpus_reprocess_jobs keys on sample_id (no creator_id column) — resolve the
  // creator's sample_ids once and filter jobs by them.
  const sampleIds = ((await sb.from('sample_content').select('id').eq('creator_id', creatorId)).data || []).map((s) => s.id);

  const worker = makeCorpusReprocessWorker({
    supabase: sb, geminiApiKey: GEMINI_API_KEY,
    internalApiBaseUrl: INTERNAL_API_BASE_URL, internalApiSecret: INTERNAL_API_SECRET,
    flyMachineId: 'eval',
  });

  // Drive tick() until the queue drains. Each tick claims+processes ONE job.
  log('  draining queue via worker.tick() (real Flash + Haiku + embeds)...');
  const t0 = Date.now();
  let ticks = 0;
  for (;;) {
    const { data: pend } = await sb.from('corpus_reprocess_jobs')
      .select('id').in('sample_id', sampleIds).in('status', ['pending', 'processing']);
    if (!pend || pend.length === 0) break;
    // audit-2 C3: enforce EVAL_MAX_USD on the DOMINANT cost path. Read live ingest
    // spend from cogs_log (the worker writes per-section) + the run tally; bail
    // BEFORE the next tick if we'd cross the cap. Without this, a runaway book
    // ingest spends unbounded (cogs is otherwise only summed post-drain).
    const liveIngest = ((await sb.from('cogs_log').select('cost_usd').eq('metadata->>creator_id', creatorId)).data || []).reduce((a, r) => a + Number(r.cost_usd || 0), 0);
    if (cost.embed + cost.voyage + cost.rewrite + liveIngest >= EVAL_MAX_USD) {
      throw new Error(`EVAL_MAX_USD ($${EVAL_MAX_USD}) reached mid-ingest (~$${(cost.embed + cost.voyage + cost.rewrite + liveIngest).toFixed(2)} spent). Stopped before next tick — raise EVAL_MAX_USD or ping Vuk.`);
    }
    await worker.tick();
    ticks++;
    if (ticks > chapters.length * 8 + 50) throw new Error('tick budget exceeded — possible stuck/erroring jobs');
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  log(`  drained in ${((Date.now() - t0) / 1000).toFixed(1)}s over ${ticks} ticks`);

  // CLEAN-RUN assertion (design C3/M6): every job done, zero requeues.
  const { data: jobs } = await sb.from('corpus_reprocess_jobs')
    .select('id, status, attempts, enqueue_version, last_error').in('sample_id', sampleIds);
  const bad = (jobs || []).filter((j) => j.status !== 'done');
  const requeued = (jobs || []).filter((j) => (j.attempts ?? 0) > 0 || (j.enqueue_version ?? 1) > 1);
  if (bad.length > 0) throw new Error(`${bad.length} job(s) not done: ` + bad.map((j) => `${j.status}(${(j.last_error || '').slice(0, 120)})`).join(' | '));
  // Requeue with all-jobs-done = DATA is complete (a chapter was reprocessed), only
  // the COGS $ figure is inflated by the re-spend. Warn + flag COGS approximate;
  // don't block the retrieval eval (which doesn't depend on COGS exactness).
  const cogsApprox = requeued.length > 0;
  if (cogsApprox) {
    log(`  ⚠ ${requeued.length} job(s) requeued (a large chapter exceeded the 9-min worker deadline + reprocessed) — ` +
      `data is COMPLETE but ingest COGS below is APPROXIMATE (includes the re-spend; exclude from any freeze).`);
  }

  // creator_v3_ready + stable corpus_version (design C4/M1).
  if (version === 3) {
    const { data: ready, error: rErr } = await sb.rpc('creator_v3_ready', { p_creator_id: creatorId });
    if (rErr) throw rErr;
    if (ready !== true) throw new Error('creator_v3_ready=false post-ingest — a section has zero v3 chunks or NULL centroid');
  }
  const v1 = (await sb.from('creators').select('current_corpus_version').eq('id', creatorId).single()).data.current_corpus_version;
  await sleep(1000);
  const v2 = (await sb.from('creators').select('current_corpus_version').eq('id', creatorId).single()).data.current_corpus_version;
  if (v1 !== v2) throw new Error(`corpus_version not stable (${v1}->${v2}) — ingest not quiesced`);

  // COGS from the clean run's cogs_log rows. cogs_log has NO creator_id column —
  // the worker attributes via metadata->>creator_id (pipeline=corpus_reprocess_v3).
  const { data: cogs } = await sb.from('cogs_log').select('service, cost_usd, metadata').eq('metadata->>creator_id', creatorId);
  const ingestUsd = (cogs || []).reduce((a, r) => a + Number(r.cost_usd || 0), 0);
  cost.ingest += ingestUsd;
  const byService = {};
  for (const r of cogs || []) byService[r.service] = (byService[r.service] || 0) + Number(r.cost_usd || 0);

  const counts = await corpusCounts(creatorId);
  log(`  ✅ clean ingest: ${counts.sections} sections · ${counts.units} units · ${counts.chunks} chunks` +
    (version === 3 ? ' · creator_v3_ready=true' : ''));
  log(`  💲 ingest COGS $${ingestUsd.toFixed(4)} (${Object.entries(byService).map(([s, v]) => `${s}=$${v.toFixed(4)}`).join(' ')})` +
    ` · running total $${totalUsd().toFixed(4)}`);
  return creatorId;
}

async function corpusCounts(creatorId) {
  const sections = (await sb.from('sample_content_sections').select('id', { count: 'exact', head: true }).eq('creator_id', creatorId)).count ?? 0;
  const units = (await sb.from('sample_content_narrative_units').select('id', { count: 'exact', head: true }).eq('creator_id', creatorId)).count ?? 0;
  const chunks = (await sb.from('sample_content_chunks').select('id', { count: 'exact', head: true }).eq('creator_id', creatorId)).count ?? 0;
  return { sections, units, chunks };
}

// ── Needle spec ──────────────────────────────────────────────────────────────
let _needles = null;
async function loadNeedles() { if (!_needles) _needles = JSON.parse(await fs.readFile(NEEDLES_PATH, 'utf8')); return _needles; }
function needlesFor(corpus) {
  const c = _needles?.corpora?.[corpus];
  if (!c) throw new Error(`needles.json has no corpus "${corpus}"`);
  return c;
}

// ── Pre-flight: resolve each needle to EXACTLY ONE unit (full text); assert off-topic empty ──
async function preflight(corpus, version) {
  const spec = needlesFor(corpus);
  const creatorId = await getCreator(corpus, version);
  if (!creatorId) throw new Error(`no creator @${handleFor(corpus, version)} — ingest first`);

  // Pull ALL units (full text) once.
  const units = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('sample_content_narrative_units')
      .select('id, text, section_id, sample_id').eq('creator_id', creatorId).range(from, from + 999);
    if (error) throw error;
    units.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const normUnits = units.map((u) => ({ ...u, _norm: normSub(u.text || '') }));

  const resolved = [];
  const problems = [];   // HARD failures (off-topic contamination) -> abort
  const warnings = [];   // needles that didn't survive THIS ingest -> exclude + warn
  for (const n of spec.needles) {
    // A needle can have MULTIPLE valid target passages (a question can have more
    // than one right answer — e.g. "why do 2 people see things differently" is
    // answered by BOTH the paradigm-lens passage AND the twin story). Each value
    // must resolve to exactly one unit; the needle's acceptable set = union of
    // those units. Hit (recall/reach/routing) = ANY acceptable unit/section.
    const gtValues = Array.isArray(n.ground_truth.values) ? n.ground_truth.values : [n.ground_truth.value];
    const acceptableUnitIds = [];
    const acceptableSectionIds = [];
    let needleOk = true;
    for (const raw of gtValues) {
      const v = normSub(raw);
      const hits = normUnits.filter((u) => u._norm.includes(v));
      // A needle that didn't survive THIS (non-deterministic) ingest is EXCLUDED
      // (not counted as a recall miss — auditor C4 intent) and reported, not fatal.
      if (hits.length === 0) { warnings.push(`needle "${n.id}": target "${raw.slice(0, 40)}..." NOT FOUND (Flash dropped/paraphrased it this ingest)`); needleOk = false; }
      else if (hits.length > 1) { warnings.push(`needle "${n.id}": target "${raw.slice(0, 40)}..." in ${hits.length} units (ambiguous) — tighten it`); needleOk = false; }
      else { acceptableUnitIds.push(hits[0].id); if (hits[0].section_id) acceptableSectionIds.push(hits[0].section_id); }
    }
    if (needleOk && acceptableUnitIds.length > 0) {
      resolved.push({ id: n.id, depth: n.depth, planted_in: n.planted_in, questions: n.questions,
        gt_values: gtValues, // raw substrings — re-resolved against the v2 corpus for no-regression
        acceptable_unit_ids: acceptableUnitIds, acceptable_section_ids: [...new Set(acceptableSectionIds)] });
    }
  }
  // Off-topic must be VERIFIED-EMPTY (design M4 / audit-2 C2). A whole question
  // is never a verbatim substring of prose, so checking includes(question) passes
  // vacuously. Instead each off_topic carries a `forbidden_substring` (the topic
  // keyword) that MUST be absent from every unit — proving the corpus genuinely
  // can't answer it, so it's a valid silence-gate negative for §5.2 calibration.
  for (const ot of spec.off_topic || []) {
    if (!ot.forbidden_substring) { problems.push(`off-topic "${ot.id}" missing forbidden_substring (can't verify empty)`); continue; }
    const v = normSub(ot.forbidden_substring);
    const acc = normUnits.filter((u) => u._norm.includes(v));
    if (acc.length > 0) problems.push(`off-topic "${ot.id}" forbidden_substring "${ot.forbidden_substring}" appears in ${acc.length} unit(s) — NOT verifiably empty`);
  }
  if (warnings.length > 0) {
    log(`  ⚠ ${warnings.length} needle target(s) excluded (didn't survive this ingest):`);
    warnings.forEach((w) => log(`     - ${w}`));
  }
  // HARD-fail only on off-topic contamination (corrupts silence-gate) or if too
  // few needles resolved to be meaningful.
  if (problems.length > 0) {
    log('  ❌ pre-flight FAILED (off-topic/structural):'); problems.forEach((p) => log(`     - ${p}`));
    throw new Error('pre-flight failed: off-topic verification (see above)');
  }
  if (resolved.length < 3) {
    throw new Error(`only ${resolved.length} needles resolved — too few to evaluate (re-ingest; a chapter likely dropped)`);
  }
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.resolve(OUT_DIR, `resolved-${corpus}.json`), JSON.stringify({ creatorId, resolved }, null, 2));
  const totalAcceptable = resolved.reduce((a, r) => a + r.acceptable_unit_ids.length, 0);
  log(`  ✅ pre-flight: ${resolved.length}/${spec.needles.length} needles resolved (${totalAcceptable} acceptable target units total); ${(spec.off_topic || []).length} off-topic verified-empty`);
  return { creatorId, resolved };
}

async function loadResolved(corpus) {
  const p = path.resolve(OUT_DIR, `resolved-${corpus}.json`);
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch { throw new Error(`no resolved-${corpus}.json — run preflight first`); }
}

// ── Read path (RPC-direct; bypasses semantic_query_cache — design M1/M2) ──────
// Returns rows in the RPC's parent_score-DESC order (design M7: never re-sort on rrf).
async function routeV3(creatorId, qVec, topicTags, topS, routeMinSim) {
  const { data, error } = await sb.rpc('_creator_route_sections_v3', {
    p_creator_id: creatorId, p_query_vec: vecToPg(qVec),
    p_topic_tags: topicTags, p_top_s: topS, p_min_sim: routeMinSim,
  });
  if (error) throw new Error(`route_sections_v3: ${error.message}`);
  return data || [];
}
async function topkV3(creatorId, sectionIds, qVec, tsq, rankMode, nParent, topkMinSim, lambda) {
  if (sectionIds.length === 0) return [];
  const { data, error } = await sb.rpc('_creator_knowledge_topk_v3', {
    p_creator_id: creatorId, p_section_ids: sectionIds, p_query_vec: vecToPg(qVec),
    p_query_tsq: tsq, p_k_child: DEFAULT_K_CHILD, p_n_parent_per_section: nParent,
    p_min_sim: topkMinSim, p_rank_mode: rankMode, p_lambda: lambda,
  });
  if (error) throw new Error(`topk_v3: ${error.message}`);
  return data || []; // already ORDER BY parent_score DESC
}
async function topkV2(creatorId, qVec, tsq) {
  const { data, error } = await sb.rpc('creator_knowledge_topk_v2', {
    p_creator_id: creatorId, p_query_vec: vecToPg(qVec), p_query_tsq: tsq,
    p_k_child: DEFAULT_K_CHILD, p_k_parent: 50, p_min_sim: V2_MIN_SIM,
  });
  if (error) throw new Error(`topk_v2: ${error.message}`);
  // v2 returns rrf_score; sort by it (legitimate on the v2 path only — design M7).
  return [...(data || [])].sort((a, b) => Number(b.rrf_score) - Number(a.rrf_score));
}
async function fetchUnitTexts(ids) {
  const out = new Map();
  if (!ids || ids.length === 0) return out;
  const { data } = await sb.from('sample_content_narrative_units').select('id, title, text').in('id', [...new Set(ids)]);
  for (const u of data || []) out.set(u.id, { title: u.title, text: u.text });
  return out;
}
async function tsqueryFor(text) {
  const { data } = await sb.rpc('try_build_tsquery', { p_text: text.slice(0, 4000) });
  return data || '';
}

// Full v3 retrieval for one question. opts: rankMode, topS, nParent, topkMinSim,
// routeMinSim, lambda, withRerank, flatFallback. Returns ranked parent_unit_ids
// (post-rerank if withRerank) + the routed section_ids + candidate set + legs.
async function retrieveV3(creatorId, topicTags, question, opts) {
  const o = { rankMode: DEFAULT_RANK_MODE, topS: DEFAULT_TOP_S, nParent: DEFAULT_N_PARENT,
    topkMinSim: DEFAULT_MIN_SIM_BY_MODE[opts.rankMode || DEFAULT_RANK_MODE], routeMinSim: 0.0,
    lambda: DEFAULT_LAMBDA, withRerank: true, flatFallback: true, ...opts };
  const legs = {};
  let t = Date.now();
  // audit-2 M5: latency runs pass freshEmbed so the embed RTT is actually timed
  // (the cost-cache would otherwise report embed=0ms and understate the full turn).
  const qVec = await embedOne(question, 'RETRIEVAL_QUERY', o.freshEmbed === true); legs.embedMs = Date.now() - t;
  t = Date.now();
  const routed = await routeV3(creatorId, qVec, topicTags, o.topS, o.routeMinSim); legs.routeMs = Date.now() - t;
  const sectionIds = routed.map((r) => r.section_id);
  t = Date.now();
  const tsq = await tsqueryFor(question); legs.tsqMs = Date.now() - t;
  t = Date.now();
  let cands = await topkV3(creatorId, sectionIds, qVec, tsq, o.rankMode, o.nParent, o.topkMinSim, o.lambda);
  legs.topkMs = Date.now() - t;
  let flatFired = false;
  // audit-2 M1: mirror prod (retrieve-knowledge.ts:1407) — flat fallback fires only
  // when routing returned sections BUT scoped topk found nothing. Zero routed
  // sections = deliberate silence; prod does NOT fall back there (matters once
  // route_min_sim > 0 can return 0 sections).
  if (cands.length === 0 && o.flatFallback && sectionIds.length > 0) {
    flatFired = true;
    const { data: allSecs } = await sb.from('sample_content_sections')
      .select('id').eq('creator_id', creatorId).order('section_index').limit(50);
    const allIds = (allSecs || []).map((s) => s.id);
    cands = await topkV3(creatorId, allIds, qVec, tsq, o.rankMode, o.nParent, o.topkMinSim, o.lambda);
  }
  const candUnitIds = cands.map((c) => c.parent_unit_id);
  let rankedUnitIds = candUnitIds;
  let rerankScores = null;
  if (o.withRerank && cands.length > 0) {
    const docs = cands.map((c) => c.parent_text || '');
    // top_k=20 vs prod's injected top_k=5: benign for recall@{1,2,5} (top-5 order
    // is identical); we keep the full ranking to compute recall@5 + debug ranks.
    const { results, ms } = await voyageRerank(question, docs, Math.min(cands.length, 20));
    legs.rerankMs = ms;
    rankedUnitIds = results.map((r) => cands[r.index]?.parent_unit_id).filter(Boolean);
    rerankScores = results.map((r) => ({ unitId: cands[r.index]?.parent_unit_id, score: r.score }));
  }
  return { rankedUnitIds, candUnitIds, sectionIds, routed, rerankScores, flatFired, legs };
}

// ── Metrics ──────────────────────────────────────────────────────────────────
async function metrics(corpus) {
  const spec = needlesFor(corpus);
  const tag = spec.topic_tag;
  const { creatorId: c3, resolved } = await loadResolved(corpus);
  const c2 = await getCreator(corpus, 2); // may be null (no-regression skipped if absent)

  hr();
  log(`  METRICS — corpus=${corpus}  v3-creator=${c3.slice(0, 8)}${c2 ? `  v2-creator=${c2.slice(0, 8)}` : '  (no v2 ingest — no-regression skipped)'}`);
  hr();

  // 1+2+3: recall@k, reach-reranker, routing precision (v3, default config).
  let routingHits = 0, reachHits = 0;
  const recall = { 1: 0, 2: 0, [RERANK_WINDOW]: 0 };
  const candCounts = []; // audit-2 C1: recall@5 window = min(5, candidate count). Surface
  // the candidate-set size so recall@5's denominator semantics are explicit, not hidden.
  let totalQ = 0;
  for (const n of resolved) {
    for (const q of n.questions) {
      assertBudget('metrics recall');
      totalQ++;
      const r = await retrieveV3(c3, [tag], q, { withRerank: true, flatFallback: true });
      candCounts.push(r.candUnitIds.length);
      // routing/reach/recall: hit if ANY acceptable target unit/section is found.
      if (anyIn(r.sectionIds, n.acceptable_section_ids)) routingHits++;
      if (anyIn(r.candUnitIds, n.acceptable_unit_ids)) reachHits++;
      const rank = bestRank(r.rankedUnitIds, n.acceptable_unit_ids);
      if (rank !== Infinity) for (const k of [1, 2, RERANK_WINDOW]) if (rank < k) recall[k]++;
    }
  }
  const candMean = candCounts.length ? (candCounts.reduce((a, c) => a + c, 0) / candCounts.length).toFixed(1) : '0';
  const candMin = candCounts.length ? Math.min(...candCounts) : 0;
  log('  [v3 default config: rank_mode=%s S=%d λ=%s topk_min_sim=%s]', DEFAULT_RANK_MODE, DEFAULT_TOP_S, DEFAULT_LAMBDA, DEFAULT_MIN_SIM_BY_MODE[DEFAULT_RANK_MODE]);
  log(`  Routing precision (needle section in top-S): ${routingHits}/${totalQ} = ${(100 * routingHits / totalQ).toFixed(1)}%  [HARD FLOOR 95%]`);
  log(`  Reach-the-reranker (needle unit in candidates): ${reachHits}/${totalQ} = ${(100 * reachHits / totalQ).toFixed(1)}%`);
  log(`  Recall@1=${(100 * recall[1] / totalQ).toFixed(1)}%  @2=${(100 * recall[2] / totalQ).toFixed(1)}%  @${RERANK_WINDOW}=${(100 * recall[RERANK_WINDOW] / totalQ).toFixed(1)}%  [candidate set: mean=${candMean} min=${candMin}; recall@${RERANK_WINDOW} window=min(${RERANK_WINDOW},cands)]`);

  // 6: no-regression v2-vs-v3 BOTH ways (design C5) — only if v2 ingest present.
  if (c2) {
    // v2 is a SEPARATE ingest (different unit_ids + different Flash segmentation),
    // so resolve each needle's target substrings against the V2 corpus independently.
    const v2units = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await sb.from('sample_content_narrative_units').select('id, text').eq('creator_id', c2).range(from, from + 999);
      v2units.push(...(data || [])); if (!data || data.length < 1000) break;
    }
    const v2norm = v2units.map((u) => ({ id: u.id, _norm: normSub(u.text || '') }));
    const v2acceptable = (n) => n.gt_values.flatMap((raw) => { const v = normSub(raw); const h = v2norm.filter((u) => u._norm.includes(v)); return h.length === 1 ? [h[0].id] : []; });

    let v2reach = 0, v3scopedReach = 0, v3fullReach = 0, flatFires = 0, comparable = 0;
    for (const n of resolved) {
      const v2ids = v2acceptable(n);
      if (v2ids.length === 0) continue; // needle didn't survive v2 ingest — not comparable
      for (const q of n.questions) {
        assertBudget('metrics no-regression');
        comparable++;
        const qVec = await embedOne(q, 'RETRIEVAL_QUERY');
        const tsq = await tsqueryFor(q);
        // v2 flat — resolve against v2's own unit ids
        const v2rows = await topkV2(c2, qVec, tsq);
        if (anyIn(v2rows.slice(0, 50).map((r) => r.parent_unit_id), v2ids)) v2reach++;
        // v3 scoped-only (fallback OFF) — v3's own acceptable ids
        const rs = await retrieveV3(c3, [tag], q, { withRerank: false, flatFallback: false });
        if (anyIn(rs.candUnitIds, n.acceptable_unit_ids)) v3scopedReach++;
        // v3 full (fallback ON)
        const rf = await retrieveV3(c3, [tag], q, { withRerank: false, flatFallback: true });
        if (anyIn(rf.candUnitIds, n.acceptable_unit_ids)) v3fullReach++;
        if (rf.flatFired) flatFires++;
      }
    }
    const nrQ = comparable || 1; // only needles present in BOTH corpora are comparable
    log(`  --- no-regression (reach-reranker), needle in candidate set · ${comparable} comparable q ---`);
    log(`  v2 flat:          ${v2reach}/${comparable} = ${(100 * v2reach / nrQ).toFixed(1)}%`);
    log(`  v3 scoped-only:   ${v3scopedReach}/${comparable} = ${(100 * v3scopedReach / nrQ).toFixed(1)}%  (flat fallback OFF — isolates ranking)`);
    log(`  v3 full pipeline: ${v3fullReach}/${comparable} = ${(100 * v3fullReach / nrQ).toFixed(1)}%  (flat fallback fired on ${flatFires} q)`);
  }

  // 4: latency p50/p95 — FULL-turn proxy (rewrite+embed+route+tsq+topk+rerank).
  log('  --- latency (full-turn proxy; gate anchor retrieveCeilingMs=3500) ---');
  const N = Number(process.env.EVAL_LATENCY_RUNS || '6');
  const totals = [], splits = { rewrite: [], embed: [], route: [], tsq: [], topk: [], rerank: [] };
  const sampleQs = resolved.flatMap((n) => n.questions).slice(0, 8);
  for (let i = 0; i < N; i++) {
    for (const q of sampleQs) {
      assertBudget('metrics latency');
      const rw = await rewriteLatencyProbe(q);
      // freshEmbed so the embed leg is actually timed (audit-2 M5).
      const r = await retrieveV3(c3, [tag], q, { withRerank: true, flatFallback: true, freshEmbed: true });
      if (i === 0 || rw === null) continue; // discard cold pass; drop failed-rewrite samples (M6)
      const full = rw + (r.legs.embedMs || 0) + (r.legs.routeMs || 0) + (r.legs.tsqMs || 0) + (r.legs.topkMs || 0) + (r.legs.rerankMs || 0);
      totals.push(full);
      splits.rewrite.push(rw); splits.embed.push(r.legs.embedMs || 0); splits.route.push(r.legs.routeMs || 0);
      splits.tsq.push(r.legs.tsqMs || 0); splits.topk.push(r.legs.topkMs || 0); splits.rerank.push(r.legs.rerankMs || 0);
    }
  }
  log(`  full-turn p50=${pctl(totals, 50)}ms p95=${pctl(totals, 95)}ms  [${totals.length} warm samples, ceiling 3500ms]`);
  log(`    leg p50: rewrite=${pctl(splits.rewrite, 50)} embed=${pctl(splits.embed, 50)} route=${pctl(splits.route, 50)} tsq=${pctl(splits.tsq, 50)} topk=${pctl(splits.topk, 50)} rerank=${pctl(splits.rerank, 50)} ms`);

  // 5: per-turn COGS (one representative query).
  const beforeE = cost.embed, beforeV = cost.voyage;
  await retrieveV3(c3, [tag], sampleQs[0], { withRerank: true, flatFallback: true });
  log(`  --- per-turn COGS (1 query): embed=$${(cost.embed - beforeE).toFixed(6)} rerank=$${(cost.voyage - beforeV).toFixed(6)} ---`);
  log(`  💲 running total $${totalUsd().toFixed(4)} / cap $${EVAL_MAX_USD}`);
  hr();
}

// ── Sweep: rank_mode x S x lambda x topk_min_sim x route_min_sim ──────────────
async function sweep(corpus) {
  const spec = needlesFor(corpus);
  const tag = spec.topic_tag;
  const { creatorId: c3, resolved } = await loadResolved(corpus);
  const sList = (process.env.EVAL_SWEEP_S || '2,3,4,6').split(',').map(Number);
  const lambdaList = (process.env.EVAL_SWEEP_LAMBDA || '0,0.1,0.4').split(',').map(Number);
  const routeMinList = (process.env.EVAL_SWEEP_ROUTE_MIN || '0,0.15,0.3').split(',').map(Number);
  // per-mode topk_min_sim ranges (design §9 C2: nested within rank_mode; cosine
  // and RRF live on different scales). Full §9 C2 ranges — env-overridable to
  // coarsen for a quick validation pass.
  const rrfRange = (process.env.EVAL_SWEEP_TOPKMIN_RRF || '0,0.05,0.1,0.15,0.2,0.3').split(',').map(Number);
  const vecRange = (process.env.EVAL_SWEEP_TOPKMIN_VEC || '0.2,0.3,0.4,0.5,0.6').split(',').map(Number);
  const topkMinByMode = { max: rrfRange, max_blend: rrfRange, best_child: rrfRange, vec_max: vecRange };
  const qs = resolved.flatMap((n) => n.questions.map((q) => ({ q, units: n.acceptable_unit_ids, sections: n.acceptable_section_ids })));

  hr();
  log(`  SWEEP — corpus=${corpus} creator=${c3.slice(0, 8)} · ${qs.length} questions`);
  log('  (freeze ORDER per design M3: rank_mode -> S+route_min -> λ+topk_min -> inject-K -> rerank floor)');
  hr();
  const rows = [];
  for (const rankMode of RANK_MODES) {
    for (const topS of sList) {
      for (const routeMinSim of routeMinList) {
        for (const topkMinSim of topkMinByMode[rankMode]) {
          for (const lambda of (rankMode === 'max_blend' ? lambdaList : [0])) {
            let routing = 0, r1 = 0, r2 = 0;
            for (const item of qs) {
              assertBudget('sweep'); // audit-2 C3: per-question, not per-cell (a cell is many reranks)
              // Crash-proofing: a Voyage 429 that survives all in-call retries
              // must NOT abort the whole sweep. Retry the question with a long
              // cooldown a few times; if it still fails, record the cell as
              // degraded (rerankErr) and move on so partial results survive.
              let r = null;
              for (let qa = 1; qa <= 3; qa++) {
                try {
                  r = await retrieveV3(c3, [tag], item.q, { rankMode, topS, nParent: DEFAULT_N_PARENT, topkMinSim, routeMinSim, lambda, withRerank: true, flatFallback: false });
                  break;
                } catch (e) {
                  if (!/voyage_429|voyage_5\d\d/.test(String(e?.message)) || qa === 3) throw e;
                  const cool = Number(process.env.EVAL_SWEEP_429_COOLDOWN_MS || '20000') * qa;
                  log(`  ⏳ voyage rate-limit on a sweep question — cooling ${cool}ms then retry (${qa}/3)`);
                  await sleep(cool);
                }
              }
              if (anyIn(r.sectionIds, item.sections)) routing++;
              const rank = bestRank(r.rankedUnitIds, item.units);
              if (rank === 0) r1++; if (rank !== Infinity && rank < 2) r2++;
            }
            rows.push({ rankMode, topS, routeMinSim, topkMinSim, lambda,
              routingPct: +(100 * routing / qs.length).toFixed(1),
              recall1: +(100 * r1 / qs.length).toFixed(1),
              recall2: +(100 * r2 / qs.length).toFixed(1) });
            // Incremental persist: write the grid after EVERY cell so a late
            // crash never costs us the cells already computed (Vuk Q3).
            try {
              await fs.mkdir(OUT_DIR, { recursive: true });
              await fs.writeFile(path.resolve(OUT_DIR, `sweep-${corpus}.json`), JSON.stringify(rows, null, 2));
            } catch { /* best-effort incremental write */ }
            log(`  · cell ${rows.length}: ${rankMode} S=${topS} routeMin=${routeMinSim} topkMin=${topkMinSim} λ=${lambda} → routing=${rows[rows.length-1].routingPct}% r@1=${rows[rows.length-1].recall1}%`);
          }
        }
      }
    }
  }
  // audit-2 M4: routing precision is the HARD 95% floor (design §3 metric 3) — a
  // config below it is UN-SHIPPABLE regardless of recall, so it must GATE, not just
  // tiebreak. Sort floor-met first, THEN by recall@1. A sub-floor cell can never
  // sort above a floor-clearing one (§5.1 "smallest S clearing the floor, then max recall").
  const ROUTING_FLOOR = 95;
  rows.sort((a, b) =>
    (b.routingPct >= ROUTING_FLOOR) - (a.routingPct >= ROUTING_FLOOR)
    || b.recall1 - a.recall1 || b.routingPct - a.routingPct);
  const clearing = rows.filter((r) => r.routingPct >= ROUTING_FLOOR).length;
  log(`  ${clearing}/${rows.length} cells clear the ${ROUTING_FLOOR}% routing floor (un-shippable below it).`);
  log('  top 15 (floor-clearing first, then recall@1) — ✓=clears floor:');
  log('     rank_mode    S  routeMin topkMin  λ     routing%  r@1   r@2');
  for (const r of rows.slice(0, 15)) {
    const mark = r.routingPct >= ROUTING_FLOOR ? '✓' : ' ';
    log(`  ${mark}  ${r.rankMode.padEnd(11)} ${String(r.topS).padStart(2)}  ${String(r.routeMinSim).padStart(6)}  ${String(r.topkMinSim).padStart(6)}  ${String(r.lambda).padStart(4)}  ${String(r.routingPct).padStart(6)}  ${String(r.recall1).padStart(4)}  ${String(r.recall2).padStart(4)}`);
  }
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.resolve(OUT_DIR, `sweep-${corpus}.json`), JSON.stringify(rows, null, 2));
  log(`  full grid (${rows.length} cells) -> eval-v3/out/sweep-${corpus}.json`);
  log(`  💲 running total $${totalUsd().toFixed(4)} / cap $${EVAL_MAX_USD}`);
  hr();
}

// ── Rubric export: CSV question sheet for the human "exactly him" rubric ──────
async function exportRubric(corpus) {
  const spec = needlesFor(corpus);
  await fs.mkdir(OUT_DIR, { recursive: true });
  const header = ['question_id', 'question', 'depth', 'rater', 'inject_k',
    'story_correctness_1to5', 'sounds_like_him_1to5', 'blanked_0or1', 'confidently_wrong_0or1', 'notes'];
  const lines = [header.join(',')];
  for (const n of spec.needles) {
    for (const q of n.questions) {
      for (const k of INJECT_K_SET) {
        const cells = [n.id, `"${q.replace(/"/g, '""')}"`, n.depth, '', String(k), '', '', '', '', ''];
        lines.push(cells.join(','));
      }
    }
  }
  const out = path.resolve(OUT_DIR, `rubric-${corpus}.csv`);
  await fs.writeFile(out, lines.join('\n'));
  log(`  ✅ rubric sheet -> ${out}`);
  log(`     ${spec.needles.length} needles × question variants × inject-K{1,2}. Duplicate per rater (>=2 raters who know the creator).`);
  log('     Pass bar: >=80% "right story", ZERO blanks on known content, ZERO confidently-wrong (design 3.7).');
}

// ── Debug: per-needle trace (true routing rank among ALL sections, candidate
// rank, rerank rank) for the FIRST question of each needle. Diagnoses whether a
// miss is routing, ranking, or fixture-question quality.
async function debug(corpus) {
  const spec = needlesFor(corpus);
  const tag = spec.topic_tag;
  const { creatorId: c3, resolved } = await loadResolved(corpus);
  const totalSecs = (await sb.from('sample_content_sections').select('id', { count: 'exact', head: true }).eq('creator_id', c3)).count;
  const ROUTE_CLAMP = 10; // route RPC clamps p_top_s to [1,10] (migration ...30:79)
  hr();
  log(`  DEBUG per-needle trace — corpus=${corpus} creator=${c3.slice(0, 8)} · ${totalSecs} total sections`);
  log(`  (audit-2 C4: route RPC CLAMPS p_top_s to ${ROUTE_CLAMP}, so "section rank" is only visible within the top-${ROUTE_CLAMP};`);
  log(`   "NOT FOUND" means the needle section ranked WORSE than #${ROUTE_CLAMP} — at book scale raise the clamp to see true rank.)`);
  hr();
  for (const n of resolved) {
    const q = n.questions[0];
    const qVec = await embedOne(q, 'RETRIEVAL_QUERY');
    const routed = await routeV3(c3, qVec, [tag], ROUTE_CLAMP, 0.0); // top-10 (RPC clamp ceiling)
    // best (lowest) rank of ANY acceptable section among the routed list
    const routedSecIds = routed.map((r) => r.section_id);
    const secRank = bestRank(routedSecIds, n.acceptable_section_ids);
    const tsq = await tsqueryFor(q);
    // candidates over the FIRST acceptable section (was the unit retrievable within it?)
    const sec0 = n.acceptable_section_ids[0];
    const inSection = await topkV3(c3, [sec0], qVec, tsq, 'max', 20, 0.0, 0);
    const candRankInSec = bestRank(inSection.map((c) => c.parent_unit_id), n.acceptable_unit_ids);
    // candidates over routed top-S (frozen default) + rerank
    const r = await retrieveV3(c3, [tag], q, { rankMode: 'max', topS: DEFAULT_TOP_S, topkMinSim: 0, routeMinSim: 0, withRerank: true, flatFallback: false });
    const candRank = bestRank(r.candUnitIds, n.acceptable_unit_ids);
    const rrRank = bestRank(r.rankedUnitIds, n.acceptable_unit_ids);
    const fmt = (x) => x === Infinity ? null : x;
    log(`  ▸ ${n.id}  (depth=${n.depth}, ${n.acceptable_unit_ids.length} acceptable target unit(s))`);
    log(`      Q: "${q}"`);
    log(`      best acceptable-section routing rank: ${secRank === Infinity ? `NOT in top-${ROUTE_CLAMP}` : `#${secRank + 1}/${totalSecs}`} (top routed score=${routed[0] ? Number(routed[0].score).toFixed(3) : 'na'})`);
    log(`      unit rank WITHIN first acceptable section (max mode): ${candRankInSec === Infinity ? 'NOT IN SECTION TOPK' : `#${candRankInSec + 1}`}`);
    log(`      unit rank in S=4 candidates: ${candRank === Infinity ? 'MISS (section not in top-4)' : `#${candRank + 1}`}  ->  post-rerank: ${rrRank === Infinity ? 'MISS' : `#${rrRank + 1}`}`);
  }
  hr();
}

// ── Answers: per question, dump the FULL text of what the user actually gets ──
// A needle "miss" that returns a genuinely good answer is the system WORKING (the
// user got what they needed) — the unit-match metric is only a proxy. This report
// lets a human judge answer QUALITY, not just target-hit. Writes a readable .md.
async function answers(corpus) {
  const spec = needlesFor(corpus);
  const tag = spec.topic_tag;
  const { creatorId: c3, resolved } = await loadResolved(corpus);
  const allVariants = process.env.EVAL_ANSWERS_ALL === '1'; // default: primary question only
  const TOPN = Number(process.env.EVAL_ANSWERS_TOPN || '2'); // passages shown per question

  const lines = [`# v3 retrieval answers — ${corpus} (creator ${c3.slice(0, 8)}, ${new Date().toISOString().slice(0, 10)})`,
    '', 'For each question: HIT/MISS vs the target needle, then the FULL passage(s) the user would actually be answered from.',
    'A MISS with a clearly-correct passage = the system working (judge answer quality, not just target-hit).', ''];
  let hitTop1 = 0, hitTop2 = 0, totalQ = 0;
  for (const n of resolved) {
    lines.push(`\n---\n## ${n.id}  (depth=${n.depth})`);
    const qs = allVariants ? n.questions : [n.questions[0]];
    for (const q of qs) {
      totalQ++;
      const r = await retrieveV3(c3, [tag], q, { withRerank: true, flatFallback: true });
      const rank = bestRank(r.rankedUnitIds, n.acceptable_unit_ids);
      if (rank === 0) hitTop1++; if (rank !== Infinity && rank < 2) hitTop2++;
      const topIds = r.rankedUnitIds.slice(0, TOPN);
      const texts = await fetchUnitTexts([...topIds, ...n.acceptable_unit_ids]);
      const verdict = rank === 0 ? 'HIT @1' : rank !== Infinity && rank < 2 ? 'HIT @2' : rank !== Infinity ? `target @${rank + 1}` : 'MISS (target not in top results)';
      lines.push(`\n**Q:** ${q}\n\n**Target-needle verdict:** ${verdict}`);
      lines.push(`\n**What the user actually gets:**`);
      topIds.forEach((id, i) => {
        const u = texts.get(id) || {};
        const isTarget = n.acceptable_unit_ids.includes(id);
        lines.push(`\n> **#${i + 1}${isTarget ? ' ✓ (this IS a target needle)' : ''} — ${(u.title || '(untitled)').trim()}**\n>\n> ${(u.text || '').trim().replace(/\n+/g, '\n> ')}`);
      });
    }
  }
  lines.unshift(`\n**Summary:** target-needle Recall@1=${(100 * hitTop1 / totalQ).toFixed(0)}% @2=${(100 * hitTop2 / totalQ).toFixed(0)}% over ${totalQ} questions — but READ THE PASSAGES: a miss can still be a great answer.\n`);
  await fs.mkdir(OUT_DIR, { recursive: true });
  const out = path.resolve(OUT_DIR, `answers-${corpus}.md`);
  await fs.writeFile(out, lines.join('\n'));
  log(`  ✅ answers report (${totalQ} questions, top-${TOPN} full passages each) -> ${out}`);
  log(`     target-needle recall@1=${(100 * hitTop1 / totalQ).toFixed(0)}% @2=${(100 * hitTop2 / totalQ).toFixed(0)}% — but the .md shows the ACTUAL answers so you can judge "miss but correct".`);
}

async function cleanup(corpus) {
  const corpora = corpus ? [corpus] : ['aod', 'book'];
  for (const c of corpora) {
    for (const v of [2, 3]) {
      const { data } = await sb.from('creators').select('id, user_id').eq('handle', handleFor(c, v)).maybeSingle();
      if (data) {
        await sb.from('creators').delete().eq('id', data.id);
        try { await sb.auth.admin.deleteUser(data.user_id); } catch { /* best-effort */ }
        log(`  deleted @${handleFor(c, v)}`);
      }
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const corpus = args.corpus || 'aod';
const version = Number(args.version || 3);
await loadNeedles();

hr();
log(`  diag-eval-v3  cmd=${cmd}  corpus=${corpus}  (LOCAL ${SB_URL}, read-only on prod)`);
log(`  cap EVAL_MAX_USD=$${EVAL_MAX_USD}`);
hr();

try {
  switch (cmd) {
    case 'ingest': await ingest(corpus, version); break;
    case 'preflight': await preflight(corpus, version); break;
    case 'metrics': await metrics(corpus); break;
    case 'sweep': await sweep(corpus); break;
    case 'debug': await debug(corpus); break;
    case 'answers': await answers(corpus); break;
    case 'export-rubric': await exportRubric(corpus); break;
    case 'cleanup': await cleanup(args.corpus); break;
    case 'all':
      await ingest(corpus, 3);
      await ingest(corpus, 2);
      await preflight(corpus, 3);
      await metrics(corpus);
      await sweep(corpus);
      break;
    default:
      log('Usage: diag-eval-v3.mjs <ingest|preflight|metrics|sweep|export-rubric|cleanup|all> [--corpus aod|book] [--version 2|3]');
      process.exit(1);
  }
  log(`\n  done. total spend this run: $${totalUsd().toFixed(4)}`);
} catch (e) {
  log(`\n  ✖ ${e.message}`);
  process.exitCode = 1;
}
