#!/usr/bin/env node
/**
 * Spike B — Phase 0 verification harness (SPIKE_B_PLAN.md Rev 5).
 *
 * Runs the Phase 0 probes BEFORE any bridge code is written. Each probe's
 * finding is what unblocks the corresponding Phase 1 task:
 *   (A) Simli API key valid + compose-token dry mint
 *   (B) Simli `is_trinity_avatar` flag layer (session / replica / account)
 *   (C) Tavus API key valid + replica status + Starter-tier replica_type
 *       (must be phoenix-4 or documented alternative — wrong type = 24h wasted training)
 *   (D) Tavus echo canonical ingest path (RTC track publish vs sendAppMessage)
 *   (E) Supabase Storage bucket `spike-b-clips` exists + signed-URL mint works
 *   (F) Report-only: MediaRecorder codec matrix — must be run BY HAND in the
 *       PWA on desktop Chrome + Pixel 7 Pro + iPhone 11 Safari installed PWA.
 *       This script prints the test snippet; negative results logged anyway.
 *
 * Required env: SIMLI_API_KEY, TAVUS_API_KEY, TAVUS_REPLICA_ID, SUPABASE_URL,
 *               SUPABASE_SERVICE_ROLE_KEY.
 *               Note: SUPABASE_URL may alias NEXT_PUBLIC_SUPABASE_URL (only the
 *               latter is in .env.example). Script accepts either.
 * Optional:     SIMLI_REPLICA_ID (post-training; absence is OK pre-training)
 * Run:          node scripts/spike-b-phase-0-verify.mjs
 *
 * Output: PASS/FAIL/INFO per check. Exit 0 on all required checks passing.
 * Nothing persisted beyond the Storage bucket probe (which is idempotent).
 */

const SIMLI_API_KEY     = process.env.SIMLI_API_KEY;
const SIMLI_REPLICA_ID  = process.env.SIMLI_REPLICA_ID || null;
const TAVUS_API_KEY     = process.env.TAVUS_API_KEY;
const TAVUS_REPLICA_ID  = process.env.TAVUS_REPLICA_ID;
const SUPABASE_URL      = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SRK      = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET            = 'spike-b-clips';

// Allowed Phoenix-4 type strings. Tavus docs as of 2026-02-19 launch accept
// `phoenix-4` (or equivalent; verify in docs.tavus.io/sections/replicas/replica-types
// before submitting training). If Starter tier rejects phoenix-4 the probe
// flags it — we do NOT want to discover this after 24h of training.
const ACCEPTED_PHOENIX_TYPES = ['phoenix-4', 'phoenix-3']; // Phoenix-3 is Starter-tier fallback if 4 is gated

