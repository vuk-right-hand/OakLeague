// brain-depth-ab-spike.mjs — Phase 3 (variable-depth) verification.
//
// Claim under test: BRAIN_DEPTH_MODE=variable makes the decoupled deep answer
// MATCH depth to the question — a story question gets the full story, a simple
// question stays short — while brief mode (the A/B control) reproduces today's
// 1-3-sentence behavior. AND tier bifurcates the budget: free ~150 words, paid
// ~450. We must SEE this bifurcation on the real model BEFORE flipping the
// secret in prod (audit M1/M6 — never A/B a behavior we haven't measured).
//
// This calls the REAL generateDeepAnswer (real Gemini) across mode × tier ×
// question, N trials each, with a PINNED reference envelope + pinned questions
// so retrieval/grounding variance is NOT a confound — only the depth clause
// changes between arms. NO prod, NO Supabase. Dev Gemini key only.
//
// Run: node --env-file=.env.local scripts/brain-depth-ab-spike.mjs [--trials=10]
//
// Pass criteria (printed at the end):
//   1. variable: paid story answer > free story answer (tier bifurcates)
//   2. variable: story answer > simple-factual answer within the same tier
//      (depth tracks the question)
//   3. brief: free ≈ paid (tier inert when not variable) AND short (control)
//   4. nothing exceeds the 4000-char OUTPUT_CHAR_CEILING (kill-switch safety)

import { generateDeepAnswer } from '../server/voice-proxy/brain-bridge.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
  }),
);
const TRIALS = Number(args.trials || 10);

// generateDeepAnswer needs GEMINI key + BRAIN_* pricing (cost values are
// irrelevant to length; set safe placeholders only if absent so the run
// doesn't fail-closed on a missing rate during a pure length probe).
const APIKEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!APIKEY) {
  console.error('FATAL: GEMINI_API_KEY not in env (run with --env-file=.env.local)');
  process.exit(1);
}
// Audit M1 — depth-following is model-specific. A verdict measured on a
// different model than prod's BRAIN_MODEL is worthless. REFUSE to silently
// default: the operator must run this against the SAME model the prod secret
// pins (or pass --allow-default-model to acknowledge they're spiking a guess).
const MODEL_DEFAULTED = !process.env.BRAIN_MODEL;
if (MODEL_DEFAULTED && !args['allow-default-model']) {
  console.error(
    'FATAL: BRAIN_MODEL is not set. Depth behavior is model-specific — set\n' +
    '  BRAIN_MODEL to the EXACT value of the prod Fly secret before trusting\n' +
    '  this verdict (or pass --allow-default-model to spike a guess explicitly).',
  );
  process.exit(2);
}
process.env.BRAIN_MODEL = process.env.BRAIN_MODEL || 'gemini-2.5-flash';
process.env.BRAIN_USD_PER_INPUT_TOKEN = process.env.BRAIN_USD_PER_INPUT_TOKEN || '0.0000003';
process.env.BRAIN_USD_PER_OUTPUT_TOKEN = process.env.BRAIN_USD_PER_OUTPUT_TOKEN || '0.0000025';
process.env.BRAIN_QUOTED_AT = process.env.BRAIN_QUOTED_AT || '2026-05-21';

// Pinned persona (decoupled shape POST-migration 20260523000005: NO baked
// "concise sentences" — otherwise the C3 self-heal would force brief and the
// variable arm couldn't be measured). Mirrors _creator_brain_compile_unsafe's
// decoupled branch output.
const PERSONA =
  'You are Vuk. Founder who scaled a creator-mentorship product. ' +
  'Topics you cover: startups, fundraising, growth. ' +
  'Speak as yourself. Address the user as Sam where natural. ' +
  'Outside your experience: say so plainly, then offer what you do know. ';

// Pinned salted L2 envelope (matches buildInjectionEnvelope's contract:
// ^--- BEGIN REFERENCE <hex> --- … --- END REFERENCE <hex> ---). Pinning it
// removes retrieval variance from the A/B.
const PINNED_ENVELOPE = [
  '--- BEGIN REFERENCE a1b2c3 ---',
  'In the early days we cold-emailed 200 creators, got 11 replies, and only ',
  '2 said yes. The first yes came after I rewrote the pitch to lead with the ',
  'cloned-voice demo instead of the deck. Growth came from one creator ',
  'posting a hook clip that did 400k views; that single clip drove the first ',
  '1000 signups in a weekend. We learned distribution beats polish early.',
  '--- END REFERENCE a1b2c3 ---',
].join('\n');

const QUESTIONS = {
  story: 'Walk me through how you got your first 1000 users — tell me the whole story.',
  simple: 'What does product-market fit mean?',
};

