#!/usr/bin/env node
/**
 * Hume Phase-0 — refinement run for ambiguous / rate-limited checks.
 *
 * Re-measures:
 *   4-refined. TTFA = single flush:true message → first audio chunk (5 trials)
 *   10a/10b.   Error envelope shapes (rate-limited in main run)
 *   13.        tts_speed cadence parity (rate-limited in main run)
 *
 * Run AFTER waiting 60s post the main spike script so the burst-429s clear.
 */

import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';
import { writeFile, readFile } from 'node:fs/promises';

const HUME_API_KEY = process.env.HUME_API_KEY;
const HUME_TEST_VOICE_ID = process.env.HUME_TEST_VOICE_ID;
if (!HUME_API_KEY || !HUME_TEST_VOICE_ID) { console.error('env required'); process.exit(2); }

const HUME_WSS = 'wss://api.hume.ai/v0/tts/stream/input';

function buildUrl() {
  const qs = new URLSearchParams({
    version: '2', instant_mode: 'true', strip_headers: 'true', format_type: 'pcm', no_binary: 'true',
  });
  const base = `${HUME_WSS}?${qs.toString()}`;
  return { urlWithKey: `${base}&api_key=${encodeURIComponent(HUME_API_KEY)}`, urlScrubbed: `${base}&api_key=[redacted]` };
}

function openWs() {
  const { urlWithKey } = buildUrl();
  return new Promise((res, rej) => {
    const ws = new WebSocket(urlWithKey, { perMessageDeflate: false });
    const to = setTimeout(() => { try { ws.terminate(); } catch {} rej(new Error('open timeout')); }, 5000);
    ws.once('open', () => { clearTimeout(to); res(ws); });
    ws.once('error', (e) => { clearTimeout(to); rej(new Error(String(e.message || e).replace(/api_key=[^&\s]+/g, 'api_key=[redacted]'))); });
  });
}

// ── Refined TTFA: single flush:true message ──────────────────────────

async function measureTTFA() {
  const trials = [];
  for (let i = 0; i < 5; i++) {
    const ws = await openWs();
    // Wait for WS to stabilize.
    await new Promise((r) => setTimeout(r, 200));
    const ttfa = await new Promise((resolve) => {
      const to = setTimeout(() => resolve({ ms: null, error: 'timeout' }), 10000);
      let firstChunkMs = null;
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
        if (msg.type === 'audio' && firstChunkMs === null) {
          firstChunkMs = Math.round(performance.now() - tSend);
          clearTimeout(to);
          resolve({ ms: firstChunkMs });
        } else if (msg.type === 'error') {
          clearTimeout(to);
          resolve({ ms: null, error: String(msg.message || msg.title || 'err').slice(0, 120) });
        }
      });
      const tSend = performance.now();
      ws.send(JSON.stringify({
        text: 'Hello.',
        voice: { id: HUME_TEST_VOICE_ID, provider: 'CUSTOM_VOICE' },
        flush: true,
      }));
    });
    try { ws.close(); } catch {}
    if (ttfa.ms !== null) trials.push(ttfa.ms);
    else console.log(`  trial ${i+1}: ${ttfa.error}`);
    await new Promise((r) => setTimeout(r, 2000)); // pace
  }
  trials.sort((a, b) => a - b);
  return { trials, p50: trials[Math.floor(trials.length / 2)], min: trials[0], max: trials[trials.length - 1] };
}

// ── Error envelope shapes (10a + 10b) ────────────────────────────────

async function probeBadVoiceId() {
  const ws = await openWs();
  await new Promise((r) => setTimeout(r, 200));
  const env = await new Promise((resolve) => {
    const to = setTimeout(() => resolve(null), 10000);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (msg.type === 'error') { clearTimeout(to); resolve(msg); }
    });
    ws.on('close', (code, reason) => { clearTimeout(to); resolve({ closed: true, code, reason: String(reason || '').slice(0, 80) }); });
    ws.send(JSON.stringify({
      text: 'Test.',
      voice: { id: 'not-a-real-voice-uuid', provider: 'CUSTOM_VOICE' },
      flush: true,
    }));
  });
  try { ws.close(); } catch {}
  return env;
}

async function probeMalformedJson() {
  const ws = await openWs();
  await new Promise((r) => setTimeout(r, 200));
  const env = await new Promise((resolve) => {
    const to = setTimeout(() => resolve(null), 8000);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (msg.type === 'error') { clearTimeout(to); resolve(msg); }
    });
    ws.on('close', (code, reason) => { clearTimeout(to); resolve({ closed: true, code, reason: String(reason || '').slice(0, 80) }); });
    ws.send('{ not even valid json');
  });
  try { ws.close(); } catch {}
  return env;
}

// ── tts_speed cadence parity (13) ────────────────────────────────────

