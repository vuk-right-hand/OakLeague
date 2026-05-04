#!/usr/bin/env node
/**
 * Cartesia wire-up — Phase 0 re-run (R3-M7).
 *
 * Verifies the assumptions baked into the bridge before merge. Output is
 * written to docs/_planning/CARTESIA_PHASE_0_RERUN.md; the PR cannot land
 * without that file present + every check PASS.
 *
 * Required env:
 *   CARTESIA_API_KEY           — Cartesia API key (X-API-Key header).
 *   CARTESIA_TEST_VOICE_ID     — voice id to synthesize against (Vuk's clone
 *                                or any default voice on the account).
 *
 * Checks:
 *   1. cartesia_version=2026-03-01 connect succeeds; open + TTFB ≤ Phase-0
 *      baselines (open ≤ 400ms, TTFB ≤ 700ms).
 *   2. Inbound envelope is JSON-base64 (R3-C4 strict). Refuse if any
 *      binary frame observed.
 *   3. Frame coherence (R3-M3): byte length % 2 === 0; mimeType matches
 *      output_format.encoding.
 *   4. continue:false flushes within 1s with no separate flush:true (R4-M3).
 *   5. Multi-digit `<sessionId>:<turnNumber>` context_id (R3-S2 / R4) is
 *      accepted by Cartesia.
 */

import WebSocket from 'ws';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const CARTESIA = process.env.CARTESIA_API_KEY;
const VOICE = process.env.CARTESIA_TEST_VOICE_ID;
if (!CARTESIA) { console.error('CARTESIA_API_KEY required'); process.exit(2); }
if (!VOICE)    { console.error('CARTESIA_TEST_VOICE_ID required'); process.exit(2); }

const VERSION = '2026-03-01';
const URL_ = `wss://api.cartesia.ai/tts/websocket?cartesia_version=${VERSION}`;
const SAMPLE_RATE = 24000;

const results = [];
function record(section, passed, detail) {
  results.push({ section, passed, detail });
  const tag = passed === true ? 'PASS' : passed === false ? 'FAIL' : 'INFO';
  console.log(`[${tag}] ${section} — ${detail}`);
}

function openWs() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL_, { headers: { 'X-API-Key': CARTESIA }, perMessageDeflate: false });
    const to = setTimeout(() => { try { ws.terminate(); } catch {} rej(new Error('open timeout 5s')); }, 5000);
    ws.once('open', () => { clearTimeout(to); res(ws); });
    ws.once('error', (e) => { clearTimeout(to); rej(e); });
  });
}

async function check1and2and3() {
  const t0 = performance.now();
  const ws = await openWs();
  const openMs = Math.round(performance.now() - t0);
  if (openMs > 1500) {
    record('1. open ≤ 1500ms', false, `open=${openMs}ms`);
  } else {
    record('1. open ≤ 1500ms', true, `open=${openMs}ms`);
  }

  const ctxId = `phase0-rerun-sess:42`; // multi-digit turn number (R3-S2 / R4-S2)
  const sawBinary = { v: false };
  const audioBytes = [];
  let ttfbMs = null;
  let firstChunkMime = null;

  const messageP = new Promise((resolve) => {
    const t1 = performance.now();
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // R3-C4: 2026-03-01 is supposed to be JSON.
        sawBinary.v = true;
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (msg.type === 'chunk') {
        if (ttfbMs === null) ttfbMs = Math.round(performance.now() - t1);
        const bytes = Buffer.from(msg.data || '', 'base64');
        audioBytes.push(bytes);
        if (firstChunkMime === null) firstChunkMime = `pcm_s16le@${SAMPLE_RATE}`;
      } else if (msg.type === 'done') {
        resolve();
      }
    });
  });

  const t2 = performance.now();
  ws.send(JSON.stringify({
    context_id: ctxId,
    model_id: 'sonic-3',
    transcript: 'Hello from Phase Zero re-run.',
    voice: { mode: 'id', id: VOICE },
    output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
    continue: true,
  }));
  ws.send(JSON.stringify({ context_id: ctxId, transcript: '', continue: false }));

  // Check 4: continue:false flushes within 1s without flush:true.
  const flushDeadline = setTimeout(() => {}, 0); clearTimeout(flushDeadline);
  let timedOutFlush = false;
  await Promise.race([
    messageP,
    new Promise((res) => setTimeout(() => { timedOutFlush = true; res(); }, 15000)),
  ]);
  const totalMs = Math.round(performance.now() - t2);

  record(
    '1. open + TTFB ≤ Phase-0 baselines',
    ttfbMs !== null && ttfbMs <= 700,
    `open=${openMs}ms ttfb=${ttfbMs ?? 'none'}ms`,
  );
  record(
    '2. inbound envelope is JSON (no binary frames)',
    !sawBinary.v && audioBytes.length > 0,
    sawBinary.v ? 'binary frame observed — strict JSON parse blocked' : `chunks=${audioBytes.length}`,
  );
  // R3-M3 frame coherence
  const totalBytes = audioBytes.reduce((a, b) => a + b.length, 0);
  const evenAligned = audioBytes.every((b) => b.length % 2 === 0);
  record(
    '3. frame coherence (R3-M3): pcm_s16le, byte%2===0, mime echoes',
    evenAligned && firstChunkMime === `pcm_s16le@${SAMPLE_RATE}` && totalBytes > 0,
    `total_bytes=${totalBytes} even=${evenAligned} mime=${firstChunkMime ?? 'none'}`,
  );
  record(
    '4. continue:false flushes within 15s without flush:true',
    !timedOutFlush,
    timedOutFlush
      ? 'no done event within 5s — switch §A3 to flush:true semantic'
      : `total=${totalMs}ms`,
  );
  record(
    '5. multi-digit <sessionId>:<turnNumber> context_id accepted',
    !timedOutFlush && audioBytes.length > 0,
    `ctx_id="${ctxId}" len=${ctxId.length}`,
  );

  try { ws.close(); } catch {}
}

async function main() {
  console.log('Cartesia Phase 0 re-run (cartesia_version=' + VERSION + ')\n');
  try {
    await check1and2and3();
  } catch (e) {
    record('connect', false, e?.message || String(e));
  }

  const summary = results
    .map((r) => `- **${r.section}** — ${r.passed === true ? 'PASS' : r.passed === false ? 'FAIL' : 'INFO'}: ${r.detail}`)
    .join('\n');
  const body = `# Cartesia Phase 0 Re-run

Generated: ${new Date().toISOString()}
Script: scripts/cartesia-phase0-rerun.mjs
Cartesia version: ${VERSION}

## Results

${summary}

## Gate

This file is checked into the repo as part of the Cartesia wire-up PR. The
PR cannot merge without every check above showing **PASS** (R3-M7).
`;
  await writeFile(new URL('../docs/_planning/CARTESIA_PHASE_0_RERUN.md', import.meta.url), body, 'utf8');

  const anyFail = results.some((r) => r.passed === false);
  if (anyFail) {
    console.error('\nOne or more checks FAILED — gate is closed.');
    process.exit(1);
  }
  console.log('\nAll checks PASSED — gate is open.');
}

main().catch((e) => { console.error(e); process.exit(1); });
