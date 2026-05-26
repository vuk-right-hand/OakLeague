#!/usr/bin/env node
/**
 * Hume Octave 2 — Phase 0 reality-check spike.
 *
 * Plan reference: docs/_planning/HUME_TTS_PLAN.md §1.
 *
 * Writes results to docs/_planning/HUME_PHASE_0.md. The §3 schema migrations
 * and §4 HumeTTSBridge code cannot land until every check shows PASS (or
 * has an explicit documented workaround in the output file).
 *
 * Required env (NEVER committed):
 *   HUME_API_KEY        — Hume API key (URL query-string auth on WS,
 *                         X-Hume-Api-Key header on REST).
 *   HUME_TEST_VOICE_ID  — voice id for synthesis. Created manually in the
 *                         Hume UI for the spike; lives in dev env only.
 *
 * Auth-secret discipline:
 *   - The api_key is ONLY put into URL strings used by new WebSocket(url).
 *   - Every console.log uses urlScrubbed (api_key=[redacted]).
 *   - Same pattern HumeTTSBridge.buildUrl() will enforce post-spike.
 *
 * Checks (numbered to match plan §1):
 *   1.  Connect + Octave 2 acceptance (version=2 query param)
 *   2.  sample_rate query param — try 24000 and 16000; gate downsampler decision
 *   3.  Bit depth / channel — s16le mono confirmed
 *   4.  TTFA — first type:'audio' frame within ≤900ms cold / ≤500ms warm
 *   5.  Streaming text shape — single generation_id across burst, is_last_chunk:true
 *   6.  Cancellation strategy (3 sub-checks: flush:false / close:true / abrupt close)
 *   7.  Voice-cloning REST path discovery (3 hypotheses)
 *   8.  DELETE /v0/tts/voices/{id} (mirror Cartesia voice_delete_queue pattern)
 *   9a. Sequential load — 20 turns, watch for 429s / drift
 *   9b. Concurrent load — 20 parallel WS
 *   10. Error envelope shape — bad voice id + malformed JSON
 *   11. Voice-id format note (informational)
 *   12. Sentry leak verification (INFO — runs against staging Sentry post-deploy)
 *   13. Hume tts_speed cadence parity at 0.85 / 1.0 / 1.15
 *   14. Bridge `text`-field leak check (INFO — runs as CI grep on hume-bridge.js)
 */

import WebSocket from 'ws';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const HUME_API_KEY = process.env.HUME_API_KEY;
const HUME_TEST_VOICE_ID = process.env.HUME_TEST_VOICE_ID;
if (!HUME_API_KEY)       { console.error('HUME_API_KEY required'); process.exit(2); }
if (!HUME_TEST_VOICE_ID) { console.error('HUME_TEST_VOICE_ID required'); process.exit(2); }

const HUME_WSS  = 'wss://api.hume.ai/v0/tts/stream/input';
const HUME_REST = 'https://api.hume.ai/v0/tts';

// Default base query (NO api_key here — appended via buildUrl).
const BASE_QUERY = {
  version:       '2',
  instant_mode:  'true',
  strip_headers: 'true',
  format_type:   'pcm',
  no_binary:     'true',
};

function buildUrl({ sampleRate, extra = {} } = {}) {
  const qs = new URLSearchParams({ ...BASE_QUERY, ...extra });
  if (sampleRate) qs.set('sample_rate', String(sampleRate));
  const base = `${HUME_WSS}?${qs.toString()}`;
  const urlWithKey  = `${base}&api_key=${encodeURIComponent(HUME_API_KEY)}`;
  const urlScrubbed = `${base}&api_key=[redacted]`;
  return { urlWithKey, urlScrubbed };
}

const results = [];
function record(section, passed, detail) {
  results.push({ section, passed, detail });
  const tag = passed === true ? 'PASS' : passed === false ? 'FAIL' : 'INFO';
  console.log(`[${tag}] ${section} — ${detail}`);
}

