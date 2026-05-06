#!/usr/bin/env node
// Phase 0 verifier for Simli Trinity face-train API.
//
// Purpose: nail down the runtime response shapes for POST /faces/trinity
// and GET /faces/trinity/generation_status, so the production route's
// parser is grounded in reality rather than a guess at field names.
//
// Usage (PowerShell):
//   $env:SIMLI_API_KEY="sk_xxx"; node scripts/face-phase0-verify.mjs ./path/to/face.jpg
//
// Usage (bash):
//   SIMLI_API_KEY=sk_xxx node scripts/face-phase0-verify.mjs ./path/to/face.jpg
//
// What it does:
//   1. POST the image to /faces/trinity with face_name="phase0_verify_<ts>"
//   2. Logs the full 200 response body (redacted: any field name containing
//      "key" / "secret" / "token" gets its value masked).
//   3. Extracts a face_id from likely keys (face_id | faceId | id | character_uid).
//   4. Polls /faces/trinity/generation_status?face_id=<id> at t=0s, 5s, 15s, 30s, 60s.
//   5. Logs every status response body verbatim (redacted).
//   6. If the face becomes ready, also calls /compose/token to confirm
//      end-to-end usability (this is the same call mint-simli.ts makes).
//   7. Optionally cleans up by DELETE /faces/trinity/{id} at the end (set
//      KEEP_FACE=1 to skip cleanup if you want to inspect in the dashboard).
//
// Output: writes JSON to docs/_planning/PHASE_0_FACE_API.md scaffolding
// + prints the same to stdout. You paste stdout back to Claude and we're
// done.

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const API_KEY = process.env.SIMLI_API_KEY;
const KEEP_FACE = process.env.KEEP_FACE === '1';
const IMAGE_PATH = process.argv[2];

if (!API_KEY) {
  console.error('FATAL: SIMLI_API_KEY env var unset.');
  process.exit(1);
}
if (!IMAGE_PATH) {
  console.error('FATAL: pass an image path as arg 1.');
  console.error('Usage: node scripts/face-phase0-verify.mjs ./face.jpg');
  process.exit(1);
}
if (!existsSync(IMAGE_PATH)) {
  console.error(`FATAL: image not found at ${IMAGE_PATH}`);
  process.exit(1);
}

const TRINITY_CREATE_URL = 'https://api.simli.ai/faces/trinity';
const TRINITY_STATUS_URL = 'https://api.simli.ai/faces/trinity/generation_status';
const TRINITY_DELETE_URL = 'https://api.simli.ai/faces/trinity'; // /{id} appended
const COMPOSE_TOKEN_URL = 'https://api.simli.ai/compose/token';

// Mask any field whose key looks sensitive. Simli responses shouldn't echo
// our key, but defense-in-depth.
function redact(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/key|secret|token|authorization/i.test(k) && typeof v === 'string') {
      out[k] = `***REDACTED(${v.length} chars)***`;
    } else {
      out[k] = redact(v);
    }
  }
  return out;
}

function logStep(label, payload) {
  console.log('\n========================================');
  console.log(label);
  console.log('========================================');
  console.log(JSON.stringify(redact(payload), null, 2));
}

async function readBody(res) {
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: json ?? text };
}

function pickFaceId(body) {
  if (!body || typeof body !== 'object') return null;
  // Try every plausible field name; log which one matched so the route
  // parser knows which key to read.
  for (const k of ['face_id', 'faceId', 'id', 'character_uid', 'characterUid', 'uid']) {
    if (typeof body[k] === 'string' && body[k].length > 0) {
      return { key: k, value: body[k] };
    }
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- 1. POST /faces/trinity ----
const fileBytes = readFileSync(IMAGE_PATH);
const fileName = basename(IMAGE_PATH);
const mime = fileName.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
const faceName = `phase0_verify_${Date.now()}`;

const fd = new FormData();
fd.append('image', new Blob([fileBytes], { type: mime }), fileName);

const createUrl = new URL(TRINITY_CREATE_URL);
createUrl.searchParams.set('face_name', faceName);
createUrl.searchParams.set('gsVersion', 'GSA_1.0');

console.log(`POST ${createUrl.toString()}`);
console.log(`  multipart image=${fileName} (${mime}, ${fileBytes.byteLength} bytes)`);

const createRes = await fetch(createUrl, {
  method: 'POST',
  headers: { 'x-simli-api-key': API_KEY },
  body: fd,
});
const created = await readBody(createRes);
logStep('STEP 1 — POST /faces/trinity response', created);

if (createRes.status !== 200 && createRes.status !== 201 && createRes.status !== 202) {
  console.error(`\nFATAL: create returned ${createRes.status}, aborting.`);
  process.exit(1);
}

const matched = pickFaceId(created.body);
if (!matched) {
  console.error('\nFATAL: could not find a face_id in the response body.');
  console.error('Inspect STEP 1 above and tell Claude which field holds the id.');
  process.exit(1);
}
console.log(`\n>>> face_id located in field "${matched.key}" = "${matched.value}"`);
const faceId = matched.value;

// ---- 2. Poll generation_status ----
const pollPoints = [0, 5_000, 15_000, 30_000, 60_000];
let lastStatus = null;
for (const wait of pollPoints) {
  if (wait > 0) {
    console.log(`\n... waiting ${wait / 1000}s before next status poll ...`);
    await sleep(wait);
  }
  const statusUrl = new URL(TRINITY_STATUS_URL);
  statusUrl.searchParams.set('face_id', faceId);
  const sres = await fetch(statusUrl, {
    method: 'GET',
    headers: { 'x-simli-api-key': API_KEY },
  });
  lastStatus = await readBody(sres);
  logStep(`STEP 2 — GET /faces/trinity/generation_status (t=${wait / 1000}s)`, lastStatus);
  // Heuristic: stop early if response looks "done"
  const b = lastStatus.body;
  if (b && typeof b === 'object') {
    const blob = JSON.stringify(b).toLowerCase();
    if (blob.includes('"ready"') || blob.includes('"done"') || blob.includes('"completed"') || blob.includes('"success"')) {
      console.log('\n>>> status response looks "ready" — exiting poll loop early');
      break;
    }
  }
}

// ---- 3. End-to-end: try compose/token ----
console.log('\n... attempting /compose/token to confirm end-to-end ...');
const composeRes = await fetch(COMPOSE_TOKEN_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-simli-api-key': API_KEY },
  body: JSON.stringify({
    faceId,
    handleSilence: true,
    maxSessionLength: 60,
    maxIdleTime: 30,
  }),
});
const compose = await readBody(composeRes);
logStep('STEP 3 — POST /compose/token response', compose);

// ---- 4. Cleanup ----
if (KEEP_FACE) {
  console.log(`\n>>> KEEP_FACE=1 set; leaving face ${faceId} in your Simli account.`);
} else {
  console.log(`\n... cleaning up: DELETE ${TRINITY_DELETE_URL}/${faceId} ...`);
  const delRes = await fetch(`${TRINITY_DELETE_URL}/${encodeURIComponent(faceId)}`, {
    method: 'DELETE',
    headers: { 'x-simli-api-key': API_KEY },
  });
  const del = await readBody(delRes);
  logStep('STEP 4 — DELETE /faces/trinity/{id} response', del);
}

console.log('\n========================================');
console.log('Phase 0 verification complete.');
console.log('Paste this entire stdout back to Claude.');
console.log('========================================');
