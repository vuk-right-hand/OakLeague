#!/usr/bin/env node
// scripts/fish-audio-ws-spike.mjs
// Phase 0.5 wire spike for Fish Audio WebSocket TTS (S2-Pro).
//
// Covers 7 of the 8 claims in docs/_planning/FISH_AUDIO_PHASE_1.md §3
// (Claim 8 — DELETE idempotency — requires a throwaway voice and is
// documented as a separate manual verification step.)
//
// Reads FISH_API_KEY + FISH_TTS_MODEL from .env.local. Total spend budget:
// ~$0.05 (mostly claim 7 — 6 sequential multi-turn samples).
//
// Output: tmp/fish-phase-0.5-results.md (gitignored) — paste relevant
// numbers into FISH_AUDIO_PHASE_1.md §3.
//
// Run: node scripts/fish-audio-ws-spike.mjs
//   Add --skip-claim 7  to skip the expensive multi-turn claim during iter.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { encode, decode } from '@msgpack/msgpack';

// Load .env.local (same pattern as other probe scripts).
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) continue;
  if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const API_KEY = process.env.FISH_API_KEY;
const MODEL = process.env.FISH_TTS_MODEL || 's2-pro';
const VOICE_ID = 'baa1fcbdb14d4bb492af632c1cb17ace'; // Vuk's clone

if (!API_KEY) { console.error('missing FISH_API_KEY'); process.exit(1); }

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = join(__dirname, '..', 'tmp');
const OUT_DIR = join(TMP, 'fish-spike');
const MULTI_TURN_DIR = join(TMP, 'fish-multi-turn');
const RESULTS_PATH = join(TMP, 'fish-phase-0.5-results.md');
[TMP, OUT_DIR, MULTI_TURN_DIR].forEach((d) => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });

const skipClaims = new Set();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--skip-claim') skipClaims.add(Number(process.argv[i + 1]));
}

const WS_URL = 'wss://api.fish.audio/v1/tts/live';

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Open a WebSocket, returning a Promise<WebSocket> resolved on 'open'. */
function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, {
      headers: { Authorization: `Bearer ${API_KEY}`, model: MODEL },
      perMessageDeflate: false,
    });
    ws.binaryType = 'arraybuffer';
    const onOpen = () => { cleanup(); resolve(ws); };
    const onError = (err) => { cleanup(); reject(err); };
    const onClose = () => { if (!ws._opened) reject(new Error('closed before open')); };
    const cleanup = () => {
      ws._opened = true;
      ws.removeListener('open', onOpen);
      ws.removeListener('error', onError);
      ws.removeListener('close', onClose);
    };
    ws.on('open', onOpen);
    ws.on('error', onError);
    ws.on('close', onClose);
    setTimeout(() => { if (!ws._opened) { cleanup(); reject(new Error('open timeout 10s')); } }, 10_000);
  });
}

/** Msgpack encode + send. */
function sendEvent(ws, payload) {
  const bytes = encode(payload);
  return new Promise((resolve, reject) => {
    ws.send(bytes, { binary: true }, (err) => err ? reject(err) : resolve());
  });
}