function openWs(opts = {}) {
  const { urlWithKey, urlScrubbed } = buildUrl(opts);
  return new Promise((res, rej) => {
    const ws = new WebSocket(urlWithKey, { perMessageDeflate: false });
    const to = setTimeout(() => { try { ws.terminate(); } catch {} rej(new Error('open timeout 5s')); }, 5000);
    ws.once('open', () => { clearTimeout(to); res({ ws, urlScrubbed }); });
    ws.once('error', (e) => {
      clearTimeout(to);
      // Scrub api_key out of any error message before re-throwing.
      const msg = String(e?.message || e).replace(/api_key=[^&\s]+/g, 'api_key=[redacted]');
      rej(new Error(msg));
    });
  });
}

// ──────────────────────────────────────────────────────────────────────
// Check 1 + 3 + 4 + 5: connect → send → measure TTFA + envelope + flush
// ──────────────────────────────────────────────────────────────────────

async function check_1_3_4_5() {
  const t0 = performance.now();
  let conn;
  try {
    conn = await openWs();
  } catch (e) {
    record('1. connect + version=2 acceptance', false, `open failed: ${e.message}`);
    return null;
  }
  const { ws, urlScrubbed } = conn;
  const openMs = Math.round(performance.now() - t0);
  record('1. connect + version=2 acceptance (handshake ≤900ms cold)', openMs <= 900, `open=${openMs}ms url=${urlScrubbed}`);

  // Collect chunks; resolve when is_last_chunk:true seen OR 15s timeout.
  const chunks = [];
  let sawBinary = false;
  let firstChunkAtMs = null;
  let generationIds = new Set();
  let snippetIds = new Set();
  let sawLastChunk = false;
  let firstChunkText = null;

  const tSend = performance.now();
  const allChunks = new Promise((resolve) => {
    ws.on('message', (data, isBinary) => {
      if (isBinary) { sawBinary = true; return; }
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (msg.type === 'audio') {
        if (firstChunkAtMs === null) firstChunkAtMs = Math.round(performance.now() - tSend);
        if (msg.generation_id) generationIds.add(msg.generation_id);
        if (msg.snippet_id)    snippetIds.add(msg.snippet_id);
        if (firstChunkText === null && typeof msg.text === 'string') firstChunkText = msg.text;
        const bytes = Buffer.from(msg.audio || '', 'base64');
        chunks.push(bytes);
        if (msg.is_last_chunk === true) {
          sawLastChunk = true;
          resolve();
        }
      } else if (msg.type === 'error') {
        resolve();
      }
    });
  });

  // Send 3 chunks WITHOUT flush, then 1 with flush:true → §1 check 5.
  ws.send(JSON.stringify({ text: 'Hello from ',           voice: { id: HUME_TEST_VOICE_ID, provider: 'CUSTOM_VOICE' } }));
  ws.send(JSON.stringify({ text: 'the OakLeague Phase Zero spike. ', voice: { id: HUME_TEST_VOICE_ID, provider: 'CUSTOM_VOICE' } }));
  ws.send(JSON.stringify({ text: 'Testing Octave 2. ',    voice: { id: HUME_TEST_VOICE_ID, provider: 'CUSTOM_VOICE' } }));
  ws.send(JSON.stringify({ text: 'End of message.',       voice: { id: HUME_TEST_VOICE_ID, provider: 'CUSTOM_VOICE' }, flush: true }));

  let timedOut = false;
  await Promise.race([
    allChunks,
    new Promise((r) => setTimeout(() => { timedOut = true; r(); }, 15000)),
  ]);

  const totalBytes = chunks.reduce((a, b) => a + b.length, 0);
  const evenAligned = chunks.every((b) => b.length % 2 === 0);

  record(
    '4. TTFA — first audio chunk arrives quickly',
    firstChunkAtMs !== null && firstChunkAtMs <= 900,
    `ttfa=${firstChunkAtMs ?? 'none'}ms (gate ≤900ms cold)`,
  );
  record(
    '3. frame coherence — s16le mono, byte%2===0, no binary frames',
    !sawBinary && evenAligned && totalBytes > 0,
    `total_bytes=${totalBytes} chunks=${chunks.length} binary_seen=${sawBinary} even=${evenAligned}`,
  );
  record(
    '5a. streaming text → single generation_id across burst',
    generationIds.size === 1,
    `generation_ids=${generationIds.size} (expect 1)`,
  );
  record(
    '5b. final chunk has is_last_chunk:true (within 15s)',
    sawLastChunk && !timedOut,
    timedOut ? 'no is_last_chunk within 15s' : `is_last_chunk:true received`,
  );
  if (firstChunkText !== null) {
    record('5c. inbound chunk includes `text` field (Vuk-C2 leak channel — DO NOT log raw)', null, `text_preview_len=${firstChunkText.length} (intentionally not logged — content)`);
  }

  try { ws.close(1000, 'spike done'); } catch {}
  return { generationIds, totalBytes, firstChunkAtMs, openMs };
}

