#!/usr/bin/env node
/**
 * DECOUPLED_STT_OUTPUT_COST_PLAN — Spike S1 (+ early S5/S6 signal).
 *
 * THE decisive unknown: does `gemini-3.1-flash-live-preview` accept
 * `responseModalities:[TEXT]` TODAY? Phase 0 (2026-04-22) found it REJECTED
 * `[TEXT]` with "Internal error encountered." on open. The model page now
 * lists outputs as "Text and audio". A month-old negative on a moving preview
 * must be re-tested before we build Layer 2 Path A (TEXT output).
 *
 * If TEXT connects AND generates text AND still emits inputTranscription +
 * turnComplete → Path A is alive (cheapest, cleanest cost fix).
 * If TEXT is rejected at open → Path A dead; fall back to Path B (AUDIO "ok").
 *
 * NOT a cogs_log writer. Throwaway diagnostic. Read-only against Gemini.
 * Run: node --env-file=.env.local scripts/decoupled-stt-text-mode-spike.mjs
 * Required env: GEMINI_API_KEY
 */

import { GoogleGenAI, Modality } from '@google/genai';

const MODEL = process.env.VOICE_MODEL || 'gemini-3.1-flash-live-preview';
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { apiVersion: 'v1alpha' },
});

// Try to connect with a given config; report open vs close-code/reason vs error.
async function tryConnect(label, config, { probe = false } = {}) {
  console.log(`\n=== ${label} ===`);
  console.log('  config:', JSON.stringify(config, (k, v) => (k === 'systemInstruction' && typeof v === 'string' ? v.slice(0, 40) + '…' : v)));
  let closed = null;
  let error = null;
  let setupComplete = false;
  const events = [];
  let session;
  try {
    session = await ai.live.connect({
      model: MODEL,
      config,
      callbacks: {
        onmessage: (m) => {
          if (m?.setupComplete) { setupComplete = true; events.push('setupComplete'); }
          const it = m?.serverContent?.inputTranscription?.text;
          if (it) events.push(`inputTranscription="${it.slice(0, 40)}"`);
          const ot = m?.serverContent?.outputTranscription?.text;
          if (ot) events.push(`outputTranscription="${ot.slice(0, 40)}"`);
          const parts = m?.serverContent?.modelTurn?.parts;
          if (Array.isArray(parts)) {
            for (const p of parts) {
              if (typeof p?.text === 'string') events.push(`modelTurn.text="${p.text.slice(0, 40)}"`);
              if (p?.inlineData?.mimeType) events.push(`modelTurn.audio(${p.inlineData.mimeType})`);
            }
          }
          if (m?.serverContent?.turnComplete) events.push('turnComplete');
          if (m?.usageMetadata) {
            const u = m.usageMetadata;
            events.push(`usage(prompt=${u.promptTokenCount ?? '?'} resp=${u.responseTokenCount ?? '?'} total=${u.totalTokenCount ?? '?'})`);
          }
        },
        onerror: (e) => { error = e?.message || String(e); },
        onclose: (e) => { closed = { code: e?.code, reason: e?.reason }; },
      },
    });
  } catch (e) {
    console.log(`  connect() THREW: ${e?.message || e}`);
    return;
  }

  // Give setup_complete / immediate-close time to land.
  await new Promise((r) => setTimeout(r, 1500));

  if (probe && setupComplete && !closed) {
    // Early S5/S6 signal: send a text user-turn (turnComplete:true triggers
    // generation) and watch what comes back — does TEXT mode generate text,
    // emit turnComplete, and report responseTokenCount?
    try {
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: 'In one short sentence, what is a good morning routine?' }] }],
        turnComplete: true,
      });
      console.log('  probe: sent text user-turn (turnComplete:true)');
    } catch (e) {
      console.log('  probe send threw:', e?.message);
    }
    await new Promise((r) => setTimeout(r, 6000));
  }

  console.log(`  setupComplete=${setupComplete}`);
  console.log(`  closed=${closed ? `${closed.code} "${closed.reason}"` : 'still open'}`);
  if (error) console.log(`  error=${error}`);
  if (events.length) console.log(`  events:\n    ${events.join('\n    ')}`);
  try { session.close?.(); } catch {}
  await new Promise((r) => setTimeout(r, 400));
}

console.log(`model=${MODEL} apiVersion=v1alpha`);

// A — CONTROL: AUDIO + outputAudioTranscription (today's α' shape). Must open.
await tryConnect('A (control): AUDIO + outputAudioTranscription', {
  responseModalities: [Modality.AUDIO],
  outputAudioTranscription: {},
  systemInstruction: 'You are a helpful mentor.',
});

// B — TEXT only (the raw Phase-0 re-test).
await tryConnect('B: TEXT only', {
  responseModalities: [Modality.TEXT],
  systemInstruction: 'You are a helpful mentor.',
});

// C — TEXT + inputAudioTranscription (the decoupled config we'd actually ship),
//     with a generation probe.
await tryConnect('C: TEXT + inputAudioTranscription (decoupled shape) + probe', {
  responseModalities: [Modality.TEXT],
  inputAudioTranscription: {},
  systemInstruction: 'You are a transcription relay.',
}, { probe: true });

// D — TEXT + inputAudioTranscription + manual VAD (S3: legal at connect?).
await tryConnect('D: TEXT + inputAudioTranscription + manual VAD', {
  responseModalities: [Modality.TEXT],
  inputAudioTranscription: {},
  realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
  systemInstruction: 'You are a transcription relay.',
});

process.exit(0);
