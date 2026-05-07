# Phase 0 — HeyGen LiveAvatar Lite verification

**Date verified:** 2026-05-06
**Plan:** scope-of-work in conversation thread → `scripts/heygen-phase0-verify.mjs`
**Verifier:** `scripts/heygen-phase0-verify.mjs` (raw dumps in `PHASE_0_HEYGEN_RAW.md`)
**Status (Run A — sandbox):** **CLEARED** 2026-05-06 — wire format works
**Status (Run B — prod):** **CLEARED** 2026-05-06 — chunking, barge-in, interrupt, idle-cadence all measured
**Verdict:** **GREEN — proceed with `heygen-bridge.ts` build.**

This file is the curated SOURCE OF TRUTH for the HeyGen wire format.
Public docs at docs.liveavatar.com are partly stale and partly wrong (success
codes, status codes, inbound vocabulary, audio chunking, barge-in, idle
cadence — see "doc lies" call-outs throughout). When this file conflicts
with docs.liveavatar.com, **trust this file**.

The verifier was run against a real LiveAvatar account on the free tier,
both `is_sandbox:true` (Wayne avatar) and `is_sandbox:false` (Ann Therapist,
1080p). The script was re-runnable; raw dumps from the most recent prod
run live in `PHASE_0_HEYGEN_RAW.md`.

---

## TL;DR — proceed with the bridge

Wire format works end-to-end. Latencies competitive with Simli. Three
unknowns the auditor flagged are now answered:

1. **Chunking:** every strategy works; 20ms-uniform (50× per 1s utterance)
   gives the lowest first-frame ack (123ms vs 485ms monolith). **Bridge
   should chunk Cartesia output at ≤20ms cadence** — same architectural
   shape as Simli's 6000-byte ring buffer, just different cadence.
2. **Barge-in:** the server **silently drops** a new utterance if the
   prior one wasn't ended. **Bridge MUST send `agent.interrupt` (or
   `agent.speak_end`) before starting a new utterance.** Cannot just
   stream the next chunk.
3. **Idle cadence:** server cleanly closes WS after **121.5 seconds** of
   silence — no `closing` state frame, just a clean drop. **Bridge
   heartbeat: every 30s** (`POST /v1/sessions/keep-alive` or any WS
   traffic). Anything over ~90s is risky.

Plus interrupt latency = 355ms (production-grade), stop is idempotent
across both runs, and the SDK's `livekit_client_token` is privileged so
must stay server-side.

---

## Verified findings

### 1. Auth and base URL
- **Base URL:** `https://api.liveavatar.com`
- **API key auth:** `x-api-key: <LIVEAVATAR_API_KEY>` on `POST /v1/sessions/token`.
- **Bearer auth:** `authorization: Bearer <session_token>` on
  `/v1/sessions/start`, `/v1/sessions/keep-alive`, `/v1/sessions/stop`.
- **Cloudflare-fronted:** `cf-ray` and `server: cloudflare` on every
  response. 5xx with `cf-ray` is a Cloudflare edge problem, not a
  HeyGen application error — bridge mapper should distinguish.

### 2. Two-call session boot — verified verbatim
- **`POST /v1/sessions/token`** body `{ mode: "LITE", avatar_id, is_sandbox }` →
  `200` with body `{ code: 1000, data: { session_id, session_token }, message }`.
  - `session_token` JWT carries `start_session_data` echoing the request
    (avatar_id, is_sandbox) and the `session_id`. Useful for debugging.
  - **Doc lie:** docs claim success `code: 100`. Server returns `code: 1000`.
    Confirmed across 8+ responses in both runs.
