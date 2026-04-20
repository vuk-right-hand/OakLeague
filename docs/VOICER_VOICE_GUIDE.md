# Voice AI Conversational Pipeline — Build Guide

> Distilled from Voicer's production voice pipeline (~10 bugs in two days of debugging) + OakLeague-specific updates for Gemini 3.1 Flash Live.
> **Last updated:** 2026-04-20

---

## 0. How to use this doc

You are about to build a browser-based bidirectional voice AI feature. **Read §1–§3 before writing any code.** The rest is reference material.

If something in this doc contradicts what you "feel" is right from general knowledge, **trust the doc**. The alternatives listed as "DON'T" were tried and broke in production.

---

## 1. The target product

Interactive video with voice Q&A:

1. User watches a vertical 9:16 video hook of a creator.
2. User taps "Ask" → screen rotates to 16:9 → avatar fades in → mic opens.
3. User asks a question.
4. AI (creator's voice / persona) answers with voice + lip-synced avatar.
5. Conversation continues, user can interrupt (barge-in).
6. User navigates away → session ends → quota debited.

**Transport:** browser → LiveKit Cloud (WebRTC pipe) + direct WebSocket to Gemini Live from the browser. No intermediate server for voice — ephemeral token issued by our Next.js server so the Gemini API key never reaches the client.

---

## 2. Provider — already decided for OakLeague

**Default:** `gemini-3.1-flash-live-preview` (released 2026-03-26). Native audio-to-audio, single model, no transcribe-think-synthesize pipeline. Best-in-class for conversational back-and-forth.

**Fallback (one env-swap):** `gemini-live-2.5-flash-native-audio` (GA on Vertex).

**Why 3.1 over 2.5 at this moment:** 3.1 has better tonal understanding, thinking modes (`thinkingLevel`), 2x conversation context, and improved handling of user frustration/confusion. Pricing is the same tier.

**Why a Spike-A gate exists:** On 2026-04-18 Voicer reported a 15-20s end-to-end latency regression on 3.1 in PWA on real phones. Google's blog claims 3.1 is faster. Real-world disagreed. Day 4 Spike A must measure real-device PWA latency for both 3.1 and 2.5. If 3.1 regression confirms, flip `VOICE_MODEL` → 2.5, zero code change.

### Hard rule — model pinning

**Pin a specific version string.** Banned: `-latest`, bare `-preview` with no version.

```bash
VOICE_MODEL=gemini-3.1-flash-live-preview  # or gemini-live-2.5-flash-native-audio
```

Real-API gated test (`RUN_REAL_API_TESTS=1`) catches silent model deprecation.

---

## 3. Architecture in one diagram

```
┌──────────────────────────── Browser (PWA / React) ──────────────────────────┐
│                                                                             │
│  [Tap "Ask"]                                                                │
│       │                                                                     │
│       ▼                                                                     │
│  [connect]──► [new AudioContext({sampleRate:16000})]──── suspend/resume     │
│       │              │                                                      │
│       │              ──► audioWorklet.addModule("mic-worklet.js") PRE-WARM  │
│       │              ──► audioWorklet.addModule("tts-worklet.js") PRE-WARM  │
│       │                                                                     │
│       ▼                                                                     │
│  [WebSocket open] ──► [provider session created, MODEL PINNED]              │
│       │                                                                     │
│       ▼                                                                     │
│  [tap voice] ──► getUserMedia (mic indicator lights — EXPECTED UX)          │
│       │                                                                     │
│       ▼                                                                     │
│  MediaStreamSource ──► mic-worklet (PCM16, 16kHz, decimated from 48k)       │
│       │                       │                                             │
│       │                       ▼                                             │
│       │              [postMessage → main thread → ws.send(send_realtime_input)]
│       │                                       │                             │
│       │                                       ▼                             │
│       │                              [Provider WS: Gemini 3.1 Live]         │
│       │                                       │                             │
│       │         ┌───── audio frames back ─────┘                             │
│       │         ▼                                                           │
│       │  [tts-worklet ring buffer] ──► AudioContext.destination             │
│       │         ▲                                                           │
│       │         │ (barge-in: flush ring buffer if mic VAD detects speech)   │
│       │                                                                     │
│  [tap again] ──► stopListening ──► stream.getTracks().stop() (mic OFF)      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Three lifetimes — keep separate

1. **Connection lifetime** — AudioContext + WS + loaded worklets. Opens at `connect()`, closes at `disconnect()`.
2. **Session lifetime** — provider WS open + model ready. Same as connection in our model.
3. **Turn lifetime** — one user voice-tap. `activityStart` → user speaks → `activityEnd` → AI speaks → `turn_complete`.
4. **Per-turn state** — accumulated transcripts, timestamps, RMS window. **Reset at turn boundary, NOT at connection boundary.**

Blurring these is the #1 source of bugs.

---

## 4. Browser audio pipeline — the traps

### 4.1 AudioContext sample rate is a lie on Android Chrome

```js
const ctx = new AudioContext({ sampleRate: 16000 });
console.log(ctx.sampleRate);  // 48000 on Pixel 7 Pro / most Android Chrome
```

Android Chrome **silently ignores** the hint. iOS Safari honors 16 kHz. Desktop Chrome honors it.

**Fix:** read `ctx.sampleRate` after construction and do your own resampling in the worklet.

```js
const inputSampleRate = audioCtx.sampleRate;  // 48000 or 16000, actually measured
const worklet = new AudioWorkletNode(audioCtx, "mic-processor", {
  processorOptions: { inputSampleRate, targetSampleRate: 16000 }
});
```

### 4.2 Decimation needs an anti-aliasing filter

**DON'T** take every 3rd sample (48k → 16k naive decimation). Aliasing folds 10 kHz content to 6 kHz, poisons ASR.

**DO** use a 7-tap windowed-sinc FIR low-pass filter with cutoff at ~7.5 kHz, then linear-interpolation resample:

```js
// mic-worklet.js — runs in AudioWorkletGlobalScope
class MicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { inputSampleRate, targetSampleRate } = options.processorOptions;
    this.ratio = inputSampleRate / targetSampleRate;
    this.needsDecimation = Math.abs(this.ratio - 1) > 0.01;
    this.firTaps = this._designSincFIR(7, 0.5 * targetSampleRate / inputSampleRate);
    this.firBuf = new Float32Array(7);
    this._phase = 0;
  }

  _designSincFIR(numTaps, cutoff) {
    const taps = new Float32Array(numTaps);
    const mid = (numTaps - 1) / 2;
    let sum = 0;
    for (let i = 0; i < numTaps; i++) {
      const n = i - mid;
      const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
      const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (numTaps - 1));
      taps[i] = sinc * hamming;
      sum += taps[i];
    }
    for (let i = 0; i < numTaps; i++) taps[i] /= sum;
    return taps;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const output = new Int16Array(Math.ceil(input.length / this.ratio));
    let outIdx = 0;

    for (let i = 0; i < input.length; i++) {
      this.firBuf.copyWithin(0, 1);
      this.firBuf[6] = input[i];
      this._phase += 1;

      if (this._phase >= this.ratio) {
        this._phase -= this.ratio;
        let acc = 0;
        for (let t = 0; t < 7; t++) acc += this.firBuf[t] * this.firTaps[t];
        const clamped = Math.max(-1, Math.min(1, acc));
        output[outIdx++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      }
    }
    this.port.postMessage(output.subarray(0, outIdx).buffer, [output.buffer]);
    return true;
  }
}
registerProcessor("mic-processor", MicProcessor);
```

Bypass decimation when `inputSampleRate === targetSampleRate` (iOS Safari).

### 4.3 Pre-warm audio BUT NOT THE MIC

When the user clicks "connect" pre-load:
- `new AudioContext({sampleRate: 16000})`
- `await audioCtx.audioWorklet.addModule("mic-worklet.js")`
- `await audioCtx.audioWorklet.addModule("tts-worklet.js")`

**DO NOT call `getUserMedia` at pre-warm.** Lights the OS mic indicator for the whole idle session. Creepy. User contract: **mic lights = being listened to**.

`getUserMedia` runs inside the voice-tap handler.

### 4.4 Suspended AudioContext trap

Mobile PWAs suspend AudioContext on background. Always:
```js
if (audioCtx.state === "suspended") await audioCtx.resume();
```
Put this at the top of every `startListening` and `playTTS`. Without it: silent in prod.

### 4.5 `worklet.port.onmessage` closure trap

Rebind `worklet.port.onmessage` **every** `startListening()` — the callback captures `wsRef.current` at first-bind and holds a stale reference across reconnects.

```js
async function startListening() {
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { sampleRate: 16000, echoCancellation: true, noiseSuppression: true }
  });
  const source = audioCtx.createMediaStreamSource(stream);
  source.connect(worklet).connect(gain);

  worklet.port.onmessage = (e) => {  // ⚠ rebind every call
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(e.data);
    }
  };
}
```

### 4.6 `active = true` MUST precede any `await` in session start

```js
// WRONG — chunks during the await are silently dropped
async start() {
  this.session = await provider.connect();
  this.active = true;  // ← too late
}