async function answerOnce({ question, tier, forceBrief }) {
  const gen = generateDeepAnswer({
    persona: PERSONA,
    referenceEnvelopeText: PINNED_ENVELOPE,
    question,
    apiKey: APIKEY,
    tier,
    forceBrief,
  });
  let text = '';
  for await (const ev of gen) {
    if (ev.final) text = ev.text || text;
    else if (ev.delta) text += ev.delta;
  }
  return text;
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const words = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);

async function cell(label, opts) {
  const chars = [];
  const wc = [];
  let maxChars = 0;
  for (let i = 0; i < TRIALS; i++) {
    const t = await answerOnce(opts);
    chars.push(t.length);
    wc.push(words(t));
    maxChars = Math.max(maxChars, t.length);
  }
  const medChars = median(chars);
  const medWords = median(wc);
  console.log(
    `${label.padEnd(28)} med=${String(medChars).padStart(4)}ch / ${String(medWords).padStart(3)}w   max=${String(maxChars).padStart(4)}ch`,
  );
  return { medChars, medWords, maxChars };
}

(async () => {
  console.log(`Phase 3 depth A/B — model=${process.env.BRAIN_MODEL}${MODEL_DEFAULTED ? ' (DEFAULTED — verdict does NOT apply to prod unless prod uses this model!)' : ' (from env)'}, trials=${TRIALS}/cell\n`);

  // ── BRIEF (control) ──────────────────────────────────────────────────
  delete process.env.BRAIN_DEPTH_MODE; // unset ⇒ brief (C4 fail-safe)
  console.log('BRIEF mode (control — BRAIN_DEPTH_MODE unset):');
  const briefFreeStory = await cell('  free  story', { question: QUESTIONS.story, tier: 'free' });
  const briefPaidStory = await cell('  paid  story', { question: QUESTIONS.story, tier: 'premium' });

  // ── VARIABLE ─────────────────────────────────────────────────────────
  process.env.BRAIN_DEPTH_MODE = 'variable';
  console.log('\nVARIABLE mode (BRAIN_DEPTH_MODE=variable):');
  const varFreeStory = await cell('  free  story', { question: QUESTIONS.story, tier: 'free' });
  const varPaidStory = await cell('  paid  story', { question: QUESTIONS.story, tier: 'premium' });
  const varBoardStory = await cell('  board story', { question: QUESTIONS.story, tier: 'boardroom' });
  const varFreeSimple = await cell('  free  simple', { question: QUESTIONS.simple, tier: 'free' });
  const varPaidSimple = await cell('  paid  simple', { question: QUESTIONS.simple, tier: 'premium' });
  const varPaidGreetFloor = await cell('  paid  story+forceBrief', {
    question: QUESTIONS.story, tier: 'premium', forceBrief: true,
  });

  // ── verdicts ─────────────────────────────────────────────────────────
  const CEIL = 4000;
  const checks = [
    ['1 tier bifurcates (var paid story > var free story)', varPaidStory.medChars > varFreeStory.medChars],
    ['2 depth tracks question (var paid story > var paid simple)', varPaidStory.medChars > varPaidSimple.medChars * 1.3],
    ['3a brief tier-inert (free ≈ paid, within 25%)',
      Math.abs(briefFreeStory.medChars - briefPaidStory.medChars) <= 0.25 * Math.max(briefFreeStory.medChars, briefPaidStory.medChars)],
    ['3b brief is short (paid story < var paid story)', briefPaidStory.medChars < varPaidStory.medChars],
    ['4 nothing exceeds 4000-char ceiling',
      [briefFreeStory, briefPaidStory, varFreeStory, varPaidStory, varBoardStory, varFreeSimple, varPaidSimple, varPaidGreetFloor]
        .every((c) => c.maxChars <= CEIL)],
    ['5 forceBrief floor works (forceBrief ≈ brief, not full story)',
      varPaidGreetFloor.medChars < varPaidStory.medChars],
    ['6 boardroom gets the full (paid) budget too (board story > free story)',
      varBoardStory.medChars > varFreeStory.medChars],
  ];
  console.log('\nVerdicts:');
  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) allPass = false;
  }
  console.log(
    allPass
      ? '\nPhase 3 CONFIRMED — bifurcation holds + ceiling-safe. Safe to A/B BRAIN_DEPTH_MODE=variable in prod.'
      : '\nPhase 3 NOT confirmed — investigate failing checks BEFORE flipping the secret. Record the real numbers; do not overstate.',
  );
  process.exit(allPass ? 0 : 1);
})().catch((e) => {
  console.error('PROBE ERROR:', e?.stack || e);
  process.exit(1);
});
