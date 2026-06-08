#!/usr/bin/env node
// scripts/fish-audio-spike.mjs
// Phase 0 quality spike. Generates Vuk's-voice TTS samples via Fish Audio
// (cloned voice baa1fcbdb14d4bb492af632c1cb17ace) across a mix of sentence
// shapes. Outputs WAV files in tmp/fish-spike/ for A/B listening against the
// current Cartesia clone.
//
// One-off. Authorized by Vuk 2026-05-28. Reads FISH_API_KEY + FISH_TTS_MODEL
// from .env.local. Total spend should be well under $1 (~5000 chars).
//
// Usage: node scripts/fish-audio-spike.mjs [voiceId]
//   voiceId defaults to Vuk's cloned voice.

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Manual .env.local loader (same pattern as simli-cogs-crossref.mjs).
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) continue;
  if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const API_KEY = process.env.FISH_API_KEY;
const MODEL = process.env.FISH_TTS_MODEL || 's2-pro';
const USD_PER_CHAR = Number(process.env.FISH_USD_PER_CHAR || '0.000015');

if (!API_KEY) { console.error('missing FISH_API_KEY in .env.local'); process.exit(1); }

const VOICE_ID = process.argv[2] || 'baa1fcbdb14d4bb492af632c1cb17ace';

// Output dir. tmp/ is already gitignored (or should be) — these WAVs are
// throwaway listening samples, not committed.
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'tmp', 'fish-spike');
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

// Test sentences — mix of categories that exercise the parts of Vuk's voice
// most likely to break or shine:
//   1. Short factual           — baseline acoustic identity
//   2. Long explanatory        — sustained prosody + breath control
//   3. Emotional / storytelling — pauses, restraint, weight
//   4. Technical jargon         — pronunciation of brand/API names
//   5. Pauses + emphasis        — beats and stress
//   6. Conversational rhythm    — "yeah", "honestly", filler cadence
//   7. Number-heavy             — number readout naturalness
//   8. Long w/ breath beats     — full-paragraph endurance + breaths
const SENTENCES = [
  { id: '01-short-factual', text: "I'm Vuk, founder of OakLeague. We build interactive AI mentorship at scale." },
  { id: '02-long-explanatory', text: "When I think about what makes a great founder, it's not the idea — it's the obsession. The willingness to grind for years on something that ninety percent of people will dismiss as crazy. That's the bar." },
  { id: '03-emotional-storytelling', text: "I'll tell you something. The hardest year of my life was the year nobody listened. Every meeting was a no. Every investor was polite but distant. And I had to wake up every morning and convince myself it was still worth showing up." },
  { id: '04-technical-jargon', text: "The architecture is decoupled: Gemini 3.1 Flash Live handles speech-to-text, then a separate brain layer runs RAG retrieval before we hit Cartesia — soon Fish Audio — for synthesis." },
  { id: '05-pauses-emphasis', text: "Look. There's no shortcut. None. The only thing that compounds is showing up, every single day, when you'd rather quit." },
  { id: '06-conversational-rhythm', text: "Yeah, I get that a lot. People ask me how I stay motivated. Honestly? Most days I'm not. I just don't stop." },
  { id: '07-number-heavy', text: "We did three thousand sessions in the first month, with average session length of one minute forty-two seconds, and a sixty-three percent week-two retention." },
  { id: '08-paragraph-endurance', text: "Here's the deal. You can spend ten years optimizing for safety. Or you can spend two years building something that matters. The math isn't close. The hard part is convincing your nervous system. Your brain will scream that the safe path is the smart one. It isn't. It's just the one with fewer surprises." },
];

const ENDPOINT = 'https://api.fish.audio/v1/tts';

async function synth(sentence) {
  const body = {
    text: sentence.text,
    reference_id: VOICE_ID,
    format: 'wav',
    latency: 'normal',
    // omit sample_rate — defaults to 44.1kHz for wav, best for headphone A/B
    // omit temperature/top_p — use defaults (0.7/0.7)
  };

  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'model': MODEL,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '<no body>');
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt.slice(0, 400)}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const elapsedMs = Date.now() - t0;
  const outPath = join(OUT_DIR, `${sentence.id}.wav`);
  writeFileSync(outPath, buf);
  return { bytes: buf.length, elapsedMs, outPath };
}

console.log(`\n== Fish Audio S2-Pro spike (voice ${VOICE_ID.slice(0, 8)}…) ==\n`);

let totalChars = 0;
let totalBytes = 0;
let totalElapsed = 0;
let errors = 0;

for (const s of SENTENCES) {
  const charCount = Buffer.byteLength(s.text, 'utf8');
  totalChars += charCount;
  try {
    const r = await synth(s);
    totalBytes += r.bytes;
    totalElapsed += r.elapsedMs;
    console.log(`  ${s.id.padEnd(28)}  chars=${String(charCount).padStart(4)}  ttfa+full=${String(r.elapsedMs).padStart(5)}ms  audio=${(r.bytes / 1024).toFixed(1).padStart(6)} KB  → ${r.outPath.replace(/^.*tmp/, 'tmp')}`);
  } catch (e) {
    errors += 1;
    console.error(`  ${s.id.padEnd(28)}  ✗ ${e.message}`);
  }
}

const estCost = totalChars * USD_PER_CHAR;

console.log(`\nTOTAL: ${SENTENCES.length} sentences · ${totalChars} chars · ${(totalBytes / 1024).toFixed(1)} KB audio · est cost $${estCost.toFixed(4)} (@ $${USD_PER_CHAR}/char)`);
if (errors > 0) console.log(`ERRORS: ${errors}`);
console.log(`\nListen: open ${OUT_DIR} in your file explorer, play each in order.`);
console.log(`A/B against your current Cartesia clone — does it pass the "exactly him" bar?\n`);