// RIGHT
async start() {
  this.active = true;        // ← gate opens immediately
  this.session = await provider.connect();
}
```

Voicer dropped the first 3-5s of audio on every connect to this.

---

## 5. TTS playback

### 5.1 Use an AudioWorklet ring buffer, not `<audio>` or `AudioBufferSourceNode`

- `<audio>` — too much buffering, no sample-level control, no barge-in.
- `AudioBufferSourceNode` — one-shot, no mid-play append, gaps.
- **AudioWorklet ring** — sample-accurate, drainable on barge-in, zero gap.

```js
// tts-worklet.js
class TTSProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(48000 * 30);  // 30s ring at 48kHz
    this.readIdx = 0;
    this.writeIdx = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === "flush") {
        this.readIdx = this.writeIdx = 0;  // barge-in
      } else if (e.data.type === "audio") {
        const chunk = new Float32Array(e.data.pcm);
        for (let i = 0; i < chunk.length; i++) {
          this.buffer[this.writeIdx] = chunk[i];
          this.writeIdx = (this.writeIdx + 1) % this.buffer.length;
        }
      }
    };
  }
  process(_, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      if (this.readIdx === this.writeIdx) {
        out[i] = 0;  // silence on underrun
      } else {
        out[i] = this.buffer[this.readIdx];
        this.readIdx = (this.readIdx + 1) % this.buffer.length;
      }
    }
    return true;
  }
}
registerProcessor("tts-processor", TTSProcessor);
```

### 5.2 Resample incoming audio

Gemini Live returns PCM16 at 24 kHz. AudioContext likely runs at 48 kHz. Zero-stuff + low-pass for 24→48.

### 5.3 iOS audio unlock — the hidden gate

iOS Safari requires a user-gesture-initiated `audioCtx.resume()` before any audio output works. Do it inside the connect button click handler:

```js
await audioCtx.resume();
```

If TTS is silent on iOS: this is it, 90% of the time.

### 5.4 First-word latency

Start playback at ~40-80ms of buffer. Smaller = underruns. Larger = perceptible delay. Gemini streams ~20ms frames — 2-4 frames of buffer is right.

---

## 6. Session lifecycle

### 6.1 Pre-warm the session, not the turn

**Voicer's 7s → <500ms win:** open the WebSocket and establish model session **before** the user taps the mic.

```js
async function connect() {
  audioCtx = new AudioContext({ sampleRate: 16000 });
  await audioCtx.audioWorklet.addModule("mic-worklet.js");
  await audioCtx.audioWorklet.addModule("tts-worklet.js");

  ws = new WebSocket(providerURL);
  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({
      setup: {
        model: process.env.VOICE_MODEL || "gemini-3.1-flash-live-preview",
        generationConfig: {
          responseModalities: ["AUDIO"],
          thinkingConfig: { thinkingLevel: "low" }  // 3.1 — not thinkingBudget
        },
        systemInstruction: creatorPersona + topicDrawerContent,
        realtimeInputConfig: {
          automaticActivityDetection: { disabled: true }  // manual turn control
        }
      }
    }));
  });
  ws.addEventListener("message", onProviderMessage);
}
```

On first tap: audio flows immediately, no handshake cost. On tap #2+: near-instant.

### 6.2 Per-turn entry point

Do **not** reconnect the WS per turn. Have a `beginTurn()`:
1. Reset per-turn state (interim transcript, timestamps, TTS queue)
2. Send `realtimeInput.activityStart` (Gemini 3.1 — unchanged from 2.5)
3. Flow audio via `send_realtime_input` (NEW in 3.1 — was mediaChunks in 2.5)
4. Send `realtimeInput.activityEnd` → wait for model's `turn_complete`

### 6.3 Parsing 3.1 server events — multi-part change

**3.1 breaking change:** single server events now contain multiple `parts[]` simultaneously. Parser must iterate, not assume one:

```js
function onProviderMessage(event) {
  const msg = JSON.parse(event.data);
  const parts = msg.serverContent?.modelTurn?.parts ?? [];
  for (const part of parts) {  // 3.1 — iterate, do NOT index [0]
    if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
      ttsPort.postMessage({ type: "audio", pcm: decodeBase64(part.inlineData.data) });
    }
    if (part.text) accumulateTranscript(part.text);
  }
  if (msg.serverContent?.turnComplete) onTurnComplete();
}
```

### 6.4 Long-session token refresh

Gemini ephemeral tokens expire at **29 minutes**. 3.1 audio-only sessions have a **15-minute hard cap**. Either:
- Call `/ephemeralTokens` and reconnect in the background (blocks new turns briefly, seamless mid-silence)
- Or accept that conversations > 15 min require a graceful "reconnecting…" moment

Use a `restart_done_event` to block `beginTurn` on in-flight refresh.

---

## 7. Barge-in

### 7.1 Detection — hybrid

- **Client-side VAD:** energy-based on mic worklet output. RMS crosses threshold → barge-in. Fast.
- **Provider VAD:** `input_transcription` / `input.audio.committed` — ~100-200ms slower.

**Hybrid:** client-side for latency, provider events for confirmation. On client detection: immediately flush TTS ring buffer. Wait for provider before sending response cancel.

### 7.2 Cancel the model's response

```js
ttsPort.postMessage({ type: "flush" });
ws.send(JSON.stringify({ clientContent: { turnComplete: false } }));
```

### 7.3 Don't double-cancel

Use a `bargingIn` flag to dedupe on nervous triple-taps.

---

## 8. Error taxonomy — don't eat exceptions

Voicer spent two hours on a "nothing happens" bug that was a retired model string. Silent failure is the root of all evil.

```ts
type VoiceError =
  | { kind: "token";     detail: string }
  | { kind: "model";     detail: string }
  | { kind: "handshake"; detail: string }
  | { kind: "no-audio";  detail: string }
  | { kind: "mic-denied";detail: string }
  | { kind: "network";   detail: string }
  | { kind: "rate-limit";detail: string }
  | { kind: "cost-kill"; detail: string }  // OakLeague-specific: 150% quota breach
  | { kind: "unknown";   detail: string };

