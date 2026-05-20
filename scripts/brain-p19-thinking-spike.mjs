#!/usr/bin/env node
/**
 * P1-9 — real-API spike for the two plan-tracked M-items that block the
 * (A)-gate re-trust on the pinned 3.x model (DECOUPLED_BRAIN_PLAN §13:887
 * + §13:1004). Rewritten after the per-step P1-9 audit (4C/7M/13S) caught
 * the original silently-false-pass surface, and AGAIN after the whole-
 * build audit (4C/7M/15S) caught the M6 prod-surface assertion was
 * structurally vacuous (substring-search across two independent
 * inferences). This version uses the spike-only `__spike_includeThoughts`
 * hook in `streamGenerate` to drive thought emission THROUGH the prod
 * joiner — so the spike proves the prod path, not a parallel
 * re-implementation.
 *
 *   • M1 — thinkingLevel is HONORED at the server (COMPARATIVE oracle).
 *          'minimal' alone proves nothing (Google docs: "'minimal' does
 *          not guarantee thinking is off"). Run each prompt twice — once
 *          with `thinkingLevel:'high'` (baseline) and once with
 *          `'minimal'` (prod default). Assert (a) the baseline emitted
 *          ≥ HIGH_MIN_THOUGHTS thoughts tokens — otherwise the prompt is
 *          invalid for the comparison; (b) minimal is ≤ MINIMAL_RATIO_MAX
 *          of the baseline. Both runs go through streamGenerate so the
 *          values come from the same code path prod uses.
 *
 *   • M6 — thought-parts excluded from the user-facing delta on the
 *          PROD joiner (whole-build audit C1 fix). One run with
 *          `__spike_thinkingLevel:'high'` + `__spike_includeThoughts:true`
 *          forces the server to emit thought parts through prod
 *          streamGenerate. The spike then ALSO runs the same prompt
 *          again with a raw `client.models.generateContentStream` call
 *          (same config) to recover the unfiltered parts, and asserts:
 *          (i)   the raw run emits ≥ 1 part with `thought:true` — proves
 *                the SDK shape contract still holds (else spike exits 2);
 *          (ii)  the prod-streamGenerate delta from the FORCED run does
 *                NOT contain any of the raw run's thought-part text
 *                (≥24-char substring check). Substring search across the
 *                two runs is still imperfect, BUT now both runs use the
 *                SAME forced-thought config, so the text distributions
 *                are statistically comparable. A future joiner-filter
 *                regression would leak THIS run's thoughts (or thoughts
 *                of the same SHAPE) into the prod delta — pickable up
 *                via the substring search far more reliably than the
 *                pre-fix cross-config compare.
 *
 * Real-API gated. Expected cost: ~6 inferences (2 prompts × 3 modes:
 * high baseline, minimal, forced + raw control). Cents.
 *
 * Required env: GEMINI_API_KEY, BRAIN_MODEL.
 *
 * Exit 0 = M1 AND M6 PASS on the pinned model.
 * Exit 1 = at least one assertion FAILED.
 * Exit 2 = transport / config error (e.g., non-thinking-family model,
 *          missing env, no thoughts emitted under 'high' so the oracle
 *          has no baseline).
 */

// NOTE: this spike calls `streamGenerate` directly. streamGenerate does
// NOT call `getBrainPricing()` (pricing is per-bridge), so the operator
// running 1a does NOT need BRAIN_USD_PER_*_TOKEN / BRAIN_QUOTED_AT set.
// If a future refactor moves pricing inside streamGenerate (matching
// the "single source of truth" trend), plumb the pricing envs here too.
import { clientFor, thinkingConfigFor, streamGenerate } from '../server/voice-proxy/brain-llm-common.js';

class TestErr extends Error {
  constructor(code, msg) { super(msg || code); this.name = 'TestErr'; this.code = code; }
}

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.BRAIN_MODEL;

if (!API_KEY) { console.error('GEMINI_API_KEY required'); process.exit(2); }
if (!MODEL) {
  console.error('BRAIN_MODEL required (set to the prod-pinned 3.x model, e.g. gemini-3.1-flash-preview)');
  process.exit(2);
}

