# Spike A — Gemini Latency Gate

**Status:** v4 — Phase 0 PASS 2026-04-21, executing  
**Owner:** Vuk  
**Day:** 4 (2026-04-23)  
**Timebox:** 1 day (+ 10m Phase 0 REPL gate up front)  
**Decision output:** `VOICE_MODEL` locked. Results appended to `.claude_learnings.md`.

---

## Goal

Measure real-device round-trip latency for `gemini-3.1-flash-live-preview` vs `gemini-live-2.5-flash-native-audio` on physical iOS Safari PWA + Android Chrome. Primary metric: **TTFA** = time from `activityEnd` sent → first `audio/pcm` chunk received.

**Hypothesis:** 3.1 wins on quality _and_ latency. The Voicer 15-20s regression was infra mismatch (likely stale `v1main` endpoint), not model regression.

**Decision gate — use turn-2 TTFA (warm, no history bloat) on both devices:**
- ≤ 3000ms → keep 3.1 ✓
- 3000-5000ms → document regression, keep 3.1 (quality wins), re-spike after Google update
- > 5000ms consistently → flip `VOICE_MODEL=gemini-live-2.5-flash-native-audio`

> Turn-5 TTFA is reported but NOT the decision key — prior-turn context inflates it and masks pure model latency.

---

## Pre-verified facts

| Claim | Status | Verified on |
|---|---|---|
| WS endpoint (API key): `v1beta.BidiGenerateContent` | ✓ | 2026-04-21 |
| WS endpoint (ephemeral): `v1alpha.BidiGenerateContentConstrained` | ✓ | 2026-04-21 |
| `BidiGenerateContentConstrained` **still requires a `setup` frame as first WS message** — `liveConnectConstraints` constrains it, does NOT replace it | ✓ Auditor C2 | 2026-04-21 |
| SDK package name: **`@google/genai`** (not `@google/generative-ai` — package split) | ✓ | 2026-04-21 |
| 3.1 uses `thinkingLevel`; 2.5 uses `thinkingBudget` | ✓ | 2026-04-21 |
| 3.1 server events: iterate `parts[]`, never index `[0]` | ✓ | 2026-04-21 |
| `v1main` in VOICER doc (lines 518 + 523) is stale — must fix both | ✓ | 2026-04-21 |
| Gemini Live audio input: **raw headerless PCM16 @ 16kHz little-endian** — NOT WAV with RIFF header | ✓ Auditor C1 | 2026-04-21 |
| `cogs_log` schema: no `source` column; `cogs_service` enum has no `spike_a` — use `service='gemini'` + `operation='spike_a_*'` + `metadata` jsonb | ✓ Auditor C-NEW-1 | 2026-04-21 |
| `cogs_log.user_id` FK → `public.profiles(id)`, NOT `auth.users` | ✓ Auditor M2 | 2026-04-21 |
| Browser WebSocket cannot send PING frames; with `automaticActivityDetection.disabled=true` the server emits nothing until `activityEnd` — no RTT probe possible mid-session | ✓ Auditor C-NEW-2 | 2026-04-21 |
| Gemini Live sends **binary** frames (Blob/ArrayBuffer) on audio output — client must handle both binary + JSON text frames | ✓ Auditor small | 2026-04-21 |

---

## Checklist

### Phase 0 — REPL verification gate (30m — BLOCKING, Day 3 EVENING)

**Run this tonight (Day 3 evening), not Day 4 morning.** 10 minutes now de-risks 8 hours tomorrow. The single biggest risk to Day 4 is `@google/genai` token-mint nesting differing from the plan's assumed shape.

- [ ] `npm i @google/genai` — confirm package name and version
- [ ] **Pre-check:** verify Vuk's `profiles` row exists — `select id, email from public.profiles where email = 'vukpjescic@gmail.com'`. If missing, `cogs_log` inserts 500 on FK violation despite successful token mint. Seed a profile row or confirm onboarding was completed.
- [ ] In REPL, call `client.authTokens.create(...)` with a minimal config; **verify the exact nesting** — the plan assumes:
  ```ts
  {
    config: {
      uses: 1,
      liveConnectConstraints: {
        config: {                          // ← probable: config nested under liveConnectConstraints
          model,
          generationConfig: { ... },
          systemInstruction: "...",
          realtimeInputConfig: { ... }
        }
      }
    }
  }
  ```
  If docs disagree, capture the actual shape and update the plan before Phase 1.
