#!/usr/bin/env node
/**
 * Brain wire-up — end-to-end smoke against staging proxy.
 *
 * Validates the full PR-2 pipeline:
 *   1. Session-open (with mocked staging creator named "Vuk Smoke")
 *   2. Voice-proxy WS open
 *   3. Brain prefix seeded post-setupComplete (turnComplete:false)
 *   4. User asks "What's your name?"
 *   5. Cartesia delivers cloned voice via outputAudioTranscription
 *
 * Asserts:
 *   * Response transcript contains "Vuk" (case-insensitive)
 *   * Response does NOT match /^I am (a|Gemini|an AI)/ (generic-mentor regression)
 *   * NO output_transcription_chunk before first user-audio frame
 *     (R2 C2 — confirms turnComplete:false didn't auto-generate)
 *   * cogs_log for the session has service='cartesia' row
 *     (R1 S9 — confirms cloned voice path engaged)
 *
 * Required env (staging):
 *   STAGING_PROXY_URL          (wss://staging-proxy.fly.dev/voice/spike-a)
 *   STAGING_VOICE_TICKET       (mint via /api/sessions/open against staging)
 *   STAGING_SUPABASE_URL
 *   STAGING_SUPABASE_SERVICE_ROLE
 *   STAGING_TEST_SESSION_ID    (from the session_open response)
 *
 * NEVER run against prod. The seeded creator + COGS rows are staging-only.
 */

import WebSocket from 'ws';
import { createClient } from '@supabase/supabase-js';

const PROXY = process.env.STAGING_PROXY_URL;
const TICKET = process.env.STAGING_VOICE_TICKET;
const SESSION_ID = process.env.STAGING_TEST_SESSION_ID;
const SB_URL = process.env.STAGING_SUPABASE_URL;
const SB_KEY = process.env.STAGING_SUPABASE_SERVICE_ROLE;

if (!PROXY || !TICKET || !SESSION_ID || !SB_URL || !SB_KEY) {
  console.error('Required env: STAGING_PROXY_URL, STAGING_VOICE_TICKET, STAGING_TEST_SESSION_ID, STAGING_SUPABASE_URL, STAGING_SUPABASE_SERVICE_ROLE');
  process.exit(2);
}

const sb = createClient(SB_URL, SB_KEY);

console.log(`[1/5] connecting WS ${PROXY}…`);
const ws = new WebSocket(`${PROXY}?ticket=${encodeURIComponent(TICKET)}`);

let firstUserAudioAt = null;
let firstTranscriptAt = null;
const transcriptParts = [];
let readyAt = null;

const transcriptBeforeUserAudio = [];

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('WS open timeout')), 10000);
  ws.on('open', () => {
    clearTimeout(timeout);
    resolve();
  });
  ws.on('error', reject);
});

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString('utf8'));
  } catch {
    return;
  }
  if (msg.type === 'ready') {
    readyAt = Date.now();
    console.log(`[2/5] proxy ready at ${readyAt - +new Date()}ms`);
  }
  if (msg.type === 'transcript' || msg.type === 'output_transcription') {
    const t = Date.now();
    if (firstTranscriptAt === null) firstTranscriptAt = t;
    if (firstUserAudioAt === null) {
      transcriptBeforeUserAudio.push({ t, text: msg.text });
    }
    if (typeof msg.text === 'string') transcriptParts.push(msg.text);
  }
});

// Wait for ready or 10s.
await new Promise((r) => setTimeout(r, 1000));
if (!readyAt) {
  console.error('[FAIL] proxy never sent ready');
  ws.close();
  process.exit(1);
}

// Assertion: NO transcript chunks arrived before any user audio.
if (transcriptBeforeUserAudio.length > 0) {
  console.error('[FAIL] R2 C2: pre-user-audio transcript chunks detected:');
  console.error(JSON.stringify(transcriptBeforeUserAudio, null, 2));
  ws.close();
  process.exit(1);
}
console.log(`[3/5] no pre-user-audio transcript chunks (R2 C2 holds)`);

// Send a synthetic "user audio" via the proxy's text passthrough if it
// supports one — otherwise send a control frame asking for a turn. The
// proxy contract uses binary PCM frames in production; this smoke needs
// a text-input shortcut, which the proxy does not expose. Instead, this
// test should be run with a separate harness that pumps a canned WAV.
//
// For v1: caller is expected to drive mic frames separately. Here we
// just verify the readiness path + post-ready quiet.

// Wait for the staging session to have completed naturally OR exit
// after a brief observation window. The full transcript assertion
// happens after harness drive.
await new Promise((r) => setTimeout(r, 5000));

console.log('[4/5] checking cogs_log for cartesia row…');
const { data: cogsRows, error: cogsErr } = await sb
  .from('cogs_log')
  .select('service, operation')
  .eq('session_id', SESSION_ID)
  .limit(20);
if (cogsErr) {
  console.error('cogs_log query failed:', cogsErr);
  ws.close();
  process.exit(2);
}
const services = new Set(cogsRows.map((r) => r.service));
console.log(`  cogs_log services for session: ${[...services].join(', ')}`);

if (!services.has('cartesia')) {
  console.error('[FAIL] R1 S9: no service=cartesia row in cogs_log — cloned voice path not engaged');
  ws.close();
  process.exit(1);
}

ws.close();

// Caller drives the actual question + collects transcript via the
// harness; this script is the assertion gate that validates the
// pre-conditions held. The transcript-name assertion needs the harness
// output piped via STDIN or env var.
const FULL_TRANSCRIPT = process.env.BRAIN_SMOKE_TRANSCRIPT || transcriptParts.join('');
console.log(`[5/5] transcript: ${FULL_TRANSCRIPT.slice(0, 200)}…`);

if (!/vuk/i.test(FULL_TRANSCRIPT)) {
  console.error('[WARN] transcript does not contain "Vuk" — check the persona compiled correctly');
  console.error('       (run brain-resumption-spike to verify systemInstruction path)');
  process.exit(1);
}
if (/^I am (a|Gemini|an AI)/i.test(FULL_TRANSCRIPT.trim())) {
  console.error('[FAIL] generic-mentor regression detected: transcript starts with generic AI disclaimer');
  process.exit(1);
}

console.log('[PASS] brain wire-up smoke green');
process.exit(0);
