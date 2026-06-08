#!/usr/bin/env node
// scripts/serve-fish-spike.mjs
// Tiny static file server for the Fish Audio Phase 0 listening test. Serves
// tmp/fish-spike/*.wav with a generated HTML index page showing the sentence
// text next to each <audio> player. Stop with Ctrl-C.
//
// Run: node scripts/serve-fish-spike.mjs
//   then open http://localhost:8765 in your browser.

import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const PORT = 8765;
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', 'tmp', 'fish-spike');

if (!existsSync(ROOT)) {
  console.error(`no samples found at ${ROOT}. run: node scripts/fish-audio-spike.mjs`);
  process.exit(1);
}

// Sentences must match scripts/fish-audio-spike.mjs SENTENCES[]. Duplicated
// here intentionally (avoid triggering the spike script's side-effects on
// import).
const SENTENCES = [
  { id: '01-short-factual',          label: '1 · Short factual',           tests: 'Baseline acoustic identity',                       text: "I'm Vuk, founder of OakLeague. We build interactive AI mentorship at scale." },
  { id: '02-long-explanatory',       label: '2 · Long explanatory',        tests: 'Sustained prosody + breath control',                text: "When I think about what makes a great founder, it's not the idea — it's the obsession. The willingness to grind for years on something that ninety percent of people will dismiss as crazy. That's the bar." },
  { id: '03-emotional-storytelling', label: '3 · Emotional storytelling',  tests: 'Pauses, restraint, weight',                         text: "I'll tell you something. The hardest year of my life was the year nobody listened. Every meeting was a no. Every investor was polite but distant. And I had to wake up every morning and convince myself it was still worth showing up." },
  { id: '04-technical-jargon',       label: '4 · Technical jargon',        tests: 'Pronunciation of brand/API names',                  text: "The architecture is decoupled: Gemini 3.1 Flash Live handles speech-to-text, then a separate brain layer runs RAG retrieval before we hit Cartesia — soon Fish Audio — for synthesis." },
  { id: '05-pauses-emphasis',        label: '5 · Pauses + emphasis',       tests: 'Sharp pauses, beats, stress',                       text: "Look. There's no shortcut. None. The only thing that compounds is showing up, every single day, when you'd rather quit." },
  { id: '06-conversational-rhythm',  label: '6 · Conversational rhythm',   tests: '"Yeah", "Honestly?", filler cadence',               text: "Yeah, I get that a lot. People ask me how I stay motivated. Honestly? Most days I'm not. I just don't stop." },
  { id: '07-number-heavy',           label: '7 · Number-heavy',            tests: 'Number readout naturalness',                        text: "We did three thousand sessions in the first month, with average session length of one minute forty-two seconds, and a sixty-three percent week-two retention." },
  { id: '08-paragraph-endurance',    label: '8 · Paragraph endurance',     tests: 'Long-form endurance + breath beats',                text: "Here's the deal. You can spend ten years optimizing for safety. Or you can spend two years building something that matters. The math isn't close. The hard part is convincing your nervous system. Your brain will scream that the safe path is the smart one. It isn't. It's just the one with fewer surprises." },
];

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

function buildIndexHtml() {
  const items = SENTENCES.map((s) => {
    const wavPath = join(ROOT, `${s.id}.wav`);
    const exists = existsSync(wavPath);
    const size = exists ? (statSync(wavPath).size / 1024).toFixed(0) + ' KB' : 'MISSING';
    return `
      <section class="card">
        <header>
          <h2>${esc(s.label)}</h2>
          <span class="tests">${esc(s.tests)}</span>
          <span class="size">${esc(size)}</span>
        </header>
        <blockquote>${esc(s.text)}</blockquote>
        ${exists ? `<audio controls preload="none" src="/audio/${esc(s.id)}.wav"></audio>` : '<p class="missing">file missing — re-run scripts/fish-audio-spike.mjs</p>'}
      </section>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Fish Audio Phase 0 — listening test</title>
  <style>
    body { font: 15px/1.5 system-ui, -apple-system, sans-serif; max-width: 880px; margin: 32px auto; padding: 0 20px; color: #222; background: #fafafa; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    .lede { color: #555; margin: 0 0 28px; }
    .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px 20px; margin-bottom: 18px; box-shadow: 0 1px 2px rgba(0,0,0,.03); }
    .card header { display: flex; align-items: baseline; gap: 14px; margin-bottom: 10px; }
    .card h2 { font-size: 16px; margin: 0; }
    .tests { color: #666; font-size: 13px; }
    .size { color: #999; font-size: 12px; margin-left: auto; }
    blockquote { margin: 8px 0 14px; padding: 10px 14px; border-left: 3px solid #5ad; background: #f6f9fc; border-radius: 0 4px 4px 0; font-size: 14px; color: #333; }
    audio { width: 100%; }
    .footer { color: #777; font-size: 13px; margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee; }
    .missing { color: #c33; font-style: italic; }
    code { background: #f0f0f0; padding: 1px 5px; border-radius: 3px; font-size: 13px; }
  </style>
</head>
<body>
  <h1>Fish Audio Phase 0 — Vuk voice clone</h1>
  <p class="lede">Voice ID <code>baa1fcbd…1cb17ace</code> · S2-Pro · ${SENTENCES.length} samples · play each, then A/B against your Cartesia clone memory.</p>
  ${items}
  <div class="footer">
    <strong>Pass bar:</strong>
    <ul>
      <li>Identity — does it sound like Vuk, or like a Vuk-flavored stranger?</li>
      <li>Range — does #3 (emotional) carry weight, or read flat?</li>
      <li>Pauses — does #5 actually pause at the punctuation, or smear through?</li>
      <li>Numbers — does #7 read "sixty-three percent" like a human, or robotically?</li>
      <li>Endurance — does #8 stay in character to the end?</li>
    </ul>
    <p>4-of-5 yes → green-light Phase 1 (bridge code). 2-3 yes → borderline, more samples. 0-1 yes → close the door.</p>
  </div>
</body>
</html>`;
}

const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const html = buildIndexHtml();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  if (req.url?.startsWith('/audio/')) {
    // Strip /audio/ prefix, reject anything with a path traversal.
    const name = req.url.slice('/audio/'.length);
    if (name.includes('/') || name.includes('\\') || name.includes('..') || extname(name) !== '.wav') {
      res.writeHead(400); return res.end('bad request');
    }
    const file = join(ROOT, name);
    if (!existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const buf = readFileSync(file);
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    return res.end(buf);
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Fish Audio Phase 0 listening test`);
  console.log(`  → http://localhost:${PORT}\n`);
  console.log(`  ${SENTENCES.length} samples served from tmp/fish-spike/`);
  console.log(`  Ctrl-C to stop.\n`);
});
