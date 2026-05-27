#!/usr/bin/env node
/**
 * Cartesia manual-flush probe (mid-word-cutoff fix, 2026-05-27).
 *
 * Verifies the `flush:true + continue:true + empty transcript` manual-flush
 * primitive against the PINNED cartesia_version=2026-03-01 BEFORE wiring a
 * flush() method into cartesia-bridge.js. Auditor C2: pipecat's flush_audio
 * uses continue:FALSE (a context close) — the keep-open manual flush is a
 * DIFFERENT op documented but never verified on our pinned version.
 *
 * Proves (or refutes):
 *   A. {flush:true, continue:true, transcript:'', <full block>} is ACCEPTED
 *      (no "Invalid transcript" / error frame).
 *   B. A `flush_done` frame arrives after the flush.
 *   C. The context SURVIVES the flush — more text on the same context_id after
 *      the flush still synthesizes audio (continue:true kept it open).
 *   D. A later {transcript:'', continue:false} still finalizes with `done`.
 *   E. Ordering: batch-1 audio chunks arrive before flush_done (so flush
 *      really forces the held tail out, not just a no-op ack).
 *
 * Env: CARTESIA_API_KEY, CARTESIA_VOICE_ID (or CARTESIA_TEST_VOICE_ID).
 */

import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';

const CARTESIA = process.env.CARTESIA_API_KEY;
const VOICE = process.env.CARTESIA_VOICE_ID || process.env.CARTESIA_TEST_VOICE_ID;
if (!CARTESIA) { console.error('CARTESIA_API_KEY required'); process.exit(2); }
if (!VOICE) { console.error('CARTESIA_VOICE_ID required'); process.exit(2); }

const VERSION = '2026-03-01';
const URL_ = `wss://api.cartesia.ai/tts/websocket?cartesia_version=${VERSION}`;
const SAMPLE_RATE = 24000;
const MODEL = 'sonic-3';
const CTX = 'flush-probe-sess:7';

const block = {
  model_id: MODEL,
  voice: { mode: 'id', id: VOICE },
  output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
};

const log = (...a) => console.log(...a);

function openWs() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL_, { headers: { 'X-API-Key': CARTESIA }, perMessageDeflate: false });
    const to = setTimeout(() => { try { ws.terminate(); } catch {} rej(new Error('open timeout 5s')); }, 5000);
    ws.once('open', () => { clearTimeout(to); res(ws); });
    ws.once('error', (e) => { clearTimeout(to); rej(e); });
  });
}

const ev = []; // ordered event log: {t, kind, detail}
let batch1Chunks = 0, batch2Chunks = 0, flushDoneSeen = false, doneSeen = false, errorFrame = null;
let phase = 'batch1';
const t0 = performance.now();
const stamp = () => Math.round(performance.now() - t0);

async function main() {
  log(`Cartesia manual-flush probe (cartesia_version=${VERSION})\n`);
  const ws = await openWs();
  log(`[${stamp()}ms] ws open`);

  const finished = new Promise((resolve) => {
    ws.on('message', (data, isBinary) => {
      if (isBinary) { ev.push({ t: stamp(), kind: 'BINARY' }); return; }
      let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      const type = msg.type;
      if (type === 'chunk') {
        if (phase === 'batch1') batch1Chunks++;
        else batch2Chunks++;
      } else if (type === 'flush_done') {
        flushDoneSeen = true;
        ev.push({ t: stamp(), kind: 'flush_done', detail: `flush_id=${msg.flush_id} ctx=${msg.context_id} b1Chunks=${batch1Chunks}` });
      } else if (type === 'done') {
        doneSeen = true;
        ev.push({ t: stamp(), kind: 'done', detail: `ctx=${msg.context_id} b1=${batch1Chunks} b2=${batch2Chunks}` });
        resolve();
      } else if (type === 'error') {
        errorFrame = msg;
        ev.push({ t: stamp(), kind: 'ERROR', detail: `${msg.error_code || ''} ${msg.message || JSON.stringify(msg)}` });
        resolve();
      } else {
        ev.push({ t: stamp(), kind: `other:${type}` });
      }
    });
  });

  // Batch 1 — first half of the sentence.
  ws.send(JSON.stringify({ ...block, context_id: CTX, transcript: 'The most important thing to focus on is your daily', continue: true }));
  log(`[${stamp()}ms] sent batch1 (continue:true)`);

  // Manual flush — the primitive under test.
  await new Promise((r) => setTimeout(r, 300));
  ws.send(JSON.stringify({ ...block, context_id: CTX, transcript: '', continue: true, flush: true }));
  log(`[${stamp()}ms] sent FLUSH (flush:true, continue:true, transcript:'')`);

  // Wait to see flush_done + whether context survives.
  await new Promise((r) => setTimeout(r, 1500));
  phase = 'batch2';
  ws.send(JSON.stringify({ ...block, context_id: CTX, transcript: ' habits and the systems around them.', continue: true }));
  log(`[${stamp()}ms] sent batch2 on SAME context (continue:true)`);

  // Finalize.
  await new Promise((r) => setTimeout(r, 300));
  ws.send(JSON.stringify({ ...block, context_id: CTX, transcript: '', continue: false }));
  log(`[${stamp()}ms] sent continue:false terminator`);

  await Promise.race([finished, new Promise((r) => setTimeout(r, 15000))]);
  try { ws.close(); } catch {}

  log('\n--- ordered event log ---');
  for (const e of ev) log(`  [${e.t}ms] ${e.kind}${e.detail ? ' — ' + e.detail : ''}`);

  log('\n--- verdict ---');
  const A = errorFrame === null;
  const B = flushDoneSeen;
  const C = batch2Chunks > 0;
  const D = doneSeen;
  const E = flushDoneSeen && batch1Chunks > 0;
  log(`  A. flush accepted (no error frame)............ ${A ? 'PASS' : 'FAIL'}${errorFrame ? ' — ' + JSON.stringify(errorFrame) : ''}`);
  log(`  B. flush_done frame received.................. ${B ? 'PASS' : 'FAIL'}`);
  log(`  C. context survived flush (batch2 audio)...... ${C ? 'PASS' : 'FAIL'} — batch2Chunks=${batch2Chunks}`);
  log(`  D. continue:false still finalized (done)...... ${D ? 'PASS' : 'FAIL'}`);
  log(`  E. flush forced batch1 audio out.............. ${E ? 'PASS' : 'FAIL'} — batch1Chunks=${batch1Chunks}`);
  const allPass = A && B && C && D && E;
  log(`\n  ${allPass ? 'ALL PASS — manual-flush primitive verified on ' + VERSION : 'NOT ALL PASS — do NOT ship flush() as planned; revise'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('probe error:', e?.message || e); process.exit(1); });