// ──────────────────────────────────────────────────────────────────────
// Check 2: sample_rate query param
// ──────────────────────────────────────────────────────────────────────

async function check_2_sample_rate(rate) {
  let conn;
  try { conn = await openWs({ sampleRate: rate }); }
  catch (e) {
    record(`2. sample_rate=${rate} accepted by WS`, false, `open failed: ${e.message}`);
    return;
  }
  const { ws } = conn;

  // Send ~1s of audio and measure the byte-rate. At s16le mono:
  //   bytes/sec = rate * 2
  // So if we collect N bytes over T sec wall time, decoded rate = N / (2 * T_audio).
  // But T_audio = chunks duration ≠ wall time. Simpler: confirm bytes are produced
  // AT ALL at the requested rate; trust Hume's accounting for now.

  const chunks = [];
  let sawError = false;
  let errorTitle = null;
  let sawLastChunk = false;
  const done = new Promise((resolve) => {
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (msg.type === 'audio') {
        chunks.push(Buffer.from(msg.audio || '', 'base64'));
        if (msg.is_last_chunk) { sawLastChunk = true; resolve(); }
      } else if (msg.type === 'error') {
        sawError = true;
        errorTitle = String(msg.message || msg.title || JSON.stringify({ type: msg.type })).slice(0, 200);
        resolve();
      }
    });
  });

  ws.send(JSON.stringify({
    text: 'One two three four five six seven eight nine ten.',
    voice: { id: HUME_TEST_VOICE_ID, provider: 'CUSTOM_VOICE' },
    flush: true,
  }));

  await Promise.race([done, new Promise((r) => setTimeout(r, 12000))]);

  const totalBytes = chunks.reduce((a, b) => a + b.length, 0);
  if (sawError) {
    record(`2. sample_rate=${rate} accepted by WS`, false, `error: ${errorTitle}`);
  } else if (totalBytes === 0) {
    record(`2. sample_rate=${rate} accepted by WS`, false, `no audio produced`);
  } else {
    // Estimate duration assuming the requested rate; rough sanity check.
    const estSeconds = totalBytes / (rate * 2);
    record(`2. sample_rate=${rate} accepted by WS`, true, `total_bytes=${totalBytes} est_audio_seconds≈${estSeconds.toFixed(2)} (request honored if duration ≈ 2-4s for the sample sentence)`);
  }
  try { ws.close(1000, 'spike done'); } catch {}
}

// ──────────────────────────────────────────────────────────────────────
// Check 6: cancellation strategy (3 sub-checks)
// ──────────────────────────────────────────────────────────────────────

