#!/usr/bin/env node
// Phase 0 verifier for HeyGen LiveAvatar Lite.
//
// Two runs share this script:
//   Run A — sandbox (default): Wayne avatar, is_sandbox:true, FREE, ~75s wall-clock.
//   Run B — prod (--prod flag): one stock public avatar, ~$0.60–$1 budget, ~5min.
//
// What we verify:
//   - REST chain: /v1/sessions/token → /v1/sessions/start → /v1/sessions/keep-alive → /v1/sessions/stop
//   - WS wire: agent.speak (base64 PCM16-24k chunks) + agent.speak_end + agent.interrupt
//   - Server inbound vocabulary (raw tap — log every type, not just SDK-handled ones)
//   - Idempotent stop, keep-alive cadence, barge-in (overlapping event_id) semantics
//   - Three chunking strategies (1s monolith / 400ms+1s SDK-d.ts spec / 20ms SDK-js spec)
//
// What we DO NOT verify (Phase 0.5 in browser):
//   - LiveKit media subscribe / first-rendered-video-frame latency
//   - Custom avatar creation
//
// Usage:
//   $env:LIVEAVATAR_API_KEY="lk_xxx"; node scripts/heygen-phase0-verify.mjs
//   $env:LIVEAVATAR_API_KEY="lk_xxx"; node scripts/heygen-phase0-verify.mjs --prod
//
// Output: stdout (paste back) + writes docs/_planning/PHASE_0_HEYGEN.md.
//
// Safety nets baked in (post-audit):
//   - 7-min wall-clock watchdog independent of try/finally
//   - SIGINT / uncaughtException / unhandledRejection → forceStop
//   - try/finally wrapping all session-bearing steps
//   - Hard-fail if response carries a billable/production marker when sandbox expected
//   - global.fetch monkey-patch logs every URL the script hits (capture keep-alive path)

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_KEY = process.env.LIVEAVATAR_API_KEY;
const IS_PROD_RUN = process.argv.includes('--prod');
const KEEP_VERBOSE = process.env.KEEP_VERBOSE === '1';

if (!API_KEY) {
  console.error('FATAL: LIVEAVATAR_API_KEY env var unset.');
  console.error('Set it in .env.local or export it before running.');
  process.exit(1);
}

const API_BASE = 'https://api.liveavatar.com';
const WAYNE_AVATAR_ID = 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a'; // sandbox-only avatar per docs
const WATCHDOG_MS = 7 * 60 * 1000; // 7 minutes — fires on uncaught throw or hang
const __dirname = dirname(fileURLToPath(import.meta.url));
// Raw run dump path — the curated source-of-truth doc is PHASE_0_HEYGEN.md
// (hand-maintained findings synthesis). The script writes its raw report
// here so future re-runs don't clobber the curated doc.
const REPORT_PATH = resolve(__dirname, '..', 'docs', '_planning', 'PHASE_0_HEYGEN_RAW.md');

// ---- Cleanup state (mutated as we go; forceStop reads it) ----
const cleanupState = {
  activeSessionId: null,
  activeSessionToken: null,
  ws: null,
  watchdogTimer: null,
  alreadyStopped: false,
};

// ---- Run log (everything we want in PHASE_0_HEYGEN.md) ----
const runLog = {
  startedAt: new Date().toISOString(),
  mode: IS_PROD_RUN ? 'prod' : 'sandbox',
  steps: [], // { label, status, body, headers, t_ms_since_start, notes }
  fetchCalls: [], // every URL fetch hits (audit C3)
  wsInboundTypes: new Set(), // every distinct inbound type (audit M3)
  wsInboundFrames: [], // first ~50 frames verbatim
  measurements: {},
  errors: [],
};
const T0 = Date.now();
const since = () => Date.now() - T0;

function log(label, payload) {
  console.log('\n========================================');
  console.log(`[t=${since()}ms] ${label}`);
  console.log('========================================');
  console.log(JSON.stringify(redact(payload), null, 2));
}

