#!/usr/bin/env node
/**
 * DECOUPLED_STT_OUTPUT_COST_PLAN — Spike S10 (Path B make-or-break).
 *
 * TEXT output is dead (S1: 1011 on this preview). The only remaining cost lever
 * is the AUDIO "ok" neuter. The prior attempt KILLED the session — but the proxy
 * was BLOCKING on turn_complete (Layer 1 removes that). The open Gemini-side
 * question this spike answers, standalone, before any Layer 1 code:
 *
 *   Does a minimal-output systemInstruction ("reply ok") make `turn_complete`
 *   slow / unreliable across a multi-turn session (the agent's "starving
 *   destabilizes the socket" hypothesis), or was that confounded by the
 *   source_type retrieval bug firing in that same session?
 *
 * Method: AUDIO mode + manual VAD + inputAudioTranscription (the decoupled
 * shape). A/B over N turns feeding the SAME canned question each turn:
 *   BASELINE — normal mentor systemInstruction (full discarded answer)
 *   NEUTER   — "reply with exactly one word: ok"
 * Per turn measure: turn_complete fired? activityEnd→turn_complete ms?
 * discarded output bytes? responseTokenCount? input transcript intact?
 * socket survives all turns?
 *
 * NOT a cogs_log writer. Throwaway. Run:
 *   node --env-file=.env.local scripts/decoupled-stt-ok-neuter-spike.mjs
 */

import { GoogleGenAI, Modality } from '@google/genai';
import { readFileSync } from 'node:fs';

const MODEL = process.env.VOICE_MODEL || 'gemini-3.1-flash-live-preview';
const TURNS = 4;
const PCM = readFileSync('public/spike-a/canned-question.pcm'); // 16k/16bit/mono
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: 'v1alpha' } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runMode(label, systemInstruction) {
  console.log(`\n──── ${label} ────`);
  console.log(`  systemInstruction: "${systemInstruction}"`);
  let closed = null;
  let setupComplete = false;
  // per-turn accumulators, reset at each activityStart
  let turn = { outBytes: 0, inText: '', outText: '', usage: null, turnCompleteAt: null };
  let resolveTurnComplete = null;

  const session = await ai.live.connect({
    model: MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      systemInstruction,
    },
    callbacks: {
      onmessage: (m) => {
        if (m?.setupComplete) setupComplete = true;
        const it = m?.serverContent?.inputTranscription?.text;
        if (it) turn.inText += it;
        const ot = m?.serverContent?.outputTranscription?.text;
        if (ot) turn.outText += ot;
        const parts = m?.serverContent?.modelTurn?.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (p?.inlineData?.data) turn.outBytes += Math.floor(p.inlineData.data.length * 0.75);
          }
        }
        if (m?.usageMetadata) turn.usage = m.usageMetadata;
        if (m?.serverContent?.turnComplete) {
          turn.turnCompleteAt = performance.now();
          if (resolveTurnComplete) resolveTurnComplete('turn_complete');
        }
      },
      onerror: (e) => console.log(`  [error] ${e?.message || e}`),
      onclose: (e) => {
        closed = { code: e?.code, reason: e?.reason };
        if (resolveTurnComplete) resolveTurnComplete(`closed_${e?.code}`);
      },
    },
  });

  // wait setupComplete
  for (let i = 0; i < 100 && !setupComplete && !closed; i++) await sleep(100);
  if (!setupComplete) { console.log(`  FAIL setup — closed=${closed ? closed.code : 'n/a'}`); try { session.close?.(); } catch {} return; }

  for (let t = 1; t <= TURNS; t++) {
    if (closed) { console.log(`  turn ${t}: socket already CLOSED (${closed.code} "${closed.reason}") — aborting mode`); break; }
    turn = { outBytes: 0, inText: '', outText: '', usage: null, turnCompleteAt: null };
    const tcPromise = new Promise((r) => { resolveTurnComplete = r; });

    session.sendRealtimeInput({ activityStart: {} });
    // feed canned audio in 100ms (3200-byte) chunks, paced
    for (let off = 0; off < PCM.length; off += 3200) {
      try {
        session.sendRealtimeInput({
          audio: { data: PCM.subarray(off, off + 3200).toString('base64'), mimeType: 'audio/pcm;rate=16000' },
        });
      } catch (e) { console.log(`  turn ${t}: sendAudio threw ${e?.message}`); }
      await sleep(20);
    }
    const tEnd = performance.now();
    session.sendRealtimeInput({ activityEnd: {} });

    const outcome = await Promise.race([tcPromise, sleep(25000).then(() => 'TIMEOUT_25s')]);
    resolveTurnComplete = null;
    const tcMs = turn.turnCompleteAt ? Math.round(turn.turnCompleteAt - tEnd) : null;
    console.log(
      `  turn ${t}: outcome=${outcome} tc_ms=${tcMs ?? 'na'} ` +
      `discardedOutBytes=${turn.outBytes} (${(turn.outBytes / 48000).toFixed(2)}s) ` +
      `respTok=${turn.usage?.responseTokenCount ?? 'na'} ` +
      `inputTranscript="${turn.inText.slice(0, 50).replace(/\n/g, ' ')}"`,
    );
    await sleep(800); // brief gap between turns
  }

  console.log(`  socket end-state: ${closed ? `CLOSED ${closed.code} "${closed.reason}"` : 'still open'}`);
  try { session.close?.(); } catch {}
  await sleep(500);
}

console.log(`model=${MODEL} turns=${TURNS} audio=${(PCM.length / 32000).toFixed(2)}s/turn`);
await runMode('BASELINE (full discarded answer)', 'You are a helpful mentor. Answer in one concise sentence.');
await runMode('NEUTER ("reply ok")', 'You are a transcription relay. Reply with exactly one word: ok. Never say anything else.');
process.exit(0);
