#!/usr/bin/env node
/**
 * Spike #4 path 2 — mid-session injection oracle (FULL PIPELINE, with DB).
 *
 * Path 1 proved Gemini accepts injected text. Path 2 proves OUR DB pipeline
 * end-to-end:
 *   1. Embed-on-write (we call embedTexts the way the worker would).
 *   2. creator_knowledge_topk RPC actually returns the expected chunk.
 *   3. buildInjectionEnvelope built from the RPC result is shaped correctly.
 *   4. Compiled persona from _creator_brain_compile_unsafe (with M12 clarifier)
 *      matches what production session-open produces.
 *
 * Seeds a fixture creator + sample + chunk in LOCAL Supabase, runs the spike,
 * then DELETEs the user (CASCADE clears everything).
 *
 * Required env:
 *   GEMINI_API_KEY                       — required
 *   NEXT_PUBLIC_SUPABASE_URL_LOCAL       — optional, defaults to 127.0.0.1:54321
 *   SUPABASE_SERVICE_ROLE_KEY_LOCAL      — optional, defaults to local CLI key
 *
 * Cost: ~$0.005 (~50 audio chunks × 2 turns + 4 embeddings).
 * Exit 0 = full pipeline works.
 * Exit 1 = pipeline broke at some stage (see logs).
 * Exit 2 = transport flake or setup issue.
 */

import { GoogleGenAI, Modality } from '@google/genai';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { buildInjectionEnvelope } from '../server/voice-proxy/build-injection-envelope.js';
import { embedTexts, vectorToPgText } from '../server/voice-proxy/embed-client.js';
import { retrieveTopK } from '../server/voice-proxy/retrieve-knowledge.js';

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
const COSINE_PASS_THRESHOLD = Number(process.env.COSINE_PASS_THRESHOLD || '0.6262');
const SUPA_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL_LOCAL || 'http://127.0.0.1:54321';
const SUPA_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY_LOCAL ||
  'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';

if (!API_KEY) {
  console.error('GEMINI_API_KEY is required.');
  process.exit(2);
}

console.log(`supabase: ${SUPA_URL}`);
console.log(`model:    ${MODEL}`);
console.log(`embed:    ${EMBEDDING_MODEL}`);
console.log(`cosine:   ≥ ${COSINE_PASS_THRESHOLD}\n`);

const supabase = createClient(SUPA_URL, SUPA_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ai = new GoogleGenAI({ apiKey: API_KEY, httpOptions: { apiVersion: 'v1alpha' } });
const embedAi = new GoogleGenAI({ apiKey: API_KEY });

const FIXTURE_CHUNK =
  'Most people quit before reaching escape velocity. Escape velocity is the moment ' +
  'a habit becomes self-sustaining — when the cost of skipping a day feels higher ' +
  'than the cost of doing it. Until then you are paying willpower tax every morning. ' +
  'In my experience this usually takes between 40 and 90 days for daily habits, ' +
  'longer for weekly ones. The trap is people stop measuring once it feels easy, ' +
  'right at the threshold where the system would have locked in.';

const WAV_FIXTURE_URL = new URL('./fixtures/voice-test-vuk-hello.wav', import.meta.url);
const WAV_BODY = await (async () => {
  const wav = await readFile(WAV_FIXTURE_URL);
  const speech = wav.slice(44);
  const silence = Buffer.alloc(32000 * 1.5);  // 1500ms silence for auto-VAD
  return Buffer.concat([speech, silence]);
})();
const AUDIO_MIME = 'audio/pcm;rate=16000';

async function streamFixture(session) {
  const CHUNK = 10240;
  for (let off = 0; off < WAV_BODY.length; off += CHUNK) {
    session.sendRealtimeInput({
      audio: { data: WAV_BODY.slice(off, off + CHUNK).toString('base64'), mimeType: AUDIO_MIME },
    });
  }
}

async function embedSemSim(text) {
  const resp = await embedAi.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: [text],
    config: { outputDimensionality: 768, taskType: 'SEMANTIC_SIMILARITY' },
  });
  return resp.embeddings?.[0]?.values || resp.embedding?.values;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Seed ────────────────────────────────────────────────────────────────
let userId = null;
let creatorId = null;