/** Promisified single-turn synthesis. Resolves with { audioBytes, firstAudioAtMs, lastAudioAtMs, finishAtMs, chunks }. */
async function synthOneTurn({ text, format, sampleRate, latency = 'low', temperature = 0.7, topP = 0.7, ws: existingWs, sendStart = true, sendStop = true, captureChunks = false }) {
  const t0 = Date.now();
  const ws = existingWs || (await openWs());
  const tOpened = Date.now();
  const chunks = [];
  let firstAudioAtMs = 0;
  let lastAudioAtMs = 0;
  let finishAtMs = 0;
  let finishReason = null;
  let finishMessage = null;
  let audioBytes = 0;

  const finished = new Promise((resolve, reject) => {
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      let decoded;
      try { decoded = decode(view); } catch (e) { return reject(new Error(`decode failed: ${e.message}`)); }
      if (!decoded || typeof decoded !== 'object' || !('event' in decoded)) return;
      const ev = decoded.event;
      if (ev === 'audio') {
        const a = decoded.audio;
        if (a instanceof Uint8Array || Buffer.isBuffer(a)) {
          if (!firstAudioAtMs) firstAudioAtMs = Date.now();
          lastAudioAtMs = Date.now();
          audioBytes += a.byteLength;
          if (captureChunks) chunks.push({ atMs: Date.now() - t0, bytes: a.byteLength, audio: Buffer.from(a) });
          else chunks.push({ atMs: Date.now() - t0, bytes: a.byteLength });
        }
      } else if (ev === 'finish') {
        finishAtMs = Date.now();
        finishReason = decoded.reason;
        finishMessage = decoded.message;
        resolve();
      }
    });
    ws.on('error', reject);
    ws.on('close', () => { if (!finishAtMs) resolve(); }); // unexpected close
  });

  if (sendStart) {
    const req = { text: '', reference_id: VOICE_ID, format, latency, temperature, top_p: topP };
    if (sampleRate) req.sample_rate = sampleRate;
    await sendEvent(ws, { event: 'start', request: req });
  }
  await sendEvent(ws, { event: 'text', text });
  const tTextSent = Date.now();
  if (sendStop) await sendEvent(ws, { event: 'stop' });
  const tStopSent = Date.now();
  await finished;
  try { ws.close(); } catch {}

  return {
    audioBytes, chunks, finishReason, finishMessage,
    tOpenMs: tOpened - t0,
    tTextSentMs: tTextSent - t0,
    tStopSentMs: tStopSent - t0,
    firstAudioMs: firstAudioAtMs ? firstAudioAtMs - t0 : null,
    lastAudioMs: lastAudioAtMs ? lastAudioAtMs - t0 : null,
    finishMs: finishAtMs ? finishAtMs - t0 : null,
    // Long-answer drain: time from `stop` send to last audio to `finish`.
    stopToLastAudioMs: (lastAudioAtMs && tStopSent) ? lastAudioAtMs - tStopSent : null,
    stopToFinishMs: (finishAtMs && tStopSent) ? finishAtMs - tStopSent : null,
  };
}

const p = (n) => (n === null || n === undefined) ? 'n/a' : (typeof n === 'number' ? n.toFixed(0) : String(n));
const quantile = (arr, q) => {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * q);
  return sorted[idx];
};

// ── Claim 1: PCM 16kHz output ───────────────────────────────────────────────
async function claim1_pcm16k() {
  const r = await synthOneTurn({
    text: "This is a sixteen kilohertz PCM test sentence.",
    format: 'pcm',
    sampleRate: 16000,
  });
  const audioSec = r.audioBytes / 2 / 16000; // PCM16-LE mono
  return {
    audioBytes: r.audioBytes,
    audioSecondsAt16kAssumption: audioSec.toFixed(2),
    firstAudioMs: r.firstAudioMs,
    finishMs: r.finishMs,
    chunks: r.chunks.length,
    verdict: r.finishReason === 'stop' && r.audioBytes > 1000
      ? `PCM accepted; ${r.chunks.length} chunks; ~${audioSec.toFixed(2)}s of audio (if rate is 16k mono).`
      : `FAILED: reason=${r.finishReason} msg=${r.finishMessage}`,
  };
}

// ── Claim 2: TTFA (20 trials × 3 sub-trials) ────────────────────────────────
async function claim2_ttfa(trials = 20) {
  const cold = [];
  const closeReopen = [];
  const bargeReopen = [];

  // Sub-trial (a): cold WS, measure first audio.
  for (let i = 0; i < trials; i++) {
    const r = await synthOneTurn({ text: "Hello.", format: 'wav', latency: 'low' });
    if (r.firstAudioMs) cold.push(r.firstAudioMs);
    await new Promise((r) => setTimeout(r, 100));
  }

  // Sub-trial (b): cold WS, close immediately after open, reopen, measure first audio of new WS.
  for (let i = 0; i < trials; i++) {
    const ws1 = await openWs(); try { ws1.close(); } catch {}
    const r = await synthOneTurn({ text: "Hello.", format: 'wav', latency: 'low' });
    if (r.firstAudioMs) closeReopen.push(r.firstAudioMs);
    await new Promise((r) => setTimeout(r, 100));
  }

  // Sub-trial (c): start synthesizing a longer turn, close at T~2s mid-synth, immediately reopen + new short synth, measure new TTFA.
  for (let i = 0; i < trials; i++) {
    const ws1 = await openWs();
    await sendEvent(ws1, { event: 'start', request: { text: '', reference_id: VOICE_ID, format: 'wav', latency: 'low' } });
    await sendEvent(ws1, { event: 'text', text: 'This is a longer sentence we are going to interrupt midway, to simulate a barge-in scenario for measurement purposes.' });
    await new Promise((r) => setTimeout(r, 2000));
    try { ws1.close(); } catch {}
    const r = await synthOneTurn({ text: "Yes.", format: 'wav', latency: 'low' });
    if (r.firstAudioMs) bargeReopen.push(r.firstAudioMs);
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    cold: { n: cold.length, p50: quantile(cold, 0.5), p99: quantile(cold, 0.99), min: Math.min(...cold), max: Math.max(...cold) },
    closeReopen: { n: closeReopen.length, p50: quantile(closeReopen, 0.5), p99: quantile(closeReopen, 0.99), min: Math.min(...closeReopen), max: Math.max(...closeReopen) },
    bargeReopen: { n: bargeReopen.length, p50: quantile(bargeReopen, 0.5), p99: quantile(bargeReopen, 0.99), min: Math.min(...bargeReopen), max: Math.max(...bargeReopen) },
    verdict: closeReopen.length && quantile(closeReopen, 0.99) > 600
      ? 'REOPEN p99 > 600ms — speculative pre-open mandatory'
      : 'reopen latency tolerable (p99 ≤ 600ms)',
  };
}

