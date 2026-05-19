// retrieve-latency.p0.real-api.test.ts — P0-4b retrieval-latency MEASUREMENT
// (DECOUPLED_BRAIN_PLAN §12). NOT a correctness test — it is a measurement
// harness wearing a vitest costume because vitest is this repo's only TS
// runner (no tsx/ts-node in package.json). Same RUN_REAL_API_TESTS gate as
// retrieve-knowledge.real-api.test.ts so it is INERT in normal CI.
//
// WHAT IT MEASURES
//   Real end-to-end retrieveKnowledgeV2 latency (rewrite → embed → cache →
//   hybrid RPC → Voyage rerank) against PROD creator #1's real corpus. This
//   is the single number the (A)(ii) gate collapsed onto (plan §12).
//
// VUK-APPROVED 2026-05-18: "prod read-only, real paid — best/most accurate."
//   - Corpus is READ-ONLY. The only writes are (a) cogs_log inserts (CORRECT
//     per CLAUDE.md — paid calls must) and (b) semantic-cache upserts. Every
//     trial uses a DISTINCT question → every trial is a cache MISS → we
//     measure full-pipeline latency (the conservative gate input; cache
//     hits are fast and are not the architecture risk). Cache rows are
//     additive, TTL'd, on Vuk's own creator, v2 gated off in prod.
//   - Spend ≈ $0.001 × N (default N=25 → ~$0.025).
//   - This is the sanctioned probe pattern (cf. probe-prod-retrieval-
//     quality.mjs prod reads + retrieve-knowledge.real-api.test.ts cogs
//     writes). PROD_DEPLOY_GATE blocks deploys/merges/creator-flips — NOT
//     read-only latency probes. No migration, no deploy, no creator mutate.
//
// RUN
//   RUN_REAL_API_TESTS=1 npx vitest run \
//     src/lib/voice/retrieve-latency.p0.real-api.test.ts
//   (loads SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/GEMINI_API_KEY/
//    VOYAGE_API_KEY from the vitest env; .env.local already points at prod.)
//
// Output: p50/p75/p95 total + per-leg + count that would exceed the REAL
// 4000ms prod RAG_TURN_BUDGET. Paste percentiles back into the plan §12 and
// feed them to scripts/ttft-gate-spike.mjs --retrieval=measured.

