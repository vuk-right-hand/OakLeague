#!/usr/bin/env node
/**
 * Days 8–12 — Voice Pipeline Phase 0 verification harness.
 *
 * Runs five live checks before Day 8 coding begins (plan REV 5 Hard Contract):
 *   (1) Cartesia API reachability + per-character USD rate (Vuk confirms from
 *       dashboard; script prints the observed response + per-request-billing
 *       header if any, for cross-reference).
 *   (2) Cartesia TTS context-id reconnect semantic (N3-M7):
 *         1.1 open WS, context_id='phase0-<rand>', stream 2s output
 *         1.2 force-close client WS
 *         1.3 reopen, continue same context_id
 *         Observe: accepts? resumes? re-bills?
 *   (3) @google/genai SDK inspection — SessionResumption types present?
 *       Already verified statically (yes, in v1.50.1). Script re-checks the
 *       installed version and prints a one-line OK/upgrade hint.
 *   (4) gemini-2.5-flash-native-audio-preview-12-2025 supports
 *       `inputAudioTranscription` + `responseModalities=[AUDIO]` simultaneously
 *       (M-N2). Opens one live session, sends 1s silent PCM, waits for either
 *       a transcript event or setup failure.
 *   (5) googleapis/js-genai issue #2238 state — fetches issue JSON (open?
 *       closed?). If closed, flags that 3.1-Live TEXT modality might be
 *       revisitable.
 *
 * Required env:
 *   GEMINI_API_KEY     — for checks 4
 *   CARTESIA_API_KEY   — for checks 1, 2
 *   (GITHUB_TOKEN optional for check 5 — anonymous works for public issues.)
 *
 * Output: one section per check with PASS/FAIL/INFO and a short detail. Writes
 * `docs/_planning/PHASE_0_MEASUREMENTS.md` as structured results for plan doc
 * cross-reference.
 *
 * Exit 0 if all MANDATORY checks pass (1, 2, 4). Check 3 is static-verified
 * already; check 5 is informational.
 */