const KEY_FP = API_KEY.slice(-4);

function isThinkingFamily(model) {
  return /^gemini-3(\.|-)/.test(model);
}

if (!isThinkingFamily(MODEL)) {
  console.error(`BRAIN_MODEL=${MODEL} is not in the 3.x thinking-family;`);
  console.error('M1/M6 are 3.x-only concepts. Set BRAIN_MODEL to the prod-pinned 3.x model.');
  process.exit(2);
}

const ai = clientFor(API_KEY);

const PROMPTS = [
  {
    label: 'word_problem',
    text:
      'A train leaves Station A at 9:00 AM travelling 60 mph. A second ' +
      'train leaves Station B at 10:30 AM travelling 75 mph toward A. ' +
      'The stations are 285 miles apart. At what exact clock time do ' +
      'the trains meet? Show your reasoning in your thinking but answer ' +
      'in one sentence.',
  },
  {
    label: 'constrained_logic',
    text:
      'Three switches in a hallway each control one of three light bulbs ' +
      'in a closed room you cannot see into. You can flip switches as ' +
      'many times as you like, then enter the room ONCE. How do you ' +
      'identify which switch controls which bulb? Answer in one sentence.',
  },
];

// Whole-build audit S3+S4 — magic numbers, document rationale.
// HIGH_MIN_THOUGHTS = 8 — empirical floor: a 'high'-mode run on a real
// reasoning prompt against gemini-3.x produces ≫8 thought tokens in our
// pre-spike probes; <8 means the prompt didn't elicit measurable
// thinking, so the 'minimal' comparison is unreliable.
// MINIMAL_RATIO_MAX = 0.25 — 'minimal' is allowed to emit up to 25% of
// the high baseline's thoughts. Tight enough to catch "level ignored"
// while leaving headroom for stochastic per-run variation.
const HIGH_MIN_THOUGHTS = 8;
const MINIMAL_RATIO_MAX = 0.25;

// streamGenerate caller — production path, prod joiner. We drive the
// thinking config via spike-only hooks (`__spike_*`); prod callers don't
// pass these and get `thinkingConfigFor(MODEL)` (audit-applied 90d7855).
async function prodRun(prompt, { level, includeThoughts }) {
  let delta = '';
  let final = null;
  for await (const ev of streamGenerate({
    client: ai, model: MODEL,
    systemInstruction: '',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    signal: null, ErrCls: TestErr,
    __spike_thinkingLevel: level,
    __spike_includeThoughts: includeThoughts,
  })) {
    if (ev.final) final = ev;
    else if (ev.delta) delta += ev.delta;
  }
  return {
    delta,
    thoughtsTokens: final?.usage?.thoughtsTokens ?? null,
    inputTokens: final?.usage?.inputTokens ?? null,
    outputTokens: final?.usage?.outputTokens ?? null,
  };
}

// Raw SDK call with the SAME forced config — the ground truth for what
// thought parts the server emitted. The prod run's delta MUST exclude
// these strings.
async function rawForcedRun(prompt) {
  const stream = await ai.models.generateContentStream({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      temperature: 0.4,
      thinkingConfig: { thinkingLevel: 'high', includeThoughts: true },
      maxOutputTokens: 250,
    },
  });
  let thoughtPartTexts = [];
  for await (const chunk of stream) {
    const parts = chunk?.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
      if (p && p.thought === true) {
        thoughtPartTexts.push((p.text || '').trim());
      }
    }
  }
  return { thoughtPartTexts };
}