- [ ] Open a raw WS to `v1alpha.BidiGenerateContentConstrained?access_token=...` in the REPL and confirm:
  - First frame MUST be `{ setup: { ... } }` (NOT optional)
  - Config values in `setup` must be consistent with `liveConnectConstraints` or it rejects
  - `setupComplete` arrives on success
- [ ] Hit `gemini-live-2.5-flash-native-audio` with an API-key WS connection. If `UNIMPLEMENTED` → Vertex-only path. If works → GA on AI Studio, no Vertex branch needed (auditor small: recent docs suggest 2.5 is GA on AI Studio).
- [ ] Record findings at top of `.claude_learnings.md` — these are inputs to Phase 1.

**Gate (numeric abort criterion):** if ANY of the following differs from the plan's assumed shape → **stop, re-draft Phase 1/3, and re-request approval**:
1. `authTokens.create` argument nesting (e.g., `config.liveConnectConstraints.config.*` vs a flatter shape)
2. `setup` frame required as first WS message on `BidiGenerateContentConstrained`
3. `2.5-flash-native-audio` availability on AI Studio WS (GA vs Vertex-only)
4. Any field name or enum value in `setup.generationConfig`
Do NOT "patch it up" mid-flight. Re-approval is cheap; bad assumptions on Day 4 are not.

---

### Phase 0 — RESULTS (2026-04-21, PASS with one plan amendment)

Probe script: [scripts/spike-a-phase0.mjs](scripts/spike-a-phase0.mjs). SDK: `@google/genai@1.50.1`.

**Passed:**
- ✅ **Shape #1** — `ai.authTokens.create({ config:{ uses, liveConnectConstraints:{ model, config } } })` accepted for both models.
- ✅ **Setup frame #2** — skipping setup closes WS code **1007** with reason `"setup must be the first message and only the first"`. Confirmed required.
- ✅ **2.5 availability #3** — `gemini-live-2.5-flash-native-audio` mints on AI Studio v1alpha. **No Vertex branch needed** — delete from Phase 4.
- ✅ **FK precheck** — Vuk's `profiles.id=0921e929-abe5-4335-bdf8-23b3eb2f1e40`, `admin_roles.role=superadmin`, not revoked. `cogs_log.user_id` FK will resolve.

**Plan amendment (not a gate fail):**
- ⚠️ **Gemini Live wire format is BINARY protobuf**, not JSON text. `setupComplete` arrived as 26-byte binary frame ~770ms post-setup. Audio output frames also binary.
  - **Fix:** Phase 3 client uses SDK `ai.live.connect({ model, config, callbacks })` — SDK decodes binary → `LiveServerMessage` object. Do NOT hand-write `JSON.parse(event.data)`.
  - Server-side token mint unchanged. Client-side flow: fetch token → `new GoogleGenAI({ apiKey: token.name, httpOptions: { apiVersion: 'v1alpha' } })` → `ai.live.connect(...)`.
  - SDK auto-sends setup frame — client just passes `config` to `connect()`.

**Plan correction (minor):**
- SDK access is `ai.authTokens.create(...)`, NOT `ai.tokens.create(...)` (SDK docblocks at `genai.d.ts:10359` are stale; class property at `:5357` is `readonly authTokens: Tokens`).

---

### Phase 1 — Ephemeral token API route + COGS logging (1.25h)