// ── Claim 3: Audio chunk cadence ────────────────────────────────────────────
async function claim3_cadence() {
  const text = "The quick brown fox jumps over the lazy dog. " +
               "She sells seashells by the seashore. " +
               "How much wood would a woodchuck chuck if a woodchuck could chuck wood?";
  const r = await synthOneTurn({ text, format: 'wav', latency: 'low' });
  // Audio duration assumption: WAV @ 44.1kHz × 2 bytes (16-bit) × 1 channel = 88200 bytes/sec.
  // WAV adds a 44-byte header on the FIRST chunk; subsequent chunks are raw PCM payload.
  const audioSec = Math.max(0, (r.audioBytes - 44)) / 88200;
  const totalReceiveMs = r.lastAudioMs - r.firstAudioMs;
  const rateVsRealtime = (audioSec * 1000) / totalReceiveMs;
  return {
    chunks: r.chunks.length,
    audioBytes: r.audioBytes,
    audioSec: audioSec.toFixed(2),
    firstAudioMs: r.firstAudioMs,
    lastAudioMs: r.lastAudioMs,
    totalReceiveMs,
    rateVsRealtime: rateVsRealtime.toFixed(2),
    verdict: rateVsRealtime >= 1.5
      ? `fire-hose: ${rateVsRealtime.toFixed(2)}× realtime (like Cartesia)`
      : rateVsRealtime >= 0.9
      ? `near-realtime pacing (${rateVsRealtime.toFixed(2)}×)`
      : `slower-than-realtime (${rateVsRealtime.toFixed(2)}×) — concerning`,
  };
}

// ── Claim 4: Post-flush continuation ────────────────────────────────────────
async function claim4_postFlush() {
  const ws = await openWs();
  const t0 = Date.now();
  let firstAudioBeforeFlushMs = 0;
  let firstAudioAfterFlushMs = 0;
  let flushSentAtMs = 0;
  let secondTextSentAtMs = 0;
  let finishAtMs = 0;
  let finishReason = null;
  let audioBytes = 0;
  let audioBytesAtFlush = 0;
  let phase = 'pre-flush';

  const done = new Promise((resolve) => {
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      const decoded = decode(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      if (decoded.event === 'audio') {
        audioBytes += decoded.audio.byteLength;
        if (phase === 'pre-flush' && !firstAudioBeforeFlushMs) firstAudioBeforeFlushMs = Date.now() - t0;
        if (phase === 'after-flush' && !firstAudioAfterFlushMs) firstAudioAfterFlushMs = Date.now() - t0;
      } else if (decoded.event === 'finish') {
        finishAtMs = Date.now() - t0;
        finishReason = decoded.reason;
        resolve();
      }
    });
    ws.on('close', () => { if (!finishAtMs) resolve(); });
  });

  await sendEvent(ws, { event: 'start', request: { text: '', reference_id: VOICE_ID, format: 'wav', latency: 'low' } });
  await sendEvent(ws, { event: 'text', text: 'First batch of text before the flush event.' });
  await new Promise((r) => setTimeout(r, 1500));
  await sendEvent(ws, { event: 'flush' });
  flushSentAtMs = Date.now() - t0;
  audioBytesAtFlush = audioBytes;
  phase = 'after-flush';
  await new Promise((r) => setTimeout(r, 500));
  // Try sending more text — does Fish accept it after flush?
  try {
    await sendEvent(ws, { event: 'text', text: 'Second batch of text after the flush event to test continuation.' });
    secondTextSentAtMs = Date.now() - t0;
  } catch (e) {
    secondTextSentAtMs = -1;
  }
  await new Promise((r) => setTimeout(r, 2500));
  try { await sendEvent(ws, { event: 'stop' }); } catch {}
  await done;
  try { ws.close(); } catch {}

  return {
    audioBytesTotal: audioBytes,
    audioBytesAtFlush,
    audioBytesAfterFlush: audioBytes - audioBytesAtFlush,
    flushSentAtMs,
    secondTextSentAtMs,
    firstAudioBeforeFlushMs,
    firstAudioAfterFlushMs,
    finishAtMs,
    finishReason,
    verdict: (audioBytes - audioBytesAtFlush) > 1000 && firstAudioAfterFlushMs > 0
      ? 'Post-flush continuation WORKS: second batch produced audio on same WS'
      : 'Post-flush continuation FAILS / not supported — flush is one-shot synth, keep as no-op',
  };
}