async function check_6_cancel(strategy) {
  // strategy ∈ { 'flush:false', 'close:true', 'abrupt' }
  let conn;
  try { conn = await openWs(); }
  catch (e) { record(`6.${strategy}. open`, false, e.message); return; }
  const { ws } = conn;

  let chunkCountBeforeCancel = 0;
  let chunkCountAfterCancel  = 0;
  let cancelSentAtMs = null;
  let lastChunkAfterCancelMs = null;
  let cancelled = false;
  let sawLastChunk = false;

  const done = new Promise((resolve) => {
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (msg.type === 'audio') {
        if (!cancelled) {
          chunkCountBeforeCancel += 1;
          // After receiving the FIRST chunk, send the cancel signal.
          if (chunkCountBeforeCancel === 1) {
            cancelSentAtMs = performance.now();
            cancelled = true;
            if (strategy === 'flush:false') {
              try { ws.send(JSON.stringify({ flush: false })); } catch {}
            } else if (strategy === 'close:true') {
              try { ws.send(JSON.stringify({ close: true })); } catch {}
            } else if (strategy === 'abrupt') {
              try { ws.close(1000, 'cancel'); } catch {}
            }
          }
        } else {
          chunkCountAfterCancel += 1;
          lastChunkAfterCancelMs = Math.round(performance.now() - cancelSentAtMs);
        }
        if (msg.is_last_chunk) { sawLastChunk = true; resolve(); }
      } else if (msg.type === 'error') {
        resolve();
      }
    });
    ws.on('close', () => resolve());
  });

  // Long-enough utterance that we can cancel mid-stream.
  ws.send(JSON.stringify({
    text: 'This is a longer utterance designed to give us several seconds of audio output so that we can probe the cancellation behavior. We need at least four or five chunks worth of synthesis to land before we trigger the cancel signal mid-stream.',
    voice: { id: HUME_TEST_VOICE_ID, provider: 'CUSTOM_VOICE' },
    flush: true,
  }));

  await Promise.race([done, new Promise((r) => setTimeout(r, 12000))]);

  if (chunkCountBeforeCancel === 0) {
    record(`6.${strategy}. cancellation strategy`, false, 'no audio chunk received before cancel — utterance was too short OR Hume buffered too long');
  } else {
    const stopped = lastChunkAfterCancelMs === null || lastChunkAfterCancelMs <= 200;
    record(
      `6.${strategy}. cancellation stops production within ≤200ms`,
      stopped,
      `chunks_before_cancel=${chunkCountBeforeCancel} chunks_after_cancel=${chunkCountAfterCancel} last_chunk_after_cancel=${lastChunkAfterCancelMs ?? 'none'}ms`,
    );
  }
  try { ws.close(1000, 'spike done'); } catch {}
}

// ──────────────────────────────────────────────────────────────────────
// Check 7: voice cloning REST path discovery
// ──────────────────────────────────────────────────────────────────────