async function measureCadence(speed) {
  const ws = await openWs();
  await new Promise((r) => setTimeout(r, 200));
  let totalBytes = 0;
  let done = false;
  let err = null;
  await new Promise((resolve) => {
    const to = setTimeout(() => { done = true; resolve(); }, 20000);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (msg.type === 'audio') {
        totalBytes += Buffer.from(msg.audio || '', 'base64').length;
        if (msg.is_last_chunk) { clearTimeout(to); done = true; resolve(); }
      } else if (msg.type === 'error') {
        err = String(msg.message || msg.title || 'err').slice(0, 80);
        clearTimeout(to); resolve();
      }
    });
    ws.send(JSON.stringify({
      text: 'The quick brown fox jumps over the lazy dog. Five boxing wizards jump quickly.',
      voice: { id: HUME_TEST_VOICE_ID, provider: 'CUSTOM_VOICE' },
      speed,
      flush: true,
    }));
  });
  try { ws.close(); } catch {}
  // At 48kHz s16le default: bytes / 96000 = seconds.
  return { speed, totalBytes, audioSec: totalBytes / 96000, complete: done && !err, error: err };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('Hume Phase-0 refinement run\n');

  console.log('## Refined TTFA (5 trials, single flush:true message, fresh WS each)');
  const ttfa = await measureTTFA();
  console.log(`  trials_ms=[${ttfa.trials.join(', ')}]`);
  console.log(`  min=${ttfa.min}ms p50=${ttfa.p50}ms max=${ttfa.max}ms`);

  console.log('\n## Error envelope shapes');
  const e10a = await probeBadVoiceId();
  console.log(`  10a bad voice id:    ${JSON.stringify(e10a).slice(0, 300)}`);
  await new Promise((r) => setTimeout(r, 3000));
  const e10b = await probeMalformedJson();
  console.log(`  10b malformed JSON:  ${JSON.stringify(e10b).slice(0, 300)}`);

  console.log('\n## tts_speed cadence parity (3 trials)');
  const c085 = await measureCadence(0.85);
  await new Promise((r) => setTimeout(r, 3000));
  const c100 = await measureCadence(1.0);
  await new Promise((r) => setTimeout(r, 3000));
  const c115 = await measureCadence(1.15);
  console.log(`  speed=0.85: ${c085.audioSec.toFixed(2)}s (${c085.totalBytes}B) complete=${c085.complete} err=${c085.error ?? ''}`);
  console.log(`  speed=1.00: ${c100.audioSec.toFixed(2)}s (${c100.totalBytes}B) complete=${c100.complete} err=${c100.error ?? ''}`);
  console.log(`  speed=1.15: ${c115.audioSec.toFixed(2)}s (${c115.totalBytes}B) complete=${c115.complete} err=${c115.error ?? ''}`);

  // Append to HUME_PHASE_0.md
  const append = `

---

## Refinement run (post-rate-limit recovery)

Generated: ${new Date().toISOString()}
Script: \`scripts/hume-phase0-refine.mjs\`

### Refined TTFA (single flush:true; 5 trials, fresh WS each)

- trials_ms = [${ttfa.trials.join(', ')}]
- min = ${ttfa.min}ms
- p50 = ${ttfa.p50}ms
- max = ${ttfa.max}ms

**Interpretation:** the main-run TTFA=4007ms reflected 4 sequential messages with only the LAST one carrying \`flush:true\`. A cleaner single-message-flush measurement is what conversational latency looks like in production. Cartesia Phase-0 baseline: ≤700ms cold.

### Error envelope shapes

**10a. bad voice id:**
\`\`\`json
${JSON.stringify(e10a, null, 2)}
\`\`\`

**10b. malformed JSON:**
\`\`\`json
${JSON.stringify(e10b, null, 2)}
\`\`\`

### tts_speed cadence parity

| speed | audio_seconds | bytes | complete |
|---|---|---|---|
| 0.85 | ${c085.audioSec.toFixed(2)} | ${c085.totalBytes} | ${c085.complete} |
| 1.00 | ${c100.audioSec.toFixed(2)} | ${c100.totalBytes} | ${c100.complete} |
| 1.15 | ${c115.audioSec.toFixed(2)} | ${c115.totalBytes} | ${c115.complete} |

Ratio 0.85 / 1.0 = ${(c085.audioSec / c100.audioSec).toFixed(3)} (expect ~1.18 if 0.85 means "0.85× normal rate")
Ratio 1.15 / 1.0 = ${(c115.audioSec / c100.audioSec).toFixed(3)} (expect ~0.87 if 1.15 means "1.15× normal rate")
`;

  const existing = await readFile(new URL('../docs/_planning/HUME_PHASE_0.md', import.meta.url), 'utf8');
  await writeFile(new URL('../docs/_planning/HUME_PHASE_0.md', import.meta.url), existing + append, 'utf8');
  console.log('\nAppended to docs/_planning/HUME_PHASE_0.md');
}

main().catch((e) => { console.error(e); process.exit(1); });