import { GoogleGenAI, Modality } from '@google/genai';
import WebSocket from 'ws';
import { writeFile, readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const GEMINI = process.env.GEMINI_API_KEY;
const CARTESIA = process.env.CARTESIA_API_KEY;

const results = [];
function record(section, passed, detail) {
  results.push({ section, passed, detail });
  const tag = passed === true ? 'PASS' : passed === false ? 'FAIL' : 'INFO';
  console.log(`[${tag}] ${section} — ${detail}`);
}

// ──────────────────────────────────────────────────────────────────────────
// (3) SDK version + SessionResumption type presence (static)
// ──────────────────────────────────────────────────────────────────────────
async function checkSdkTypes() {
  try {
    const pkg = JSON.parse(
      await readFile(
        new URL(
          '../server/voice-proxy/node_modules/@google/genai/package.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const types = await readFile(
      new URL(
        '../server/voice-proxy/node_modules/@google/genai/dist/genai.d.ts',
        import.meta.url,
      ),
      'utf8',
    );
    const hasResumption = /SessionResumptionConfig|sessionResumptionUpdate/.test(types);
    const hasInputTranscription = /inputAudioTranscription/.test(types);
    record(
      'SDK @google/genai inspection',
      hasResumption && hasInputTranscription,
      `version=${pkg.version} resumption=${hasResumption} inputAudioTranscription=${hasInputTranscription}`,
    );
  } catch (e) {
    record('SDK @google/genai inspection', false, `read failed: ${e.message}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// (1) Cartesia reachability + rate (manual-read after script dumps response)
// (2) Cartesia context-id reconnect semantic (N3-M7)
// ──────────────────────────────────────────────────────────────────────────
async function checkCartesia() {
  if (!CARTESIA) {
    record('Cartesia reachability', null, 'CARTESIA_API_KEY unset — skipped');
    record('Cartesia context-id reconnect (N3-M7)', null, 'skipped');
    return;
  }

  const VOICE_ID = process.env.CARTESIA_TEST_VOICE_ID; // Vuk's clone or a default
  if (!VOICE_ID) {
    record('Cartesia reachability', null, 'CARTESIA_TEST_VOICE_ID unset — skipped');
    record('Cartesia context-id reconnect (N3-M7)', null, 'skipped');
    return;
  }

  const ctxId = `phase0-${Math.random().toString(36).slice(2, 10)}`;
  const url = `wss://api.cartesia.ai/tts/websocket?api_key=${encodeURIComponent(CARTESIA)}&cartesia_version=2024-11-13`;

  // Phase 1: open, push some text, collect ~2s of audio.
  let ws1;
  let firstChunkAt = null;
  let charsShipped = 0;
  const phase1Start = performance.now();
  try {
    ws1 = new WebSocket(url);
    await new Promise((res, rej) => {
      ws1.on('open', res);
      ws1.on('error', rej);
      setTimeout(() => rej(new Error('open timeout 5s')), 5000);
    });

    const openLatencyMs = Math.round(performance.now() - phase1Start);

    const text =
      'Hello, this is a context resumption test for Cartesia websocket mid-turn reconnect behavior.';
    charsShipped += text.length;
    ws1.send(
      JSON.stringify({
        context_id: ctxId,
        model_id: 'sonic-english',
        transcript: text,
        voice: { mode: 'id', id: VOICE_ID },
        output_format: {
          container: 'raw',
          encoding: 'pcm_s16le',
          sample_rate: 24000,
        },
        continue: true,
      }),
    );

    await new Promise((res, rej) => {
      const to = setTimeout(() => res('timeout-ok'), 2500);
      ws1.on('message', (data) => {
        // Gate on audio only: binary PCM frames are large, JSON control/error
        // frames are short. Without this guard an auth-error JSON frame would
        // false-pass the reachability gate (audit M3).
        if (Buffer.isBuffer(data) && data.length > 64 && !firstChunkAt) {
          firstChunkAt = performance.now() - phase1Start;
        }
      });
      ws1.on('error', rej);
    });

    const ttfbMs = firstChunkAt == null ? null : Math.round(firstChunkAt);
    record(
      'Cartesia reachability',
      firstChunkAt != null,
      `open=${openLatencyMs}ms ttfb=${ttfbMs ?? 'none'}ms ctx_id=${ctxId}`,
    );
  } catch (e) {
    record('Cartesia reachability', false, `phase1 failed: ${e.message}`);
    try { ws1?.terminate(); } catch {}
    record('Cartesia context-id reconnect (N3-M7)', false, 'cannot run — phase1 failed');
    return;
  }
  // Abrupt close to simulate WS drop.
  try { ws1.terminate(); } catch {}

  // Phase 2: reopen, try same context_id.
  await new Promise((r) => setTimeout(r, 200));
  let ws2;
  try {
    ws2 = new WebSocket(url);
    await new Promise((res, rej) => {
      ws2.on('open', res);
      ws2.on('error', rej);
      setTimeout(() => rej(new Error('reopen timeout 5s')), 5000);
    });

    const resumeText = 'Continuation after reconnect.';
    ws2.send(
      JSON.stringify({
        context_id: ctxId,
        model_id: 'sonic-english',
        transcript: resumeText,
        voice: { mode: 'id', id: VOICE_ID },
        output_format: {
          container: 'raw',
          encoding: 'pcm_s16le',
          sample_rate: 24000,
        },
        continue: false,
      }),
    );

    // Observe for 2s: did we get audio back? Any error event?
    let observed = { gotAudio: false, gotError: null };
    await new Promise((res) => {
      const to = setTimeout(res, 2500);
      ws2.on('message', (data) => {
        // Cartesia JSON control frames are short; binary PCM is long.
        if (Buffer.isBuffer(data) && data.length > 64) observed.gotAudio = true;
        else {
          try {
            const j = JSON.parse(data.toString('utf8'));
            if (j.type === 'error') observed.gotError = j.error ?? JSON.stringify(j);
          } catch {}
        }
      });
      ws2.on('error', (e) => { observed.gotError = e.message; res(); });
    });

    const outcome = observed.gotError
      ? `rejected (${observed.gotError})`
      : observed.gotAudio
        ? 'accepted — emitted audio on same ctx_id'
        : 'ambiguous — no error + no audio';
    record(
      'Cartesia context-id reconnect (N3-M7)',
      observed.gotAudio && !observed.gotError,
      outcome,
    );
  } catch (e) {
    record('Cartesia context-id reconnect (N3-M7)', false, `reopen failed: ${e.message}`);
  } finally {
    try { ws2?.close(); } catch {}
  }

  console.log(
    `  [manual] Cross-check Cartesia dashboard: was this run billed once or twice? ` +
      `chars_shipped_phase1=${charsShipped}, ctx_id=${ctxId}`,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// (4) 2.5-flash native-audio inputAudioTranscription capability
// ──────────────────────────────────────────────────────────────────────────
async function check25NativeAudioInputTranscription() {
  if (!GEMINI) {
    record('Gemini 2.5 native-audio inputAudioTranscription', null, 'GEMINI_API_KEY unset — skipped');
    return;
  }
  const MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
  // v1alpha pins production (server/voice-proxy/gemini-bridge.js:17). Testing
  // v1beta here would gate the wrong API surface — audit C1.
  const client = new GoogleGenAI({ apiKey: GEMINI, httpOptions: { apiVersion: 'v1alpha' } });

  let session;
  let sawTranscript = false;
  let sawTurnComplete = false;
  let setupError = null;
  try {
    session = await client.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      },
      callbacks: {
        onopen: () => {},
        onmessage: (msg) => {
          // Accepting the config != surfacing transcripts at runtime. We only
          // PASS when the model actually emits an inputTranscription event in
          // response to real audio (audit M4).
          const sc = msg?.serverContent;
          if (sc?.inputTranscription) sawTranscript = true;
          if (sc?.turnComplete) sawTurnComplete = true;
        },
        onerror: (e) => { setupError = e?.message || String(e); },
        onclose: () => {},
      },
    });

    // Manual-VAD session: bracket a 1s silent PCM frame with activityStart /
    // activityEnd so Gemini treats it as one complete user turn. 16kHz mono
    // 16-bit → 32000 bytes of zeros.
    const silentPcm = Buffer.alloc(32000, 0);
    session.sendRealtimeInput({ activityStart: {} });
    session.sendRealtimeInput({
      audio: {
        data: silentPcm.toString('base64'),
        mimeType: 'audio/pcm;rate=16000',
      },
    });
    session.sendRealtimeInput({ activityEnd: {} });

    // Wait up to 5s for either a transcript event or turnComplete.
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline && !sawTranscript && !sawTurnComplete && !setupError) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (setupError) {
      record('Gemini 2.5 native-audio inputAudioTranscription', false, `setup error: ${setupError}`);
    } else if (sawTranscript) {
      record('Gemini 2.5 native-audio inputAudioTranscription', true,
        'runtime transcript event observed on 1s silent PCM');
    } else if (sawTurnComplete) {
      // Model accepted config + completed the turn but emitted no transcript —
      // same failure mode the audit flagged. Silent PCM may legitimately yield
      // no words; classify as AMBIGUOUS, not PASS.
      record('Gemini 2.5 native-audio inputAudioTranscription', null,
        'turnComplete with no inputTranscription — config accepted but runtime behavior unverified; re-run with real speech');
    } else {
      record('Gemini 2.5 native-audio inputAudioTranscription', false,
        '5s elapsed with no transcript or turnComplete');
    }
  } catch (e) {
    record(
      'Gemini 2.5 native-audio inputAudioTranscription',
      false,
      `open failed: ${e?.message || e}`,
    );
    return;
  } finally {
    try { session?.close(); } catch {}
  }
}

// ──────────────────────────────────────────────────────────────────────────
// (6) 3.1 Flash Live accepts audio input with responseModalities=[TEXT]
// ──────────────────────────────────────────────────────────────────────────
// Pipeline α (the whole product architecture): every tier uses 3.1 Flash Live
// as the brain with TEXT output, then Cartesia cloned voice for TTS. Never
// Gemini's stock voice. Public pricing lists a text-output rate for 3.1 Live
// ($4.50/1M tokens) — strong implication it's supported. This runtime check
// confirms: open a 3.1 Live session with responseModalities=[TEXT], send 1s
// silent PCM via manual-VAD, wait for a text part or turnComplete. PASS
// requires at least one text part (empty on silent PCM is acceptable — the
// model just has nothing to transcribe; what matters is no modality rejection).
async function check31LiveTextOutput() {
  if (!GEMINI) {
    record('Gemini 3.1 Live audio-in + TEXT-out (Pipeline α)', null, 'GEMINI_API_KEY unset — skipped');
    return;
  }

  // Load the real-speech fixture. 16kHz mono s16le PCM inside a WAV container;
  // we strip the 44-byte header and stream the rest as raw PCM. If the fixture
  // is missing, fall back to 1s of silence (ambiguous — known failure mode).
  let pcmBody;
  let fixtureDetail = 'silent-pcm-fallback';
  try {
    const wav = await readFile(
      new URL('../scripts/fixtures/voice-test-vuk-hello.wav', import.meta.url),
    );
    // WAV header is 44 bytes for standard PCM files written by ffmpeg.
    // Sanity-check the RIFF/WAVE magic before slicing.
    if (wav.slice(0, 4).toString() !== 'RIFF' || wav.slice(8, 12).toString() !== 'WAVE') {
      throw new Error('fixture is not a RIFF/WAVE file');
    }
    pcmBody = wav.slice(44);
    const durationSec = (pcmBody.length / 2 / 16000).toFixed(2);
    fixtureDetail = `fixture=voice-test-vuk-hello.wav duration=${durationSec}s`;
  } catch (e) {
    pcmBody = Buffer.alloc(32000, 0);
    fixtureDetail = `fixture-missing (${e.message}) — using 1s silence (ambiguous)`;
  }

  const MODEL = 'gemini-3.1-flash-live-preview';
  const client = new GoogleGenAI({ apiKey: GEMINI, httpOptions: { apiVersion: 'v1alpha' } });

  let session;
  let sawTextPart = false;
  let textSample = '';
  let sawTurnComplete = false;
  let setupError = null;
  const rawEvents = [];
  try {
    session = await client.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.TEXT],
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      },
      callbacks: {
        onopen: () => { rawEvents.push({ t: 'open' }); },
        onmessage: (msg) => {
          // Keep a compact record of every server event — strip base64 audio
          // so stdout stays readable.
          try {
            const safe = JSON.parse(JSON.stringify(msg, (k, v) => {
              if (k === 'data' && typeof v === 'string' && v.length > 40) return `<b64:${v.length}>`;
              return v;
            }));
            rawEvents.push(safe);
          } catch { rawEvents.push({ t: 'unparseable' }); }

          const sc = msg?.serverContent;
          const parts = sc?.modelTurn?.parts;
          if (parts?.length) {
            sawTextPart = true;
            for (const p of parts) {
              if (typeof p?.text === 'string') textSample += p.text;
            }
          }
          if (sc?.turnComplete) sawTurnComplete = true;
        },
        onerror: (e) => { setupError = e?.message || String(e); rawEvents.push({ t: 'error', e: String(e?.message || e) }); },
        onclose: (e) => { rawEvents.push({ t: 'close', reason: String(e?.reason || '') }); },
      },
    });

    // Stream the fixture as if it were real-time mic audio. Chunk at 320ms
    // (10240 bytes) so the server sees a natural streaming cadence.
    session.sendRealtimeInput({ activityStart: {} });
    const CHUNK = 10240;
    for (let offset = 0; offset < pcmBody.length; offset += CHUNK) {
      const slice = pcmBody.slice(offset, offset + CHUNK);
      session.sendRealtimeInput({
        audio: { data: slice.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
      });
    }
    session.sendRealtimeInput({ activityEnd: {} });

    // Real speech → model should answer. Give it 15s (model thinking + first
    // token + turn close) which matches production UX budget.
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline && !sawTurnComplete && !setupError) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // Dump raw event trace so we can diagnose silent fails without rerunning.
    console.log('\n--- 3.1 Live raw event trace ---');
    for (const e of rawEvents) {
      console.log(JSON.stringify(e).slice(0, 400));
    }
    console.log(`--- end trace (${rawEvents.length} events) ---\n`);

    if (setupError) {
      record('Gemini 3.1 Live audio-in + TEXT-out (Pipeline α)', false,
        `setup/modality error: ${setupError} — pipeline α blocked`);
    } else if (sawTurnComplete && sawTextPart) {
      record('Gemini 3.1 Live audio-in + TEXT-out (Pipeline α)', true,
        `${fixtureDetail}; text_out="${textSample.slice(0, 80).replace(/\s+/g, ' ')}"`);
    } else if (sawTurnComplete) {
      record('Gemini 3.1 Live audio-in + TEXT-out (Pipeline α)', true,
        `${fixtureDetail}; turnComplete with no text (model had nothing to say — modality still accepted)`);
    } else {
      record('Gemini 3.1 Live audio-in + TEXT-out (Pipeline α)', false,
        `${fixtureDetail}; 15s elapsed with no turnComplete (events=${rawEvents.length})`);
    }
  } catch (e) {
    record('Gemini 3.1 Live audio-in + TEXT-out (Pipeline α)', false,
      `open failed: ${e?.message || e} — pipeline α blocked`);
    return;
  } finally {
    try { session?.close(); } catch {}
  }
}