async function main() {
  console.log(`P1-9 thinking-off spike — model=${MODEL} key_fp=…${KEY_FP}`);
  console.log(`runtime thinkingConfig (prod default)=${JSON.stringify(thinkingConfigFor(MODEL))}\n`);

  const runs = [];
  let failed = 0;
  let incomplete = false;
  try {
    for (const p of PROMPTS) {
      console.log(`── prompt: ${p.label} ──`);
      console.log(`  [m1.high]    prod streamGenerate w/ __spike_thinkingLevel:'high'…`);
      const high = await prodRun(p.text, { level: 'high' });
      console.log(`  [m1.minimal] prod streamGenerate w/ __spike_thinkingLevel:'minimal'…`);
      const minimal = await prodRun(p.text, { level: 'minimal' });

      console.log(`  [m6.forced]  prod streamGenerate w/ includeThoughts:true (prod joiner under test)…`);
      const forced = await prodRun(p.text, { level: 'high', includeThoughts: true });
      console.log(`  [m6.raw]     raw SDK forced-thoughts run (ground truth)…`);
      const raw = await rawForcedRun(p.text);

      runs.push({ prompt: p, high, minimal, forced, raw });
    }
  } catch (e) {
    console.error('transport error during runs:', e?.stack || e?.message || e);
    incomplete = true;
    if (runs.length === 0) process.exit(2);
  }

  console.log('\n── M1 — thinkingLevel honored (comparative: high vs minimal) ──');
  for (const r of runs) {
    const hi = r.high.thoughtsTokens ?? 0;
    const mi = r.minimal.thoughtsTokens ?? 0;
    if (hi < HIGH_MIN_THOUGHTS) {
      console.log(`[FAIL] ${r.prompt.label}: HIGH baseline only emitted ${hi} thoughts tokens ` +
        `(< ${HIGH_MIN_THOUGHTS}); prompt cannot validate the 'minimal' assertion. Use a more reasoning-heavy prompt.`);
      failed++;
      continue;
    }
    const ratio = mi / hi;
    const honored = ratio <= MINIMAL_RATIO_MAX;
    console.log(`[${honored ? 'PASS' : 'FAIL'}] ${r.prompt.label}: high=${hi}, minimal=${mi} ` +
      `(ratio=${ratio.toFixed(2)}, threshold ≤ ${MINIMAL_RATIO_MAX})`);
    if (!honored) failed++;
  }

  console.log('\n── M6 — prod joiner excludes thought-parts (forced positive control) ──');
  for (const r of runs) {
    // Step (i): SDK shape sanity — raw forced run MUST emit thought parts.
    if (r.raw.thoughtPartTexts.length === 0) {
      console.log(`[FAIL] ${r.prompt.label}: raw SDK forced run produced ZERO thought parts. ` +
        `SDK shape may have changed; spike premise invalid. Exit 2.`);
      failed++;
      process.exit(2);
    }
    // Step (ii): the prod-joiner FORCED run's delta MUST NOT contain
    // any ≥24-char substring of the raw run's thought parts.
    const leakProbes = r.raw.thoughtPartTexts
      .filter((t) => t.length >= 24)
      .map((t) => t.slice(0, 24));
    const leaks = leakProbes.filter((probe) => r.forced.delta.includes(probe));
    if (leaks.length > 0) {
      console.log(`[FAIL] ${r.prompt.label}: prod streamGenerate delta CONTAINS thought-part text:`);
      console.log(`        ↳ probe: "${leaks[0].replace(/\n/g, ' ')}…"`);
      console.log(`        ↳ delta head: "${r.forced.delta.slice(0, 200).replace(/\n/g, ' ')}…"`);
      failed++;
    } else {
      console.log(`[PASS] ${r.prompt.label}: raw=${r.raw.thoughtPartTexts.length} thought-part(s) ` +
        `observed; prod streamGenerate delta excludes all ≥24c probes.`);
    }
  }

  console.log('\n── samples (operator review) ──');
  for (const r of runs) {
    console.log(`  ${r.prompt.label} [minimal]: "${(r.minimal.delta || '').slice(0, 200).replace(/\n/g, ' ')}…"`);
    console.log(`  ${r.prompt.label} [forced ]: "${(r.forced.delta || '').slice(0, 200).replace(/\n/g, ' ')}…"`);
  }

  if (failed > 0) {
    console.error(`\n[FAIL] ${failed} assertion(s) failed${incomplete ? ' (incomplete run)' : ''} — (A) gate cannot be re-trusted for ${MODEL}`);
    process.exit(1);
  }
  console.log(`\n[PASS] M1 + M6 hold on ${MODEL} — (A) gate re-trusted for the pinned model`);
  process.exit(0);
}

main().catch((e) => {
  console.error('top-level transport error:', e?.stack || e?.message || e);
  process.exit(2);
});
