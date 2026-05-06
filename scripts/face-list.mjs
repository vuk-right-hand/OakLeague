#!/usr/bin/env node
// Lists all faces in the Simli account so we can decide which to delete
// before re-running the Phase 0 verifier.
//
// Usage: node --env-file=.env.local scripts/face-list.mjs

const API_KEY = process.env.SIMLI_API_KEY;
if (!API_KEY) { console.error('FATAL: SIMLI_API_KEY unset.'); process.exit(1); }

const res = await fetch('https://api.simli.ai/faces', {
  headers: { 'x-simli-api-key': API_KEY },
});
const text = await res.text();
let body; try { body = JSON.parse(text); } catch { body = text; }
console.log('status:', res.status);
console.log(JSON.stringify(body, null, 2));