- **`POST /v1/sessions/start`** with Bearer JWT, empty body → **`201 Created`**
  (other endpoints return 200) with body:
  ```json
  {
    "code": 1000,
    "data": {
      "session_id": "<uuid>",
      "livekit_url": "wss://heygen-feapbkvq.livekit.cloud",
      "livekit_client_token": "<jwt 377 chars>",
      "livekit_agent_token": "<jwt 397 chars>",
      "max_session_duration": 60 | 1200,
      "ws_url": "wss://webrtc-signaling.heygen.io/v2-alpha/interactive-avatar/session/<room-uuid>"
    },
    "message": "Session created successfully"
  }
  ```
  - **`max_session_duration` = `60` in sandbox, `1200` (= 20 min) on prod
    free tier.** Bridge must read this from the response and never
    exceed it.
  - The room-uuid in `ws_url` matches the LiveKit `room` claim — the
    WS path component IS the room id.
  - **Two transports, two hosts:** `webrtc-signaling.heygen.io` (control WS)
    + `heygen-feapbkvq.livekit.cloud` (LiveKit room). Different edges,
    different latencies — log both for region inference.

### 3. WebSocket inbound vocabulary — 9 types verified, docs admit only 2

| Type | When it fires | Carries `task.id`? |
|---|---|---|
| `session.state_updated` | post-WS-open, sets `state: "connected"` | no |
| `agent.audio_buffer_appended` | first ack after we send `agent.speak` (carrier of correlation key) | **yes** |
| `agent.audio_buffer_committed` | server has accepted buffer for synthesis (~1ms after appended) | yes |
| `agent.speak_started` | avatar started lipsyncing | yes |
| `agent.speak_ended` | avatar finished or was interrupted | yes |
| `agent.idle_started` | avatar back to idle (~1ms after speak_ended) | no |
| `agent.idle_ended` | new utterance starting after idle | (Run B) |
| `agent.audio_buffer_cleared` | fires after `agent.interrupt` | (Run B) |
| `warning` | observed in idle phase; content TBD — content past first-50 frames | unknown |

**Bridge must explicitly handle or no-op all 9.** Reject unknown types
loudly so the next breaking change is visible.

### 4. Outbound vocabulary
- `{ type: "agent.speak", event_id: <client-uuid>, audio: <base64-pcm16-24k> }`
- `{ type: "agent.speak_end", event_id: <same-client-uuid> }`
- `{ type: "agent.interrupt", event_id: <fresh-client-uuid> }`
- `{ type: "agent.start_listening" | "agent.stop_listening", event_id }` (untested)

Reuse a single `event_id` across all chunks of one utterance + the
trailing `agent.speak_end`.

### 5. Correlation key is `task.id`, not `event_id` ⚠ load-bearing
The single most important wire detail not in any HeyGen doc.

The server **assigns a fresh `event_id` to every inbound frame** — they
do NOT echo the client-supplied `event_id`. What stays stable across an
utterance's lifecycle is `task.id`:

```
client → server:  { type: "agent.speak",       event_id: "65eab26f-..." }
server → client:  { type: "audio_buffer_appended",  event_id: "e4865bcd-...", task: { id: "c75f39ca-..." } }
server → client:  { type: "audio_buffer_committed", event_id: "2e46d212-...", task: { id: "c75f39ca-..." } }
server → client:  { type: "speak_started",          event_id: "0abd2f86-...", task: { id: "c75f39ca-..." } }
server → client:  { type: "speak_ended",            event_id: "5fa72a3a-...", task: { id: "c75f39ca-..." } }
```

**Bridge contract:**
1. Client sends `agent.speak` with a client-generated `event_id`.
2. Capture `task.id` from the FIRST inbound `audio_buffer_appended` after the send.
3. Match every subsequent server frame for that utterance on `task.id`.
4. Never match on the client-sent `event_id`.

### 6. Audio chunking — all sizes work; smaller is faster (Run B)

| Strategy | Chunks per 1s tone | First server ack (`audio_buffer_appended`) | First lipsync (`speak_started`) | Total (`speak_ended`) |
|---|---|---|---|---|
| Monolith | 1 × 48000B raw | 485ms | +269ms | +1001ms |
| SDK .d.ts (400ms + 1s) | 2 | 242ms | +311ms | +1000ms |
| **SDK .js 20ms uniform** | **50 × 960B** | **123ms** | **+273ms** | **+1000ms** |