function friendlyMessage(err: VoiceError): string {
  switch (err.kind) {
    case "token": return "Signed out. Reconnect to continue.";
    case "model": return "Voice service updating. Try again in a moment.";
    case "handshake": return "Couldn't connect to voice service. Check your internet.";
    case "no-audio": return "I'm not hearing anything. Check your mic.";
    case "mic-denied": return "Mic access needed. Please allow in your browser settings.";
    case "network": return "Lost connection. Reconnecting…";
    case "rate-limit": return "Busy — try again in 30 seconds.";
    case "cost-kill": return "You've hit today's limit. Resets at midnight.";
    case "unknown": return "Something went wrong. Try tapping again.";
  }
}
```

**Critical:** queue pre-warm errors and flush to UI when ready — don't silently drop them.

---

## 9. Diagnostic logging

```
- connect() → WS open                    Xms
- WS open → session ready                Xms
- tap → first audio chunk sent           Xms  (TTF audio)
- tap → first model response             Xms  (TTF transcript / TTF TTS audio)
- rolling 5s RMS on mic input            (warn if < 0.0002 = silence)
- peak queue depth
- model ID + session UUID (for `cogs_log` join)
```

Log at INFO. Tag with session UUID.

---

## 10. Testing

Voicer's PWA tests use `node --test` with hand-rolled Web Audio mocks. JSDOM / happy-dom don't implement AudioContext or AudioWorklet.

### Test matrix

1. **Unit** — decimation math, FIR coefficient sum = 1.0, resample produces correct sample count.
2. **Integration (mocked)** — connect → tap → speech frames → transcripts → stop using a fake WS.
3. **Real-API (gated)** — `RUN_REAL_API_TESTS=1`. One test per pinned model — fires before users notice deprecation.
4. **OakLeague-specific** — `cogs_log` insert on every paid call. Quota-breach → kill-switch → `sessions.state = 'errored'`.

---

## 11. Rollback flags

Every major change ships with a boolean env flag:
- `VOICE_MODEL` env — instant swap 3.1 ↔ 2.5
- `NEXT_PUBLIC_AUDIO_PREWARM` — pre-warm on/off
- Barge-in client-VAD on/off

Delete legacy branches only after steady-state proven across iOS Safari + Android Chrome + desktop.

---

## 12. The DO NOT list

1. **DON'T** use `MediaRecorder`. Timing unreliable, format varies.
2. **DON'T** use `ScriptProcessorNode`. Deprecated, main-thread.
3. **DON'T** naive-decimate. FIR first.
4. **DON'T** pin `-latest` or bare `-preview`.
5. **DON'T** call `getUserMedia` at pre-warm.
6. **DON'T** trust `AudioContext({sampleRate: 16000})` on Android.
7. **DON'T** forget `audioCtx.resume()` on every voice-start.
8. **DON'T** attach `worklet.port.onmessage` once. Rebind.
9. **DON'T** eat exceptions in connect/handshake.
10. **DON'T** skip the real-API test.
11. **DON'T** reuse one WS across reconnects.
12. **DON'T** bundle mic and TTS in one worklet.
13. **DON'T** use `thinkingBudget` (2.5 term). Use `thinkingLevel` (3.1).
14. **DON'T** index `parts[0]` on 3.1 server events — iterate `parts[]`.
15. **DON'T** use `send_client_content` for per-turn audio in 3.1. Use `send_realtime_input`.

---

## 13. Minimum viable implementation — order of operations

1. **Hello world WS** — connect, send canned text "hello", receive any response. Proves auth + model ID.
2. **Mic → transcript** — AudioWorklet + 16kHz PCM → WS via `send_realtime_input` → print transcripts.
3. **Transcript → TTS** — model returns audio, playback via TTS worklet.
4. **Pre-warm** — split connect (expensive) from tap (cheap). Measure: tap-to-first-audio < 500ms.
5. **Multi-turn** — tap N times without reconnecting. Verify session reuse.
6. **Barge-in** — interrupt AI mid-response. Flush TTS, cancel, new turn.
7. **Error taxonomy** — break deliberately, verify friendly messages.
8. **Token refresh** — run session past ephemeral token expiry.
9. **Mobile verification** — Android Chrome + iOS Safari physical devices. Not emulators.

**Do not move to N+1 until N is solid.** Compound bugs eat weeks.

---

## 14. Gemini 3.1 Flash Live — API quick reference

### Endpoint

```
wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1main.GenerativeService.BidiGenerateContent
```

### Auth

Ephemeral token from `/v1main/auth:generateToken` (expires in 29 min) OR API key in query string (BYOK dev only — never for client).

### Setup message

```json
{
  "setup": {
    "model": "gemini-3.1-flash-live-preview",
    "generationConfig": {
      "responseModalities": ["AUDIO"],
      "thinkingConfig": { "thinkingLevel": "low" }
    },
    "systemInstruction": "<creator persona + topic drawer>",
    "realtimeInputConfig": {
      "automaticActivityDetection": { "disabled": true }
    },
    "inputAudioTranscription": {},
    "outputAudioTranscription": {}
  }
}
```

### Audio in (3.1)

Use `send_realtime_input` for live audio (NEW in 3.1):
```json
{ "realtimeInput": { "mediaChunks": [{ "mimeType": "audio/pcm;rate=16000", "data": "<base64>" }] } }
```

### Audio out

```json
{ "serverContent": { "modelTurn": { "parts": [
  { "inlineData": { "mimeType": "audio/pcm;rate=24000", "data": "<base64>" } },
  { "text": "partial transcript" }
]}}}
```
**Iterate `parts[]`** — 3.1 packs multiple parts per event.

### Turn control

```json
{ "realtimeInput": { "activityStart": {} } }
{ "realtimeInput": { "activityEnd": {} } }
```

### Session limits

- Audio-only: **15 min** hard cap
- Audio + video: 2 min hard cap
- Ephemeral token: 29 min

### Pricing

- Audio input: $0.005/min
- Audio output: $0.018/min
- 10-min session ≈ $0.23 before TTS + avatar

### Migration cheatsheet 2.5 → 3.1

| 2.5 | 3.1 |
|---|---|
| `thinkingBudget: N` | `thinkingLevel: "minimal"\|"low"\|"medium"\|"high"` |
| Assume `parts[0]` | Iterate `parts[]` |
| `send_client_content` for live audio | `send_realtime_input` for live audio |
| `send_client_content` for history seed | `send_client_content` for history seed (unchanged) |
| Async tool calls | Sync tool calls only |
| Proactive audio available | Removed |
| Affective dialog available | Removed |

---

## 15. Critical files to create

- `src/lib/voice/mic-worklet.js` — PCM capture + decimation + anti-alias FIR
- `src/lib/voice/tts-worklet.js` — ring buffer playback with flush
- `src/lib/voice/session.ts` — WS setup, pre-warm, turn management, error taxonomy
- `src/lib/voice/provider-gemini.ts` — 3.1-specific message shapes, multi-part parsing
- `src/hooks/useVoice.ts` — React hook wrapping the above: `{connect, disconnect, startListening, stopListening, transcript, isListening, error}`
- `tests/voice-*.test.mjs` — hand-rolled mocks + real-API gated test

Keep each file under 300 lines. Split by concern when exceeding (worklet code, main-thread glue, provider-specific, session state).
