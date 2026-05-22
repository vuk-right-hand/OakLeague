#!/usr/bin/env node
/**
 * DECOUPLED_STT_OUTPUT_COST_PLAN — Spike S11 (cost lever after TEXT + "ok" both fail).
 *
 * S1: TEXT output rejected (1011). S10: "reply ok" neuter breaks turn_complete
 * (never fires / one-turn lag) — degenerate minimization destabilizes the
 * lifecycle. This tests the MIDDLE ground: cap output at the API level with a
 * NORMAL systemInstruction, so the model produces a real-but-short answer (cheap)
 * WITHOUT a degenerate instruction. Question: does Gemini Live honor
 * maxOutputTokens, and does turn_complete stay reliable when the cap (not an
 * instruction) shortens the output?
 *
 * Tests maxOutputTokens both top-level and under generationConfig (docs silent on
 * which the Live config accepts), plus a "one short sentence" instruction control.
 *
 * NOT a cogs_log writer. Throwaway.
 * Run: node --env-file=.env.local scripts/decoupled-stt-maxtokens-spike.mjs
 */

import { GoogleGenAI, Modality } from '@google/genai';
import { readFileSync } from 'node:fs';

const MODEL = process.env.VOICE_MODEL || 'gemini-3.1-flash-live-preview';
const TURNS = 3;
const PCM = readFileSync('public/spike-a/canned-question.pcm');
// Audit M1 — a >15s utterance (forum 107385 truncates input transcription after
// ~100 chunks). The cap caps OUTPUT, a separate stream — but prove it: stitch the
// 3.6s clip ×5 ≈ 18s and confirm input transcription + turn_complete survive WITH
// the cap on. LONG=1 swaps the canned clip for the stitched one.
const LONG_PCM = Buffer.concat([PCM, PCM, PCM, PCM, PCM]); // ≈17.8s
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: 'v1alpha' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MENTOR = 'You are a helpful mentor. Answer in one concise sentence.';

async function runMode(label, extraConfig, { long = false } = {}) {
  const clip = long ? LONG_PCM : PCM;
  console.log(`\n──── ${label} ────`);
  console.log(`  extra config: ${JSON.stringify(extraConfig)} audio=${(clip.length / 32000).toFixed(1)}s`);
  let closed = null, setupComplete = false;
  let turn = { outBytes: 0, inText: '', usage: null, tcAt: null };
  let resolveTc = null;

  let session;
  try {
    session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        systemInstruction: MENTOR,
        ...extraConfig,
      },
      callbacks: {
        onmessage: (m) => {
          if (m?.setupComplete) setupComplete = true;
          const it = m?.serverContent?.inputTranscription?.text; if (it) turn.inText += it;
          const parts = m?.serverContent?.modelTurn?.parts;
          if (Array.isArray(parts)) for (const p of parts) if (p?.inlineData?.data) turn.outBytes += Math.floor(p.inlineData.data.length * 0.75);
          if (m?.usageMetadata) turn.usage = m.usageMetadata;
          if (m?.serverContent?.turnComplete) { turn.tcAt = performance.now(); if (resolveTc) resolveTc('turn_complete'); }
        },
        onerror: (e) => console.log(`  [error] ${e?.message || e}`),
        onclose: (e) => { closed = { code: e?.code, reason: e?.reason }; if (resolveTc) resolveTc(`closed_${e?.code}`); },
      },
    });
  } catch (e) { console.log(`  connect THREW: ${e?.message || e}`); return; }

  for (let i = 0; i < 100 && !setupComplete && !closed; i++) await sleep(100);
  if (!setupComplete) { console.log(`  FAIL setup — closed=${closed ? `${closed.code} "${closed.reason}"` : 'n/a'}`); try { session.close?.(); } catch {} return; }

  for (let t = 1; t <= TURNS; t++) {
    if (closed) { console.log(`  turn ${t}: socket CLOSED (${closed.code}) — abort`); break; }
    turn = { outBytes: 0, inText: '', usage: null, tcAt: null };
    const tcP = new Promise((r) => { resolveTc = r; });
    session.sendRealtimeInput({ activityStart: {} });
    for (let off = 0; off < clip.length; off += 3200) {
      try { session.sendRealtimeInput({ audio: { data: clip.subarray(off, off + 3200).toString('base64'), mimeType: 'audio/pcm;rate=16000' } }); } catch {}
      await sleep(20);
    }
    const tEnd = performance.now();
    session.sendRealtimeInput({ activityEnd: {} });
    const outcome = await Promise.race([tcP, sleep(20000).then(() => 'TIMEOUT_20s')]);
    resolveTc = null;
    const tcMs = turn.tcAt ? Math.round(turn.tcAt - tEnd) : null;
    console.log(`  turn ${t}: outcome=${outcome} tc_ms=${tcMs ?? 'na'} outBytes=${turn.outBytes} (${(turn.outBytes / 48000).toFixed(2)}s) respTok=${turn.usage?.responseTokenCount ?? 'na'} transcriptLen=${turn.inText.length} transcript="${turn.inText.slice(0, 60).replace(/\n/g, ' ')}…"`);
    await sleep(800);
  }
  console.log(`  socket end-state: ${closed ? `CLOSED ${closed.code}` : 'still open'}`);
  try { session.close?.(); } catch {}
  await sleep(500);
}

console.log(`model=${MODEL} turns=${TURNS}`);
// Pin the production-safe TOP-LEVEL value (generationConfig is deprecated).
// 8 was flaky, 32 was clean — map the floor with 4 turns each for confidence.
await runMode('maxOutputTokens=24 (top-level, ~3.6s utterance)', { maxOutputTokens: 24 });
// Audit M1 — does the cap perturb input transcription on a >15s utterance?
await runMode('maxOutputTokens=24 (top-level, ~18s utterance)', { maxOutputTokens: 24 }, { long: true });
process.exit(0);
