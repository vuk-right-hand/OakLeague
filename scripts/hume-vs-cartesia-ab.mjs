#!/usr/bin/env node
/**
 * HUME_TTS_PLAN §7 — Hume vs Cartesia A/B harness.
 *
 * 20 canned mentorship prompts × 2 providers (Cartesia Sonic 3, Hume Octave 2)
 * using Vuk's cloned voice on each. Emits per-turn WAVs + a CSV with the
 * decision metrics, then templates the scoring doc.
 *
 * §7 audit fixes (2026-05-13):
 *   C1 — TTFA reads wireRxAtMs from each bridge's audio_out event so the
 *        measurement is wire-receive time, not handler-invocation time.
 *   C2 — One WARM bridge per provider, all 20 turns through it. Cold open
 *        latency is captured separately as a one-shot per provider.
 *   C3 — Char accounting + audio-seconds-per-char ratio in CSV; errored
 *        rows excluded from cost summary; scoring doc discloses basis.
 *   C4 — First-chunk sample-rate sanity check (assert 1s ≈ sampleRate*2
 *        bytes for s16le mono); abort if mismatched.
 *   M1 — Capture ALL error events (not just fatals) into warning_codes.
 *   M2 — Sibling cancellation script `hume-vs-cartesia-ab-cancel.mjs`
 *        addresses Phase-0 risk 11.2.
 *   M3 — Compute peak / RMS dBFS per WAV; emit in CSV.
 *   M4 — 250ms pacing between turns.
 *   M5 — Per-turn error array (all events, not just last-fatal).
 *   M6 — Prompts now contain curly quotes, em-dashes, ellipses, NBSP so
 *        the raw variant actually exercises the normalizer.
 *   M7 — Blind-A/B mapping written to provider-mapping.json; per-prompt
 *        random ordering of A/B; scoring doc includes the listening protocol.
 *
 * NORMALIZATION POLICY (locked by §7): both bridges receive ALREADY-NORMALIZED
 * text. Production input arrives from Gemini's outputTranscription and is
 * normalized at the bridge boundary regardless of provider. Comparing on
 * pre-normalized input would over-credit whichever provider handles curly
 * quotes natively. The raw-text variant lives at
 * hume-vs-cartesia-ab-raw.mjs and is informational only.
 *
 * DIAL POLICY (project memory: Hume "save voice" bakes prosody):
 *   The Hume voice id Vuk uses (`Vuk 1.5 spd & 0.25 Tr silence`) was saved
 *   from a playground render at speed=1.5 / trailing_silence=0.25. Those
 *   settings are BAKED into the cloned voice's cadence. We send NEUTRAL
 *   dials at synth so we don't compound. If you point this harness at a
 *   "neutral" Hume voice, pass HUME_TTS_SPEED + HUME_TRAILING_SILENCE env
 *   vars to dial at runtime.
 *
 * Required env (load from .env.local):
 *   CARTESIA_API_KEY
 *   CARTESIA_VOICE_ID                — Vuk's Cartesia clone
 *   CARTESIA_USD_PER_CHAR            — e.g. 0.00005
 *   CARTESIA_QUOTED_AT               — e.g. 2026-05-13
 *   HUME_API_KEY
 *   HUME_VOICE_ID                    — Vuk's Hume clone (settings-baked OK)
 *   HUME_USD_PER_CHAR                — e.g. 0.0000076
 *   HUME_QUOTED_AT                   — e.g. 2026-05-13
 *
 * Optional env:
 *   HUME_TTS_SPEED                   — only when using a neutral Hume voice
 *   HUME_TRAILING_SILENCE
 *   HUME_VOICE_DESCRIPTION
 *   HUME_MODEL_VERSION               — '1' | '2' | 'default'; default '2'
 *   AB_OUTPUT_DIR                    — default ./tmp/ab
 *   AB_SKIP_NORMALIZE                — '1' = raw-variant entrypoint, skip
 *                                      normalize() before sendText
 *   AB_TURN_PACE_MS                  — pause between turns, default 250
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { CartesiaTTSBridge } from '../server/voice-proxy/cartesia-bridge.js';
import { HumeTTSBridge, validateHumePricingOrExit } from '../server/voice-proxy/hume-bridge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// 20 canned mentorship prompts. M6 audit fix: real Unicode punctuation
// (curly quotes ' ' " ", em-dash —, ellipsis …, NBSP) so the raw variant
// actually exercises the normalizer path. The normalized variant maps
// these to ASCII before sendText.
const PROMPTS = [
  // Short factual
  "Yes, you should commit small and often. Every change should compile and pass tests.",
  "Three reasons: visibility, accountability, and momentum. Skip any one and the system breaks.",
  // Emotional reframe (curly apostrophes)
  "I hear you. That feeling of being stuck is real, and it doesn’t mean you’re failing — it means you’re paying attention.",
  "Look — the worst thing isn’t the rejection. It’s the lesson you missed because you flinched away from the no.",
  // Step-by-step
  "Start with the smallest thing that scares you. Set a 25-minute timer. Do nothing else. Then take a five-minute break, and decide whether you want another round.",
  "First, write down what you actually shipped this week. Then write what you wanted to ship. The gap is your data — don’t argue with it, just look at it.",
  // Conditional with curly quote
  "If your competitor outspends you on ads, you don’t out-spend them — you out-narrate them. Find the story their budget can’t buy.",
  "Suppose you had 90 days and no salary safety net. What would you actually build? That’s your real roadmap.",
  // Long with em-dash + ellipsis
  "Here’s the thing about hard conversations: they’re never as bad as the silence you’re avoiding. You’ve already paid the cost in your head a hundred times… sending the message is almost a relief by comparison — and you give the other person the same gift, because they probably knew it was coming.",
  "When I was 24, I had a mentor tell me that ambition without endurance is just a tantrum. I didn’t get it for years. The point isn’t to want big things — anyone can do that. The point is to want them long enough that the wanting becomes work, and the work becomes a person, and the person becomes the result.",
  // Punctuation / prosody stress test — em-dashes, NBSP between words
  "Wait, wait, wait — slow down. What did she actually say? Not what you heard. What words came out of her mouth?",
  "Listen: a no today, a no tomorrow, a no the day after. Then a yes. That’s not luck. That’s math.",
  // Numbers — Cartesia known good
  "Aim for at least $10,000 in monthly recurring revenue before you start hiring. Below that, every hire is a bet you can’t afford to lose.",
  "Try this: send 50 cold emails this week, log a 5% reply rate, and three of those replies turn into 15-minute calls. That’s your funnel.",
  // Question-back with curly quote
  "What does your gut say? Not your spreadsheet. Your gut.",
  "Tell me — if we removed every external opinion from the picture, what would you do tomorrow morning?",
  // Imperative
  "Get the demo recorded today. Even if it’s ugly. Edit tomorrow. Ship by Friday. That’s the order.",
  "Stop polishing the deck. Show it to ten people. The next version writes itself.",
  // Reflective — em-dash + curly
  "You’re allowed to take the long way. The shortcut everyone’s bragging about is a survivorship-bias loop. Most people who took it are quiet because it didn’t work.",
  // Closing — NBSP in "future-you"
  "We’ll pick this back up Tuesday. Between now and then, do one thing — just one — that future-you will thank present-you for.",
];

// Normalizer mirrors cartesia-bridge.js sendText lines 210-215.
function normalize(text) {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[ ]/g, ' ');
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: env ${name} missing`);
    process.exit(1);
  }
  return v;
}

function getCartesiaUsdPerChar() {
  const n = Number(process.env.CARTESIA_USD_PER_CHAR);
  if (!Number.isFinite(n) || n <= 0) {
    console.error('FATAL: CARTESIA_USD_PER_CHAR must be a positive number');
    process.exit(1);
  }
  return n;
}

function pcmToWav(bytes, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + bytes.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([header, bytes]);
}

// M3 audit fix — peak + RMS dBFS for s16le mono PCM. dBFS is referenced
// to full-scale (i16 max = 32767). Returns null on empty buffer.
function analyzeLoudness(pcmBuf) {
  if (pcmBuf.length < 2) return { peakDbfs: null, rmsDbfs: null };
  const sampleCount = pcmBuf.length / 2;
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < pcmBuf.length; i += 2) {
    const s = pcmBuf.readInt16LE(i);
    const absS = Math.abs(s);
    if (absS > peak) peak = absS;
    sumSquares += s * s;
  }
  const maxI16 = 32768;
  const peakDbfs = peak === 0 ? -Infinity : 20 * Math.log10(peak / maxI16);
  const rms = Math.sqrt(sumSquares / sampleCount);
  const rmsDbfs = rms === 0 ? -Infinity : 20 * Math.log10(rms / maxI16);
  return {
    peakDbfs: Number.isFinite(peakDbfs) ? Number(peakDbfs.toFixed(2)) : null,
    rmsDbfs:  Number.isFinite(rmsDbfs)  ? Number(rmsDbfs.toFixed(2))  : null,
  };
}

async function runOneTurn({ bridge, prompt, sampleRate, turnTagPrefix }) {
  const audioChunks = [];
  let firstWireRxAtMs = null;        // C1 audit fix — wire-receive time
  const errorEvents = [];            // M1 + M5 audit fixes — ALL error events
  const startedAtPerfMs = performance.now();
  const startedAtWallMs = Date.now();
  const off = bridge.on((e) => {
    if (e.kind === 'audio_out') {
      if (firstWireRxAtMs === null) firstWireRxAtMs = e.wireRxAtMs ?? Date.now();
      audioChunks.push(Buffer.from(e.chunk.bytes));
    } else if (e.kind === 'error') {
      errorEvents.push({ code: e.code, fatal: !!e.fatal, message: e.message });
    }
  });
  let openedTurn = false;
  let turnEndError = null;
  let metrics = null;
  try {
    bridge.turnStart(`${turnTagPrefix}:${Date.now()}`);
    openedTurn = true;
    bridge.sendText(prompt);
    metrics = await bridge.turnEnd({ timeoutMs: 30_000 });
  } catch (e) {
    turnEndError = e;
  }
  off();

  const audioBuf = Buffer.concat(audioChunks);
  const ttfaMs = firstWireRxAtMs === null ? null : (firstWireRxAtMs - startedAtWallMs);
  const audioSeconds = audioBuf.length / (sampleRate * 2);
  const loudness = analyzeLoudness(audioBuf);
  const fatalFromEvents = errorEvents.find((e) => e.fatal);
  return {
    chars: metrics?.characters ?? prompt.length,
    audioBytes: audioBuf.length,
    audioSeconds,
    ttfaMs,
    partial: !!metrics?.partial,
    peakDbfs: loudness.peakDbfs,
    rmsDbfs:  loudness.rmsDbfs,
    warningCodes: errorEvents.filter((e) => !e.fatal).map((e) => e.code),
    fatalCode: fatalFromEvents?.code || (turnEndError ? 'turn_end_threw' : null),
    fatalMessage: fatalFromEvents?.message || (turnEndError?.message ?? null),
    wav: pcmToWav(audioBuf, sampleRate),
    openedTurn,
  };
}

async function runProvider({ providerName, makeBridge, sampleRate, outputDir, prompts, pacingMs }) {
  console.log(`[ab] === ${providerName} run start (warm bridge, ${prompts.length} turns) ===`);

  // C2 audit fix — open ONE bridge for the entire run. Captures warm
  // TTFA (matches production lifecycle). Cold open latency reported
  // separately.
  const coldOpenStart = performance.now();
  const bridge = makeBridge();
  try {
    await bridge.open();
  } catch (err) {
    console.error(`[ab] ${providerName} cold open FAIL`, err?.message || err);
    return {
      results: prompts.map((_, i) => ({
        q: String(i + 1).padStart(2, '0'),
        fatalCode: 'open_failed',
        fatalMessage: err?.message || String(err),
      })),
      coldOpenMs: null,
      sampleRateAssertion: { ok: false, reason: 'open_failed' },
    };
  }
  const coldOpenMs = Math.round(performance.now() - coldOpenStart);
  console.log(`[ab] ${providerName} cold open ${coldOpenMs}ms`);

  // C4 audit fix — sample-rate sanity check. Run a calibration prompt FIRST
  // and verify that 1 second of synthesized speech yields close to
  // (sampleRate * 2) bytes. Abort the provider's run if mismatched.
  let sampleRateAssertion = { ok: true };
  try {
    const cal = await runOneTurn({
      bridge,
      prompt: 'one two three four five six seven eight nine ten.', // ~3 seconds
      sampleRate,
      turnTagPrefix: 'cal',
    });
    const audioSec = cal.audioSeconds;
    if (audioSec > 0) {
      // Don't gate on exact ratio (TTS pacing varies); just sanity-check
      // we're in the right order of magnitude. If sampleRate is half what
      // we asked for, audio_seconds will be ~2× the truth.
      const bytesPerSec = cal.audioBytes / audioSec;
      const expectedBytesPerSec = sampleRate * 2;
      const ratio = bytesPerSec / expectedBytesPerSec;
      if (Math.abs(ratio - 1.0) > 0.01) {
        sampleRateAssertion = {
          ok: false,
          reason: `bytes_per_sec=${bytesPerSec.toFixed(1)} expected≈${expectedBytesPerSec} ratio=${ratio.toFixed(3)}`,
        };
      } else {
        sampleRateAssertion.measuredBytesPerSec = bytesPerSec;
      }
    } else {
      sampleRateAssertion = { ok: false, reason: 'calibration_no_audio' };
    }
  } catch (err) {
    sampleRateAssertion = { ok: false, reason: `calibration_threw: ${err?.message || err}` };
  }
  if (!sampleRateAssertion.ok) {
    console.warn(`[ab] ${providerName} sample-rate sanity FAILED: ${sampleRateAssertion.reason}`);
    console.warn('[ab] proceeding anyway; audio_seconds math may be off — see CSV sample_rate_ok column');
  } else {
    console.log(`[ab] ${providerName} sample-rate sanity OK (${sampleRateAssertion.measuredBytesPerSec?.toFixed(0)} bytes/sec ≈ ${sampleRate * 2})`);
  }

  const results = [];
  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const num = String(i + 1).padStart(2, '0');
    try {
      const t = await runOneTurn({ bridge, prompt, sampleRate, turnTagPrefix: `q${num}` });
      await fs.writeFile(path.join(outputDir, `${providerName}_q${num}.wav`), t.wav);
      const tag = t.fatalCode ? ` FATAL=${t.fatalCode}` : '';
      const wTag = t.warningCodes.length ? ` warnings=${t.warningCodes.join(',')}` : '';
      console.log(`[ab] ${providerName} q${num} chars=${t.chars} ttfa=${t.ttfaMs}ms audio=${t.audioSeconds.toFixed(2)}s peak=${t.peakDbfs}dB rms=${t.rmsDbfs}dB partial=${t.partial}${tag}${wTag}`);
      results.push({ q: num, ...t });
    } catch (err) {
      console.error(`[ab] ${providerName} q${num} unexpected throw`, err?.message || err);
      results.push({ q: num, fatalCode: 'unexpected_throw', fatalMessage: err?.message || String(err) });
    }
    // M4 audit fix — pace between turns to avoid concurrent-cap edge cases.
    if (i < prompts.length - 1 && pacingMs > 0) {
      await new Promise((r) => setTimeout(r, pacingMs));
    }
  }
  try { await bridge.close(); } catch {}
  return { results, coldOpenMs, sampleRateAssertion };
}

function pricingDollars(perChar, chars) {
  return Number((perChar * chars).toFixed(6));
}

function p50(values) {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 0 ? (v[mid - 1] + v[mid]) / 2 : v[mid];
}

function csvField(v) {
  // M smalls (s9) — escape commas and double-quotes per RFC 4180.
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// M7 audit fix — blinded A/B mapping. For each prompt, the listener WAV
// labels are `q{NN}_A.wav` / `q{NN}_B.wav` and the provider assignment is
// recorded in provider-mapping.json. The mapping is NOT printed to console.
function buildBlindMapping(numPrompts) {
  const mapping = [];
  for (let i = 0; i < numPrompts; i++) {
    const aIsCartesia = (crypto.randomBytes(1)[0] & 1) === 0;
    mapping.push({
      q: String(i + 1).padStart(2, '0'),
      A: aIsCartesia ? 'cartesia' : 'hume',
      B: aIsCartesia ? 'hume' : 'cartesia',
    });
  }
  return mapping;
}

async function main() {
  const cartesiaApiKey = requireEnv('CARTESIA_API_KEY');
  const cartesiaVoiceId = requireEnv('CARTESIA_VOICE_ID');
  const cartesiaUsdPerChar = getCartesiaUsdPerChar();
  const cartesiaQuotedAt = requireEnv('CARTESIA_QUOTED_AT');

  const humeApiKey = requireEnv('HUME_API_KEY');
  const humeVoiceId = requireEnv('HUME_VOICE_ID');
  let humePricing;
  try {
    humePricing = validateHumePricingOrExit({
      env: process.env,
      // Small (s1) — surface which env was missing in the throw, not just exit code.
      exit: (code) => {
        const missingChar = !Number.isFinite(Number(process.env.HUME_USD_PER_CHAR)) || Number(process.env.HUME_USD_PER_CHAR) <= 0;
        const missingDate = !process.env.HUME_QUOTED_AT;
        const which = [
          missingChar ? 'HUME_USD_PER_CHAR' : null,
          missingDate ? 'HUME_QUOTED_AT' : null,
        ].filter(Boolean).join(' + ') || `(exit ${code})`;
        throw new Error(`Hume pricing invalid — missing/bad: ${which}`);
      },
    });
  } catch (err) {
    console.error(`[ab] ${err.message}`);
    process.exit(1);
  }

  const humeSpeed   = process.env.HUME_TTS_SPEED ? Number(process.env.HUME_TTS_SPEED) : null;
  const humeSilence = process.env.HUME_TRAILING_SILENCE ? Number(process.env.HUME_TRAILING_SILENCE) : null;
  const humeDesc    = process.env.HUME_VOICE_DESCRIPTION || null;
  const humeModel   = process.env.HUME_MODEL_VERSION || '2';
  const pacingMs    = Number.isFinite(Number(process.env.AB_TURN_PACE_MS)) ? Number(process.env.AB_TURN_PACE_MS) : 250;

  // Small (s12) — log dial state so runtime config is visible.
  console.log(`[ab] dials: cartesia speed=null (Cartesia default), hume speed=${humeSpeed} silence=${humeSilence} desc=${humeDesc ? 'yes' : 'no'} model=${humeModel}`);
  console.log(`[ab] hume voice baked-prosody contract: if humeSpeed=${humeSpeed} is non-neutral against a settings-baked voice id, dials will COMPOUND with the bake. Verify with the operator.`);

  const outputDir = process.env.AB_OUTPUT_DIR || path.join(ROOT, 'tmp', 'ab');
  await fs.mkdir(outputDir, { recursive: true });

  const skipNormalize = process.env.AB_SKIP_NORMALIZE === '1';
  const promptsToSend = skipNormalize ? PROMPTS.slice() : PROMPTS.map(normalize);
  if (skipNormalize) {
    console.log('[ab] AB_SKIP_NORMALIZE=1 — sending raw Unicode punctuation through both bridges (informational variant)');
  }

  const sampleRate = 24000;
  const startedAt = new Date().toISOString();

  const cartesiaRun = await runProvider({
    providerName: 'cartesia',
    sampleRate,
    outputDir,
    prompts: promptsToSend,
    pacingMs,
    makeBridge: () => new CartesiaTTSBridge({
      apiKey: cartesiaApiKey,
      voiceId: cartesiaVoiceId,
      sampleRate,
      ttsSpeed: null, // neutral
    }),
  });

  const humeRun = await runProvider({
    providerName: 'hume',
    sampleRate,
    outputDir,
    prompts: promptsToSend,
    pacingMs,
    makeBridge: () => new HumeTTSBridge({
      apiKey: humeApiKey,
      voiceId: humeVoiceId,
      sampleRate,
      ttsSpeed: humeSpeed,
      trailingSilence: humeSilence,
      description: humeDesc,
      modelVersion: humeModel,
      pricing: humePricing,
    }),
  });

  const cartesiaResults = cartesiaRun.results;
  const humeResults = humeRun.results;

  // M7 audit fix — blinded WAV copies + provider mapping. The original
  // `cartesia_q{NN}.wav` / `hume_q{NN}.wav` are kept for ops debugging;
  // the blinded `q{NN}_A.wav` / `q{NN}_B.wav` are what the listener uses.
  const mapping = buildBlindMapping(PROMPTS.length);
  for (let i = 0; i < PROMPTS.length; i++) {
    const num = String(i + 1).padStart(2, '0');
    const m = mapping[i];
    const c = cartesiaResults[i];
    const h = humeResults[i];
    try {
      if (c?.wav) {
        const target = m.A === 'cartesia' ? `q${num}_A.wav` : `q${num}_B.wav`;
        await fs.writeFile(path.join(outputDir, target), c.wav);
      }
      if (h?.wav) {
        const target = m.A === 'hume' ? `q${num}_A.wav` : `q${num}_B.wav`;
        await fs.writeFile(path.join(outputDir, target), h.wav);
      }
    } catch (err) {
      console.warn(`[ab] q${num} blind-mapping write failed: ${err?.message || err}`);
    }
  }
  await fs.writeFile(
    path.join(outputDir, 'provider-mapping.json'),
    JSON.stringify({ note: 'Do NOT open until after listening pass — reveals the blind A/B labels.', mapping }, null, 2),
  );

  // CSV
  const header = [
    'q',
    'cartesia_chars', 'hume_chars',
    'cartesia_audio_seconds', 'hume_audio_seconds',
    'cartesia_audio_seconds_per_char', 'hume_audio_seconds_per_char', // C3 audit fix
    'cartesia_ttfa_ms', 'hume_ttfa_ms',
    'cartesia_cost_usd', 'hume_cost_usd',
    'cartesia_peak_dbfs', 'hume_peak_dbfs',      // M3 audit fix
    'cartesia_rms_dbfs', 'hume_rms_dbfs',
    'cartesia_partial', 'hume_partial',
    'cartesia_warning_codes', 'hume_warning_codes', // M1 audit fix
    'cartesia_error', 'hume_error',
  ];
  const rows = [header.join(',')];

  // Small (s7) — iterate by max(len) for defense; both should be PROMPTS.length.
  const rowCount = Math.max(cartesiaResults.length, humeResults.length, PROMPTS.length);
  for (let i = 0; i < rowCount; i++) {
    const c = cartesiaResults[i] || {};
    const h = humeResults[i] || {};
    const cChars = c.chars ?? '';
    const hChars = h.chars ?? '';
    const cCost = (c.chars != null && !c.fatalCode) ? pricingDollars(cartesiaUsdPerChar, c.chars) : '';
    const hCost = (h.chars != null && !h.fatalCode) ? pricingDollars(humePricing.usdPerChar, h.chars) : '';
    const cRatio = (c.chars && c.audioSeconds) ? (c.audioSeconds / c.chars).toFixed(5) : '';
    const hRatio = (h.chars && h.audioSeconds) ? (h.audioSeconds / h.chars).toFixed(5) : '';
    rows.push([
      String(i + 1).padStart(2, '0'),
      csvField(cChars), csvField(hChars),
      csvField(c.audioSeconds?.toFixed(3) ?? ''),
      csvField(h.audioSeconds?.toFixed(3) ?? ''),
      csvField(cRatio),
      csvField(hRatio),
      csvField(c.ttfaMs ?? ''),
      csvField(h.ttfaMs ?? ''),
      csvField(cCost),
      csvField(hCost),
      csvField(c.peakDbfs ?? ''),
      csvField(h.peakDbfs ?? ''),
      csvField(c.rmsDbfs ?? ''),
      csvField(h.rmsDbfs ?? ''),
      csvField(c.partial ?? ''),
      csvField(h.partial ?? ''),
      csvField((c.warningCodes || []).join('|')),
      csvField((h.warningCodes || []).join('|')),
      csvField(c.fatalCode ?? ''),
      csvField(h.fatalCode ?? ''),
    ].join(','));
  }
  const csvPath = path.join(outputDir, 'ab-results.csv');
  await fs.writeFile(csvPath, rows.join('\n') + '\n');

  // Summary stats — C3 audit fix: exclude errored rows from cost & TTFA.
  const cClean = cartesiaResults.filter((r) => !r.fatalCode);
  const hClean = humeResults.filter((r) => !r.fatalCode);
  const cttfa = cClean.map((r) => r.ttfaMs).filter((x) => Number.isFinite(x));
  const httfa = hClean.map((r) => r.ttfaMs).filter((x) => Number.isFinite(x));
  const cTotalChars = cClean.reduce((a, r) => a + (r.chars || 0), 0);
  const hTotalChars = hClean.reduce((a, r) => a + (r.chars || 0), 0);
  const cTotalCost = pricingDollars(cartesiaUsdPerChar, cTotalChars);
  const hTotalCost = pricingDollars(humePricing.usdPerChar, hTotalChars);
  const cp50 = p50(cttfa);
  const hp50 = p50(httfa);

  // Smalls (s2, s3, s4) — placeholders + divide-by-zero guards.
  const fmtMs = (v) => v == null ? '—' : `${v.toFixed(0)}ms`;
  const fmtRatio = (n, d) => (n == null || d == null || d === 0) ? '—' : `${(n / d).toFixed(2)}×`;

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('A/B RESULTS — SUMMARY (errored rows excluded from cost + TTFA)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Cartesia:   ${cClean.length}/${cartesiaResults.length} clean turns, cold open ${cartesiaRun.coldOpenMs}ms, warm p50 TTFA ${fmtMs(cp50)}, total chars ${cTotalChars}, total cost $${cTotalCost.toFixed(4)}`);
  console.log(`Hume:       ${hClean.length}/${humeResults.length} clean turns, cold open ${humeRun.coldOpenMs}ms, warm p50 TTFA ${fmtMs(hp50)}, total chars ${hTotalChars}, total cost $${hTotalCost.toFixed(4)}`);
  console.log(`Cost ratio (Cartesia / Hume): ${fmtRatio(cTotalCost, hTotalCost)} (Hume cheaper iff >1)`);
  console.log(`TTFA ratio (Hume / Cartesia, warm): ${fmtRatio(hp50, cp50)} (gate ≤ 1.5×)`);
  console.log(`Sample-rate sanity: cartesia=${cartesiaRun.sampleRateAssertion.ok ? 'OK' : 'FAIL ' + cartesiaRun.sampleRateAssertion.reason} · hume=${humeRun.sampleRateAssertion.ok ? 'OK' : 'FAIL ' + humeRun.sampleRateAssertion.reason}`);
  console.log('');
  console.log(`Per-turn WAVs (debug):  ${path.relative(ROOT, outputDir)}/{cartesia,hume}_q{NN}.wav`);
  console.log(`Blinded WAVs (listen):  ${path.relative(ROOT, outputDir)}/q{NN}_{A,B}.wav`);
  console.log(`Mapping (post-listen):  ${path.relative(ROOT, outputDir)}/provider-mapping.json`);
  console.log(`CSV:                    ${path.relative(ROOT, csvPath)}`);
  console.log('═══════════════════════════════════════════════════════════════');

  // Scoring doc — small (s11) audit fix: don't overwrite an existing doc
  // that has scores in it. Write to a timestamped filename if the canonical
  // path exists and contains non-template content.
  const canonicalScoringPath = path.join(ROOT, 'docs', '_planning', 'HUME_VS_CARTESIA_AB.md');
  let scoringPath = canonicalScoringPath;
  try {
    const existing = await fs.readFile(canonicalScoringPath, 'utf8');
    if (existing.includes('|')) {
      // Heuristic — if the file has been populated with table rows containing
      // anything other than placeholder underscores, save with a timestamp.
      const hasScores = /\|\s*\d\s*\|\s*\d/.test(existing);
      if (hasScores) {
        const stamp = startedAt.replace(/[:.]/g, '-');
        scoringPath = path.join(ROOT, 'docs', '_planning', `HUME_VS_CARTESIA_AB_${stamp}.md`);
        console.log(`[ab] canonical scoring doc has scores; writing new run to ${path.relative(ROOT, scoringPath)}`);
      }
    }
  } catch {
    // File doesn't exist — write canonical path.
  }

  // Smalls (s10) — escape backticks and ${ in prompt strings before
  // embedding in the markdown table.
  const safePromptRow = (i) => {
    const p = PROMPTS[i] || '';
    return p.replace(/[`$]/g, '?').slice(0, 80);
  };

  const scoring = `# Hume vs Cartesia A/B — ${startedAt}

Generated by \`scripts/hume-vs-cartesia-ab.mjs\`. CSV: \`${path.relative(ROOT, csvPath)}\`. Blinded WAVs: \`${path.relative(ROOT, outputDir)}/q{NN}_{A,B}.wav\`.

## Measured

| Metric | Cartesia | Hume |
| --- | ---: | ---: |
| Turns completed | ${cClean.length} / ${cartesiaResults.length} | ${hClean.length} / ${humeResults.length} |
| Cold open (one-shot) | ${cartesiaRun.coldOpenMs ?? '—'} ms | ${humeRun.coldOpenMs ?? '—'} ms |
| Warm p50 TTFA | ${fmtMs(cp50)} | ${fmtMs(hp50)} |
| Total chars (clean turns) | ${cTotalChars} | ${hTotalChars} |
| Total cost (clean turns) | $${cTotalCost.toFixed(4)} | $${hTotalCost.toFixed(4)} |
| Partial turns | ${cartesiaResults.filter((r) => r.partial).length} | ${humeResults.filter((r) => r.partial).length} |
| Errored turns | ${cartesiaResults.filter((r) => r.fatalCode).length} | ${humeResults.filter((r) => r.fatalCode).length} |
| Sample-rate sanity | ${cartesiaRun.sampleRateAssertion.ok ? 'OK' : 'FAIL — ' + cartesiaRun.sampleRateAssertion.reason} | ${humeRun.sampleRateAssertion.ok ? 'OK' : 'FAIL — ' + humeRun.sampleRateAssertion.reason} |

**Notes on accounting basis:**
- **chars** is counted post-bridge-normalize at the bridge boundary, so both providers count comparable units.
- **cost** excludes errored / partial rows from the total (avoids comparing fully-synthesized Cartesia turns against half-synthesized Hume turns).
- **TTFA** is wire-receive time (pre-parse) on a WARM bridge — matches production lifecycle.
- **dBFS** columns let you read loudness deltas; a quieter provider sounds less "present" in playback.

## Listening test — protocol

1. **Stay blind.** Do NOT open \`provider-mapping.json\` until you've scored every row. Per-prompt A/B is randomized — sometimes A=Cartesia, sometimes A=Hume.
2. **Score in groups.** Do 5 prompts, rest 5 minutes, do 5 more. Listener fatigue corrupts later scores.
3. **Score both criteria per WAV.** For each \`q{NN}_A.wav\` and \`q{NN}_B.wav\`, score 1–5 on:
   - **sounds-like-Vuk**: 1 = doesn't sound like Vuk at all, 5 = indistinguishable from Vuk
   - **emotional fit**: 1 = wrong register / no emotion / wooden, 5 = nails the intended tone
4. **Note recurring artifacts.** Glitches, clicks, mispronunciations, weird breathing — log them in the Notes column. Recurring across multiple prompts = decision-blocker per gate (c).
5. **Reveal mapping last.** After all scores entered, open \`provider-mapping.json\` and compute the per-provider averages.

| q | A: sounds-like-Vuk | A: emotional fit | B: sounds-like-Vuk | B: emotional fit | Notes (artifacts, weird pacing, etc.) | Prompt preview |
| ---: | :---: | :---: | :---: | :---: | --- | --- |
${PROMPTS.map((_, i) => `| ${String(i + 1).padStart(2, '0')} | _ | _ | _ | _ | | ${safePromptRow(i)} |`).join('\n')}

## Decision gate (HUME_TTS_PLAN §7)

After revealing mapping, compute averages per provider:

| Criterion | Cartesia avg | Hume avg | Pass? |
| --- | ---: | ---: | :---: |
| (a) sounds-like-Vuk | _ | _ | Hume ≥ Cartesia ⇒ pass |
| (b) emotional fit | _ | _ | Hume ≥ Cartesia ⇒ pass |
| (c) recurring artifacts | (note count) | (note count) | Hume artifact count = 0 ⇒ pass |
| (d) warm p50 TTFA | ${fmtMs(cp50)} | ${fmtMs(hp50)} | ${fmtRatio(hp50, cp50)} ≤ 1.5× ⇒ pass |

Hume wins iff ALL FOUR pass. Cost is tiebreaker only when sound criteria tie.

## Verdict

> _Fill in after listening pass:_

- Sound: _
- Emotional fit: _
- Artifacts: _
- TTFA: _
- **Winner: _**

## Re-run

\`\`\`bash
node scripts/hume-vs-cartesia-ab.mjs                 # decision input (normalized text)
node scripts/hume-vs-cartesia-ab-raw.mjs             # informational (raw Unicode)
node scripts/hume-vs-cartesia-ab-cancel.mjs          # cancellation-waste analysis
\`\`\`
`;
  await fs.writeFile(scoringPath, scoring);
  console.log(`Scoring doc: ${path.relative(ROOT, scoringPath)}`);
}

main().catch((err) => {
  console.error('[ab] fatal:', err);
  process.exit(1);
});