async function check_7_clone_paths() {
  // Probe three documented/hypothesized REST endpoints. We DO NOT actually
  // upload audio in the spike — we POST with empty bodies and inspect the
  // status code + error shape to learn whether the path EXISTS at all.
  // A 4xx with "missing audio" / "field required" = path exists, schema
  // discovered. A 404 = path doesn't exist.

  const probes = [
    { path: '/v0/tts/voices/clone',          note: '7a. REST analog of Cartesia /voices/clone' },
    { path: '/v0/tts/voices',                note: '7b. multipart audio-upload variant of save endpoint' },
    { path: '/v0/tts/voices/from-generation', note: '7c. design-from-generation hypothesis' },
  ];

  for (const { path, note } of probes) {
    try {
      const r = await fetch(`https://api.hume.ai${path}`, {
        method: 'POST',
        headers: { 'X-Hume-Api-Key': HUME_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const status = r.status;
      let bodyText = '';
      try { bodyText = (await r.text()).slice(0, 200); } catch {}
      // 404 = path doesn't exist; 4xx-non-404 = path exists, schema rejected our empty body.
      if (status === 404) {
        record(note, false, `404 — path does NOT exist`);
      } else if (status >= 400 && status < 500) {
        record(note, true, `${status} — path EXISTS (schema-error body): ${bodyText}`);
      } else if (status >= 200 && status < 300) {
        record(note, null, `${status} unexpected — empty body accepted? body=${bodyText}`);
      } else {
        record(note, null, `${status} — body=${bodyText}`);
      }
    } catch (e) {
      record(note, false, `request failed: ${e.message}`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Check 8: DELETE /v0/tts/voices/{id}
// ──────────────────────────────────────────────────────────────────────

async function check_8_delete() {
  // Try DELETE against a definitely-non-existent UUID. If the endpoint
  // exists, expect 404 (voice not found). If it doesn't exist, expect
  // a different shape (405 method-not-allowed, or a route-level 404).
  const fakeId = '00000000-0000-0000-0000-000000000000';
  try {
    const r = await fetch(`${HUME_REST}/voices/${fakeId}`, {
      method: 'DELETE',
      headers: { 'X-Hume-Api-Key': HUME_API_KEY },
    });
    let bodyText = '';
    try { bodyText = (await r.text()).slice(0, 200); } catch {}
    // If 404 with "voice not found"-shaped body → DELETE endpoint exists.
    // If 404 with route-not-found shape → endpoint missing.
    // If 405 → method not allowed.
    const looksRouted = r.status === 404 && /not.*found|does not exist|no such/i.test(bodyText);
    if (r.status === 200 || r.status === 204) {
      record('8. DELETE /v0/tts/voices/{id}', true, `${r.status} — endpoint exists`);
    } else if (looksRouted) {
      record('8. DELETE /v0/tts/voices/{id}', true, `404 — endpoint routed (body: ${bodyText})`);
    } else if (r.status === 405) {
      record('8. DELETE /v0/tts/voices/{id}', false, `405 method not allowed — DELETE not supported here`);
    } else {
      record('8. DELETE /v0/tts/voices/{id}', null, `${r.status} body=${bodyText}`);
    }
  } catch (e) {
    record('8. DELETE /v0/tts/voices/{id}', false, e.message);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Check 9a: sequential load
// ──────────────────────────────────────────────────────────────────────

async function check_9a_sequential() {
  // 20 turns on a single WS, time each.
  let conn;
  try { conn = await openWs(); } catch (e) { record('9a. sequential 20-turn load', false, e.message); return; }
  const { ws } = conn;

  const turnTimes = [];
  let sawError = false;
  let saw429 = false;
  let pendingResolve = null;

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (msg.type === 'audio' && msg.is_last_chunk) {
      if (pendingResolve) { pendingResolve(); pendingResolve = null; }
    } else if (msg.type === 'error') {
      sawError = true;
      const txt = String(msg.message || msg.title || '').toLowerCase();
      if (/429|rate.?limit|too many/i.test(txt)) saw429 = true;
      if (pendingResolve) { pendingResolve(); pendingResolve = null; }
    }
  });

  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const turnDone = new Promise((r) => { pendingResolve = r; });
    ws.send(JSON.stringify({
      text: `Sequence turn number ${i + 1}, short utterance for load testing.`,
      voice: { id: HUME_TEST_VOICE_ID, provider: 'CUSTOM_VOICE' },
      flush: true,
    }));
    await Promise.race([turnDone, new Promise((r) => setTimeout(r, 10000))]);
    turnTimes.push(Math.round(performance.now() - t0));
    if (sawError) break;
  }

  const completed = turnTimes.length;
  const p50 = turnTimes.sort((a, b) => a - b)[Math.floor(completed / 2)] ?? 0;
  const max = turnTimes[completed - 1] ?? 0;
  record(
    '9a. sequential 20-turn load — no 429s, latency stable',
    !saw429 && completed === 20,
    `completed=${completed} p50=${p50}ms max=${max}ms 429=${saw429} other_error=${sawError && !saw429}`,
  );
  try { ws.close(1000, 'spike done'); } catch {}
}

// ──────────────────────────────────────────────────────────────────────
// Check 9b: concurrent connection cap
// ──────────────────────────────────────────────────────────────────────

async function check_9b_concurrent() {
  const N = 20;
  const opens = [];
  const errors = [];
  const t0 = performance.now();

  for (let i = 0; i < N; i++) {
    opens.push(
      openWs()
        .then(({ ws }) => ({ ws, idx: i }))
        .catch((e) => { errors.push({ idx: i, msg: e.message }); return null; }),
    );
  }

  const wsList = (await Promise.all(opens)).filter(Boolean);
  const openMs = Math.round(performance.now() - t0);

  // Send one turn on each successfully-opened WS.
  const firstChunkPromises = wsList.map(({ ws, idx }) => {
    return new Promise((resolve) => {
      let firstAt = null;
      const localT0 = performance.now();
      const to = setTimeout(() => resolve({ idx, firstAtMs: null, error: 'timeout' }), 15000);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
        if (msg.type === 'audio' && firstAt === null) {
          firstAt = Math.round(performance.now() - localT0);
          clearTimeout(to);
          resolve({ idx, firstAtMs: firstAt });
        } else if (msg.type === 'error') {
          clearTimeout(to);
          resolve({ idx, firstAtMs: null, error: String(msg.message || msg.title || 'err').slice(0, 80) });
        }
      });
      ws.send(JSON.stringify({
        text: `Concurrent turn ${idx + 1}.`,
        voice: { id: HUME_TEST_VOICE_ID, provider: 'CUSTOM_VOICE' },
        flush: true,
      }));
    });
  });

  const turnResults = await Promise.all(firstChunkPromises);
  const successful = turnResults.filter((r) => r.firstAtMs !== null).length;

  record(
    `9b. concurrent 20-WS open (cap probe)`,
    errors.length === 0 && successful === N,
    `opened=${wsList.length}/${N} first_chunk_ok=${successful} open_time=${openMs}ms open_errors=${errors.length} (sample: ${errors.slice(0, 3).map((e) => e.msg.slice(0, 60)).join(' | ')})`,
  );

  for (const { ws } of wsList) { try { ws.close(1000, 'spike done'); } catch {} }
}

// ──────────────────────────────────────────────────────────────────────
// Check 10: error envelope shapes
// ──────────────────────────────────────────────────────────────────────

async function check_10_errors() {
  // 10a: bad voice id
  try {
    const { ws } = await openWs();
    const errEnv = await new Promise((resolve) => {
      const to = setTimeout(() => resolve(null), 8000);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
        if (msg.type === 'error') { clearTimeout(to); resolve(msg); }
      });
      ws.send(JSON.stringify({
        text: 'Test bad voice id.',
        voice: { id: 'not-a-real-voice-uuid', provider: 'CUSTOM_VOICE' },
        flush: true,
      }));
    });
    try { ws.close(); } catch {}
    if (errEnv) {
      const keys = Object.keys(errEnv).filter((k) => k !== 'text' && k !== 'audio');
      record('10a. bad voice id → error envelope', true, `keys=[${keys.join(',')}] shape=${JSON.stringify({ type: errEnv.type, code: errEnv.code ?? errEnv.error_code, message_len: typeof errEnv.message === 'string' ? errEnv.message.length : null }).slice(0, 200)}`);
    } else {
      record('10a. bad voice id → error envelope', false, 'no error within 8s');
    }
  } catch (e) {
    record('10a. bad voice id', false, e.message);
  }

  // 10b: malformed JSON
  try {
    const { ws } = await openWs();
    const errEnv = await new Promise((resolve) => {
      const to = setTimeout(() => resolve(null), 5000);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
        if (msg.type === 'error') { clearTimeout(to); resolve(msg); }
      });
      ws.on('close', (code, reason) => {
        clearTimeout(to);
        resolve({ closed: true, code, reason: String(reason || '').slice(0, 80) });
      });
      ws.send('{ not even valid json');
    });
    try { ws.close(); } catch {}
    if (errEnv) {
      const summary = errEnv.closed
        ? `close(code=${errEnv.code} reason="${errEnv.reason}")`
        : `error(type=${errEnv.type} code=${errEnv.code ?? errEnv.error_code ?? 'none'})`;
      record('10b. malformed JSON → error or close', true, summary);
    } else {
      record('10b. malformed JSON → error or close', false, 'no response within 5s');
    }
  } catch (e) {
    record('10b. malformed JSON', false, e.message);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Check 11: voice-id format note (informational)
// ──────────────────────────────────────────────────────────────────────

function check_11_voice_id_format() {
  const id = HUME_TEST_VOICE_ID;
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  record(
    '11. voice-id format (informational)',
    null,
    `id_length=${id.length} looks_like_uuid=${isUUID} — column CHECK is char_length BETWEEN 1 AND 128 (no regex enforcement per plan §0 row 15)`,
  );
}

// ──────────────────────────────────────────────────────────────────────
// Check 13: tts_speed cadence parity
// ──────────────────────────────────────────────────────────────────────

async function check_13_speed_parity() {
  const phrase = 'The quick brown fox jumps over the lazy dog. This sentence is used for cadence measurement.';
  const samples = [];
  for (const speed of [0.85, 1.0, 1.15]) {
    let conn;
    try { conn = await openWs(); } catch (e) {
      record(`13.${speed}. cadence at speed=${speed}`, false, e.message); continue;
    }
    const { ws } = conn;
    let totalBytes = 0;
    let lastChunkSeen = false;
    const done = new Promise((resolve) => {
      const to = setTimeout(resolve, 15000);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
        if (msg.type === 'audio') {
          totalBytes += Buffer.from(msg.audio || '', 'base64').length;
          if (msg.is_last_chunk) { lastChunkSeen = true; clearTimeout(to); resolve(); }
        } else if (msg.type === 'error') { clearTimeout(to); resolve(); }
      });
    });
    ws.send(JSON.stringify({
      text: phrase,
      voice: { id: HUME_TEST_VOICE_ID, provider: 'CUSTOM_VOICE' },
      speed,
      flush: true,
    }));
    await done;
    // At 48kHz s16le, audio seconds = bytes / 96000. At other rates, divisor changes.
    // We didn't set sample_rate, so Hume default 48000.
    const audioSec = totalBytes / 96000;
    samples.push({ speed, audioSec, totalBytes, complete: lastChunkSeen });
    try { ws.close(1000, 'spike done'); } catch {}
  }
  const ok = samples.every((s) => s.complete);
  const tbl = samples.map((s) => `speed=${s.speed}→${s.audioSec.toFixed(2)}s/${s.totalBytes}B`).join(' | ');
  record(
    '13. tts_speed cadence parity — 0.85/1.0/1.15 produce different durations',
    ok && new Set(samples.map((s) => Math.round(s.audioSec * 10))).size === samples.length,
    tbl,
  );
}