const results = [];
function record(label, status, detail = '') {
  results.push({ label, status, detail });
  const mark = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'INFO';
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}`);
}

function requireEnv(name, value) {
  if (!value) {
    console.error(`${name} missing from env. Pull from 1Password or .env.local.`);
    process.exit(2);
  }
}

// -----------------------------------------------------------------------------
// A. Simli API key + compose-token dry mint
// -----------------------------------------------------------------------------
async function checkSimliAuth() {
  console.log('\n[A] Simli — API key + compose-token dry mint:');
  if (!SIMLI_API_KEY) { record('Simli API key present', 'FAIL', 'SIMLI_API_KEY not set'); return; }
  try {
    // Simli's compose-token endpoint (api.simli.ai/startAudioToVideoSession or
    // startE2ESession) gates on API key + faceId/replica. We mint against
    // SIMLI_REPLICA_ID if present; otherwise just verify the key with a 400
    // (payload-rejected) response — which is distinct from 401 unauthorized.
    const body = {
      apiKey: SIMLI_API_KEY,
      faceId: SIMLI_REPLICA_ID || 'dry-run-no-replica',
      syncAudio: true,
      handleSilence: false,
    };
    const res = await fetch('https://api.simli.ai/startAudioToVideoSession', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    if (res.status === 401 || res.status === 403) {
      record('Simli API key', 'FAIL', `${res.status} — key rejected`);
      return;
    }
    if (SIMLI_REPLICA_ID && res.ok) {
      record('Simli compose-token mint', 'PASS', `status=${res.status}, body has token=${txt.includes('roomUrl') || txt.includes('session_token') || txt.includes('sessionToken')}`);
      // NOTE: probe intentionally does NOT close the session on success. No
      // audio is sent → no cost meter runs → session idles out on Simli's
      // timer. Adding a close call would introduce a second API shape (session
      // id extraction + DELETE path) this probe hasn't validated. Accepting
      // one idling session slot until Simli's idle timeout fires.
    } else {
      record('Simli API key', 'PASS', `status=${res.status} (no replica yet; key accepted at auth layer)`);
    }
  } catch (e) {
    record('Simli API reachable', 'FAIL', e?.message || String(e));
  }
}

// -----------------------------------------------------------------------------
// B. Simli `is_trinity_avatar` flag layer
//    This one is a documentation probe, not an API probe. We surface the
//    question and a structured placeholder — Claude must confirm from
//    docs.simli.com or Simli SDK source BEFORE SimliBridge is written.
// -----------------------------------------------------------------------------
function checkSimliTrinityFlagDoc() {
  console.log('\n[B] Simli `is_trinity_avatar` flag layer (doc probe):');
  record(
    'Trinity-flag layer',
    'INFO',
    'Manual confirm required: session-param vs replica-param vs account-param.\n' +
    '       Source of truth: docs.simli.com + Simli SDK source (npm: simli-client).\n' +
    '       If training-time (replica-param): Simli retrain must kick off Apr 22 AM, not Apr 21.\n' +
    '       Current assumption: session-param (set in startAudioToVideoSession body).'
  );
}

// -----------------------------------------------------------------------------
// C. Tavus API key + replica status + replica_type (Phoenix-4 / fallback)
// -----------------------------------------------------------------------------
async function checkTavusReplica() {
  console.log('\n[C] Tavus — API key + replica status + replica_type:');
  if (!TAVUS_API_KEY)    { record('Tavus API key present',    'FAIL', 'TAVUS_API_KEY not set');    return; }
  if (!TAVUS_REPLICA_ID) { record('Tavus replica id present', 'INFO', 'TAVUS_REPLICA_ID not set — OK pre-training'); }

  try {
    // GET /v2/replicas to list and GET /v2/replicas/:id for specific status.
    const listRes = await fetch('https://tavusapi.com/v2/replicas', {
      headers: { 'x-api-key': TAVUS_API_KEY },
    });
    if (listRes.status === 401 || listRes.status === 403) {
      record('Tavus API key', 'FAIL', `${listRes.status} — key rejected`);
      return;
    }
    record('Tavus API key', 'PASS', `GET /v2/replicas status=${listRes.status}`);

    if (TAVUS_REPLICA_ID) {
      const detail = await fetch(`https://tavusapi.com/v2/replicas/${TAVUS_REPLICA_ID}`, {
        headers: { 'x-api-key': TAVUS_API_KEY },
      });
      if (!detail.ok) {
        record('Tavus replica reachable', 'FAIL', `${detail.status}`);
        return;
      }
      const body = await detail.json();
      const status = body.status || body.training_progress || 'unknown';
      const replicaType = body.model_name || body.replica_type || body.model || 'unknown';
      record('Tavus replica status', 'PASS', `status=${status}, type=${replicaType}`);

      // Normalize delimiter variants (phoenix_4, phoenix.4 → phoenix-4) before
      // matching. Provider APIs are inconsistent about punctuation and a silent
      // mismatch here would fail the check while the replica is actually fine.
      const lcType = String(replicaType).toLowerCase().replace(/[._]/g, '-');
      const accepted = ACCEPTED_PHOENIX_TYPES.some((t) => lcType.includes(t));
      if (accepted) {
        record('Tavus replica_type accepted', 'PASS', `${replicaType} in accepted set [${ACCEPTED_PHOENIX_TYPES.join(', ')}]`);
      } else {
        // Log raw body shape on FAIL so the dev doesn't need to re-run with
        // manual curl to discover which field the type actually lives under.
        console.log(`       DEBUG raw replica body keys: ${Object.keys(body).join(', ')}`);
        console.log(`       DEBUG raw replica body (truncated): ${JSON.stringify(body).slice(0, 400)}`);
        record('Tavus replica_type accepted', 'FAIL',
          `normalized=${lcType}, raw=${replicaType} NOT in accepted set — confirm Starter-tier support in docs.tavus.io/sections/replicas before training. Wrong type = 24h wasted training.`);
      }
    }
  } catch (e) {
    record('Tavus API reachable', 'FAIL', e?.message || String(e));
  }
}

// -----------------------------------------------------------------------------
// D. Tavus echo canonical ingest path (doc probe)
// -----------------------------------------------------------------------------
function checkTavusEchoIngestDoc() {
  console.log('\n[D] Tavus echo canonical ingest path (doc probe):');
  record(
    'Echo ingest path',
    'INFO',
    'Manual confirm required: RTC audio track publish vs daily-js sendAppMessage(base64).\n' +
    '       Source of truth: docs.tavus.io/sections/conversations/pipeline-modes (echo) + daily-js SDK + Tavus Discord.\n' +
    '       Current assumption: publish PCM16 as local mic track; sendAppMessage reserved for interrupt signal.\n' +
    '       Clips pre-resampled offline: ffmpeg -ar 24000 -sample_fmt s16 -ac 1.'
  );
}

