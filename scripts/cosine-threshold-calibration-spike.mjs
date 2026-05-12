#!/usr/bin/env node
/**
 * Spike #4a — cosine-threshold calibration (R3 S3 pre-Spike #4).
 *
 * Pins `cosine_pass_threshold` BEFORE Spike #4 runs. Without this, the plan's
 * ≥0.65 default is un-anchored to gemini-embedding-001's actual behavior and
 * either always passes (loose) or flakes (tight).
 *
 * Method:
 *   1. Define a fixture chunk (the "self-sustaining" passage used by Spike #4).
 *   2. Generate 5 plausible substantive responses a model would emit to the
 *      seed question "what is escape velocity for habits?" after seeing the
 *      chunk via injection. Variants vary fidelity (direct quote → paraphrase
 *      → tangential).
 *   3. Embed chunk via RETRIEVAL_DOCUMENT, each response via SEMANTIC_SIMILARITY.
 *      (Per Gemini's asymmetric-task guidance: doc-vs-doc similarity uses
 *      SEMANTIC_SIMILARITY on the response side; the chunk stays as the
 *      indexed document to match production retrieval.)
 *   4. Compute cosine similarity for each (response, chunk) pair.
 *   5. Output the 5 cosines + recommended threshold = min(observed) - 0.05.
 *
 * Required env:
 *   GEMINI_API_KEY  — required
 *
 * Cost: 6 embedding calls × ~50 tokens × $0.15/1M = ~$0.0001.
 * Exit 0 = wrote calibration to stdout; copy threshold into Spike #4 / env.
 */

import { GoogleGenAI } from '@google/genai';

const API_KEY = process.env.GEMINI_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
const DIM = 768;

if (!API_KEY) {
  console.error('GEMINI_API_KEY is required.');
  process.exit(2);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

// The fixture chunk — same shape Spike #4 will seed into a fixture creator.
// Unique phrase ("escape velocity is the moment a habit becomes self-sustaining")
// embedded inside paragraph context so the model has more than a one-liner
// to retrieve.
const FIXTURE_CHUNK =
  'Most people quit before reaching escape velocity. Escape velocity is the moment ' +
  'a habit becomes self-sustaining — when the cost of skipping a day feels higher ' +
  'than the cost of doing it. Until then you are paying willpower tax every morning. ' +
  'In my experience this usually takes between 40 and 90 days for daily habits, ' +
  'longer for weekly ones. The trap is people stop measuring once it feels easy, ' +
  'right at the threshold where the system would have locked in.';

// 5 plausible model responses, sorted approximately from highest to lowest fidelity.
const RESPONSES = [
  // 1. Near-quote with paraphrase
  'Escape velocity for habits is the moment a habit becomes self-sustaining — when ' +
  'skipping a day costs you more than doing it. Most people quit right before they hit ' +
  'that point. For daily habits it usually takes 40 to 90 days.',

  // 2. Faithful paraphrase, no direct quote
  'It is the threshold where a habit no longer needs willpower — once skipping feels ' +
  'more painful than doing it, the habit is locked in. Most people give up just before ' +
  'they reach that point. Are you trying to install a daily or weekly habit?',

  // 3. Concept correctly captured but reworded
  'You hit escape velocity when the habit runs itself — when not doing it feels worse ' +
  'than doing it. Below that line you are burning willpower; above it the system ' +
  'sustains itself. The hard part is people quit right at the threshold.',

  // 4. Tangentially related — talks about habits but misses the "self-sustaining" framing
  'It usually takes 40 to 90 days of daily repetition before a habit feels automatic. ' +
  'The key is consistency — missing more than one day in a row resets the clock. ' +
  'What habit are you trying to build?',

  // 5. On-topic but generic, no chunk-specific information
  'Building habits is about reducing friction. Make the right thing easy and the wrong ' +
  'thing hard. Start small and stack new habits onto existing ones. What habit do you have in mind?',
];

const QUESTION = 'What is escape velocity for habits?';

async function embed(text, taskType) {
  const resp = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: [text],
    config: {
      outputDimensionality: DIM,
      taskType,
    },
  });
  const obj = resp;
  let v;
  if (Array.isArray(obj.embeddings) && obj.embeddings[0]?.values) {
    v = obj.embeddings[0].values;
  } else if (obj.embedding?.values) {
    v = obj.embedding.values;
  } else {
    throw new Error('no embeddings in response: ' + JSON.stringify(Object.keys(obj)));
  }
  if (!Array.isArray(v) || v.length !== DIM) {
    throw new Error(`expected ${DIM}-dim, got ${v?.length}`);
  }
  return v;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function main() {
  console.log(`fixture chunk (${FIXTURE_CHUNK.length} chars):`);
  console.log(`  "${FIXTURE_CHUNK.slice(0, 120)}…"\n`);
  console.log(`question (production seed): "${QUESTION}"\n`);

  // Embed chunk as RETRIEVAL_DOCUMENT (production indexes chunks this way).
  console.log('[1] embedding chunk as RETRIEVAL_DOCUMENT…');
  const chunkVec = await embed(FIXTURE_CHUNK, 'RETRIEVAL_DOCUMENT');

  // Embed question as RETRIEVAL_QUERY — sanity check the retrieval step
  // would actually find this chunk (informational only).
  console.log('[2] embedding question as RETRIEVAL_QUERY (sanity)…');
  const queryVec = await embed(QUESTION, 'RETRIEVAL_QUERY');
  const queryCos = cosine(queryVec, chunkVec);
  console.log(`    query↔chunk cosine = ${queryCos.toFixed(4)}\n`);

  // Embed each response as SEMANTIC_SIMILARITY (this is the response-vs-chunk
  // comparison Spike #4 will perform on the model's actual emission).
  console.log('[3] embedding 5 responses as SEMANTIC_SIMILARITY…');
  const cosines = [];
  for (let i = 0; i < RESPONSES.length; i++) {
    const respVec = await embed(RESPONSES[i], 'SEMANTIC_SIMILARITY');
    const cos = cosine(respVec, chunkVec);
    cosines.push(cos);
    console.log(
      `    R${i + 1} (${RESPONSES[i].length} chars) cosine = ${cos.toFixed(4)}  ` +
      `— "${RESPONSES[i].slice(0, 60)}…"`,
    );
  }

  const min = Math.min(...cosines);
  const max = Math.max(...cosines);
  const mean = cosines.reduce((s, c) => s + c, 0) / cosines.length;
  const threshold = min - 0.05;

  console.log('\n────────────────────────────────────────');
  console.log(`min:   ${min.toFixed(4)}`);
  console.log(`max:   ${max.toFixed(4)}`);
  console.log(`mean:  ${mean.toFixed(4)}`);
  console.log(`spread: ${(max - min).toFixed(4)}`);
  console.log('────────────────────────────────────────');
  console.log(`\nRECOMMENDED cosine_pass_threshold = ${threshold.toFixed(4)}`);
  console.log(`  (= min(${min.toFixed(4)}) - 0.05 safety margin)`);
  console.log(`\nPin in Spike #4 via env: COSINE_PASS_THRESHOLD=${threshold.toFixed(4)}`);

  // Also show generic ≥0.65 plan-default comparison for context.
  if (threshold >= 0.65) {
    console.log('\nNOTE: calibrated threshold ≥ 0.65 plan-default — Spike #4 default would be loose.');
  } else if (threshold < 0.45) {
    console.log(
      '\nWARNING: calibrated threshold < 0.45 — fixture chunk and responses may be too dissimilar; ' +
      'consider tighter response variants or a different fixture.',
    );
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('error:', e?.message || e);
  process.exit(1);
});