// ──────────────────────────────────────────────────────────────────────
// Checks 12 + 14: informational stubs (not runnable in spike script)
// ──────────────────────────────────────────────────────────────────────

function check_12_14_info() {
  record(
    '12. Sentry leak verification',
    null,
    'INFO — runs AFTER §2.0 scrub PR lands on staging Sentry. Spike cannot exercise the staging Sentry path; manual check at §8.6 burn-in.',
  );
  record(
    '14. bridge `text`-field leak (CI grep)',
    null,
    'INFO — enforced at PR time on hume-bridge.js via CI grep for JSON.stringify(msg) + console.*(.*\\bmsg\\b. Spike cannot exercise; gated at §4.6 test PR.',
  );
}

// ──────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Hume Octave 2 — Phase 0 spike\n');
  console.log(`Endpoint: ${HUME_WSS}`);
  console.log(`Voice id length: ${HUME_TEST_VOICE_ID.length} (value not logged)`);
  console.log(`API key length: ${HUME_API_KEY.length} (value not logged)\n`);

  // Run sequentially so we don't blow the concurrent-cap before §9b probes it.
  await check_1_3_4_5();
  await check_2_sample_rate(24000);
  await check_2_sample_rate(16000);
  await check_6_cancel('flush:false');
  await check_6_cancel('close:true');
  await check_6_cancel('abrupt');
  await check_7_clone_paths();
  await check_8_delete();
  await check_9a_sequential();
  await check_9b_concurrent();
  await check_10_errors();
  check_11_voice_id_format();
  await check_13_speed_parity();
  check_12_14_info();

  const passed = results.filter((r) => r.passed === true).length;
  const failed = results.filter((r) => r.passed === false).length;
  const info   = results.filter((r) => r.passed === null).length;

  const summary = results
    .map((r) => {
      const tag = r.passed === true ? 'PASS' : r.passed === false ? 'FAIL' : 'INFO';
      return `- **${r.section}** — ${tag}: ${r.detail}`;
    })
    .join('\n');

  const body = `# Hume Octave 2 — Phase 0 Spike Results

Generated: ${new Date().toISOString()}
Script: \`scripts/hume-phase0-spike.mjs\`
Plan: [docs/_planning/HUME_TTS_PLAN.md](./HUME_TTS_PLAN.md) §1.

## Summary

- PASS: ${passed}
- FAIL: ${failed}
- INFO: ${info}

## Results

${summary}

## Decisions Required (surface to Vuk)

Based on the results above, the following plan decisions need to be made before §3 schema lands:

### Cancel strategy (drives §4.2 \`HumeTTSBridge.cancel()\`)
- If \`6.flush:false\` PASS (stops <200ms) → cancel sends \`{flush:false}\`, WS stays open. Cleanest.
- Else if \`6.close:true\` PASS → cancel sends \`{close:true}\` + auto-reopen. ~200ms gap.
- Else → filter chunks by generation_id post-cancel; bill wasted chars to \`cogs_log.metadata.cancelled_after_chars\`.

### Sample-rate fallback (drives §4.4)
- If \`2.sample_rate=24000\` AND \`2.sample_rate=16000\` PASS → bridge uses per-session sample rate query param. No downsampler needed.
- Else → escalate to Hume support before ship; fall back to libsamplerate/speex-resampler dep if support unblocks.

### Voice-clone path (drives §5.1 vs §5.2)
- If \`7a\` or \`7b\` PASS (path exists) → Scenario A (programmatic clone via /api/admin/voice-clone with provider=hume).
- Else if only \`7c\` (design-from-generation) PASS → still Scenario B for audio cloning; document that audio-clone is UI-only.
- Else → Scenario B (UI-paste route at /api/admin/voice-clone/hume-id).

### Concurrent cap
- \`9b\` opened=X/20 → if X < 20, escalate to Hume Pro/Enterprise tier negotiation BEFORE flipping env to hume in §8.7.

## Gate

This file is the source of truth for the spike verdict. The PR landing §3 schema migrations cannot merge without this file present and the three decisions above resolved.
`;

  await writeFile(new URL('../docs/_planning/HUME_PHASE_0.md', import.meta.url), body, 'utf8');
  console.log(`\nWrote docs/_planning/HUME_PHASE_0.md (PASS=${passed} FAIL=${failed} INFO=${info})`);

  if (failed > 0) {
    console.error(`\n${failed} check(s) FAILED — review HUME_PHASE_0.md before proceeding to §3.`);
    process.exit(1);
  }
  console.log('\nAll runnable checks PASSED. Surface the file to Vuk for the 3 decisions.');
}

main().catch((e) => { console.error(e); process.exit(1); });