**20ms-uniform chunking is the lowest-latency path** — server starts
processing on the first 960-byte chunk without waiting for the full
buffer. Bridge contract: chunk Cartesia PCM16-24k output at 20ms (960
raw bytes per chunk = 1280 base64 chars per chunk). The Simli bridge's
6000-byte ring buffer pattern translates directly — different size,
same architecture.

**Wire format:** raw PCM bytes → base64 → string in `audio` field. The
SDK source's "binary string" comment (`splitPcm24kStringToChunks`) is
misleading — what works on the wire is base64, confirmed across all
three strategies in Run B.

### 7. Barge-in — server SILENTLY drops new utterance if prior unended ⚠
**The single most consequential bridge-architecture finding.**

Run B test: send 500ms PCM with NO `agent.speak_end`, then 300ms later
send a fresh `event_id` with new audio. Result over the next 8 seconds:

```json
"bargeIn": {
  "first_event_id":  "9516caa3-...", "first_task_id": "9e743824-...",
  "second_event_id": "d9623932-...",
  "frames_after_second": []
}
```

**Zero inbound frames.** No `audio_buffer_appended` for the second
utterance. No error. No rejection. The server appears to require
`agent.speak_end` (or `agent.interrupt`) on the prior utterance before
it will process a new one.

**Bridge contract for barge-in:**
1. On user barge-in, send `agent.interrupt` first (or `agent.speak_end`
   on the in-flight task — verify which is preferred during bridge build).
2. Wait for `agent.speak_ended` ack.
3. Only THEN send the new `agent.speak` chunks.

This is opposite to how Simli's `ClearBuffer()` works (drop and resume
immediately). HeyGen requires an explicit handshake.

### 8. Interrupt latency — 355ms (production-grade)
Run B: 3-second tone in flight, fired `agent.interrupt` 800ms after
`speak_started`, measured time to `speak_ended`:
- `agent.interrupt` sent at t=28453ms
- `agent.speak_ended` received at t=28808ms
- **Interrupt latency = 355ms**

Followed by `agent.audio_buffer_cleared` (Run B-only inbound type)
confirming server cleared the queued audio.

### 9. Idle/keep-alive — server drops WS at ~120s silence (Run B)
- Idle cadence test: silent for 130s after a `keep-alive` REST call.
- Server cleanly closed WS at t+121.5s with code 1000 wasClean=true.
- **No `closing` state frame** sent before the drop. **No `session.stopped`**
  message. WS just closes.

**Bridge heartbeat contract:**
- Send keep-alive (REST `POST /v1/sessions/keep-alive` body `{session_id}`,
  Bearer auth) every **30 seconds**.
- Anything over ~90s of silence is unsafe.
- The bridge's `setInterval(keepAlive, 30000)` must be started right
  after `start()` resolves and cleared in `close()`.

### 10. JWT permissions — `livekit_client_token` is privileged ⚠ security
Confirmed identical across both runs:
```json
{
  "iss": "APIPrDE25vYFWDG", "name": "client", "sub": "client",
  "video": {
    "canPublish": true, "canPublishData": true, "canSubscribe": true,
    "room": "<uuid matching ws_url path>", "roomJoin": true
  }
}
```
**The "client" token can publish, publish data, AND subscribe.** It is
NOT a subscribe-only token.

**Architectural implication:** `livekit_client_token` MUST stay server-side.
Voice-proxy mints it and uses it; never exposed to browser. For browser
playback, we re-mint a subscribe-only token via our own LiveKit server
SDK before handing to the client. (Same posture as Simli's compose-token
mint, which is also server-side.)

### 11. Stop — fully idempotent across both runs
- `POST /v1/sessions/stop` body `{ session_id, reason: "USER_CLOSED" }`,
  Bearer auth.
- First call: `200 OK { code: 1000, data: null, message: "Successfully stopped session" }`.
- Second call (200ms later): identical 200. Not 404, not 409.
- Server cleanly closes WS code 1000 wasClean=true at ~stop+200ms.
- **Bridge contract:** stop is fire-and-forget on disconnect; no need
  to guard against double-stop. Don't pre-close WS — let stop close it.