// ── Claim 5: Concurrent dispatch ────────────────────────────────────────────
async function claim5_concurrent() {
  // Try 2 concurrent first (well under Starter's 5).
  const results = await Promise.allSettled([
    synthOneTurn({ text: 'Concurrent A.', format: 'wav', latency: 'low' }),
    synthOneTurn({ text: 'Concurrent B.', format: 'wav', latency: 'low' }),
  ]);
  const both2 = results.every((r) => r.status === 'fulfilled' && r.value.finishReason === 'stop');

  // Try 6 concurrent (over the 5 limit).
  const six = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) => synthOneTurn({ text: `Concurrent test ${i}.`, format: 'wav', latency: 'low' }))
  );
  const sixOk = six.filter((r) => r.status === 'fulfilled' && r.value.finishReason === 'stop').length;
  const sixErr = six.filter((r) => r.status === 'rejected' || (r.status === 'fulfilled' && r.value.finishReason !== 'stop'));

  return {
    twoConcurrentBothOk: both2,
    sixConcurrentSuccessCount: sixOk,
    sixConcurrentErrors: sixErr.length,
    sixErrorSamples: sixErr.slice(0, 2).map((e) => e.reason?.message || e.value?.finishMessage || 'unknown'),
    verdict: both2 && sixOk >= 5 ? '5+ concurrent OK as expected for Starter tier' : 'CONCURRENCY ISSUE',
  };
}

// ── Claim 6: Long-answer drain time ─────────────────────────────────────────
async function claim6_longAnswerDrain() {
  const text = (
    "When I think about what truly separates great founders from good ones, " +
    "it's the willingness to grind on something for years that most people will " +
    "casually dismiss as crazy or unimportant. The hardest year of my career " +
    "was the year nobody listened — every pitch was met with polite indifference, " +
    "every investor meeting ended with 'interesting, let's stay in touch.' " +
    "What kept me going wasn't optimism, it was stubbornness. The kind of " +
    "stubbornness that says: I will be right about this, eventually. " +
    "And the second hard truth: most of what you build will not work. " +
    "You will ship features users ignore, write code you'll throw away, " +
    "give talks that fall flat. The compounding only happens for people " +
    "who can lose every battle on a Tuesday and still show up on Wednesday."
  );
  const r = await synthOneTurn({ text, format: 'wav', latency: 'low', captureChunks: false });
  const audioSec = Math.max(0, (r.audioBytes - 44)) / 88200;
  return {
    textChars: text.length,
    audioBytes: r.audioBytes,
    audioSec: audioSec.toFixed(2),
    firstAudioMs: r.firstAudioMs,
    lastAudioMs: r.lastAudioMs,
    stopSentAtMs: r.tStopSentMs,
    stopToLastAudioMs: r.stopToLastAudioMs,
    stopToFinishMs: r.stopToFinishMs,
    finishReason: r.finishReason,
    verdict: r.stopToFinishMs !== null
      ? `RECOMMEND ttsFinalizeTimeoutMs = max(${(r.stopToFinishMs * 2)}, 30_000)`
      : 'no finish event observed — investigate',
  };
}