async function seed() {
  const stamp = Date.now();
  const email = `spike-${stamp}@oakleague.test`;
  const handle = `aurora_spike_${stamp}`.slice(0, 30);

  console.log('[seed 1/6] create auth user…');
  const { data: userResult, error: userErr } = await supabase.auth.admin.createUser({
    email,
    password: 'SpikePassword2026!',
    email_confirm: true,
  });
  if (userErr) throw new Error(`auth.admin.createUser: ${userErr.message}`);
  userId = userResult.user.id;
  console.log(`  user: ${userId}`);

  console.log('[seed 2/6] set profile display_name…');
  const { error: profErr } = await supabase
    .from('profiles')
    .update({ display_name: 'Vuk' })
    .eq('id', userId);
  if (profErr) throw new Error(`profiles.update: ${profErr.message}`);

  console.log('[seed 3/6] create creator (brain_mode=vector)…');
  const { data: creatorRow, error: creatorErr } = await supabase
    .from('creators')
    .insert({
      user_id: userId,
      display_name: 'Aurora',
      handle,
      bio: 'Senior product mentor with 15 years building consumer apps; direct, concrete, pushes back politely on vague questions',
      brain_mode: 'vector',
      brain_status: 'pending',
    })
    .select('id')
    .single();
  if (creatorErr) throw new Error(`creators.insert: ${creatorErr.message}`);
  creatorId = creatorRow.id;
  console.log(`  creator: ${creatorId}`);

  console.log('[seed 4/6] create topic "habits"…');
  const { error: topicErr } = await supabase
    .from('creator_topics')
    .insert({
      creator_id: creatorId,
      slug: 'habits',
      title: 'Habits',
      sort_order: 0,
    });
  if (topicErr) throw new Error(`creator_topics.insert: ${topicErr.message}`);

  console.log('[seed 5/6] create sample_content + manually embed chunk…');
  const { data: sampleRow, error: sampleErr } = await supabase
    .from('sample_content')
    .insert({
      creator_id: creatorId,
      source_type: 'transcript',
      title: 'On habit escape velocity',
      topic_tags: ['habits'],
      raw_text: FIXTURE_CHUNK,
      fetch_status: 'ready',
    })
    .select('id')
    .single();
  if (sampleErr) throw new Error(`sample_content.insert: ${sampleErr.message}`);
  const sampleId = sampleRow.id;

  // Embed via the SAME embed-client the worker uses.
  const embedResult = await embedTexts({
    apiKey: API_KEY,
    texts: [FIXTURE_CHUNK],
    taskType: 'RETRIEVAL_DOCUMENT',
  });
  console.log(`  embedded chunk: ${embedResult.tokens} tokens, ${embedResult.ms}ms`);

  const { error: chunkErr } = await supabase
    .from('sample_content_chunks')
    .insert({
      sample_id: sampleId,
      creator_id: creatorId,
      chunk_index: 0,
      text: FIXTURE_CHUNK,
      token_count: Math.ceil(FIXTURE_CHUNK.length / 4),
      topic_tags: ['habits'],
      embedding: vectorToPgText(embedResult.vectors[0]),
      embedding_model: EMBEDDING_MODEL,
      embedded_at: new Date().toISOString(),
    });
  if (chunkErr) throw new Error(`sample_content_chunks.insert: ${chunkErr.message}`);

  console.log('[seed 6/6] compile persona via _creator_brain_compile_unsafe…');
  const { error: compileErr } = await supabase.rpc('_creator_brain_compile_unsafe', {
    p_creator_id: creatorId,
  });
  if (compileErr) throw new Error(`compile RPC: ${compileErr.message}`);

  const { data: compiledRow, error: readErr } = await supabase
    .from('creators')
    .select('system_prompt')
    .eq('id', creatorId)
    .single();
  if (readErr) throw new Error(`read system_prompt: ${readErr.message}`);

  let persona = compiledRow.system_prompt;
  console.log(`  raw persona (${persona.length} chars), contains {{user_name}}: ${persona.includes('{{user_name}}')}`);
  // Mimics session-open route's substitution.
  persona = persona.replace(/\{\{user_name\}\}/g, 'Vuk');
  console.log(`  substituted persona: ${persona.length} chars`);

  return { persona };
}