### 12. Sandbox vs production
- **Sandbox** (`is_sandbox: true`): only Wayne avatar (`dd73ea75-1218-4ef3-92ce-606d5f7fbc0a`).
  `max_session_duration: 60`. Free, no credits consumed.
- **Production** (`is_sandbox: false`): any active stock or custom avatar.
  `max_session_duration: 1200` on free tier. **1 credit/min** Lite,
  free tier has 10 credits/month.
- All 20 stock avatars on page 1 of `/v1/avatars/public` had `is_1080p: true`.
  Lite billing per-minute is independent of `is_1080p` (per docs/faq/credits).

### 13. `/v1/avatars/public` — public avatar list
Unauthed `GET`. Default `page_size=20`, max 100. Pagination via `next` URL.
Field names: `id | space_id | type | status | name | preview_url |
is_expired | default_voice: { id, name } | is_1080p | created_at |
updated_at | error_message`. 83 stock avatars total.

### 14. Pricing — credit-based, not pay-as-you-go
- Free tier: 10 credits/month (≈10 min Lite).
- Paid: 1000 credits/month rolling.
- Lite: 1 credit/min. Full / Embedded: 2 credits/min.
- Overage: $0.10 per credit, opt-in per account.
- Sessions escrow 1 minute's worth of credits on start.
- **Phase 0 used ~3 credits of free tier** across both runs.

---

## Bridge-build contract checklist (bake in from day one)

- [ ] Match all server frames on `task.id`, never on client `event_id` (§5).
- [ ] Treat `code: 1000` as success across all REST calls (§2).
- [ ] `/v1/sessions/start` returns 201, all others 200 (§2).
- [ ] Two transport URLs — `ws_url` for control, `livekit_url` for video (§2).
- [ ] Handle all 9 inbound WS types explicitly; reject unknown loudly (§3).
- [ ] Chunk Cartesia PCM16-24k at 20ms (960 raw / 1280 base64 chars) (§6).
- [ ] Barge-in flow: send `agent.interrupt` → wait for `speak_ended` →
      then send new `agent.speak` (§7). Never just stream the next chunk.
- [ ] Heartbeat REST `/v1/sessions/keep-alive` every 30s starting at
      `start()` resolve, cleared in `close()` (§9). Server drops at ~120s.
- [ ] `livekit_client_token` server-side only; re-mint subscribe-only
      for browser (§10).
- [ ] Stop is idempotent — fire-and-forget on disconnect (§11).
- [ ] `max_session_duration` from `/v1/sessions/start` is the per-session
      ceiling — bridge enforces a graceful close before the cap (§2).

## Known unknowns deferred to bridge-build / Phase 0.5

- **First-rendered-video-frame latency** — Phase 0 verified server-side
  ack, not pixel arrival. Vuk to test in browser during bridge build.
- **`warning` event content** — observed during idle phase but content
  past frame 50 wasn't captured. Inspect during bridge integration tests.
- **`agent.start_listening` / `agent.stop_listening` server semantics** —
  outbound types verified by SDK but not exercised in Phase 0.
- **Custom avatar (video / image) creation** — Phase 0.5, separate verification.
- **Concurrent sessions per account** — not tested (Phase 0 ran one
  session at a time).
- **Network partition recovery** — what happens if WS drops mid-utterance?
  Bridge needs reconnect strategy verified during integration.

## Re-running the verifier

```powershell
# Sandbox (free, ~30s)
node --env-file=.env.local scripts/heygen-phase0-verify.mjs

# Prod (~3 credits, ~3 min — set KEEP_VERBOSE=1 for live frame log)
$env:KEEP_VERBOSE="1"; node --env-file=.env.local scripts/heygen-phase0-verify.mjs --prod
```

Raw run dumps go to `PHASE_0_HEYGEN_RAW.md` (overwritten each run); this
curated doc is hand-maintained and not touched by the script.

Watchdog: 7 min. Cleanup nets: SIGINT, uncaughtException, unhandledRejection,
try/finally, double-stop. Hard-fails if a sandbox response carries any
billable marker.
