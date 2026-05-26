// rewrite-thinking-ab-spike.mjs — F2 verification (DECOUPLED_BRAIN_PLAN §12).
//
// Claim under test: query-rewrite.ts calls gemini-2.5-flash with NO
// thinkingConfig, so it pays the default extended-thinking tax (the same
// one that inflated the paraphrase 3321→639ms). A one-line
// thinkingConfig:{thinkingBudget:0} should ~halve the rewrite latency.
//
// This probe replicates query-rewrite.ts's EXACT call shape (model, config,
// prompt) and measures full generateContent latency (it uses non-streaming
// generateContent — it needs the whole JSON) with thinking ON (current
// prod) vs OFF, A/B, same prompts. NO prod, NO Supabase — dev Gemini key
// only. Does NOT modify query-rewrite.ts; that one-liner ships separately
// through the normal audit gate IFF this proves the delta.
//
// Run: node --env-file=.env.local scripts/rewrite-thinking-ab-spike.mjs [--trials=20]

import { GoogleGenAI } from '@google/genai';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
  }),
);
const TRIALS = Number(args.trials || 20);
const APIKEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const MODEL = 'gemini-2.5-flash'; // QUERY_REWRITE_MODEL default
if (!APIKEY) {
  console.error('FATAL: GEMINI_API_KEY not in env (run with --env-file=.env.local)');
  process.exit(1);
}

// EXACT buildPrompt() shape from query-rewrite.ts:358-375 (mirrored).
function buildPrompt(utterance, lastAsst) {
  return [
    'You rewrite a user utterance into a standalone search query for a knowledge-retrieval system.',
    'If the utterance references the prior assistant turn ("tell me more", "what about that"), expand it using the topic of the prior turn.',
    'Otherwise return the utterance unchanged, possibly tightened.',
    'Return exactly: {"rewritten":"<query>"}. No prose. Keep <100 words.',
    '',
    'Prior assistant turn:',
    lastAsst.length > 0 ? lastAsst : '(none — start of conversation or post-resumption)',
    '',
    'User utterance:',
    utterance,
  ].join('\n');
}

const CASES = [
  ['tell me more about that', 'Two siblings read the same absence as self-reliance vs abandonment; the interpretation compounds.'],
  ['how can two identical upbringings produce different realities', ''],
  ['what about the twins', 'The twins story is about escape velocity from environment.'],
  ['why does that happen', 'Self-fulfilling beliefs make people seek evidence that confirms them.'],
  ['what is a mental model', ''],
  ['go on', 'Negative visualization rehearses loss so the present feels chosen, not owed.'],
];

const ai = new GoogleGenAI({ apiKey: APIKEY });
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const f = (n) => `${n.toFixed(0)}ms`;

async function callOnce(thinkingOff) {
  const [u, l] = CASES[Math.floor(Math.random() * CASES.length)];
  const t0 = performance.now();
  await ai.models.generateContent({
    model: MODEL,
    contents: buildPrompt(u, l),
    config: {
      temperature: 0.0,
      responseMimeType: 'application/json',
      ...(thinkingOff ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  });
  return performance.now() - t0;
}

async function run(label, thinkingOff) {
  const lat = [];
  for (let i = 0; i < TRIALS; i++) lat.push(await callOnce(thinkingOff));
  console.log(
    `${label.padEnd(18)} p50=${f(pct(lat, 50))}  p75=${f(pct(lat, 75))}  p95=${f(pct(lat, 95))}`,
  );
  return pct(lat, 50);
}

(async () => {
  console.log(`F2 A/B — query-rewrite call shape, model=${MODEL}, trials=${TRIALS} each\n`);
  // Interleave-free but warm: run OFF first then ON (order effect is small
  // vs the thinking delta we're testing; both share the same warmed client).
  const onP50 = await run('thinking ON (prod)', false);
  const offP50 = await run('thinking OFF (fix)', true);
  const cut = ((onP50 - offP50) / onP50) * 100;
  console.log(
    `\nΔ p50: ${f(onP50)} → ${f(offP50)}  (${cut.toFixed(0)}% ${cut >= 0 ? 'faster' : 'SLOWER'})`,
  );
  console.log(
    cut >= 30
      ? 'F2 CONFIRMED — thinkingBudget:0 materially cuts rewrite latency; ship the one-liner (audited).'
      : 'F2 NOT confirmed at the ~half claim — record the real delta, do NOT overstate.',
  );
})().catch((e) => {
  console.error('PROBE ERROR:', e?.stack || e);
  process.exit(1);
});