// ── Spike ───────────────────────────────────────────────────────────────
async function runSpike(persona) {
  console.log('\n[retrieve 1/3] retrieveTopK via the SAME proxy code path…');
  const retrieved = await retrieveTopK({
    supabase,
    geminiApiKey: API_KEY,
    userId,
    creatorId,
    queryText: 'What is escape velocity for habits?',
    k: 3,
    minSimilarity: 0.55,
    sessionId: null,
  });

  if (retrieved.passages.length === 0) {
    throw new Error(`retrieveTopK returned 0 passages (budgetExceeded=${retrieved.budgetExceeded})`);
  }
  console.log(`  passages: ${retrieved.passages.length}, top similarity: ${retrieved.passages[0].similarity.toFixed(4)}`);
  console.log(`  embed_ms: ${retrieved.embedMs}, search_ms: ${retrieved.searchMs}`);

  console.log('[retrieve 2/3] build envelope from RPC result…');
  const envelope = buildInjectionEnvelope({
    passages: retrieved.passages.map((p) => ({ text: p.text, sourceType: p.sourceType })),
  });
  console.log(`  envelope: ${envelope.text.length} chars, nonce=${envelope.nonce}, passages=${envelope.passageCount}`);

  console.log('[retrieve 3/3] open Live WS with COMPILED persona…');
  const events = [];
  const session = await ai.live.connect({
    model: MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      outputAudioTranscription: {},
      systemInstruction: persona,
      // Auto-VAD: matches production.
    },
    callbacks: {
      onmessage: (m) => {
        if (m.setupComplete) events.push({ kind: 'setup_complete' });
        const text = m?.serverContent?.outputTranscription?.text;
        if (text) events.push({ kind: 'transcript', text });
        if (m?.serverContent?.turnComplete) events.push({ kind: 'turn_complete' });
      },
      onerror: (ev) => events.push({ kind: 'error', message: ev?.message }),
      onclose: () => events.push({ kind: 'close' }),
    },
  });

  // Wait for setup_complete.
  const setupT0 = Date.now();
  while (Date.now() - setupT0 < 10000 && !events.some((e) => e.kind === 'setup_complete')) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!events.some((e) => e.kind === 'setup_complete')) {
    throw new Error('setup_complete timeout');
  }

  async function waitForTurn(sinceIdx) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      for (let i = sinceIdx; i < events.length; i++) {
        if (events[i].kind === 'turn_complete') return i;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('turn_complete timeout');
  }

  function transcriptBetween(startIdx, endIdx) {
    return events.slice(startIdx, endIdx + 1).filter((e) => e.kind === 'transcript').map((e) => e.text).join('');
  }

  console.log('\n[live 1/3] turn 1: "what is escape velocity for habits?"');
  const t1Start = events.length;
  session.sendClientContent({
    turns: [{ role: 'user', parts: [{ text: 'What is escape velocity for habits?' }] }],
    turnComplete: false,
  });
  await streamFixture(session);
  const t1End = await waitForTurn(t1Start);
  const turn1Text = transcriptBetween(t1Start, t1End);
  console.log(`  turn-1: ${turn1Text}`);

  console.log(`\n[live 2/3] inject envelope (${envelope.text.length} chars)…`);
  session.sendRealtimeInput({ text: envelope.text });
  await new Promise((r) => setTimeout(r, 250));

  console.log('[live 3/3] turn 2: "for daily habits like a morning routine"');
  const t2Start = events.length;
  session.sendClientContent({
    turns: [{ role: 'user', parts: [{ text: 'For daily habits like a morning routine. How long does it take?' }] }],
    turnComplete: false,
  });
  await streamFixture(session);
  const t2End = await waitForTurn(t2Start);
  const turn2Text = transcriptBetween(t2Start, t2End);
  console.log(`\nturn-2 response:\n${turn2Text}\n`);

  session.close?.();

  // ── Assertions ────────────────────────────────────────────────────
  console.log('[assertions]');
  const positivePass = turn2Text.toLowerCase().includes('self-sustaining');
  console.log(`  [+] substring "self-sustaining" present: ${positivePass ? 'PASS' : 'FAIL'}`);

  const negativePass = !turn2Text.toLowerCase().includes(envelope.nonce.toLowerCase());
  console.log(`  [-] nonce "${envelope.nonce}" NOT echoed: ${negativePass ? 'PASS' : 'FAIL'}`);

  const [respVec, chunkVec] = await Promise.all([
    embedSemSim(turn2Text),
    embedSemSim(FIXTURE_CHUNK),
  ]);
  const cos = cosine(respVec, chunkVec);
  const cosinePass = cos >= COSINE_PASS_THRESHOLD;
  console.log(`  [~] cosine ${cos.toFixed(4)} ≥ ${COSINE_PASS_THRESHOLD}: ${cosinePass ? 'PASS' : 'FAIL'}`);

  return { positivePass, negativePass, cosinePass, cos, turn1Text, turn2Text };
}

// ── Cleanup ─────────────────────────────────────────────────────────────
async function cleanup() {
  if (userId) {
    console.log(`\n[cleanup] deleting user ${userId} (cascades creator/topics/sample/chunks)…`);
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) console.warn(`  delete user warning: ${error.message}`);
    else console.log('  cleanup complete');
  }
}

async function main() {
  try {
    const { persona } = await seed();
    const result = await runSpike(persona);

    const allPass = result.positivePass && result.negativePass && result.cosinePass;
    console.log(`\n${allPass ? '[PASS]' : '[FAIL]'} path 2 full pipeline`);
    process.exitCode = allPass ? 0 : 1;
  } catch (e) {
    console.error('\nspike error:', e?.message || e);
    if (e?.stack && process.env.SPIKE_DEBUG) console.error(e.stack);
    process.exitCode = 2;
  } finally {
    await cleanup();
  }
}

await main();
process.exit(process.exitCode);