// Redact JWT / API key / token values. Keep field names — those tell us
// the contract. Mask values longer than 12 chars in fields whose name
// looks sensitive.
function redact(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/key|secret|token|authorization|password/i.test(k) && typeof v === 'string' && v.length > 12) {
      out[k] = `***REDACTED(${v.length} chars, head=${v.slice(0, 6)})***`;
    } else {
      out[k] = redact(v);
    }
  }
  return out;
}

// Hard-fail guard: scan a response body for billable indicators when
// is_sandbox:true was requested. If anything matches AND looks truthy,
// abort the entire script before we burn anything.
function assertSandboxBilling(body, label) {
  if (IS_PROD_RUN) return; // prod is allowed to be billable
  const blob = JSON.stringify(body);
  const hits = [
    /\"billable\"\s*:\s*true/i,
    /\"is_billable\"\s*:\s*true/i,
    /\"production\"\s*:\s*true/i,
    /\"paid\"\s*:\s*true/i,
    /\"charged\"\s*:\s*true/i,
  ].filter((re) => re.test(blob));
  if (hits.length > 0) {
    console.error(`\n!!!! SANDBOX MISMATCH at ${label}: response contains billable marker.`);
    console.error(`Matches: ${hits.map((r) => r.source).join(', ')}`);
    console.error('Aborting before any further session activity.');
    runLog.errors.push({ label, kind: 'sandbox_billable_mismatch', hits: hits.map((r) => r.source) });
    throw new Error('sandbox-billing-mismatch');
  }
}

// ---- fetch monkey-patch — log every URL we hit (audit C3 round 2) ----
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const recorded = { url: typeof url === 'string' ? url : url.toString(), method: init?.method ?? 'GET', t_ms: since() };
  runLog.fetchCalls.push(recorded);
  if (KEEP_VERBOSE) console.log(`[fetch] ${recorded.method} ${recorded.url}`);
  return originalFetch(url, init);
};

async function readBody(res) {
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: json ?? text };
}

function recordStep(label, result, notes) {
  runLog.steps.push({
    label,
    t_ms: since(),
    status: result.status,
    body: redact(result.body),
    headers: result.headers,
    notes: notes ?? null,
  });
}

// ---- forceStop: idempotent best-effort cleanup. Called from try/finally,
//      SIGINT, uncaughtException, watchdog. Must NOT throw. ----
async function forceStop(reason) {
  if (cleanupState.alreadyStopped) return;
  cleanupState.alreadyStopped = true;
  try {
    if (cleanupState.ws) {
      try { cleanupState.ws.close(1000, 'phase0_force_stop'); } catch { /* swallowed */ }
      cleanupState.ws = null;
    }
    if (cleanupState.activeSessionId && cleanupState.activeSessionToken) {
      console.log(`\n[forceStop reason=${reason}] POST /v1/sessions/stop session=${cleanupState.activeSessionId.slice(0, 8)}...`);
      try {
        const res = await fetch(`${API_BASE}/v1/sessions/stop`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': `Bearer ${cleanupState.activeSessionToken}`,
          },
          body: JSON.stringify({ session_id: cleanupState.activeSessionId, reason: 'USER_CLOSED' }),
        });
        const result = await readBody(res);
        log(`forceStop /v1/sessions/stop (reason=${reason})`, result);
      } catch (e) {
        console.error(`forceStop fetch failed: ${(e && e.message) || e}`);
      }
    }
  } catch (e) {
    console.error(`forceStop unexpected error: ${(e && e.message) || e}`);
  }
}

// Watchdog — guarantees stop fires even on uncaught hang/throw.
cleanupState.watchdogTimer = setTimeout(() => {
  console.error(`\n!!!! WATCHDOG fired at ${WATCHDOG_MS}ms. Force-stopping and exiting.`);
  runLog.errors.push({ label: 'watchdog', t_ms: since() });
  forceStop('watchdog').finally(() => {
    writeReport();
    process.exit(2);
  });
}, WATCHDOG_MS).unref?.();