- [ ] Create `src/app/api/voice/ephemeral-token/route.ts`
  - POST only
  - **CSRF guard:** reject if `Origin` header ≠ `NEXT_PUBLIC_SITE_URL`
  - Auth: `assertAdminFromSession()` — existing `auth-guards.ts` throws `AuthGuardError`; wrap with `try/catch` returning `401/403` JSON
  - Body: `{ model: string }` — **exact** allowlist (hardcoded, no glob):
    - `"gemini-3.1-flash-live-preview"`
    - `"gemini-live-2.5-flash-native-audio"`
  - Mint token via `@google/genai` SDK `client.authTokens.create({...})` with **shape confirmed in Phase 0**; use `uses: 1` (treat WS drop as INVALID, mint fresh — not speculative `uses: 2`)
  - **10-second timeout** on SDK call; return `504` on timeout
  - Return `{ token }` only
  - **Never** log `GEMINI_API_KEY`
  - **Sentry/PostHog scrubbing — concrete patch (auditor M4):**
    - In [sentry.client.config.ts](sentry.client.config.ts), extend `redactInvitePath` (L29-31) to also strip the access_token query param:
      ```ts
      function redactInvitePath(s: string): string {
        return s
          .replace(/\/invite\/[^/?#]+/g, '/invite/[redacted]')
          .replace(/([?&])access_token=[^&#]+/g, '$1access_token=[redacted]');
      }
      ```
    - PostHog: no URL scrubber built-in. Mitigation = never pass token URLs to `posthog.capture` / autocapture (the harness opens the WS programmatically, not via link nav) + set PostHog `session_recording.maskAllInputs: true` is already default. No URL-level scrub needed because no page navigation carries the token.
  - Set response header `Referrer-Policy: no-referrer` on the route (prevents token leaking to origin headers downstream).
  - **Response headers:** `Cache-Control: no-store`

- [ ] **COGS logging — satisfy CLAUDE.md hard rule, schema-correct (auditor C-NEW-1).**
  - `cogs_log` has NO `source` column and `cogs_service` enum has NO `spike_a`. Do NOT invent either — no migration needed.
  - On successful token mint → insert row:
    ```ts
    {
      user_id:    <admin profile id — NOT auth.users.id; FK is profiles(id)>,
      session_id: null,
      service:    'gemini',
      operation:  'spike_a_ephemeral_mint',   // ≤ 64 chars, CHECK enforced
      units:      1,
      unit_label: 'token',
      cost_usd:   0,
      metadata:   { source: 'spike_a', model, device, ua }   // ≤ 4096 bytes
    }
    ```
  - Client reports final cost per run to `/api/voice/spike-a/record` which writes `operation='spike_a_live_audio_input_seconds'` / `spike_a_live_audio_output_seconds` with real pricing (3.1: $0.005/min input, $0.018/min output).
  - This validates the Day 8 COGS pipeline on the spike itself — no wasted work.
  - Kill-switch not required for spike (admin-only, bounded N=~30 runs), but the log path must work end-to-end.

- [ ] **Consecutive-INVALID cap (auditor M3).** Client tracks consecutive `INVALID` outcomes in memory. On **3** in a row (bad WiFi loop) → abort model cell, surface banner `"Aborted: 3 consecutive invalid sessions — check network"`, do not auto-remint.

---

### Phase 2 — Canned audio preparation (20m, done once offline)

