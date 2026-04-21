// Phase 0 REPL gate for Spike A.
// Verifies @google/genai shape + WS behavior before Phase 1 coding.
// Run: node scripts/spike-a-phase0.mjs

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import WebSocket from 'ws';
import fs from 'node:fs/promises';

// .env.local is the source of truth locally; dotenv/config reads .env by default.
// Load .env.local explicitly.
const dotenv = await import('dotenv');
dotenv.config({ path: '.env.local', override: true });

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY missing'); process.exit(1); }

const findings = {
  runAt: new Date().toISOString(),
  gemini31: { model: 'gemini-3.1-flash-live-preview' },
  gemini25: { model: 'gemini-live-2.5-flash-native-audio' },
  sdkVersion: null,
  mintShapeVerified: false,
  setupFrameRequired: null,
  setupFrameOptional: null,
  binaryFramesObserved: false,
  twoPointFiveAvailable: null,
  gateVerdict: null,
  notes: [],
};

try {
  const pkg = JSON.parse(await fs.readFile('node_modules/@google/genai/package.json', 'utf8'));
  findings.sdkVersion = pkg.version;
} catch {}

// v1alpha client for ephemeral token minting.
const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });

// ─── Step 1: mint ephemeral token for 3.1 with nested liveConnectConstraints.config ───
async function mintToken(modelId) {
  return ai.authTokens.create({
    config: {
      uses: 1,
      liveConnectConstraints: {
        model: modelId,
        config: {
          responseModalities: ['AUDIO'],
          systemInstruction: 'You are a helpful mentor. One sentence.',
        },
      },
    },
  });
}

let token31;
try {
  token31 = await mintToken(findings.gemini31.model);
  findings.mintShapeVerified = true;
  findings.gemini31.tokenName = token31.name ? token31.name.slice(0, 18) + '…' : '(no name)';
  findings.notes.push('✓ authTokens.create({ config:{ uses, liveConnectConstraints:{ model, config } } }) accepted');
} catch (e) {
  findings.notes.push('✗ Mint failed on 3.1: ' + (e.message || e));
}

// ─── Step 2: try minting 2.5 token — if accepted, 2.5 is GA on AI Studio ───
let token25;
try {
  token25 = await mintToken(findings.gemini25.model);
  findings.twoPointFiveAvailable = true;
  findings.gemini25.tokenName = token25.name ? token25.name.slice(0, 18) + '…' : '(no name)';
  findings.notes.push('✓ 2.5 token mint accepted — GA on AI Studio, no Vertex branch needed');
} catch (e) {
  findings.twoPointFiveAvailable = false;
  findings.gemini25.mintError = e.message || String(e);
  findings.notes.push('✗ 2.5 token mint failed: ' + (e.message || e).slice(0, 200));
}

// ─── Step 3: open WS using 3.1 token. Test: first send a bogus frame (no setup) → see what happens.
//            Then on a fresh token, send proper setup frame → expect setupComplete.
async function probeWs(tokenName, modelId, sendSetup) {
  return new Promise((resolve) => {
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(tokenName)}`;
    const events = [];
    let done = false;
    const finish = (reason) => { if (done) return; done = true; try { ws.close(); } catch {} resolve({ reason, events }); };
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => finish('timeout_15s'), 15000);
    ws.on('open', () => {
      events.push({ t: Date.now(), ev: 'open' });
      if (sendSetup) {
        const setup = {
          setup: {
            model: modelId,
            generationConfig: { responseModalities: ['AUDIO'] },
            systemInstruction: { parts: [{ text: 'One sentence.' }] },
            realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
          },
        };
        ws.send(JSON.stringify(setup));
        events.push({ t: Date.now(), ev: 'sent_setup' });
      } else {
        // Skip setup — send a tiny media chunk to see if server errors or waits.
        const mediaOnly = {
          realtimeInput: { mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: 'AAAA' }] },
        };
        ws.send(JSON.stringify(mediaOnly));
        events.push({ t: Date.now(), ev: 'sent_media_without_setup' });
      }
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary || data instanceof ArrayBuffer || (data && data.byteLength !== undefined && !(typeof data === 'string'))) {
        events.push({ t: Date.now(), ev: 'binary_frame', bytes: data.byteLength ?? data.length });
      } else {
        const s = data.toString();
        try {
          const obj = JSON.parse(s);
          const kind = obj.setupComplete ? 'setupComplete'
                    : obj.serverContent ? 'serverContent'
                    : obj.error ? 'error'
                    : Object.keys(obj)[0] || 'unknown';
          events.push({ t: Date.now(), ev: 'text_frame', kind, preview: s.slice(0, 160) });
          if (obj.setupComplete) setTimeout(() => finish('got_setupComplete'), 100);
          if (obj.error) setTimeout(() => finish('server_error'), 100);
        } catch {
          events.push({ t: Date.now(), ev: 'text_frame_unparsed', preview: s.slice(0, 160) });
        }
      }
    });
    ws.on('close', (code, reason) => { events.push({ t: Date.now(), ev: 'close', code, reason: reason?.toString() }); clearTimeout(timer); finish('closed'); });
    ws.on('error', (err) => { events.push({ t: Date.now(), ev: 'error', msg: String(err).slice(0, 200) }); });
  });
}

if (token31?.name) {
  // Need separate single-use tokens for each probe.
  const tA = await mintToken(findings.gemini31.model).catch(() => null);
  const tB = await mintToken(findings.gemini31.model).catch(() => null);

  if (tA?.name) {
    const withSetup = await probeWs(tA.name, findings.gemini31.model, true);
    findings.setupFrameProbe_withSetup = withSetup;
    findings.setupFrameOptional = !!withSetup.events.find(e => e.ev === 'text_frame' && e.kind === 'setupComplete');
  }
  if (tB?.name) {
    const noSetup = await probeWs(tB.name, findings.gemini31.model, false);
    findings.setupFrameProbe_noSetup = noSetup;
    // If server closed with an error code or returned error JSON, setup IS required.
    const sawError = noSetup.events.some(e => (e.ev === 'text_frame' && e.kind === 'error') || (e.ev === 'close' && e.code && e.code !== 1000));
    findings.setupFrameRequired = sawError;
  }
}

// Verdict
const passed =
  findings.mintShapeVerified &&
  findings.setupFrameOptional === true &&      // setup frame accepted → plan is correct
  findings.twoPointFiveAvailable !== null;     // yes OR no, either is fine — just record

findings.gateVerdict = passed ? 'PASS — proceed to Phase 1' : 'REVIEW — re-check plan before Phase 1';

console.log(JSON.stringify(findings, null, 2));