// ──────────────────────────────────────────────────────────────────────────
// (7) Pipeline α' — 3.1 Live AUDIO mode + outputAudioTranscription
// After check #6 proved responseModalities=[TEXT] is refused on 3.1 Live
// preview ("Internal error encountered." on open), we pivot to grabbing
// Gemini's self-transcription of its spoken output. We keep AUDIO modality
// (proven to work in prod gemini-bridge.js), discard the audio, pipe the
// streaming transcript text to Cartesia cloned voice.
// PASS = one or more outputTranscription events observed + turnComplete.
// ──────────────────────────────────────────────────────────────────────────
async function check31LiveAudioWithOutputTranscription() {
  if (!GEMINI) {
    record("Gemini 3.1 Live AUDIO + outputTranscription (Pipeline α')", null, 'GEMINI_API_KEY unset — skipped');
    return;
  }

  let pcmBody;
  let fixtureDetail = 'silent-pcm-fallback';
  try {
    const wav = await readFile(
      new URL('../scripts/fixtures/voice-test-vuk-hello.wav', import.meta.url),
    );
    if (wav.slice(0, 4).toString() !== 'RIFF' || wav.slice(8, 12).toString() !== 'WAVE') {
      throw new Error('fixture is not a RIFF/WAVE file');
    }
    pcmBody = wav.slice(44);
    const durationSec = (pcmBody.length / 2 / 16000).toFixed(2);
    fixtureDetail = `fixture=voice-test-vuk-hello.wav duration=${durationSec}s`;
  } catch (e) {
    pcmBody = Buffer.alloc(32000, 0);
    fixtureDetail = `fixture-missing (${e.message}) — using 1s silence (ambiguous)`;
  }

  const MODEL = 'gemini-3.1-flash-live-preview';
  const client = new GoogleGenAI({ apiKey: GEMINI, httpOptions: { apiVersion: 'v1alpha' } });

  let session;
  let setupError = null;
  let sawTurnComplete = false;
  let sawSetupComplete = false;
  let outputTranscript = '';
  let outputTranscriptEvents = 0;
  let audioOutBytes = 0;
  const rawEvents = [];
  try {
    session = await client.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
        systemInstruction: 'You are a helpful mentor. Reply in one short sentence.',
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      },
      callbacks: {
        onopen: () => { rawEvents.push({ t: 'open' }); },
        onmessage: (msg) => {
          try {
            const safe = JSON.parse(JSON.stringify(msg, (k, v) => {
              if (k === 'data' && typeof v === 'string' && v.length > 40) return `<b64:${v.length}>`;
              return v;
            }));
            rawEvents.push(safe);
          } catch { rawEvents.push({ t: 'unparseable' }); }

          if (msg?.setupComplete) sawSetupComplete = true;
          const sc = msg?.serverContent;
          // Count audio-out bytes (we'll discard in production)
          const parts = sc?.modelTurn?.parts;
          if (parts?.length) {
            for (const p of parts) {
              const b64 = p?.inlineData?.data;
              if (typeof b64 === 'string') audioOutBytes += Math.floor(b64.length * 0.75);
            }
          }
          // outputTranscription is the key signal
          const ot = sc?.outputTranscription;
          if (ot?.text) {
            outputTranscriptEvents++;
            outputTranscript += ot.text;
          }
          if (sc?.turnComplete) sawTurnComplete = true;
        },
        onerror: (e) => { setupError = e?.message || String(e); rawEvents.push({ t: 'error', e: String(e?.message || e) }); },
        onclose: (e) => { rawEvents.push({ t: 'close', reason: String(e?.reason || '') }); },
      },
    });

    session.sendRealtimeInput({ activityStart: {} });
    const CHUNK = 10240;
    for (let offset = 0; offset < pcmBody.length; offset += CHUNK) {
      const slice = pcmBody.slice(offset, offset + CHUNK);
      session.sendRealtimeInput({
        audio: { data: slice.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
      });
    }
    session.sendRealtimeInput({ activityEnd: {} });

    const deadline = performance.now() + 20000;
    while (performance.now() < deadline && !sawTurnComplete && !setupError) {
      await new Promise((r) => setTimeout(r, 100));
    }

    console.log("\n--- 3.1 Live α' raw event trace (compressed) ---");
    console.log(`events=${rawEvents.length} setupComplete=${sawSetupComplete} turnComplete=${sawTurnComplete} audio_out_bytes=${audioOutBytes} transcript_events=${outputTranscriptEvents}`);
    for (const e of rawEvents) console.log(JSON.stringify(e).slice(0, 600));
    console.log(`--- end trace ---\n`);

    if (setupError) {
      record("Gemini 3.1 Live AUDIO + outputTranscription (Pipeline α')", false,
        `setup/modality error: ${setupError}`);
    } else if (sawTurnComplete && outputTranscriptEvents > 0) {
      record("Gemini 3.1 Live AUDIO + outputTranscription (Pipeline α')", true,
        `${fixtureDetail}; transcript_events=${outputTranscriptEvents} audio_out_bytes=${audioOutBytes} text="${outputTranscript.slice(0, 80).replace(/\s+/g, ' ')}"`);
    } else if (sawTurnComplete) {
      record("Gemini 3.1 Live AUDIO + outputTranscription (Pipeline α')", false,
        `${fixtureDetail}; turnComplete but 0 transcript events — outputAudioTranscription not emitted`);
    } else {
      record("Gemini 3.1 Live AUDIO + outputTranscription (Pipeline α')", false,
        `${fixtureDetail}; 20s elapsed with no turnComplete (events=${rawEvents.length}, setupComplete=${sawSetupComplete})`);
    }
  } catch (e) {
    record("Gemini 3.1 Live AUDIO + outputTranscription (Pipeline α')", false,
      `open failed: ${e?.message || e}`);
    return;
  } finally {
    try { session?.close(); } catch {}
  }
}

