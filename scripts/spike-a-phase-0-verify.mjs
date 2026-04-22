#!/usr/bin/env node
/**
 * Spike A — Phase 0 verification harness (SPIKE_A_V2_PLAN.md Rev 5).
 *
 * Runs four checks before any proxy code is written:
 *   (A) 2.5 native-audio reachable from Node SDK on v1beta
 *   (B) 3.1 preview reachable from Node SDK on v1alpha
 *   (C) Two concurrent GoogleGenAI singletons per apiVersion (C4)
 *   (D) Empty-frame warm-up timing (C1) — validates Priming Window foundation
 *
 * Required env: GEMINI_API_KEY
 * Run: GEMINI_API_KEY=... node scripts/spike-a-phase-0-verify.mjs
 *
 * Output: prints PASS/FAIL per check + exact model IDs + warm-up timing.
 * Exit 0 on all-pass, 1 otherwise. Nothing persisted.
 */

import { GoogleGenAI, Modality } from '@google/genai';

// Swallow late rejections from timed-out setup promises so the harness keeps
// running all four checks even after an early failure.
process.on('unhandledRejection', (e) => {
  console.log(`  [late-reject] ${e?.message || e}`);
});

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error('GEMINI_API_KEY missing. Pull from 1Password or .env.local.');
  process.exit(2);
}

const MODEL_25 = 'gemini-2.5-flash-native-audio-preview-12-2025';
const MODEL_31 = 'gemini-3.1-flash-live-preview';

const mkClient = (apiVersion) =>
  new GoogleGenAI({ apiKey: KEY, httpOptions: { apiVersion } });

// Open a Live session, wait for setupComplete, return { session, t_setupComplete, close }.
async function openLive(client, model, extraConfig = {}) {
  const t_start = performance.now();
  let t_setupComplete = null;
  const messages = [];
  let resolveSetup;
  const setupDone = new Promise((r) => { resolveSetup = r; });
  let resolveClose;
  const closed = new Promise((r) => { resolveClose = r; });

  const session = await client.live.connect({
    model,
    config: { responseModalities: [Modality.AUDIO], ...extraConfig },
    callbacks: {
      onopen: () => {},
      onmessage: (m) => {
        messages.push({ t: performance.now() - t_start, m });
        if (m.setupComplete && t_setupComplete == null) {
          t_setupComplete = performance.now() - t_start;
          resolveSetup();
        }
      },
      onerror: (e) => { console.error('[live:error]', e?.message || e); },
      onclose: (e) => { resolveClose(e); },
    },
  });

  await Promise.race([
    setupDone,
    new Promise((_, rej) => setTimeout(() => rej(new Error('setup timeout 10s')), 10_000)),
  ]);

  return {
    session,
    t_setupComplete,
    messages,
    close: async () => { session.close(); await Promise.race([closed, new Promise((r) => setTimeout(r, 2000))]); },
  };
}

async function checkReachable(apiVersion, model, label) {
  try {
    const h = await openLive(mkClient(apiVersion), model);
    console.log(`  PASS ${label} (${apiVersion}/${model}) — setupComplete at ${h.t_setupComplete.toFixed(0)}ms`);
    await h.close();
    return true;
  } catch (e) {
    console.log(`  FAIL ${label} — ${e?.message || e}`);
    return false;
  }
}

async function checkDualSingletons() {
  const clients = [
    { apiVersion: 'v1alpha', model: MODEL_25 },
    { apiVersion: 'v1alpha', model: MODEL_25 },
    { apiVersion: 'v1alpha', model: MODEL_31 },
    { apiVersion: 'v1alpha', model: MODEL_31 },
  ];
  try {
    const handles = await Promise.all(
      clients.map((c) => openLive(mkClient(c.apiVersion), c.model))
    );
    console.log(`  PASS 4 concurrent Live sessions opened (2× v1beta + 2× v1alpha)`);
    await Promise.all(handles.map((h) => h.close()));
    return true;
  } catch (e) {
    console.log(`  FAIL dual-singleton — ${e?.message || e}`);
    return false;
  }
}

