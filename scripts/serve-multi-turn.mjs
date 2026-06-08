#!/usr/bin/env node
// scripts/serve-multi-turn.mjs
// Listening server for Phase 0.5 claim #7 (multi-turn voice consistency).
// Serves tmp/fish-multi-turn/turn-01..06.wav with side-by-side playback so
// Vuk can hear voice drift across 6 sequential per-turn-WS syntheses.
//
// Run: node scripts/serve-multi-turn.mjs   → http://localhost:8766

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const PORT = 8766;
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', 'tmp', 'fish-multi-turn');

if (!existsSync(ROOT)) {
  console.error(`no multi-turn samples at ${ROOT}. run: node scripts/fish-audio-ws-spike.mjs`);
  process.exit(1);
}

const TURNS = [
  { id: 'turn-01', label: 'Turn 1', text: "I'm Vuk, founder of OakLeague." },
  { id: 'turn-02', label: 'Turn 2', text: "When I think about what makes a great founder, it's obsession, not ideas." },
  { id: 'turn-03', label: 'Turn 3', text: "The hardest year of my life was the year nobody listened." },
  { id: 'turn-04', label: 'Turn 4', text: "Look. There's no shortcut. The only thing that compounds is showing up." },
  { id: 'turn-05', label: 'Turn 5', text: "Yeah, I get that a lot. Most days I'm not motivated. I just don't stop." },
  { id: 'turn-06', label: 'Turn 6', text: "Here's the deal: you can spend ten years optimizing for safety, or two building something that matters." },
];

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

function buildHtml() {
  const items = TURNS.map((t) => {
    const file = join(ROOT, `${t.id}.wav`);
    const exists = existsSync(file);
    const size = exists ? (statSync(file).size / 1024).toFixed(0) + ' KB' : 'MISSING';
    return `
      <section class="card">
        <header>
          <h2>${esc(t.label)}</h2>
          <span class="size">${esc(size)}</span>
        </header>
        <blockquote>${esc(t.text)}</blockquote>
        ${exists ? `<audio controls preload="none" src="/audio/${esc(t.id)}.wav"></audio>` : '<p class="missing">file missing</p>'}
      </section>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Phase 0.5 — multi-turn consistency</title>
<style>
body { font: 15px/1.5 system-ui, sans-serif; max-width: 880px; margin: 32px auto; padding: 0 20px; color: #222; background: #fafafa; }
h1 { font-size: 22px; margin: 0 0 8px; }
.lede { color: #555; margin: 0 0 28px; }
.card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px 20px; margin-bottom: 18px; }
.card header { display: flex; align-items: baseline; gap: 14px; margin-bottom: 10px; }
.card h2 { font-size: 16px; margin: 0; }
.size { color: #999; font-size: 12px; margin-left: auto; }
blockquote { margin: 8px 0 14px; padding: 10px 14px; border-left: 3px solid #fa5; background: #fff7eb; border-radius: 0 4px 4px 0; font-size: 14px; color: #333; }
audio { width: 100%; }
.footer { color: #777; font-size: 13px; margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee; }
code { background: #f0f0f0; padding: 1px 5px; border-radius: 3px; font-size: 13px; }
.missing { color: #c33; font-style: italic; }
</style></head><body>
<h1>Phase 0.5 Claim #7 — Multi-turn voice consistency</h1>
<p class="lede">6 sequential syntheses via fresh WS per turn (mirrors prod path). Voice ID <code>baa1fcbd…</code> · S2-Pro · temperature 0.7 / top_p 0.7. Listen back-to-back; the question is whether Vuk's voice DRIFTS across turns.</p>
${items}
<div class="footer">
  <strong>What to listen for:</strong>
  <ul>
    <li><strong>Pitch consistency</strong> — does turn 4 sound at the same pitch as turn 1?</li>
    <li><strong>Energy / cadence</strong> — does turn 6 have the same conversational rhythm as turn 1, or is it flatter / faster?</li>
    <li><strong>Acoustic timbre</strong> — does it sound like the SAME person across all 6, or like a Vuk-flavored cousin?</li>
  </ul>
  <p><strong>Decision:</strong></p>
  <ul>
    <li>No audible drift → Phase 1 ships at temperature 0.7 (current).</li>
    <li>Mild drift → lower temperature to 0.4-0.5 + add seed pinning (need to verify Fish supports seed).</li>
    <li>Major drift → blocking issue — pause Phase 1 and investigate.</li>
  </ul>
</div>
</body></html>`;
}

const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(buildHtml());
  }
  if (req.url?.startsWith('/audio/')) {
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
  console.log(`\n  Phase 0.5 multi-turn consistency listening test`);
  console.log(`  → http://localhost:${PORT}\n`);
  console.log(`  ${TURNS.length} sequential turns from tmp/fish-multi-turn/`);
  console.log(`  Ctrl-C to stop.\n`);
});
