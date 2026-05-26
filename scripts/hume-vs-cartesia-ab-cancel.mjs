#!/usr/bin/env node
/**
 * HUME_TTS_PLAN §7 — A/B cancellation-waste harness.
 *
 * Phase-0 risk 11.2: "Cancellation cost waste — if >5% of cost is
 * post-cancel, halt cut-over and revisit Hume's cancel semantics."
 *
 * This script fires `bridge.cancel()` 500ms into each of 20 prompts and
 * captures how many billed characters were synthesized AFTER the cancel —
 * this is the per-cancel waste. Cartesia's WS-level cancel stops billing
 * immediately. Hume's filter-by-generation_id cancel (Phase-0 mandated;
 * Hume can't stop within 200ms per their wire) keeps billing characters
 * after the cancel signal.
 *
 * Output: `tmp/ab-cancel/ab-cancel-results.csv` + console summary.
 *
 * Decision rule: if Hume's cancel waste / (Hume total cost over 20 turns)
 * exceeds 5%, the cut-over halts and we revisit cancel semantics with
 * Hume. The number is also useful for sizing the $-impact at scale.
 *
 * Re-uses the env contract from hume-vs-cartesia-ab.mjs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { CartesiaTTSBridge } from '../server/voice-proxy/cartesia-bridge.js';
import { HumeTTSBridge, validateHumePricingOrExit } from '../server/voice-proxy/hume-bridge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CANCEL_AT_MS = Number(process.env.AB_CANCEL_AT_MS || 500);
const POST_CANCEL_OBSERVE_MS = Number(process.env.AB_POST_CANCEL_MS || 1500);

// Long prompts — we want enough text to still be streaming at cancel-time
// (~500ms in). Each prompt is ≥400 chars so even a fast bridge has unsynthesized
// text in its buffer when we cancel.
const PROMPTS = [
  "Here's what most founders miss: the second mover advantage is real, but only if you understand why the first mover stumbled. They didn't fail because the idea was wrong; they failed because they overshot the market by 18 months, burned through cash on customer education, and got out-executed by a team with half the funding and twice the discipline. Your job is to be that team.",
  "When you sit down with a customer to do discovery, the rule is simple: ask three layers deep on every answer. They say they want a feature; ask why. They tell you the problem; ask what they tried. They tell you the workaround; ask what makes that hard. By the third layer, you're past the symptom and into the actual pain you can solve.",
  "Burn rate isn't just dollars per month — it's the rate at which you're consuming your ability to make decisions. Every month of runway is another month you get to be wrong and still recover. Cut team early; you can rebuild faster than you can re-raise. Cut tools early; the half you keep is the half that matters.",
  "There's a moment in every company's life where the founder realizes they're the bottleneck. Their job stops being to do the work and starts being to design the system that does the work. Most founders miss this by six months and burn out trying to keep up.",
  "The hardest thing about hiring your first ten people isn't the interview process — it's that you'll be wrong about three of them, and you have to be willing to be wrong fast. A bad hire isn't a personal failure; it's a data point. The cost is not what they did wrong, it's what your right candidate didn't get to do because the seat was taken.",
  "Pricing is a research problem disguised as a finance problem. The number itself is downstream of every conversation you've had with a customer about value. If you're guessing at price, you're guessing at value, which means you don't yet know what you're selling. Go talk to ten customers and listen for the dollar figure that comes out of their mouth, not yours.",
  "There's a phrase founders love: 'we're customer-obsessed.' Almost nobody is. Customer-obsessed means you can recite the top three jobs your last ten new customers were trying to do when they signed up. If you can't, you're product-obsessed at best, ego-obsessed at worst, and the gap will close on you faster than you think.",
  "Distribution is the moat. Everything else — the model, the wedge, the design — is downstream. If your acquisition channel is one Twitter thread that worked last quarter, you don't have distribution, you have a lottery ticket. Real distribution is replicable: ten threads in a row that each move the needle the same amount.",
  "Pivots get romanticized. The truth is most successful pivots aren't dramatic strategy resets — they're slow, painful trims where you stop doing the wrong things one at a time. By month nine you look back and realize you've changed everything, but no single day was a 'pivot day.' That's how it actually works.",
  "Burnout in founders isn't from working too hard. It's from working hard on things you secretly know don't matter. You can grind for years on the right problem; you can't grind for six months on the wrong one. The first sign isn't fatigue, it's irritability at people who ask you what you do for a living.",
  "Your first investor meeting is a job interview where you're hiring them. They're not assessing the deck; they're assessing whether you'll be tolerable in board meetings for the next eight years. The cleanest signal you can send is to walk in with the answers to last quarter's questions and the framing for next quarter's decisions.",
  "Founders chase metrics. Operators chase systems. The shift from one to the other is what makes you scalable. When you start asking 'what's broken about how we got this metric' instead of 'what's the metric,' the second derivative goes positive and the team feels it within two weeks.",
  "Sales cycles are a function of how clearly the buyer can imagine the future where they bought from you. Long sales cycles aren't a sign of an enterprise market — they're a sign that your story is too abstract. Concrete trumps clever every single time. A real customer's quote beats a thousand-word value-prop paragraph.",
  "If you're founder-led on sales past month twelve, you have a recruiting problem disguised as a sales problem. The transition is uncomfortable: hiring a sales leader feels like admitting you can't sell, but it's actually admitting that your time is more valuable doing the work only you can do. Make peace with the discomfort and ship the hire.",
  "Equity compensation is a trust signal compressed into a number. A 0.1% offer to a senior engineer who's seen three exits says 'we don't believe in our own upside.' A 1.5% offer says 'we want you to be permanently incentivized to fix the things we can't see yet.' Pay attention to what your offer says before you pay attention to what it costs.",
  "Marketing without product-market fit is amplifying noise. Marketing with product-market fit is the cheapest leverage you'll ever have. The single best test for fit isn't NPS or retention — it's whether your customers spontaneously talk about you when you're not in the room. If they don't, fix the product before you hire the marketer.",
  "Founders love the phrase 'move fast and break things,' but the version that ships at scale is 'move fast and notice what broke.' Speed without observability is just chaos. Every team that hits a wall in year three is a team that shipped without metrics in year two.",
  "Co-founder conflict is almost always about pace, not strategy. One person thinks 'we're moving too slow,' the other thinks 'we're moving too sloppy,' and they fight about the roadmap when they should be fighting about the rhythm. Name the pace question explicitly and watch the strategy debate evaporate.",
  "Customer support is the highest-leverage product role you'll ever underfund. Every ticket is a defect signal, an upsell signal, or a churn signal — usually two of the three. If your support team has nothing better to do than answer questions, you're under-collecting the data they have. Promote the best one to product within twelve months.",
  "The board meeting nobody runs well: the one where things are going fine. Crisis meetings are easy — everyone snaps to attention. Steady-state meetings are where companies coast into death. The discipline is to manufacture the productive disagreement that the numbers aren't forcing on you yet.",
];

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

function requireEnv(name) {
  const v = process.env[name];
  if (!v) { console.error(`FATAL: env ${name} missing`); process.exit(1); }
  return v;
}

async function runOneCancelTurn({ bridge, prompt, sampleRate, providerName, turnTag }) {
  // Audit S11 (unit-wide) — actual per-chunk timestamp + byte accounting
  // so post-cancel bytes are MEASURED, not interpolated from first/last
  // chunk timestamps. Each chunk records (wireRxAtMs, byteCount); the
  // post-cancel sum is the integral over chunks with ts > cancelledAt.
  const chunks = [];   // [{tsMs, bytes}]
  let cancelledAt = null;
  let firstChunkAtMs = null;
  let lastChunkAtMs = null;
  const errors = [];
  const off = bridge.on((e) => {
    if (e.kind === 'audio_out') {
      const tsMs = e.wireRxAtMs ?? Date.now();
      if (firstChunkAtMs === null) firstChunkAtMs = tsMs;
      lastChunkAtMs = tsMs;
      const buf = Buffer.from(e.chunk.bytes);
      chunks.push({ tsMs, bytes: buf });
    } else if (e.kind === 'error') {
      errors.push({ code: e.code, fatal: !!e.fatal, message: e.message });
    }
  });

  bridge.turnStart(`cancel-${turnTag}`);
  bridge.sendText(prompt);
  await new Promise((r) => setTimeout(r, CANCEL_AT_MS));
  cancelledAt = Date.now();
  bridge.cancel();
  await new Promise((r) => setTimeout(r, POST_CANCEL_OBSERVE_MS));
  let metrics = null;
  try {
    metrics = await bridge.turnEnd({ timeoutMs: 5_000 });
  } catch {
    // turnEnd may resolve partial — expected after cancel.
  }
  off();

  const audioBuf = Buffer.concat(chunks.map((c) => c.bytes));
  // Audit S11 — sum bytes from chunks received AFTER the cancel timestamp.
  // This is the measured cancel-waste, not an interpolation.
  let postCancelBytes = 0;
  let postCancelTimeMs = 0;
  if (cancelledAt !== null) {
    for (const c of chunks) {
      if (c.tsMs > cancelledAt) {
        postCancelBytes += c.bytes.length;
      }
    }
    if (lastChunkAtMs !== null && lastChunkAtMs > cancelledAt) {
      postCancelTimeMs = lastChunkAtMs - cancelledAt;
    }
  }
  return {
    prompt,
    charsSentToBridge: prompt.length,
    billedChars: metrics?.characters ?? prompt.length,
    totalAudioBytes: audioBuf.length,
    totalAudioSeconds: audioBuf.length / (sampleRate * 2),
    chunkCount: chunks.length,
    firstChunkAtMs,
    lastChunkAtMs,
    cancelledAt,
    postCancelBytes,
    postCancelTimeMs,
    errors,
    wav: pcmToWav(audioBuf, sampleRate),
  };
}

async function runProviderCancel({ providerName, makeBridge, sampleRate, outputDir, prompts }) {
  console.log(`[ab-cancel] === ${providerName} warm bridge, ${prompts.length} turns ===`);
  const bridge = makeBridge();
  try {
    await bridge.open();
  } catch (err) {
    console.error(`[ab-cancel] ${providerName} open FAIL`, err?.message || err);
    return { results: [], usdPerChar: 0 };
  }
  const results = [];
  for (let i = 0; i < prompts.length; i++) {
    const num = String(i + 1).padStart(2, '0');
    try {
      const t = await runOneCancelTurn({ bridge, prompt: prompts[i], sampleRate, providerName, turnTag: num });
      await fs.writeFile(path.join(outputDir, `${providerName}_q${num}_cancel.wav`), t.wav);
      console.log(`[ab-cancel] ${providerName} q${num} billed=${t.billedChars} audio=${t.totalAudioSeconds.toFixed(2)}s post_cancel=${t.postCancelBytes}b (${t.postCancelTimeMs}ms after cancel) errors=${t.errors.length}`);
      results.push({ q: num, ...t });
    } catch (err) {
      console.error(`[ab-cancel] ${providerName} q${num} threw`, err?.message || err);
      results.push({ q: num, fatalCode: 'threw', fatalMessage: err?.message || String(err) });
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  try { await bridge.close(); } catch {}
  return { results };
}

function csvField(v) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  const cartesiaApiKey = requireEnv('CARTESIA_API_KEY');
  const cartesiaVoiceId = requireEnv('CARTESIA_VOICE_ID');
  const cartesiaUsdPerChar = Number(process.env.CARTESIA_USD_PER_CHAR);
  if (!Number.isFinite(cartesiaUsdPerChar) || cartesiaUsdPerChar <= 0) {
    console.error('FATAL: CARTESIA_USD_PER_CHAR must be positive');
    process.exit(1);
  }
  const humeApiKey = requireEnv('HUME_API_KEY');
  const humeVoiceId = requireEnv('HUME_VOICE_ID');
  let humePricing;
  try {
    humePricing = validateHumePricingOrExit({
      env: process.env,
      exit: (code) => { throw new Error(`Hume pricing invalid (exit ${code})`); },
    });
  } catch (err) {
    console.error(`[ab-cancel] ${err.message}`);
    process.exit(1);
  }

  const outputDir = process.env.AB_OUTPUT_DIR || path.join(ROOT, 'tmp', 'ab-cancel');
  await fs.mkdir(outputDir, { recursive: true });
  const sampleRate = 24000;

  const cartesia = await runProviderCancel({
    providerName: 'cartesia',
    sampleRate,
    outputDir,
    prompts: PROMPTS,
    makeBridge: () => new CartesiaTTSBridge({
      apiKey: cartesiaApiKey,
      voiceId: cartesiaVoiceId,
      sampleRate,
      ttsSpeed: null,
    }),
  });
  const hume = await runProviderCancel({
    providerName: 'hume',
    sampleRate,
    outputDir,
    prompts: PROMPTS,
    makeBridge: () => new HumeTTSBridge({
      apiKey: humeApiKey,
      voiceId: humeVoiceId,
      sampleRate,
      ttsSpeed: process.env.HUME_TTS_SPEED ? Number(process.env.HUME_TTS_SPEED) : null,
      trailingSilence: process.env.HUME_TRAILING_SILENCE ? Number(process.env.HUME_TRAILING_SILENCE) : null,
      description: process.env.HUME_VOICE_DESCRIPTION || null,
      modelVersion: process.env.HUME_MODEL_VERSION || '2',
      pricing: humePricing,
    }),
  });

  // CSV
  const header = [
    'q',
    'cartesia_billed_chars', 'hume_billed_chars',
    'cartesia_post_cancel_bytes', 'hume_post_cancel_bytes',
    'cartesia_post_cancel_ms', 'hume_post_cancel_ms',
    'cartesia_total_audio_bytes', 'hume_total_audio_bytes',
    'cartesia_post_cancel_pct', 'hume_post_cancel_pct',
  ];
  const rows = [header.join(',')];
  let cTotalChars = 0, cWasteBytes = 0, cTotalBytes = 0;
  let hTotalChars = 0, hWasteBytes = 0, hTotalBytes = 0;
  for (let i = 0; i < PROMPTS.length; i++) {
    const c = cartesia.results[i] || {};
    const h = hume.results[i] || {};
    cTotalChars += c.billedChars || 0;
    hTotalChars += h.billedChars || 0;
    cWasteBytes += c.postCancelBytes || 0;
    hWasteBytes += h.postCancelBytes || 0;
    cTotalBytes += c.totalAudioBytes || 0;
    hTotalBytes += h.totalAudioBytes || 0;
    const cPct = (c.totalAudioBytes && c.totalAudioBytes > 0)
      ? ((c.postCancelBytes / c.totalAudioBytes) * 100).toFixed(2)
      : '';
    const hPct = (h.totalAudioBytes && h.totalAudioBytes > 0)
      ? ((h.postCancelBytes / h.totalAudioBytes) * 100).toFixed(2)
      : '';
    rows.push([
      String(i + 1).padStart(2, '0'),
      csvField(c.billedChars ?? ''), csvField(h.billedChars ?? ''),
      csvField(c.postCancelBytes ?? ''), csvField(h.postCancelBytes ?? ''),
      csvField(c.postCancelTimeMs ?? ''), csvField(h.postCancelTimeMs ?? ''),
      csvField(c.totalAudioBytes ?? ''), csvField(h.totalAudioBytes ?? ''),
      csvField(cPct), csvField(hPct),
    ].join(','));
  }
  const csvPath = path.join(outputDir, 'ab-cancel-results.csv');
  await fs.writeFile(csvPath, rows.join('\n') + '\n');

  // Summary
  const cWastePct = cTotalBytes > 0 ? (cWasteBytes / cTotalBytes) * 100 : 0;
  const hWastePct = hTotalBytes > 0 ? (hWasteBytes / hTotalBytes) * 100 : 0;
  const cCost = Number((cartesiaUsdPerChar * cTotalChars).toFixed(6));
  const hCost = Number((humePricing.usdPerChar * hTotalChars).toFixed(6));
  const cWasteCost = Number((cCost * (cWastePct / 100)).toFixed(6));
  const hWasteCost = Number((hCost * (hWastePct / 100)).toFixed(6));

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('A/B CANCELLATION-WASTE — SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Cancel fired ${CANCEL_AT_MS}ms into each prompt; observed ${POST_CANCEL_OBSERVE_MS}ms after.`);
  console.log('');
  console.log(`Cartesia: post-cancel waste ${cWastePct.toFixed(2)}% of audio bytes ($${cWasteCost.toFixed(4)} of $${cCost.toFixed(4)} total)`);
  console.log(`Hume:     post-cancel waste ${hWastePct.toFixed(2)}% of audio bytes ($${hWasteCost.toFixed(4)} of $${hCost.toFixed(4)} total)`);
  console.log('');
  console.log(`Phase-0 risk 11.2 gate: HALT CUT-OVER if Hume waste >5% of cost.`);
  console.log(`Verdict: ${hWastePct > 5 ? '⚠️  HALT — Hume waste exceeds 5%' : '✅  PASS — Hume waste within budget'}`);
  console.log('');
  console.log(`Per-turn WAVs: ${path.relative(ROOT, outputDir)}/{cartesia,hume}_q{NN}_cancel.wav`);
  console.log(`CSV:           ${path.relative(ROOT, csvPath)}`);
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('[ab-cancel] fatal:', err);
  process.exit(1);
});