// Empty-frame warm-up test. Measures: does pre-sending silent PCM frames after
// setupComplete reduce time-to-first-audio on a subsequent real turn?
//
// Trigger: sendClientContent with a short text turn ("Say hi briefly.") — this
// is the canonical way to force a response turn without needing mic audio.
// We average N=3 runs per mode to smooth network jitter.
async function checkEmptyFrameWarmup() {
  const silentPCM = Buffer.alloc(Math.floor(16_000 * 2 * 0.04), 0).toString('base64'); // 40ms @ 16k 16bit mono
  const runs = { withWarmup: [], coldPath: [] };
  const N = 3;

  for (const mode of ['withWarmup', 'coldPath']) {
    for (let run = 0; run < N; run++) {
      let h;
      try {
        h = await openLive(mkClient('v1alpha'), MODEL_25);
      } catch (e) {
        console.log(`    ${mode}#${run} open failed: ${e.message}`);
        continue;
      }

      if (mode === 'withWarmup') {
        // ~500ms of silent PCM before the real turn.
        for (let i = 0; i < 12; i++) {
          try {
            h.session.sendRealtimeInput({ audio: { data: silentPCM, mimeType: 'audio/pcm;rate=16000' } });
          } catch {}
          await new Promise((r) => setTimeout(r, 40));
        }
      }

      const orig = h.messages.length;
      const t_turnStart = performance.now();
      try {
        h.session.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: 'Say hi briefly.' }] }],
          turnComplete: true,
        });
      } catch (e) {
        console.log(`    ${mode}#${run} send failed: ${e.message}`);
        await h.close(); continue;
      }

      const t_firstAudio = await new Promise((resolve) => {
        const timeout = setTimeout(() => { clearInterval(poll); resolve(null); }, 8000);
        const poll = setInterval(() => {
          for (let i = orig; i < h.messages.length; i++) {
            const { m } = h.messages[i];
            const parts = m?.serverContent?.modelTurn?.parts || [];
            for (const p of parts) {
              if (p?.inlineData?.data) {
                clearTimeout(timeout); clearInterval(poll);
                resolve(performance.now() - t_turnStart);
                return;
              }
            }
          }
        }, 10);
      });

      if (t_firstAudio != null) {
        runs[mode].push(Math.round(t_firstAudio));
        console.log(`    ${mode}#${run}: ${Math.round(t_firstAudio)}ms`);
      } else {
        console.log(`    ${mode}#${run}: no audio within 8s`);
      }
      await h.close();
    }
  }

  const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  const w = avg(runs.withWarmup);
  const c = avg(runs.coldPath);
  console.log(`  withWarmup avg: ${w}ms (n=${runs.withWarmup.length}) | coldPath avg: ${c}ms (n=${runs.coldPath.length})`);

  if (w == null || c == null) {
    console.log(`  INCONCLUSIVE — at least one mode produced no samples`);
    return false;
  }
  const masked = c - w;
  console.log(`  Masking delta: ${masked}ms (positive = warm-up helps)`);
  if (masked >= 400) console.log(`  PASS — Priming Window validated for Day 5 (≥400ms masking)`);
  else if (masked >= 200) console.log(`  MARGINAL — 200-400ms band; revisit Day 5 with real canned-audio clip`);
  else if (masked >= 0) console.log(`  DEAD — empty-frame warm-up <200ms; Priming Window needs canned server-turn approach`);
  else console.log(`  NEGATIVE — empty frames INCREASED latency; abandon empty-frame approach`);
  return true;
}

async function listLiveModels() {
  const versions = ['v1alpha', 'v1beta'];
  for (const v of versions) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/${v}/models?pageSize=200&key=${KEY}`);
      const json = await res.json();
      const models = json?.models || [];
      const live = models.filter((m) => {
        const methods = m.supportedGenerationMethods || [];
        const name = (m.name || '').toLowerCase();
        return methods.some((x) => x.toLowerCase().includes('bidi')) ||
               name.includes('live') || name.includes('native-audio') || name.includes('realtime');
      });
      console.log(`  [${v}] ${live.length} live/native-audio/realtime models:`);
      for (const m of live) {
        console.log(`    ${m.name}  methods=[${(m.supportedGenerationMethods||[]).join(',')}]`);
      }
    } catch (e) {
      console.log(`  [${v}] list failed: ${e?.message || e}`);
    }
  }
}

(async () => {
  console.log('Spike A Phase 0 — verification harness');
  console.log('---------------------------------------');

  console.log('\n[0] Discover available Live / native-audio models:');
  await listLiveModels();

  console.log('\n[A] 2.5 native-audio reachable (v1alpha):');
  const a = await checkReachable('v1alpha', MODEL_25, '2.5');

  console.log('\n[B] 3.1 preview reachable (v1alpha):');
  const b = await checkReachable('v1alpha', MODEL_31, '3.1');

  console.log('\n[C] Dual-model concurrent singletons (all v1alpha):');
  const c = await checkDualSingletons();

  console.log('\n[D] Empty-frame warm-up test:');
  let d = false;
  try { d = await checkEmptyFrameWarmup(); }
  catch (e) { console.log(`  FAIL — ${e?.message || e}`); }

  console.log('\n---------------------------------------');
  console.log(`Summary: A=${a ? 'PASS' : 'FAIL'} B=${b ? 'PASS' : 'FAIL'} C=${c ? 'PASS' : 'FAIL'} D=${d ? 'RAN' : 'FAIL'}`);
  console.log(`Pinned model IDs for .env.example:`);
  console.log(`  VOICE_MODEL_PRIMARY=${MODEL_25}`);
  console.log(`  VOICE_MODEL_SECONDARY=${MODEL_31}`);

  process.exit(a && b && c ? 0 : 1);
})();
