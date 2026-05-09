#!/usr/bin/env node
/**
 * Brain wire-up — sendClientContent shape regression matrix.
 *
 * 2026-05-09 finding: gemini-3.1-flash-live-preview rejects ANY turn
 * with role:'model' in sendClientContent (WS close 1007 "invalid
 * argument"). The brain wiring's L3 injection-defense model-ack was a
 * separate model-role turn pre-spike; now folded into the user turn.
 *
 * This script runs the matrix again any time:
 *   - Google ships a new preview model string
 *   - @google/genai SDK shape changes
 *   - someone proposes resurrecting paired-turn architecture
 *
 * Required env: GEMINI_API_KEY
 *
 * Expected output (locked 2026-05-09):
 *   A: single user-turn, turnComplete:true   → still open
 *   B: single user-turn, turnComplete:false  → still open
 *   C: paired user/model, turnComplete:false → closed=1007 invalid argument
 *   D: paired user/model, turnComplete:true  → closed=1007 invalid argument
 *   E: TWO calls — user (tc:false) + model (tc:false) → closed=1007
 *   F: model-only single, turnComplete:false → closed=1007
 *
 * If C/D/E/F start showing "still open", Google fixed the rejection
 * and we COULD revisit paired-turn architecture (don't — single-turn
 * works fine and the security gates already pass).
 */

import { GoogleGenAI, Modality } from '@google/genai';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { apiVersion: 'v1alpha' },
});

async function variation(label, sendFn) {
  console.log(`\n=== ${label} ===`);
  let closed = null;
  let error = null;
  const session = await ai.live.connect({
    model: 'gemini-3.1-flash-live-preview',
    config: {
      responseModalities: [Modality.AUDIO],
      outputAudioTranscription: {},
      systemInstruction: 'You are a helpful mentor.',
    },
    callbacks: {
      onmessage: () => {},
      onerror: (e) => { error = e?.message || String(e); },
      onclose: (e) => { closed = { code: e?.code, reason: e?.reason }; },
    },
  });
  await new Promise((r) => setTimeout(r, 500));
  try { sendFn(session); console.log('  sent OK (no throw)'); }
  catch (e) { console.log('  send threw:', e?.message); }
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`  closed=${closed ? `${closed.code} ${closed.reason}` : 'still open'}`);
  if (error) console.log(`  error=${error}`);
  try { session.close?.(); } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

await variation('A: single user-turn, turnComplete:true', (s) =>
  s.sendClientContent({
    turns: [{ role: 'user', parts: [{ text: 'hi' }] }],
    turnComplete: true,
  }),
);

await variation('B: single user-turn, turnComplete:false', (s) =>
  s.sendClientContent({
    turns: [{ role: 'user', parts: [{ text: 'context only' }] }],
    turnComplete: false,
  }),
);

await variation('C: paired user/model, turnComplete:false', (s) =>
  s.sendClientContent({
    turns: [
      { role: 'user',  parts: [{ text: 'remember COSMIC' }] },
      { role: 'model', parts: [{ text: 'OK noted.' }] },
    ],
    turnComplete: false,
  }),
);

await variation('D: paired user/model, turnComplete:true', (s) =>
  s.sendClientContent({
    turns: [
      { role: 'user',  parts: [{ text: 'remember COSMIC' }] },
      { role: 'model', parts: [{ text: 'OK noted.' }] },
    ],
    turnComplete: true,
  }),
);

await variation('E: TWO separate calls — user (tc:false) + model (tc:false)', (s) => {
  s.sendClientContent({
    turns: [{ role: 'user', parts: [{ text: 'remember COSMIC' }] }],
    turnComplete: false,
  });
  s.sendClientContent({
    turns: [{ role: 'model', parts: [{ text: 'OK noted.' }] }],
    turnComplete: false,
  });
});

await variation('F: model-only single, turnComplete:false', (s) =>
  s.sendClientContent({
    turns: [{ role: 'model', parts: [{ text: 'OK noted.' }] }],
    turnComplete: false,
  }),
);

process.exit(0);