process.on('SIGINT', () => {
  console.error('\n!!!! SIGINT — force-stopping.');
  forceStop('SIGINT').finally(() => {
    writeReport();
    process.exit(130);
  });
});
process.on('uncaughtException', (e) => {
  console.error(`\n!!!! uncaughtException: ${e?.stack ?? e}`);
  runLog.errors.push({ label: 'uncaughtException', message: e?.message ?? String(e) });
  forceStop('uncaughtException').finally(() => {
    writeReport();
    process.exit(1);
  });
});
process.on('unhandledRejection', (e) => {
  console.error(`\n!!!! unhandledRejection: ${e?.stack ?? e}`);
  runLog.errors.push({ label: 'unhandledRejection', message: e?.message ?? String(e) });
  forceStop('unhandledRejection').finally(() => {
    writeReport();
    process.exit(1);
  });
});

// ---- Audio fixture: 1 second 440Hz tone, PCM16 LE mono @ 24kHz ----
function genTone({ freq = 440, durationMs = 1000, sampleRate = 24000, amplitude = 0.3 } = {}) {
  const n = Math.floor((durationMs / 1000) * sampleRate);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * amplitude * 32767);
    buf.writeInt16LE(sample, i * 2);
  }
  return buf; // raw PCM16 LE
}

// Decode a JWT payload (claims). Used to inspect livekit_client_token.
function decodeJwtClaims(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return { error: 'not a 3-part JWT' };
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims;
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

// ---- WebSocket helper (native Node WebSocket, no deps) ----
async function openWs(wsUrl) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('Native WebSocket missing. Need Node 22+ (script tested on Node 24).');
  }
  return new Promise((resolveOpen, rejectOpen) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => rejectOpen(new Error(`WS open timeout to ${wsUrl}`)), 15000);
    ws.addEventListener('open', () => {
      clearTimeout(timeout);
      console.log(`[t=${since()}ms] WS open`);
      resolveOpen(ws);
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(timeout);
      rejectOpen(new Error(`WS error: ${e?.message ?? 'unknown'}`));
    });
  });
}

function attachWsTap(ws, label) {
  ws.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : '<binary>';
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* binary frame */ }
    const type = parsed?.type ?? '<no-type>';
    runLog.wsInboundTypes.add(type);
    if (runLog.wsInboundFrames.length < 50) {
      runLog.wsInboundFrames.push({ t_ms: since(), label, type, frame: parsed ?? raw.slice(0, 200) });
    }
    if (KEEP_VERBOSE) console.log(`[ws-in t=${since()}ms ${label}] ${raw.slice(0, 300)}`);
  });
  ws.addEventListener('close', (e) => {
    console.log(`[ws-close t=${since()}ms ${label}] code=${e.code} reason="${e.reason}" wasClean=${e.wasClean}`);
    runLog.wsInboundFrames.push({ t_ms: since(), label, type: '<close>', frame: { code: e.code, reason: e.reason, wasClean: e.wasClean } });
  });
}

function uuid4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Send one utterance. Optionally skip the trailing speak_end (barge-in test).
function sendUtterance(ws, { eventId, pcmChunks, sendSpeakEnd = true, label = 'utt' }) {
  const sendStartMs = since();
  for (const chunk of pcmChunks) {
    ws.send(JSON.stringify({
      type: 'agent.speak',
      event_id: eventId,
      audio: chunk.toString('base64'),
    }));
  }
  if (sendSpeakEnd) {
    ws.send(JSON.stringify({ type: 'agent.speak_end', event_id: eventId }));
  }
  console.log(`[utt-send t=${since()}ms ${label}] event_id=${eventId} chunks=${pcmChunks.length} speak_end=${sendSpeakEnd}`);
  return { eventId, sendStartMs };
}