import { describe, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

import { retrieveKnowledgeV2, RAG_TURN_BUDGET_MS_DEFAULT } from './retrieve-knowledge';

const REAL = process.env.RUN_REAL_API_TESTS === '1';
const GEMINI = process.env.GEMINI_API_KEY;
const VOYAGE = process.env.VOYAGE_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ENABLED = !!(REAL && GEMINI && VOYAGE && SUPABASE_URL && SUPABASE_KEY);

if (!ENABLED) {
  // eslint-disable-next-line no-console
  console.log(
    `[p0-4b retrieval-latency] skipped — RUN_REAL_API_TESTS=${REAL ? '1' : '0'} ` +
      `GEMINI=${GEMINI ? 'set' : 'missing'} VOYAGE=${VOYAGE ? 'set' : 'missing'} ` +
      `SUPABASE_URL=${SUPABASE_URL ? 'set' : 'missing'} KEY=${SUPABASE_KEY ? 'set' : 'missing'}`,
  );
}

// Prod creator #1 (Vuk) — same id probe-prod-retrieval-quality.mjs uses.
const CREATOR_ID = '74e897d8-6e91-4f00-98ab-190a66c92d9a';
// userId MUST be a real profiles(id): voice_retrieval_budget.user_id has a
// FK → profiles(id) (migration 20260512000008) and the orchestrator's
// budget gate inserts before any retrieval. creators.user_id IS a real
// profile = creator #1's owner (Vuk himself). We probe as that real owner:
// his creator, his prod, his explicit approval. Resolved at runtime below.
const N = Number(process.env.P0_RETRIEVAL_TRIALS || 25);

// Distinct, varied, in-domain questions (creator #1 corpus = mental models /
// worldview / "twins" / "one-eyed man"). DISTINCT so each trial is a cache
// miss = full-pipeline latency. Cycled+suffixed if N > list length so even
// the wrap stays cache-missing.
const BASE_QUESTIONS = [
  'How can two identical upbringings produce completely different realities?',
  'What does the one-eyed man in the land of the blind really mean?',
  'Why do some people bounce back from failure and others never recover?',
  'What actually changes when someone has a genuine mindset shift?',
  'How do I tell intuition apart from bias in a fast decision?',
  'Why does the same advice transform one person and wreck another?',
  'What is a mental model and how do I actually build one?',
  'How does environment set escape velocity for a person?',
  'Why do siblings raised together end up on opposite paths?',
  'What is negative visualization and when does it backfire?',
  'How do first high-salience memories shape an adult interpreter?',
  'Why is the interpretation of an event more durable than the event?',
  'How do I rewire a self-fulfilling belief that keeps proving itself?',
  'What separates people who compound from people who plateau?',
  'How does birth order quietly steer a worldview?',
  'Why does self-reliance read as strength for one kid and wound for another?',
  'What is the mechanism behind compounding interpretation over decades?',
  'How do I notice the model I am running instead of the events themselves?',
  'When does a strong narrative about yourself become a cage?',
  'How do I test whether a belief is true or just well-rehearsed?',
  'Why do two people remember the same childhood completely differently?',
  'What makes some frames load-bearing and others decorative?',
  'How does temperament filter the same input into opposite meanings?',
  'Why is changing the question more powerful than changing the answer?',
  'What is the difference between a value and a defense dressed as a value?',
];
function questionFor(i: number): string {
  const base = BASE_QUESTIONS[i % BASE_QUESTIONS.length];
  const lap = Math.floor(i / BASE_QUESTIONS.length);
  return lap === 0 ? base : `${base} (angle ${lap + 1})`; // keep wrap cache-missing
}

const pct = (arr: number[], p: number): number => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const f = (n: number) => `${n.toFixed(0)}ms`;

const maybe = ENABLED ? describe : describe.skip;

maybe('P0-4b — real v2 retrieval latency vs PROD creator #1', () => {
  it(`measures ${N} cache-miss full-pipeline latencies`, async () => {
    const admin = createClient(SUPABASE_URL as string, SUPABASE_KEY as string, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });

    // corpusVersionAtSession MUST equal the creator's live value or the
    // orchestrator throws invalid_corpus_version. Read it (read-only).
    const { data: cRow, error: cErr } = await admin
      .from('creators')
      .select('current_corpus_version, user_id')
      .eq('id', CREATOR_ID)
      .single();
    if (cErr) throw new Error(`creator read failed: ${cErr.message}`);
    const corpusVersion = (cRow as { current_corpus_version: number } | null)?.current_corpus_version;
    const PROBE_USER_ID = (cRow as { user_id: string } | null)?.user_id;
    if (!PROBE_USER_ID) throw new Error('creator #1 has no owner user_id — cannot probe');
    // eslint-disable-next-line no-console
    console.log(
      `[p0-4b] prod creator #1 current_corpus_version=${corpusVersion} ` +
        `owner=${PROBE_USER_ID.slice(0, 8)}… (probing as the real owner; ` +
        `consumes ${N}/200 of today's retrieval budget, resets daily)`,
    );
    if (!corpusVersion || corpusVersion < 1) {
      throw new Error(
        `creator #1 has no usable corpus (current_corpus_version=${corpusVersion}) — ` +
          `refusing to measure a phantom corpus`,
      );
    }

    const total: number[] = [];
    const rewriteMs: number[] = [];
    const rerankMs: number[] = [];
    let overProdBudget = 0;
    let anyError = 0;
    let cacheHits = 0;

    for (let i = 0; i < N; i++) {
      const q = questionFor(i);
      const t0 = performance.now();
      try {
        // GENEROUS deadline so we measure TRUE latency, not a 4000-capped
        // value; we separately count how many would breach the real prod
        // 4000ms RAG_TURN_BUDGET.
        const r = await retrieveKnowledgeV2({
          supabaseAdmin: admin,
          userId: PROBE_USER_ID,
          creatorId: CREATOR_ID,
          rawUtterance: q,
          lastAssistantResponse: null,
          corpusVersionAtSession: corpusVersion,
          sessionId: null,
          geminiApiKey: GEMINI as string,
          voyageApiKey: VOYAGE as string,
          deadlineMs: Date.now() + 30_000,
          topK: 5,
        });
        const dt = performance.now() - t0;
        total.push(dt);
        if (dt > RAG_TURN_BUDGET_MS_DEFAULT) overProdBudget++;
        if (r.telemetry?.cacheHit) cacheHits++;
        const tlm = r.telemetry as unknown as {
          rewrite?: { latencyMs?: number };
          rerank?: { latencyMs?: number } | null;
        };
        if (typeof tlm.rewrite?.latencyMs === 'number') rewriteMs.push(tlm.rewrite.latencyMs);
        if (tlm.rerank && typeof tlm.rerank.latencyMs === 'number') rerankMs.push(tlm.rerank.latencyMs);
        // eslint-disable-next-line no-console
        console.log(
          `  trial ${String(i + 1).padStart(2)}  total=${f(dt)}  ` +
            `parents=${r.parents.length}  cacheHit=${r.telemetry?.cacheHit ? 'Y' : 'n'}  ` +
            `budgetExceeded=${r.budgetExceeded ? 'Y' : 'n'}`,
        );
      } catch (e) {
        anyError++;
        // eslint-disable-next-line no-console
        console.log(`  trial ${String(i + 1).padStart(2)}  ERROR ${(e as Error).message}`);
      }
    }

    // eslint-disable-next-line no-console
    console.log('\n──────── P0-4b RETRIEVAL LATENCY (prod creator #1, cache-miss) ────────');
    // eslint-disable-next-line no-console
    console.log(`N=${N}  errors=${anyError}  cacheHits=${cacheHits} (expect 0)`);
    if (total.length) {
      // eslint-disable-next-line no-console
      console.log(`TOTAL    p50=${f(pct(total, 50))}  p75=${f(pct(total, 75))}  p95=${f(pct(total, 95))}`);
      // eslint-disable-next-line no-console
      console.log(`would exceed REAL ${RAG_TURN_BUDGET_MS_DEFAULT}ms prod budget: ${overProdBudget}/${total.length}`);
    }
    if (rewriteMs.length)
      // eslint-disable-next-line no-console
      console.log(`rewrite  p50=${f(pct(rewriteMs, 50))}  p75=${f(pct(rewriteMs, 75))}  p95=${f(pct(rewriteMs, 95))}`);
    if (rerankMs.length)
      // eslint-disable-next-line no-console
      console.log(`rerank   p50=${f(pct(rerankMs, 50))}  p75=${f(pct(rerankMs, 75))}  p95=${f(pct(rerankMs, 95))}`);
    // eslint-disable-next-line no-console
    console.log(
      `\nFEED → scripts/ttft-gate-spike.mjs --retrieval=measured ` +
        `RETRIEVAL_P50_MS=${total.length ? pct(total, 50).toFixed(0) : 'NA'} ` +
        `RETRIEVAL_P75_MS=${total.length ? pct(total, 75).toFixed(0) : 'NA'} ` +
        `RETRIEVAL_P95_MS=${total.length ? pct(total, 95).toFixed(0) : 'NA'}\n`,
    );
    // Measurement, not assertion. Only fail if NOTHING worked (rig broken).
    if (total.length === 0) throw new Error('all retrieval trials failed — rig/creds broken');
  }, 180_000);
});