// ── Claim 7: Multi-turn voice consistency ───────────────────────────────────
async function claim7_multiTurn() {
  const sentences = [
    "I'm Vuk, founder of OakLeague.",
    "When I think about what makes a great founder, it's obsession, not ideas.",
    "The hardest year of my life was the year nobody listened.",
    "Look. There's no shortcut. The only thing that compounds is showing up.",
    "Yeah, I get that a lot. Most days I'm not motivated. I just don't stop.",
    "Here's the deal: you can spend ten years optimizing for safety, or two building something that matters.",
  ];
  const out = [];
  for (let i = 0; i < sentences.length; i++) {
    // Fresh WS per turn — mirrors prod path. Capture chunks once for timing AND disk.
    const r = await synthOneTurn({ text: sentences[i], format: 'wav', latency: 'low', captureChunks: true });
    const fullBuf = Buffer.concat(r.chunks.map((c) => c.audio).filter(Boolean));
    const outPath = join(MULTI_TURN_DIR, `turn-${String(i + 1).padStart(2, '0')}.wav`);
    writeFileSync(outPath, fullBuf);
    out.push({ i: i + 1, text: sentences[i], firstAudioMs: r.firstAudioMs, audioBytes: r.audioBytes, outPath: outPath.replace(/^.*tmp/, 'tmp') });
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    turns: out,
    verdict: `Listen back-to-back via tmp/fish-multi-turn/*.wav. If voice drifts (pitch/energy/cadence) across turns 1→6, lower temperature 0.7→0.4 and consider seed pinning.`,
  };
}

// ── Driver ──────────────────────────────────────────────────────────────────

async function runAll() {
  const results = {};
  const claims = [
    ['1', 'PCM 16kHz output works', claim1_pcm16k],
    ['2', 'TTFA: cold/close-reopen/barge-reopen (20 trials × 3)', claim2_ttfa],
    ['3', 'Audio chunk cadence', claim3_cadence],
    ['4', 'Post-flush continuation', claim4_postFlush],
    ['5', 'Concurrent dispatch', claim5_concurrent],
    ['6', 'Long-answer drain time', claim6_longAnswerDrain],
    ['7', 'Multi-turn voice consistency', claim7_multiTurn],
  ];

  console.log(`\n== Fish Audio Phase 0.5 — WS spike ==\n`);
  for (const [n, label, fn] of claims) {
    if (skipClaims.has(Number(n))) { console.log(`[skip] Claim ${n}`); continue; }
    console.log(`\n[run] Claim ${n}: ${label}`);
    const t0 = Date.now();
    try {
      results[n] = await fn();
      console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${results[n].verdict || 'see file'}`);
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
      results[n] = { error: e.message };
    }
  }

  // Write a markdown summary.
  const lines = [
    `# Fish Audio Phase 0.5 — wire spike results`,
    ``,
    `Run: ${new Date().toISOString()}`,
    `Voice ID: \`${VOICE_ID}\``,
    `Model: \`${MODEL}\``,
    ``,
  ];
  for (const [n, label] of claims) {
    if (skipClaims.has(Number(n))) continue;
    lines.push(`## Claim ${n} — ${label}`, '');
    const r = results[n];
    if (!r) { lines.push('(not run)', ''); continue; }
    lines.push('```json', JSON.stringify(r, (_k, v) => Buffer.isBuffer(v) || v instanceof Uint8Array ? `<${v.byteLength}B>` : v, 2), '```', '');
  }
  lines.push(`---`, `## Claim 8 — DELETE idempotency (MANUAL)`, ``);
  lines.push(`This claim requires a throwaway voice ID to delete. Steps:`);
  lines.push(`1. Clone any short audio (15s) to a throwaway voice via the Fish dashboard. Note its \`reference_id\`.`);
  lines.push(`2. \`curl -X DELETE https://api.fish.audio/model/<id> -H "Authorization: Bearer $FISH_API_KEY" -v\``);
  lines.push(`3. Expect 200 or 204. Repeat the call — expect 404.`);
  lines.push(`4. Document the exact status codes.`);

  writeFileSync(RESULTS_PATH, lines.join('\n'));
  console.log(`\nResults written to ${RESULTS_PATH.replace(/^.*tmp/, 'tmp')}`);
  console.log(`Multi-turn WAVs (if claim 7 ran): tmp/fish-multi-turn/turn-01..06.wav`);
  console.log(`\nNext: paste relevant numbers into FISH_AUDIO_PHASE_1.md §3, then resume implementation.\n`);
}

runAll().catch((e) => { console.error('spike died:', e); process.exit(1); });