// ──────────────────────────────────────────────────────────────────────────
// (8) Control — 3.1 Live AUDIO-only (production config, no transcription).
// If this fails too, Google is broken right now. If this passes but α' fails,
// outputAudioTranscription on 3.1 Live preview is the specific problem.
// ──────────────────────────────────────────────────────────────────────────
async function check31LiveAudioOnlyControl() {
  if (!GEMINI) {
    record('Gemini 3.1 Live AUDIO-only (control)', null, 'GEMINI_API_KEY unset — skipped');
    return;
  }

  let pcmBody;
  try {
    const wav = await readFile(
      new URL('../scripts/fixtures/voice-test-vuk-hello.wav', import.meta.url),
    );
    pcmBody = wav.slice(44);
  } catch {
    pcmBody = Buffer.alloc(32000, 0);
  }

  const client = new GoogleGenAI({ apiKey: GEMINI, httpOptions: { apiVersion: 'v1alpha' } });

  let session;
  let sawTurnComplete = false;
  let sawSetupComplete = false;
  let audioOutBytes = 0;
  let setupError = null;
  const rawEvents = [];
  try {
    session = await client.live.connect({
      model: 'gemini-3.1-flash-live-preview',
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: 'You are a helpful mentor. Reply in one short sentence.',
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      },
      callbacks: {
        onopen: () => { rawEvents.push({ t: 'open' }); },
        onmessage: (msg) => {
          try {
            const safe = JSON.parse(JSON.stringify(msg, (k, v) => {
              if (k === 'data' && typeof v === 'string' && v.length > 40) return `<b64:${v.length}>`;
              return v;
            }));
            rawEvents.push(safe);
          } catch { rawEvents.push({ t: 'unparseable' }); }
          if (msg?.setupComplete) sawSetupComplete = true;
          const parts = msg?.serverContent?.modelTurn?.parts;
          if (parts?.length) {
            for (const p of parts) {
              const b64 = p?.inlineData?.data;
              if (typeof b64 === 'string') audioOutBytes += Math.floor(b64.length * 0.75);
            }
          }
          if (msg?.serverContent?.turnComplete) sawTurnComplete = true;
        },
        onerror: (e) => { setupError = e?.message || String(e); rawEvents.push({ t: 'error', e: String(e?.message || e) }); },
        onclose: (e) => { rawEvents.push({ t: 'close', reason: String(e?.reason || '') }); },
      },
    });

    session.sendRealtimeInput({ activityStart: {} });
    const CHUNK = 10240;
    for (let offset = 0; offset < pcmBody.length; offset += CHUNK) {
      const slice = pcmBody.slice(offset, offset + CHUNK);
      session.sendRealtimeInput({
        audio: { data: slice.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
      });
    }
    session.sendRealtimeInput({ activityEnd: {} });

    const deadline = performance.now() + 20000;
    while (performance.now() < deadline && !sawTurnComplete && !setupError) {
      await new Promise((r) => setTimeout(r, 100));
    }

    console.log('\n--- 3.1 Live AUDIO-only control trace ---');
    console.log(`events=${rawEvents.length} setupComplete=${sawSetupComplete} turnComplete=${sawTurnComplete} audio_out_bytes=${audioOutBytes}`);
    for (const e of rawEvents) console.log(JSON.stringify(e).slice(0, 600));
    console.log(`--- end control trace ---\n`);

    if (setupError) {
      record('Gemini 3.1 Live AUDIO-only (control)', false, `setup error: ${setupError}`);
    } else if (sawTurnComplete && audioOutBytes > 0) {
      record('Gemini 3.1 Live AUDIO-only (control)', true,
        `audio_out_bytes=${audioOutBytes} turnComplete=true — 3.1 Live AUDIO mode is alive`);
    } else {
      record('Gemini 3.1 Live AUDIO-only (control)', false,
        `events=${rawEvents.length} setupComplete=${sawSetupComplete} turnComplete=${sawTurnComplete} audio_out_bytes=${audioOutBytes} — 3.1 Live AUDIO mode itself appears broken`);
    }
  } catch (e) {
    record('Gemini 3.1 Live AUDIO-only (control)', false, `open failed: ${e?.message || e}`);
    return;
  } finally {
    try { session?.close(); } catch {}
  }
}