function chunkPcm(pcmBuf, strategy) {
  // strategy: 'monolith' | 'sdk_dts' | 'sdk_js_20ms'
  if (strategy === 'monolith') return [pcmBuf];
  if (strategy === 'sdk_dts') {
    // 400ms first chunk = 19200 bytes, 1000ms subsequent = 48000 bytes
    const out = [];
    let offset = 0;
    if (pcmBuf.length > 19200) {
      out.push(pcmBuf.subarray(0, 19200));
      offset = 19200;
    }
    while (offset < pcmBuf.length) {
      out.push(pcmBuf.subarray(offset, offset + 48000));
      offset += 48000;
    }
    return out;
  }
  if (strategy === 'sdk_js_20ms') {
    // 20ms = 960 bytes
    const out = [];
    for (let i = 0; i < pcmBuf.length; i += 960) {
      out.push(pcmBuf.subarray(i, i + 960));
    }
    return out;
  }
  throw new Error(`unknown strategy ${strategy}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for an inbound event matching predicate, or timeout. Records the
// match timestamp into runLog.measurements under measurementKey.
//
// CORRELATION KEY = task.id, NOT event_id. Verified in A: server assigns a
// fresh event_id to every inbound frame; task.id stays stable across the
// audio_buffer_appended → audio_buffer_committed → speak_started → speak_ended
// chain for one utterance. The first inbound `agent.audio_buffer_appended`
// after we send `agent.speak` is the carrier of our utterance's task.id.
function waitForInbound(ws, predicate, { timeoutMs = 5000, measurementKey, label }) {
  return new Promise((resolveWait) => {
    const t0 = since();
    const onMessage = (event) => {
      const raw = typeof event.data === 'string' ? event.data : '';
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* */ }
      if (parsed && predicate(parsed)) {
        const elapsed = since() - t0;
        if (measurementKey) runLog.measurements[measurementKey] = { elapsed_ms: elapsed, t_at: since(), match: parsed };
        ws.removeEventListener('message', onMessage);
        if (timer) clearTimeout(timer);
        console.log(`[wait-match t=${since()}ms ${label}] ${measurementKey} elapsed=${elapsed}ms type=${parsed.type} task.id=${parsed.task?.id?.slice(0,8) ?? 'n/a'}`);
        resolveWait({ matched: true, elapsed, parsed });
      }
    };
    ws.addEventListener('message', onMessage);
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      console.log(`[wait-timeout t=${since()}ms ${label}] ${measurementKey} after ${timeoutMs}ms`);
      if (measurementKey) runLog.measurements[measurementKey] = { elapsed_ms: null, timed_out: true };
      resolveWait({ matched: false, elapsed: timeoutMs });
    }, timeoutMs);
  });
}

// Send utterance + wait for our task.id to surface on the first
// audio_buffer_appended frame. Returns the task.id so subsequent waits
// (speak_started, speak_ended, interrupt-ack) can correlate.
async function sendUtteranceAndCaptureTaskId(ws, { eventId, pcmChunks, sendSpeakEnd = true, label = 'utt' }) {
  const taskIdPromise = waitForInbound(
    ws,
    (m) => m.type === 'agent.audio_buffer_appended' && typeof m.task?.id === 'string',
    { timeoutMs: 5000, measurementKey: `${label}_audio_buffer_appended_ms`, label },
  );
  sendUtterance(ws, { eventId, pcmChunks, sendSpeakEnd, label });
  const result = await taskIdPromise;
  const taskId = result.parsed?.task?.id ?? null;
  if (!taskId) throw new Error(`No task.id captured for ${label}`);
  console.log(`[task-id t=${since()}ms ${label}] task.id=${taskId.slice(0,8)} client_event_id=${eventId.slice(0,8)}`);
  return taskId;
}

// =====================================================================
// MAIN — run A always; run B only with --prod
// =====================================================================

async function main() {
  console.log(`\n=== HeyGen LiveAvatar Phase 0 — mode=${runLog.mode} ===`);

  // STEP 1 — list public avatars (unauthed)
  const listRes = await fetch(`${API_BASE}/v1/avatars/public?page=1&page_size=20`);
  const listResult = await readBody(listRes);
  recordStep('GET /v1/avatars/public', listResult);
  log('STEP 1 — list public avatars', listResult);
  if (listRes.status !== 200) {
    throw new Error(`list-public-avatars returned ${listRes.status}`);
  }

  // For Run B: any ACTIVE stock avatar. Empirically (Run A): all 20 stock
  // avatars are is_1080p:true so the original "filter out 1080p" guard
  // would never find a candidate. Lite mode bills 1 credit/min regardless
  // of is_1080p (per docs/faq/credits) — the 1080p flag affects video
  // resolution, not Lite billing. Picking the first ACTIVE non-Wayne.
  let prodAvatarId = null;
  if (IS_PROD_RUN) {
    const results = listResult.body?.data?.results ?? [];
    const candidate = results.find((a) => a.status === 'ACTIVE' && a.id !== WAYNE_AVATAR_ID && a.is_expired === false);
    if (!candidate) {
      throw new Error(`No ACTIVE stock avatar found in /v1/avatars/public. Cannot proceed in --prod mode. Got ${results.length} results.`);
    }
    prodAvatarId = candidate.id;
    console.log(`\n[prod] Selected avatar: id=${prodAvatarId} name="${candidate.name}" is_1080p=${candidate.is_1080p}`);
  }

  // STEP 2 — create session token. is_sandbox flag depends on mode.
  const tokenBody = IS_PROD_RUN
    ? { mode: 'LITE', avatar_id: prodAvatarId, is_sandbox: false }
    : { mode: 'LITE', avatar_id: WAYNE_AVATAR_ID, is_sandbox: true };

  const tokenRes = await fetch(`${API_BASE}/v1/sessions/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(tokenBody),
  });
  const tokenResult = await readBody(tokenRes);
  recordStep('POST /v1/sessions/token', tokenResult, { request: redact(tokenBody) });
  log('STEP 2 — POST /v1/sessions/token', tokenResult);
  if (tokenRes.status !== 200) throw new Error(`session/token returned ${tokenRes.status}`);

  const sessionToken = tokenResult.body?.data?.session_token;
  if (!sessionToken) throw new Error('No session_token in response');
  cleanupState.activeSessionToken = sessionToken;

  // Inspect session_token JWT claims (audit M2 — capture permissions surface)
  const sessionTokenClaims = decodeJwtClaims(sessionToken);
  log('STEP 2b — session_token JWT claims (decoded)', sessionTokenClaims);
  runLog.measurements.sessionTokenClaims = sessionTokenClaims;

  // STEP 3 — start session
  const startRes = await fetch(`${API_BASE}/v1/sessions/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${sessionToken}` },
  });
  const startResult = await readBody(startRes);
  recordStep('POST /v1/sessions/start', startResult);
  log('STEP 3 — POST /v1/sessions/start (full SessionInfo dump)', startResult);
  if (startRes.status !== 200 && startRes.status !== 201) {
    throw new Error(`session/start returned ${startRes.status}`);
  }
  assertSandboxBilling(startResult.body, 'sessions/start'); // hard-fail in sandbox if billable marker

  const data = startResult.body?.data ?? {};
  const sessionId = data.session_id;
  const wsUrl = data.ws_url;
  const livekitUrl = data.livekit_url;
  const livekitClientToken = data.livekit_client_token;
  const maxSessionDuration = data.max_session_duration;
  cleanupState.activeSessionId = sessionId;

  if (!sessionId) throw new Error('No session_id in start response');
  if (!wsUrl) throw new Error('No ws_url in start response — Lite mode requires it');

  // Decode LiveKit client JWT (audit M2 — verify canPublish:false expected)
  const livekitClaims = livekitClientToken ? decodeJwtClaims(livekitClientToken) : null;
  log('STEP 3b — livekit_client_token JWT claims (decoded)', livekitClaims);
  runLog.measurements.livekitClientClaims = livekitClaims;
  runLog.measurements.wsUrlHost = (() => { try { return new URL(wsUrl).host; } catch { return null; } })();
  runLog.measurements.livekitUrlHost = (() => { try { return new URL(livekitUrl).host; } catch { return null; } })();
  runLog.measurements.maxSessionDurationRequested = tokenBody.max_session_duration ?? null;
  runLog.measurements.maxSessionDurationReturned = maxSessionDuration;

  // STEP 4 — fire keep-alive immediately. Captures the verified URL via
  // monkey-patched fetch (audit C3) since we hit it through fetch.
  const keepAliveRes = await fetch(`${API_BASE}/v1/sessions/keep-alive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${sessionToken}` },
    body: JSON.stringify({ session_id: sessionId }),
  });
  const keepAliveResult = await readBody(keepAliveRes);
  recordStep('POST /v1/sessions/keep-alive (early)', keepAliveResult);
  log('STEP 4 — POST /v1/sessions/keep-alive (early)', keepAliveResult);

  // STEP 5 — open WS, attach raw tap, wait for connected state.
  console.log(`\n[t=${since()}ms] opening WS to ${wsUrl}`);
  const ws = await openWs(wsUrl);
  cleanupState.ws = ws;
  runLog.measurements.wsOpenAtMs = since();
  attachWsTap(ws, 'main');

  // Give the server a moment to push any unprompted state frames
  await sleep(2000);
  console.log(`\n[t=${since()}ms] inbound types observed in 2s post-open: ${[...runLog.wsInboundTypes].join(', ') || '<none>'}`);

  // STEP 6 — Run A: ONE 1s utterance at 440Hz, monolithic chunk.
  if (!IS_PROD_RUN) {
    const tone = genTone({ durationMs: 1000 });
    const eventId = uuid4();
    const taskId = await sendUtteranceAndCaptureTaskId(ws, {
      eventId, pcmChunks: chunkPcm(tone, 'monolith'), label: 'A_monolith',
    });
    await waitForInbound(
      ws,
      (m) => m.type === 'agent.speak_started' && m.task?.id === taskId,
      { timeoutMs: 8000, measurementKey: 'A_speak_started_latency_ms', label: 'A-monolith' },
    );
    await waitForInbound(
      ws,
      (m) => m.type === 'agent.speak_ended' && m.task?.id === taskId,
      { timeoutMs: 15000, measurementKey: 'A_speak_ended_latency_ms', label: 'A-monolith' },
    );
  }

  // STEP 7 — Run B only: chunk-strategy comparison + barge-in + idle cadence
  if (IS_PROD_RUN) {
    // 7a — three chunking strategies, fresh utterance each, 2s gap between.
    // Run A already proved monolith works; this confirms the SDK splits work too.
    const strategies = ['monolith', 'sdk_dts', 'sdk_js_20ms'];
    for (const strategy of strategies) {
      const tone = genTone({ durationMs: 1000, freq: 440 });
      const eventId = uuid4();
      console.log(`\n[t=${since()}ms] B/chunking strategy=${strategy}`);
      const taskId = await sendUtteranceAndCaptureTaskId(ws, {
        eventId, pcmChunks: chunkPcm(tone, strategy), label: `B_${strategy}`,
      });
      await waitForInbound(
        ws,
        (m) => m.type === 'agent.speak_started' && m.task?.id === taskId,
        { timeoutMs: 8000, measurementKey: `B_${strategy}_speak_started_ms`, label: `B-${strategy}` },
      );
      await waitForInbound(
        ws,
        (m) => m.type === 'agent.speak_ended' && m.task?.id === taskId,
        { timeoutMs: 15000, measurementKey: `B_${strategy}_speak_ended_ms`, label: `B-${strategy}` },
      );
      await sleep(2000);
    }

    // 7b — barge-in semantics. Send 500ms then mid-flight a NEW event_id
    // chunk WITHOUT prior agent.speak_end. Observe what the server does.
    // Capture both task.ids so we can tell whether server treated them as
    // (a) one merged utterance, (b) two utterances with first auto-ended,
    // (c) rejection of the second.
    const tone500 = genTone({ durationMs: 500 });
    const firstId = uuid4();
    const secondId = uuid4();
    console.log(`\n[t=${since()}ms] B/barge-in: first=${firstId.slice(0,8)} second=${secondId.slice(0,8)}`);
    const firstTaskWait = waitForInbound(
      ws,
      (m) => m.type === 'agent.audio_buffer_appended' && typeof m.task?.id === 'string',
      { timeoutMs: 5000, measurementKey: 'B_barge_first_task_appended_ms', label: 'B-barge-first' },
    );
    sendUtterance(ws, { eventId: firstId, pcmChunks: chunkPcm(tone500, 'monolith'), sendSpeakEnd: false, label: 'B-barge-first' });
    const firstResult = await firstTaskWait;
    const firstTaskId = firstResult.parsed?.task?.id ?? null;
    await sleep(300);
    const tone1000 = genTone({ durationMs: 1000, freq: 660 });
    sendUtterance(ws, { eventId: secondId, pcmChunks: chunkPcm(tone1000, 'monolith'), label: 'B-barge-second' });
    const bargeT0 = since();
    await sleep(8000);
    const bargeFrames = runLog.wsInboundFrames.filter((f) => f.t_ms >= bargeT0).map((f) => ({
      delta_ms: f.t_ms - bargeT0,
      type: f.type,
      task_id: f.frame?.task?.id ?? null,
      matches_first_task: f.frame?.task?.id === firstTaskId,
    }));
    runLog.measurements.bargeIn = {
      first_event_id: firstId, second_event_id: secondId,
      first_task_id: firstTaskId,
      frames_after_second: bargeFrames,
    };
    log('STEP 7b — barge-in inbound frames after second utterance', bargeFrames);

    // 7c — interrupt event verification (clean test, separate utterance)
    await sleep(1500);
    const tone3sec = genTone({ durationMs: 3000 });
    const intEventId = uuid4();
    console.log(`\n[t=${since()}ms] B/interrupt: send 3s then interrupt mid-stream`);
    const intTaskId = await sendUtteranceAndCaptureTaskId(ws, {
      eventId: intEventId, pcmChunks: chunkPcm(tone3sec, 'monolith'), label: 'B_interrupt',
    });
    await waitForInbound(
      ws,
      (m) => m.type === 'agent.speak_started' && m.task?.id === intTaskId,
      { timeoutMs: 8000, measurementKey: 'B_interrupt_speak_started_ms', label: 'B-interrupt' },
    );
    await sleep(800);
    const interruptSentMs = since();
    ws.send(JSON.stringify({ type: 'agent.interrupt', event_id: uuid4() }));
    runLog.measurements.interruptSentAtMs = interruptSentMs;
    const intEnded = await waitForInbound(
      ws,
      (m) => m.type === 'agent.speak_ended' && m.task?.id === intTaskId,
      { timeoutMs: 5000, measurementKey: 'B_interrupt_to_speak_ended_ms', label: 'B-interrupt' },
    );
    if (intEnded.matched) {
      runLog.measurements.B_interrupt_latency_ms = intEnded.parsed ? (since() - interruptSentMs - intEnded.elapsed) : null;
      // Cleaner: the wait started at the moment we sent interrupt (since `since()` at construction)
      // so elapsed IS the interrupt-to-speak-ended latency.
      runLog.measurements.B_interrupt_latency_ms_clean = intEnded.elapsed;
    }

    // 7d — idle cadence: silent 30/60/90/120s, observe close behavior.
    // We've burned ~1 min wall-clock so far; this adds ~5 min more. Total ~6 min in WATCHDOG_MS=7min.
    console.log(`\n[t=${since()}ms] B/idle cadence: keep-alive then silent 120s. Watching for closing/closed.`);
    await fetch(`${API_BASE}/v1/sessions/keep-alive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ session_id: sessionId }),
    });
    const idleT0 = since();
    runLog.measurements.idleCadenceStart = idleT0;
    let closingSeen = false;
    const onIdleMsg = (event) => {
      try {
        const m = JSON.parse(event.data);
        if (m.state === 'closing' || m.state === 'closed' || m.type === 'session.stopped') {
          closingSeen = true;
          runLog.measurements.idleCloseAtMs = since() - idleT0;
          console.log(`[idle-close t=${since()}ms] state/type=${m.state ?? m.type} elapsed_since_silence=${since() - idleT0}ms`);
        }
      } catch { /* */ }
    };
    ws.addEventListener('message', onIdleMsg);
    // Wait up to 130s for close, polling every 5s
    for (let i = 0; i < 26 && !closingSeen; i++) {
      await sleep(5000);
      console.log(`[idle-poll t=${since()}ms] elapsed_since_silence=${since() - idleT0}ms closingSeen=${closingSeen}`);
    }
    ws.removeEventListener('message', onIdleMsg);
    if (!closingSeen) {
      runLog.measurements.idleCloseAtMs = null;
      runLog.measurements.idleNote = 'No close observed after 130s of silence. Server tolerated longer than expected.';
    }
  }

  // STEP 8 — explicit stop, then double-stop idempotency check (audit M4)
  const stop1Res = await fetch(`${API_BASE}/v1/sessions/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${sessionToken}` },
    body: JSON.stringify({ session_id: sessionId, reason: 'USER_CLOSED' }),
  });
  const stop1Result = await readBody(stop1Res);
  recordStep('POST /v1/sessions/stop (#1)', stop1Result);
  log('STEP 8 — POST /v1/sessions/stop (#1)', stop1Result);

  const stop2Res = await fetch(`${API_BASE}/v1/sessions/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${sessionToken}` },
    body: JSON.stringify({ session_id: sessionId, reason: 'USER_CLOSED' }),
  });
  const stop2Result = await readBody(stop2Res);
  recordStep('POST /v1/sessions/stop (#2 — idempotency)', stop2Result);
  log('STEP 8b — POST /v1/sessions/stop (#2)', stop2Result);
  runLog.measurements.stopIdempotency = {
    first_status: stop1Result.status,
    second_status: stop2Result.status,
    first_body: redact(stop1Result.body),
    second_body: redact(stop2Result.body),
  };

  // Mark cleanup as done so try/finally forceStop is a no-op
  cleanupState.alreadyStopped = true;
  try { ws.close(1000, 'phase0_complete'); } catch { /* */ }

  console.log(`\n=== Phase 0 ${runLog.mode} run complete at t=${since()}ms ===`);
}

// ---- Report writer ----
function writeReport() {
  if (cleanupState.watchdogTimer) clearTimeout(cleanupState.watchdogTimer);
  runLog.endedAt = new Date().toISOString();
  runLog.totalMs = since();
  runLog.wsInboundTypes = [...runLog.wsInboundTypes];

  const md = `# Phase 0 — HeyGen LiveAvatar Lite verification

**Date:** ${runLog.startedAt}
**Mode:** \`${runLog.mode}\` (${IS_PROD_RUN ? 'prod, billable' : 'sandbox, free'})
**Total wall-clock:** ${runLog.totalMs}ms
**Verifier:** \`scripts/heygen-phase0-verify.mjs\` — re-runnable
**Errors:** ${runLog.errors.length === 0 ? 'none' : runLog.errors.length}

---

## Errors
\`\`\`json
${JSON.stringify(runLog.errors, null, 2)}
\`\`\`

## Measurements
\`\`\`json
${JSON.stringify(runLog.measurements, null, 2)}
\`\`\`

## Inbound WS message types observed (canonical vocabulary)
${runLog.wsInboundTypes.map((t) => `- \`${t}\``).join('\n') || '_none_'}