// -----------------------------------------------------------------------------
// E. Supabase Storage bucket `spike-b-clips` + signed-URL mint
// -----------------------------------------------------------------------------
async function checkStorageBucket() {
  console.log('\n[E] Supabase Storage — spike-b-clips bucket:');
  if (!SUPABASE_URL || !SUPABASE_SRK) {
    record('Supabase env', 'FAIL', 'SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required');
    return;
  }
  const base = SUPABASE_URL.replace(/\/$/, '');
  const authHeaders = {
    apikey: SUPABASE_SRK,
    Authorization: `Bearer ${SUPABASE_SRK}`,
  };

  try {
    // GET bucket metadata — 200 if exists, 404 if missing.
    const getRes = await fetch(`${base}/storage/v1/bucket/${BUCKET}`, { headers: authHeaders });
    if (getRes.status === 404) {
      // Create it: private, size-capped, MIME-restricted. Defense-in-depth:
      // a leaked service-role key still can't dump arbitrary large files or
      // non-audio payloads into this bucket. Clips are <500KB each; 10MB ceiling
      // is comfortable. Audio only — .wav for raw PCM, .mpeg for compressed.
      const createRes = await fetch(`${base}/storage/v1/bucket`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          id: BUCKET,
          name: BUCKET,
          public: false,
          file_size_limit: 10485760,
          allowed_mime_types: ['audio/wav', 'audio/mpeg'],
        }),
      });
      if (!createRes.ok) {
        const t = await createRes.text();
        record('Storage bucket create', 'FAIL', `${createRes.status} — ${t.slice(0, 200)}`);
        return;
      }
      record('Storage bucket', 'PASS', 'created (private, 10MB cap, audio MIME only)');
    } else if (getRes.ok) {
      const info = await getRes.json();
      if (info.public === true) {
        record('Storage bucket privacy', 'FAIL', 'bucket is PUBLIC — spike-b-clips must be private');
        return;
      }
      record('Storage bucket', 'PASS', `exists (private)`);
    } else {
      record('Storage bucket probe', 'FAIL', `unexpected status ${getRes.status}`);
      return;
    }

    // Signed-URL mint probe — /storage/v1/object/sign requires the object to
    // already exist (404 otherwise). Upload a 1-byte placeholder first so the
    // sign call exercises the real codepath end-to-end. Placeholder uses
    // x-upsert:true to stay idempotent across probe reruns.
    const placeholderBody = new Uint8Array([0]); // 1 byte, any value
    const upRes = await fetch(`${base}/storage/v1/object/${BUCKET}/probe.wav`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': 'audio/wav',
        'x-upsert': 'true',
      },
      body: placeholderBody,
    });
    if (!upRes.ok) {
      const t = await upRes.text();
      record('Storage placeholder upload', 'FAIL', `${upRes.status} — ${t.slice(0, 200)}`);
      return;
    }

    const signRes = await fetch(`${base}/storage/v1/object/sign/${BUCKET}/probe.wav`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ expiresIn: 60 }),
    });
    if (!signRes.ok) {
      const t = await signRes.text();
      record('Signed-URL mint', 'FAIL', `${signRes.status} — ${t.slice(0, 200)}`);
      return;
    }
    const signed = await signRes.json();
    record('Signed-URL mint', 'PASS', `signedURL length=${(signed.signedURL || signed.signedUrl || '').length}, 60s expiry`);
  } catch (e) {
    record('Storage probe', 'FAIL', e?.message || String(e));
  }
}

// -----------------------------------------------------------------------------
// F. MediaRecorder codec matrix — human-run snippet printer
// -----------------------------------------------------------------------------
function printMediaRecorderSnippet() {
  console.log('\n[F] MediaRecorder codec matrix — run BY HAND on each target device:');
  console.log('       Paste into DevTools Console (desktop Chrome / Pixel 7 Pro Chrome / iPhone 11 Safari installed PWA):');
  console.log(`
       (() => {
         const mimes = [
           'video/webm;codecs=vp9,opus',
           'video/webm;codecs=vp8,opus',
           'video/webm',
           'video/mp4;codecs=avc1,mp4a.40.2',
           'video/mp4',
         ];
         const results = {};
         for (const m of mimes) results[m] = MediaRecorder.isTypeSupported(m);
         console.table(results);
         return { ua: navigator.userAgent, results };
       })();
       `);
  console.log('       Log negative results (ALL false on iPhone 11 PWA) explicitly — commits to QuickTime-over-cable for iOS Phase 3 recordings.');
  record('MediaRecorder codec matrix', 'INFO', 'human-run snippet printed; log results in .claude_learnings.md');
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
(async () => {
  console.log('Spike B Phase 0 — verification harness');
  console.log('---------------------------------------');

  await checkSimliAuth();
  checkSimliTrinityFlagDoc();
  await checkTavusReplica();
  checkTavusEchoIngestDoc();
  await checkStorageBucket();
  printMediaRecorderSnippet();

  console.log('\n---------------------------------------');
  const failed = results.filter((r) => r.status === 'FAIL');
  const passed = results.filter((r) => r.status === 'PASS');
  const info   = results.filter((r) => r.status === 'INFO');
  console.log(`Summary: ${passed.length} PASS, ${failed.length} FAIL, ${info.length} INFO (manual follow-up)`);

  if (failed.length > 0) {
    console.log('\nFailed checks:');
    for (const f of failed) console.log(`  - ${f.label} — ${f.detail}`);
    process.exit(1);
  }
  console.log('\nAll machine-checkable probes PASS. Resolve INFO items before SimliBridge / TavusBridge code.');
  process.exit(0);
})();