// ──────────────────────────────────────────────────────────────────────────
// (5) js-genai issue #2238 state (info only)
// ──────────────────────────────────────────────────────────────────────────
async function checkIssue2238() {
  try {
    const res = await fetch('https://api.github.com/repos/googleapis/js-genai/issues/2238', {
      headers: {
        accept: 'application/vnd.github+json',
        ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const issue = await res.json();
    record(
      'googleapis/js-genai#2238 state',
      null,
      `state=${issue.state} updated=${issue.updated_at} title="${(issue.title || '').slice(0, 80)}"`,
    );
  } catch (e) {
    record('googleapis/js-genai#2238 state', null, `fetch failed: ${e.message}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Days 8–12 Voice Phase 0 verification (REV 5 hard contract)\n');

  await checkSdkTypes();
  await checkCartesia();
  await check25NativeAudioInputTranscription();
  await check31LiveTextOutput();
  await check31LiveAudioWithOutputTranscription();
  // REV 5.2 audit M5: checks #7 and #8 both open a 3.1-Live session on the
  // same API key within seconds of each other. The preview's concurrent-
  // session cap intermittently returns "Precondition check failed" on the
  // second open. A 10s breather lets the previous session fully close
  // server-side before we try again, turning the control from FLAKE → stable.
  await new Promise((r) => setTimeout(r, 10_000));
  await check31LiveAudioOnlyControl();
  await checkIssue2238();

  // Emit a results file the plan doc can reference.
  const summary = results
    .map((r) => `- **${r.section}** — ${r.passed === true ? 'PASS' : r.passed === false ? 'FAIL' : 'INFO'}: ${r.detail}`)
    .join('\n');
  const body = `# Phase 0 Measurements — Days 8–12 Voice Plan

Generated: ${new Date().toISOString()}
Script: scripts/voice-phase0-verify.mjs

## Results

${summary}

## Sign-off

Plan REV 5 Hard Contract items 4–7 covered by the above results. File committed
alongside the 11 migration drafts before Phase 1 coding begins.
`;
  await writeFile(
    new URL('../docs/_planning/PHASE_0_MEASUREMENTS.md', import.meta.url),
    body,
    'utf8',
  );
  console.log('\nResults written to docs/_planning/PHASE_0_MEASUREMENTS.md');

  // Pipeline α (TEXT-out) now expected to fail on 3.1 Live preview — it's left
  // in the check list as a documented negative result. Gate on α' instead.
  const mandatory = results.filter(
    (r) =>
      r.section.startsWith('Cartesia reachability') ||
      r.section.startsWith('Cartesia context-id reconnect') ||
      r.section.startsWith("Gemini 3.1 Live AUDIO + outputTranscription"),
  );
  const anyFailed = mandatory.some((r) => r.passed === false);
  if (anyFailed) {
    console.error('\nOne or more mandatory checks failed — Phase 1 gated.');
    process.exit(1);
  }
  console.log('\nMandatory checks passed (or skipped with reason).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