- [ ] Generate `public/spike-a/canned-question.pcm` **OFFLINE on desktop** (not in-browser — iOS Safari `speechSynthesis` → AudioBuffer does not work):
  - Content: "What's the most important mindset shift for someone starting their entrepreneurship journey?"
  - Tool: `say` (macOS) / `espeak` (Linux) → `ffmpeg -f s16le -ar 16000 -ac 1` → raw PCM16 LE, **no container, no header**
  - Commit the binary file to repo (it's ~100KB)
  - Target duration: 2-4 seconds
- [ ] **On-load validation** in the client:
  - Fetch as `ArrayBuffer`
  - Assert `byteLength` corresponds to ≥ 2s and ≤ 5s at 16kHz mono PCM16: `byteLength / 2 / 16000` in `[2, 5]`
  - If out of bounds: fail with visible error, don't run

**Critical:** ship headerless raw PCM. Do NOT strip a WAV header at runtime — source of bugs. Generate headerless from the start.

**Windows CRLF trap (auditor M5):** create/append to `.gitattributes` at repo root:
```
*.pcm binary
```
before committing `canned-question.pcm`. Without this, git on Windows may CRLF-mangle the binary and every chunk will decode as garbage.

**Chunking:** split the PCM buffer into ~1s slices (≈32KB each at 16kHz PCM16), base64-encode each, send via `realtimeInput.mediaChunks` with `mimeType: "audio/pcm;rate=16000"`. No WAV RIFF header on any chunk.

---

### Phase 3 — Spike harness at `/admin/spike-a` (2.5h)

Route lives under `/admin/` so it **inherits** `src/app/admin/layout.tsx` which already handles `AuthGuardError` via `try/catch → notFound()`. No duplication, no custom redirect logic.

- [ ] `src/app/admin/spike-a/page.tsx` — RSC, no extra gate needed (layout handles it), renders `<SpikeClient />`, includes `<meta name="robots" content="noindex">`
- [ ] `src/app/admin/spike-a/spike-client.tsx` — client component

**Pre-mount PWA cookie preflight:**
On mount, client fetches `GET /api/me` (tiny JSON route returning `{ userId, email }` if session cookie valid). If 401/403 → render "Log in to Safari in regular tab first, then reinstall PWA" warning. iOS standalone PWA has a **separate cookie jar** from Safari — this catches it before users waste 10 minutes.

- [ ] Create `src/app/api/me/route.ts` if it doesn't exist — GET, uses `getCallerUserId()`, returns `{ userId }` or `401`.

**State machine per test run:**
```
IDLE → PREFLIGHT → FETCHING_TOKEN → WS_CONNECTING → SETUP_SENDING
  → SETUP_COMPLETE → AUDIO_SENDING → AWAITING_FIRST_CHUNK
  → DONE | ERROR | TIMEOUT | INVALID
```

**Session abort guards (all three — any fires → INVALID):**
```js
document.addEventListener("visibilitychange", onAbort);  // tab hidden
window.addEventListener("pagehide", onAbort);             // PWA navigation / phone call
document.addEventListener("freeze", onAbort);             // iOS freeze (M1)
```

**Timing points** (`performance.now()` at each):

| Var | Event |
|---|---|
| `t0` | "Run" clicked |
| `t1` | Ephemeral token received |
| `t2` | WS `open` event |
| `t3_setup_sent` | `setup` frame flushed to WS |
| `t3` | `setupComplete` event received |
| `t4` | `activityEnd` sent (last send) + snapshot `ws.bufferedAmount` |
| `t5` | First event containing `inlineData.mimeType audio/pcm` part received |

**RTT probe — REMOVED (auditor C-NEW-2):**
With `automaticActivityDetection.disabled=true` the server emits nothing in response to a bare media chunk — no ack exists to measure against. Browser WebSocket API cannot send PING frames. Any "probe" would be garbage data worse than no data. **Mitigation: same-WiFi discipline (Phase 4 pre-test checklist), report raw TTFA only.** Inter-model comparison on identical network = identical RTT → model delta is the signal.

**Derived metrics:**
- `token_ms = t1 - t0`
- `ws_handshake_ms = t2 - t1`
- `setup_send_ms = t3_setup_sent - t2`
- `setup_complete_ms = t3 - t3_setup_sent`
- `buffered_at_t4` = uplink backpressure indicator (auditor small: flag SUSPECT if > 4096 bytes)
- **`ttfa_ms = t5 - t4`** ← primary metric (decision key)
- `total_tap_to_audio_ms = t5 - t0` ← **diagnostic only** (includes token mint + handshake — do NOT surface as "user-perceived latency"; in prod the harness flow does not exist)

**Client connection via SDK (Phase 0 amendment — binary protobuf wire format):**
```ts
import { GoogleGenAI, Modality } from '@google/genai';

const { token } = await fetch('/api/voice/ephemeral-token', { method:'POST', body: JSON.stringify({ model }) }).then(r => r.json());
const client = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });

const session = await client.live.connect({
  model,
  config: {
    responseModalities: [Modality.AUDIO],
    systemInstruction: 'You are a helpful mentor. One sentence.',
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    // 3.1: thinkingConfig.thinkingLevel='minimal' | 2.5: thinkingConfig.thinkingBudget=0
  },
  callbacks: {
    onopen: () => { t2 = performance.now(); },
    onmessage: (m) => {
      if (m.setupComplete && !t3Recorded) { t3 = performance.now(); t3Recorded = true; return; }
      const parts = m.serverContent?.modelTurn?.parts ?? [];
      for (const part of parts) {
        if (part.inlineData?.mimeType?.startsWith('audio/pcm')) {
          if (!t5Recorded) { t5 = performance.now(); t5Recorded = true; }
        }
      }
      if (m.serverContent?.turnComplete) onTurnComplete();
    },
    onerror: (e) => { onAbort('ws_error', e); },
    onclose: (e) => { onAbort('ws_close_' + e.code, e); },
  },
});
```
SDK handles: binary protobuf decoding, setup-frame auto-send, token-bound apiVersion pinning. Values passed to `config` MUST match what was locked at mint time via `liveConnectConstraints.config`.

**Turn sequence (via `session.sendRealtimeInput`):**
1. `session.sendRealtimeInput({ activityStart: {} })`
2. For each ~1s slice of the headerless PCM16 buffer: `session.sendRealtimeInput({ media: { data: <base64>, mimeType: 'audio/pcm;rate=16000' } })`
3. Snapshot `session.conn.bufferedAmount` (flag SUSPECT if >4096); `session.sendRealtimeInput({ activityEnd: {} })`; record `t4`

**Per-phase timeouts:**

| Phase | Timeout | Result |
|---|---|---|
| Token fetch | 10s | TIMEOUT |
| WS open | 10s | TIMEOUT |
| `setupComplete` | 10s | TIMEOUT |
| First audio chunk | 15s | TIMEOUT |

**Response parsing:** handled by SDK — see `onmessage` in the "Client connection via SDK" block above. SDK gives decoded `LiveServerMessage` objects; we iterate `parts[]` (never `[0]`) per 3.1 multi-part rule.

**Run sequence:** **3 sessions × 5 turns per model cell** (auditor M1 — n=1 is below the noise floor). Report **median + IQR** across the three turn-2 samples per cell.
- Turn 1: cold (WS + setup amortized)
- **Turn 2**: warm, minimal history → **decision-gate metric** (reported as median / IQR across 3 sessions)
- Turns 3-5: warm with growing history → reported but not decision key (context inflates TTFA)
- WS drop mid-sequence → entire session INVALID, mint fresh token, restart
- 3 consecutive INVALIDs → abort cell (see Phase 1 cap)

**UI requirements:**
- Model selector: [3.1 Flash Live] [2.5 Flash Native Audio] — disabled mid-run
- "Run 5-turn session" button — disabled while in-flight
- Per-session table: `Turn | token_ms | ws_ms | setup_ms | buffered_at_t4 | ttfa_ms | total_ms | status`
- **Turn 2 rows highlighted** (decision key)
- Per-cell summary row: `turn2_median_ms | turn2_iqr_ms | n_valid / n_total`
- INVALID runs: strikethrough with abort reason
- "Copy JSON" payload:
  ```json
  {
    "gitSha": "...",
    "voiceModel": "...",
    "userAgent": "...",
    "standaloneMode": true,
    "network": { "effectiveType": "...", "rttEstimate": 0 },
    "timeOrigin": 0,
    "runs": [...]
  }
  ```

**iOS Safari PWA checklist (baked into UI):**
- `audioCtx.resume()` inside button click handler (unlock — required even if not playing audio back)
- `/api/me` preflight on mount catches separate-cookie-jar issue
- Show standalone-mode indicator: `window.matchMedia('(display-mode: standalone)').matches`

---

### Phase 4 — Physical device testing (2h)

- [ ] Push `spike/spike-a` branch → Vercel preview URL

**Pre-test checklist on each device:**
- [ ] Same WiFi on all devices (eliminates RTT delta between models)
- [ ] Screen auto-lock: Never / 5+ min
- [ ] Do Not Disturb on (no phone calls triggering `pagehide`)
- [ ] Logged in as Vuk (admin)
- [ ] For iOS: login in Safari regular tab → "Add to Home Screen" → open standalone → verify `/api/me` preflight passes

**Runs per device:**
Each cell = **3 sessions × 5 turns** (n=15 turns per cell, 3 turn-2 samples for median).
- [ ] iPhone 15+ Safari PWA — 3× 3.1 session → Copy JSON → 3× 2.5 session → Copy JSON
- [ ] Android Chrome — same
- [ ] Desktop Chrome baseline — same
- [ ] Budget: +20 min vs v3 (~10 min per extra session × 2 models × 3 devices = already inside Phase 4 2h timebox; Phase 4 may slip to 2h20m — acceptable)

**2.5 availability: CONFIRMED GA on AI Studio v1alpha (Phase 0, 2026-04-21).** No Vertex branch. Standard path for both models.

---

### Phase 5 — Decision + documentation (30m)

- [ ] Compare **turn-2 TTFA median (n=3)** across models and devices (decision metric)
- [ ] Apply decision gate (on median, per device):
  - ≤ 3000ms both devices → keep 3.1 ✓
  - 3000-5000ms → keep 3.1, document
  - > 5000ms consistently → flip `VOICE_MODEL=gemini-live-2.5-flash-native-audio` in `.env.local` + Vercel env dashboard
- [ ] Report IQR alongside median — wide IQR on an otherwise-passing median = flag for Day 8 follow-up, not a gate fail
- [ ] Append to `.claude_learnings.md`:
  ```
  ## 2026-04-23 — Spike A: Gemini Latency Gate
  Root cause: [v1main stale endpoint / confirmed regression / not reproduced]
  Fix: VOICE_MODEL=<final>, endpoints pinned to v1beta/v1alpha
  Lesson: [turn-2 TTFA table + notes]
  ```
- [ ] **Update `VOICER_VOICE_GUIDE.md`**:
  - Line 518: `v1main` → `v1beta`
  - Line 523: `/v1main/auth:generateToken` → `/v1alpha/authTokens` (or SDK equivalent)
- [ ] Update memory file (path is memory dir, not docs/):
  `C:\Users\Korisnik\.claude\projects\c--Antigravity-OakLeague\memory\project_voice_model.md` — record locked model + evidence

---

## Files created / touched

| File | Purpose | Reused Day 8? |
|---|---|---|
| `src/app/api/voice/ephemeral-token/route.ts` | Ephemeral token minter + Referrer-Policy | ✓ exactly |
| `src/app/api/voice/spike-a/record/route.ts` | Post-run cogs_log writer | ✓ pattern reused |
| `src/app/api/me/route.ts` | PWA cookie-jar preflight | ✓ general utility |
| `src/app/admin/spike-a/page.tsx` | RSC under admin layout | Spike-only |
| `src/app/admin/spike-a/spike-client.tsx` | Measurement harness | Spike-only |
| `public/spike-a/canned-question.pcm` | Headerless PCM16 @ 16kHz | Spike-only |
| `.gitattributes` | `*.pcm binary` — prevent Windows CRLF corruption | ✓ always |
| `sentry.client.config.ts` | Extend `redactInvitePath` with `access_token` scrub | ✓ always |
| `.claude_learnings.md` | Results appended | Always |
| `docs/VOICER_VOICE_GUIDE.md` | Fix `v1main` on L518, L523 | ✓ |
| `memory/project_voice_model.md` | Locked-model memory update | ✓ |

---

## Audit history

| Round | Criticals addressed | Summary |
|---|---|---|
| v1 | — | Initial draft |
| v2 | 6/6 (CSRF, constrained-token config, VAD, Vertex branch, iOS visibility, timeouts) | |
| v3 | 5/5 (C1 raw PCM / C2 setup-required / C3 Phase 0 REPL / C4 cogs_log / C5 `/admin/spike-a` layout) + 7/7 Mediums + Smalls | |
| v4 — CURRENT | **2/2 new Criticals** (C-NEW-1 schema-correct cogs_log — `service='gemini'`, `metadata.source='spike_a'`, profile FK pre-check; C-NEW-2 removed broken RTT probe) + **6/6 Mediums** (M1 n=3 sessions median+IQR, M2 profiles FK Phase-0 check, M3 3-consecutive-INVALID cap, M4 concrete Sentry regex, M5 `.gitattributes *.pcm binary`, M6 numeric Phase-0 abort criterion, M7 run REPL Day-3 evening) + Smalls (binary WS frames, `bufferedAmount > 4096 = SUSPECT`, `total_tap_to_audio_ms` marked diagnostic-only, `verified_on` column) | |