## Inbound WS frames (first 50)
\`\`\`json
${JSON.stringify(runLog.wsInboundFrames, null, 2)}
\`\`\`

## fetch() calls (every URL the script hit, in order)
\`\`\`json
${JSON.stringify(runLog.fetchCalls, null, 2)}
\`\`\`

## REST steps (verbatim, redacted)
\`\`\`json
${JSON.stringify(runLog.steps, null, 2)}
\`\`\`
`;
  try {
    writeFileSync(REPORT_PATH, md, 'utf8');
    console.log(`\n>>> Report written to ${REPORT_PATH}`);
  } catch (e) {
    console.error(`Could not write report: ${(e && e.message) || e}`);
  }
}

// ---- Run ----
let exitCode = 0;
try {
  await main();
} catch (e) {
  console.error(`\n!!!! main() threw: ${e?.stack ?? e}`);
  runLog.errors.push({ label: 'main_threw', message: (e && e.message) || String(e) });
  exitCode = 1;
} finally {
  await forceStop('finally');
  writeReport();
  console.log(`\n========================================`);
  console.log(`Phase 0 ${runLog.mode} verification ${exitCode === 0 ? 'OK' : 'FAILED'}.`);
  console.log(`Paste this stdout back to Claude.`);
  console.log(`========================================`);
  // Allow stdout to flush before exit
  setTimeout(() => process.exit(exitCode), 100);
}
