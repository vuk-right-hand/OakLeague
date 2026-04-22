# Days 8–12 — Voice Pipeline (Production) — REV 5

**Window:** 2026-04-27 → 2026-05-01
**Revision history:** REV 1 drafted 2026-04-22. REV 2 incorporated auditor Critical × 5 + Medium × 7, plus web-verified blockers. **REV 3** resolves 10 pre-gate TODOs + 5 new-Criticals from second audit pass. **REV 4** resolves third-audit pass: 5 Criticals, 11 Mediums, 10 Smalls, 1 data-governance flag. **REV 5** (this doc's trailing § "REV 5 DELTA") resolves fourth-audit pass: 1 inverted-predicate Critical, 8 Mediums (cost-cap trigger coupling, Cartesia-rate gating Pro, beacon in-memory rate limit on Vercel, AudioBridge interface extension, admin role-name filter, cap sentinel, Cartesia context-id reconnect semantic, cross-resume cost accounting), 7 Smalls, 2 confirmations. **Read REV 5 DELTA first — it overrides all prior revisions on conflicts.**
**Deliverable:** Tap "Ask" on a hook → real-time voice conversation with the creator's AI avatar — quota decrements → barge-in works → errors are friendly → verified on desktop Chrome + Pixel Chrome + iPhone 11 Safari. No face yet (avatar lands Day 13–14).
**Upstream spike:** Spike A cleared 2026-04-21; Fly voice proxy + GeminiBridge + ticket auth + quota RPCs + cogs_insert_turn RPC + ghost reaper are already in production. This sprint *promotes* the admin-gated harness to a user-facing path and adds the client worklets, barge-in, tiered routing, and error taxonomy.

---

## Architecture Decisions (REV 2)

**D1 — Keep the Fly proxy. Promote `/voice/spike-a` → `/voice/session`.** Browser ↔ Fly proxy ↔ providers. API key server-side. Quota, COGS, kill-switch, session row lifecycle are all proxy-enforced. Unchanged from REV 1.

**D2 — Per-tier routing at session-open (locked for the session) — PRO PIPELINE ARCHITECTURE REVISED.**
Session-open picks pipeline from `profiles.tier`. No mid-session swap (CLAUDE.md hard rule).
- `free` → Gemini 3.1 Flash Live, native audio in/out, **Puck** voice (1 of 30 prebuilt Gemini voices; confirmed available). Cloning is not possible on Gemini Live.
- `premium` | `boardroom` → **Pro pipeline REVISED:** STT via Gemini 3.1 Flash Live `inputAudioTranscription` (audio modality in, transcript events out) → text shipped to `gemini-2.5-flash` via `generateContentStream` for reasoning → Cartesia Sonic 3 streaming TTS (voice_id = creator clone) → PCM16 24kHz stream to client. **We cannot run Gemini 3.1 Live in TEXT-only mode — upstream bug #2238 returns WS 1011. Gemini-2.5-flash via plain streaming `generateContent` is the reasoning leg; it is NOT a WebSocket.**
- Both pipelines expose the same AudioBridge contract to client. Client `tts-worklet` is identical.

**D2.1 — Pro pipeline bridge composition (new).**
`ProPipelineBridge` wraps THREE upstreams:
- `GeminiLiveSTTBridge` — 3.1 Flash Live with `responseModalities: [AUDIO]` still (the only working modality) but we DISCARD the audio output and only forward `inputTranscription` events. Alternative if discarding audio feels wasteful: `gemini-2.5-flash-native-audio-preview-12-2025` in "input-transcription + output-text" combo — verify in Phase 5. Accept the audio-billing waste for v1; token-based pricing switch (D6) reveals actual cost.
- `Gemini25TextBridge` — HTTP streaming `generateContentStream` call, fires on each completed user turn. Streams text tokens.
- `CartesiaBridge` — WebSocket to `wss://api.cartesia.ai/tts/websocket` with `context_id = session_id + turn_number`. New context per turn (mandatory for barge-in cancellation per Cartesia docs).

Per-turn lifecycle:
1. `turnStart()` → opens new Cartesia `context_id`.
2. Mic PCM streams to Gemini Live (STT leg) → transcription events accumulate.
3. `turnEnd()` (activityEnd + awaiting turnComplete with transcript) → full transcript handed to Gemini 2.5 stream.
4. Gemini 2.5 text tokens arrive → buffered + forwarded to Cartesia WS (streaming mode with `continue: true`).
5. Cartesia emits PCM16 chunks → proxy forwards binary to client.
6. Barge-in → client sends `{type:'cancel'}` → proxy sends Cartesia `{cancel: true}` (only stops not-yet-started work) AND closes-then-reopens the Cartesia `context_id`. Client-side buffer flush is the only guaranteed interruption.

**D3 — Cartesia voice cloning ships this sprint; non-admin UX gated off.**
Revised per web research: **Instant Voice Clone needs only 3s of clean audio** (not 30–60s). We still cap uploads at 10MB + [10s, 120s] duration for quality + audit + anti-abuse. Creator brain-training job already stores sample content; voice clone upload is a separate admin tool feeding the same `creators.voice_id` column.

**D4 — Client lives under `src/lib/voice/client/` + `public/worklets/`.** Unchanged from REV 1.

**D5 — Reconnect uses Gemini's native `sessionResumption` — REVISED.**
Web research overturns REV 1's D5: Gemini Live exposes a documented **session resumption** flow (resumption tokens valid 2h after WS drop, sessions live 24h, works with context compression to extend past the 15-min audio cap). Replaces our planned transcript-replay hack entirely (which was flagged Critical by the auditor for transcript leak + quota doubling risk).

- Proxy opens Live session with `sessionResumption: { transparent: true }` in setup (or the equivalent config — confirm field path in Phase 5).
- Proxy persists latest `resumption_update.new_handle` server-side in a new `sessions.gemini_resumption_handle text` column.
- On WS close (15-min cap, ~10-min connection drop, iOS background kill): client retries with `{ resume: true, sessionId: prior }`; proxy looks up prior `sessions.gemini_resumption_handle`, opens new Live session with `sessionResumption: { handle }`, associates with the EXISTING `sessions` row (no new row, no quota-bucket change).
- iOS Safari visibility-return path: if prior session < 2h ago AND owned by currently-authenticated `user_id`, offer resume; otherwise start fresh.
- Resume path tightens auditor C1 (cross-session transcript leak) to zero because Gemini's resumption handle is opaque and server-bound to a user's prior session row.
- For the Pro pipeline, session resumption has no equivalent since Gemini 2.5 is HTTP streaming (stateless). Pro reconnect = client replay of last N transcripts via `generateContentStream.contents[]` history, capped to 8 turns or 4k tokens whichever first; Cartesia context opens fresh per turn anyway.

**D6 — COGS operation name stability + unit migration.** Unchanged from REV 1, with the correction that `voice_accumulate_seconds` stays the ground-truth input to the kill-switch latch regardless of `VOICE_COGS_PRICING` — when the flag flips to `tokens`, the proxy computes estimated seconds from token deltas and passes seconds to the RPC. The `daily_quotas.seconds_used` column stays the single source of truth for the latch.

**D7 — Tier TOCTOU defense (new, auditor C2).** Proxy MUST verify `sessions.tier_at_session == expected_tier_for_pipeline` AFTER the insert returns. The `sessions_enforce_tier_and_kill_switch` trigger (migration 0017) re-reads `profiles.tier` at insert time — so the ticket's advisory tier CAN drift vs. the trigger's final value if an admin flip lands in the gap. Mismatch → proxy tears down WS with 4007 `tier_changed` (new code) and the client re-mints a ticket. No Pro-pipeline cost billed to a free-tier row.

**D8 — Migration safety for `pipeline_kind` (new, auditor C3).** The 0427 migration:
1. Adds column with no default, NOT NULL deferred.
2. In the same transaction, `UPDATE voice_tickets SET pipeline_kind = 'native_audio' WHERE consumed_at IS NOT NULL` (harmless backfill for history).
3. `DELETE FROM voice_tickets WHERE consumed_at IS NULL` (invalidates in-flight tickets so nobody silently downgrades post-deploy).
4. `ALTER COLUMN pipeline_kind SET NOT NULL`.
5. Column default added last. No `pipeline_kind_explicit` column needed because step 3 guarantees no pre-migration unconsumed rows exist.

---

## Order of Operations (Voicer §13 strict)

### Phase 1 — Hello-world on user-gated path (Day 8 AM)

- [ ] Add `assertCallerFromSession()` to `src/lib/auth-guards.ts` — net new helper (auditor small-nit): returns `{ userId, email }` for any authenticated user, or throws with status 401. Mirrors `assertAdminFromSession` structure.
- [ ] New RSC route `POST /api/voice/session/ticket` — **not admin-gated**; any authenticated user with `profiles.tier ≠ null`.
  - Same-origin + `assertCallerFromSession()`. `x-forwarded-host` honored only when `process.env.VERCEL === '1'` (Vercel edge) OR `NODE_ENV !== 'production'` (dev). Prod-non-Vercel refuses forwarded-host (auditor M5).
  - Body: `{ hookId: uuid, creatorId?: uuid }`. If `creatorId` omitted, derive from hook.
  - Resolve user tier → pick `pipeline_kind` + advisory `expected_tier` (tier snapshot at mint time; proxy re-verifies post-insert per D7).
  - Pre-flight: call existing `voice_check_quota` RPC with a synthesized future session_id? No — RPC signature requires an existing session. Instead: direct SELECT on `daily_quotas (user_id, today-local-date)` for kill-switch state; if latched, 429 `quota_exceeded` before minting. Saves a ticket burn per latched attempt.
  - Rate limit REVISED: **2 tickets/min/user** (auditor M1) + IP rate-limit at proxy path level (see Phase 8 bullet).
  - Mint ticket with `pipeline_kind`, `expected_tier`, `hook_id` (new column) so proxy passes through to `openSession` insert (auditor small: sessions.hook_id currently null-inserted).
- [ ] Migration `20260427000001_voice_tickets_pipeline_and_hook.sql` — per D8 sequence:
  1. `CREATE TYPE voice_pipeline_kind AS ENUM ('native_audio','pro_gemini25_cartesia')`.
  2. `ALTER TABLE voice_tickets ADD COLUMN pipeline_kind voice_pipeline_kind`.
  3. `ALTER TABLE voice_tickets ADD COLUMN expected_tier profile_tier`.
  4. `ALTER TABLE voice_tickets ADD COLUMN hook_id uuid REFERENCES hooks(id) ON DELETE SET NULL`.
  5. `UPDATE voice_tickets SET pipeline_kind = 'native_audio', expected_tier = 'free' WHERE consumed_at IS NOT NULL`.
  6. `DELETE FROM voice_tickets WHERE consumed_at IS NULL` (auditor C3 hard invalidation).
  7. `ALTER COLUMN pipeline_kind SET NOT NULL` + `ALTER COLUMN expected_tier SET NOT NULL`.
  8. Column defaults added last.
- [ ] Migration `20260427000002_sessions_gemini_resumption.sql` — add `sessions.gemini_resumption_handle text` (nullable) for D5 native session resumption.
- [ ] Proxy path `/voice/session` accepts both kinds; instantiates `GeminiBridge` or `ProPipelineBridge` (D2.1). For Phase 1, only `native_audio` is wired. Proxy reads `ticket.pipeline_kind` + `ticket.expected_tier` and compares post-insert `sessions.tier_at_session` to `expected_tier` (D7); mismatch → close 4007 `tier_changed`.
- [ ] Proxy IP rate limit: sliding window on `req.socket.remoteAddress` + `X-Forwarded-For[0]`: max 20 connections/min per IP. In-memory Map with 2-min eviction; good enough for single-machine Fly deploy. Deny pre-upgrade with 429 before ticket consume.
- [ ] Client smoke: hand-written `testConnect.ts` dev script that opens the WS, sends a canned text turn (`turn_start` → fake 1s of silence PCM → `turn_end`), prints received audio length. Proves tier-routed auth + quota + cogs path end-to-end for a non-admin user account.
- [ ] **Retire spike-a admin harness in full:** delete `src/app/api/voice/spike-a/` entirely (both `ticket/` and `record/`), delete the admin-only spike-a client page, delete the proxy's `/voice/spike-a` WS path binding. Keep `server/voice-proxy/*.test.js` files (they don't reach HTTP). `src/app/api/voice/ephemeral-token/route.ts` is orphaned after spike-a deletion — decision: remove it; the production flow does not mint ephemeral tokens to the client (auditor Unknown-2).

### Phase 2 — Mic → Transcript (Day 8 PM → Day 9 AM)

- [ ] **Redesign `public/worklets/mic-processor.js` per Voicer §4.2** (inherited Day-5 item: current naive 3:1 decimation drops sample 0 and aliases above 8 kHz).
  - 7-tap windowed-sinc Hamming FIR at cutoff `0.5 × 16k/inputRate`. Linear-phase, coefficient sum = 1.0 asserted in unit test.
  - Bypass decimation when `inputSampleRate === 16000` (iOS Safari path).
  - Read actual `ctx.sampleRate` from constructor options (already done) — don't trust the `AudioContext({sampleRate: 16000})` hint on Android (Voicer §4.1).
  - Frame size: 40ms @ 16kHz = 640 samples = 1280 bytes. Post via transferable `ArrayBuffer`.
- [ ] `src/lib/voice/client/session.ts` — main-thread glue.
  - `connect(opts)` → opens `AudioContext({sampleRate: 16000})`, loads both worklet modules, opens proxy WS. **Does NOT call `getUserMedia`.** (Voicer §4.3)
  - `startListening()` → `audioCtx.resume()` first (iOS unlock, §5.3), then `getUserMedia`, `createMediaStreamSource`, connect to worklet, rebind `worklet.port.onmessage` **every call** (§4.5 closure trap), `ws.send(turn_start)`, set `this.active = true` **before any await** (§4.6).
  - `stopListening()` → send `turn_end` over WS, track cleanup, worklet disconnect.
- [ ] Verify live transcripts round-trip on Pixel 7 Pro (48kHz path) and iPhone 11 (16kHz honor).

### Phase 3 — Transcript → TTS (Day 9 PM)

- [ ] `public/worklets/tts-processor.js` — ring buffer per Voicer §5.1.
  - 30-second Float32 ring at 48 kHz. Read/write pointers, silence on underrun.
  - `{type:'audio', pcm: ArrayBuffer}` to push frames; `{type:'flush'}` drains for barge-in.
  - **Resample incoming 24kHz PCM16 → 48kHz Float32 in worklet** via zero-stuff + FIR low-pass (§5.2). Verified on Chrome 48k and iOS 44.1k output-device mismatch.
- [ ] First-audio latency target: start playback at 2–3 frames of buffer (~40–60ms, §5.4). Measure and log TTFA in `diagnostics.ts`.
- [ ] Proxy already streams audio-out frames unchanged from GeminiBridge (24kHz LE PCM16) → client decodes base64 N/A (proxy sends raw binary frames, base64 is Gemini-side). Client just pipes to worklet.

### Phase 4 — Pre-warm split (Day 10 AM)

- [ ] Move proxy WS open + setupComplete + worklet module load into `connect()`; keep only `audioCtx.resume()` + `getUserMedia` + first `turn_start` in `startListening()`.
- [ ] Pre-warm trigger: first user gesture on the feed that touches a hook capable of conversation — NOT the initial page load (that would open a WS for every scroller and torch COGS).
  - Concretely: `onPointerDown` on the Ask button arms pre-warm, `onPointerUp` commits the tap. This matches Voicer's 7s → 500ms win.
- [ ] Measurement: tap-to-first-audio p50/p90 on all three surfaces. Target p50 < 700ms (Spike A matrix + pre-warm budget). Log to `.claude_learnings.md`.

### Phase 5 — Multi-turn (Day 10 PM) + Cartesia scaffold in parallel

- [ ] Verify ≥5 turns on a single WS without reconnect. No new `getUserMedia` call per turn — just pause/resume mic MediaStream tracks via `.enabled` toggle.
- [ ] 15-min test: use Gemini Live `sessionResumption` (D5 native). Open session, talk, wait until ~14:30, verify resumption handle is persisted to `sessions.gemini_resumption_handle`, force WS close, reconnect via `{resume:true}` ticket, verify context preserved (AI remembers last topic).
- [ ] **Cartesia scaffold (concurrent task):**
  - [ ] `server/voice-proxy/cartesia-bridge.js` — `AudioBridge` impl. Opens Cartesia WS to `wss://api.cartesia.ai/tts/websocket` with `access_token=<API_KEY>` query param (header auth not available from Node WS library in the shape we need). Output format: `pcm_s16le` @ 24kHz mono (matches Gemini free-path for client identity). New `context_id` per turn. On `{type:'cancel'}` from client: send Cartesia `{"context_id":..., "cancel":true}` AND abandon the context (open fresh next turn) — Cartesia's cancel only halts un-started work per docs, so the new-context-per-turn pattern is mandatory for barge-in.
  - [ ] `server/voice-proxy/gemini25-text-bridge.js` — HTTP `generateContentStream` client against `gemini-2.5-flash`. Single-shot per turn; maintains rolling `contents[]` history (last 8 turns or 4k tokens, whichever first). Replaces the REV 1 "Gemini 3.1 text-out via Live" path which is broken (upstream bug #2238).
  - [ ] `server/voice-proxy/pro-pipeline-bridge.js` — composite bridge implementing `AudioBridge`. Owns: GeminiLiveSTTBridge (input-transcription via 3.1 audio-modality session, audio-out discarded for now), Gemini25TextBridge, CartesiaBridge. Plumbs turn_start → opens new Cartesia context; turn_end → await Gemini-STT turn_complete, extract transcript, stream to Gemini-2.5, pipe tokens to Cartesia, forward PCM to ws.
  - [ ] **Pro pipeline mid-turn failure semantics (auditor C4):**
    - Gemini-STT fails: abort turn, client receives `{type:'error', code:'stt_failed'}`, no COGS.
    - Gemini-2.5 fails mid-stream: send partial text to Cartesia and mark turn as partial; COGS records tokens + partial chars.
    - Cartesia fails mid-synthesis: abort turn with `{type:'error', code:'tts_mid_turn_failure'}`, COGS records Gemini legs only; session stays open.
    - All three: surface to Sentry at `error` level with `{sessionId, turnNumber, failed_leg}` tags.
  - [ ] **COGS per-turn RPC for Pro path (auditor C4):** new migration `20260428000001_cogs_insert_turn_pro.sql` adding `cogs_insert_turn_pro(p_session_id, p_user_id, p_gemini_stt_input_seconds, p_gemini_stt_output_seconds, p_gemini25_input_tokens, p_gemini25_output_tokens, p_cartesia_characters, p_cartesia_audio_seconds, p_environment, p_metadata)`. Writes one row per leg with distinct `service` + `operation` so COGS viewer aggregates correctly. Add `voice_proxy_pro_turn` enum value to `cogs_service` if needed.
  - [ ] `src/app/api/admin/creator-voice-clone/route.ts` — admin-only upload.
    - Same-origin + `assertAdminFromSession()`.
    - Validate: `Content-Length <= 10 MB`; sniff actual audio type with `file-type` pkg (never trust Content-Type); require ffprobe duration ∈ [10s, 120s] (lowers floor to 10s per web research but keeps sane max); compute SHA-256 of blob; insert audit row `voice_clone_uploads (id, admin_user_id, creator_id, sha256, duration_seconds, mime, bytes, created_at)`.
    - Rate limit: 3 clones/day/admin via the audit table.
    - Call Cartesia voice-clone, store `voice_id` on `creators.voice_id`.
  - [ ] Gate Pro pipeline activation in ticket route: `profiles.tier IN ('premium','boardroom') AND profile.user_id IN (SELECT user_id FROM admin_roles_user_id)` for v1. Non-admin premium → silently downgrade to native_audio with metadata `pipeline_downgrade_reason='v1_gate'`. This is the auditor-flagged "admin can flip own account" demo path, with no side channel for exploit.

### Phase 6 — Barge-in (Day 11 AM) — REVISED

- [ ] Client-side hybrid VAD (Voicer §7.1) with auditor-M3 fixes.
  - Mic worklet posts rolling RMS to main thread every 40ms frame (cheap — already have the Int16 buffer).
  - Main thread threshold algorithm:
    - **Initial calibration:** first 500ms of mic open sets `ambientDbFs`. Floor: `max(-40, measured)`. Ceiling: `min(-20, measured)`. Keeps noisy-cafe and silent-room cases inside a plausible range.
    - **Threshold:** `ambientDbFs + 9dB` (raised from REV 1's +6 to cut false barge-in on AC hum and keystrokes).
    - **Adaptive re-calibration:** during AI-speaking windows (when the client is filling the TTS ring buffer), continuously recompute `ambientDbFs` from a 2-second sliding window of the mic — that's the "expected silence" floor. Update the threshold every 500ms.
    - **Spectral guard:** zero-crossing rate > 0.03 required simultaneously with RMS breach → kills pure-tone false positives (fans, sirens).
    - **Debounce:** 80ms (up from 60ms) to further cut transient triggers.
  - On detection while `isSpeaking`: (a) increment `flushGeneration` counter (auditor M2), (b) `ttsPort.postMessage({type:'flush', generation: n})`, (c) send `{type:'cancel'}` control frame to proxy, (d) immediately fire a new `turn_start`.
  - **Flush-race fix (auditor M2):** each audio frame from proxy carries a monotonic server-side turn counter in a length-prefixed binary header. Client main-thread tags incoming frames; any frame with `turn < currentTurn` is dropped BEFORE posting to tts-worklet. Worklet flush additionally clears pending `port.onmessage` queue.
- [ ] Proxy bridge contracts for cancel:
  - Native audio: `bridge.cancel()` sends `activityEnd` so Gemini commits to turn boundary; subsequent `activityStart` starts new turn (per gemini-bridge.js comment). Implement as `this._session.sendRealtimeInput({activityEnd:{}})` — stop relying on no-op.
  - Pro path: `bridge.cancel()` → Cartesia `{cancel:true}` + abandon context + discard any Gemini-2.5 text buffered but not yet shipped.
- [ ] Every outbound audio frame from proxy carries a 4-byte big-endian turn counter prefix. Client strips prefix, drops stale frames.
- [ ] `bargingIn` flag dedupes triple-taps (§7.3).
- [ ] Flag: `NEXT_PUBLIC_VOICE_BARGE_IN=1` default on; `0` disables client detection entirely.

### Phase 7 — Error taxonomy (Day 11 PM) — REVISED

- [ ] `src/lib/voice/client/errors.ts` — `VoiceError` union per Voicer §8 plus OakLeague kinds:
  - `token`, `model`, `handshake`, `no-audio`, `mic-denied`, `network`, `rate-limit`, `cost-kill`, `quota-state-inconsistent`, `session-already-active`, `tier-changed`, `protocol`, `tls-handshake`, `unknown`.
- [ ] WS close-code → error kind map (completed per auditor small-nit):
  - 1000 normal → no-error
  - 1002 protocol_error → `protocol`
  - 1006 abnormal → `network`
  - 1007 invalid_payload → `protocol`
  - 1008 + reason 'quota_exceeded' → `cost-kill`
  - 1008 + reason 'kill_switch_fired' → `cost-kill`
  - 1008 (any other reason) → `rate-limit`
  - 1011 → `network`
  - 1015 tls_handshake → `tls-handshake`
  - 4001 invalid_ticket → `token`
  - 4002 session_already_active → `session-already-active`
  - 4003 kill_switch_fired → `cost-kill`
  - 4004 bad_request → `handshake`
  - 4005 upstream_error → `model`
  - 4006 quota_state_inconsistent → `quota-state-inconsistent`
  - 4007 tier_changed → `tier-changed` (NEW per D7)
  - 4008 rate_limited → `rate-limit` (NEW per Phase 1 proxy IP limit)
- [ ] `friendlyMessage()` with OakLeague brand tone (not generic Voicer strings). Vuk-reviewed strings before merge.
- [ ] Deliberate-break test suite (Phase 9): force each close code, assert toast copy. Add test cases for `tier-changed` (simulate admin flip mid-mint) and `rate-limit` (mint > 2 tickets in one minute).

### Phase 8 — Session lifecycle hardening (Day 12 AM) — REVISED

- [ ] **15-min cap + WS drops: use Gemini native session resumption (D5, auditor C1 fix).**
  - Proxy opens Live session with `sessionResumption: { transparent: true }` (field path verified in Phase 5).
  - On every `sessionResumptionUpdate` server event: persist `new_handle` to `sessions.gemini_resumption_handle` (single-row UPDATE, fire-and-forget; latest wins).
  - Client heuristic: at session elapsed 14:30, show inline "resetting context…" hint, close WS with `normal_closure`, mint resume ticket (`{hookId, resume: true, sessionId}`), proxy looks up prior row's handle and reopens with `sessionResumption: { handle }`.
  - Same `sessions` row reused — new row NOT created — so quota bucket stays attached and auditor-C1 quota-doubling-at-midnight cannot occur.
  - Resume ticket enforces `sessions.user_id == assertCallerFromSession().userId` at the RSC route. Refuses resume for any other user.
- [ ] **iOS backgrounding — cross-user device-swap guard (auditor M4).**
  - `document.visibilitychange` → `hidden`: don't try to rescue; accept WS will die. Record session pointer in `sessionStorage` tagged with `userId` from current `getCallerUserId()`.
  - On `visible` return: re-fetch `/api/me` (lightweight, cached) to get current `userId`. Compare to `sessionStorage.voiceSession.userId`. Mismatch → clear state, start fresh. Match → if prior session < 120 minutes ago (Gemini resumption token TTL) AND currently auth'd → offer "Tap to continue."
- [ ] **Quota-remaining UI.** Fetch `daily_quotas.seconds_used / daily_limit_s` on session open + on every `turn_end_ack`. Display chip that drains in real time. At 90%: warning. At 100%: session ends cleanly, modal CTA.
- [ ] **Heartbeat + reaper budget (auditor C5).** Tightened-but-safe:
  - Heartbeat aggregate: pong → in-memory touch.
  - Flush interval: **every 10s** (not 20s) so two flushes always land before the reaper threshold.
  - Reaper threshold: 60s (not 30s). Gives 6× flush-interval safety margin against proxy restart / transient Supabase latency.
  - Reaper additionally checks: `last_heartbeat_at < now() - 60s AND (status = 'active' OR status = 'starting')`. No false positives from already-ended rows.
  - Multi-proxy safety: wrap reaper in `SELECT pg_try_advisory_lock(hashtext('voice_reaper'))`; only lock-winner runs the UPDATE.
- [ ] **`daily_quotas.day_utc` generated col + index** (inherited Day-8 item). Migration adds `day_utc date GENERATED ALWAYS AS ((quota_date at time zone 'UTC')::date) STORED` + composite `(user_id, day_utc)` index. Kill-switch client lookup switches from rolling 24h window → equality match.
- [ ] **Mid-session tier flip handling.** If an admin flips the current user's tier DURING a session, the session's `tier_at_session` is locked (per trigger) and proxy keeps using the pipeline it opened with. The flip takes effect on the NEXT session open. No mid-session reroute (CLAUDE.md hard rule). PostHog event `voice.tier_flip_during_active_session` for visibility.

### Phase 9 — Device matrix verification (Day 12 PM)

Runbook, physical devices only (emulators lie about audio stack):
- [ ] Desktop Chrome — pre-warm, tap, 5-turn conversation, barge-in, deliberate errors.
- [ ] Pixel 7 Pro Chrome (WiFi + LTE) — 48kHz FIR path, iOS-backgrounding-equivalent tab switch, quota decrement visual.
- [ ] iPhone 11 Safari (WiFi + LTE hotspot) — iOS audio unlock happens, 16kHz path honored, TTS audible, barge-in works.
- [ ] Measurement table → `.claude_learnings.md`. Columns: TTFA p50/p90, barge-in reaction ms, error-surface latency.

---

## Hard Rules / Security (Per CLAUDE.md) — REVISED

- RLS already on `sessions`, `session_turns`, `daily_quotas`, `cogs_log`, `voice_tickets`. New tables: `voice_clone_uploads` (admin audit log) → RLS enabled, zero policies (service-role only).
- New auth guard `assertCallerFromSession()` in `src/lib/auth-guards.ts`. `assertAdminFromSession()` ONLY on admin endpoints (voice-clone upload).
- Ticket UA-hash binding already in place; keep for user path.
- **Rate limit ticket mint: 2/min/user** (REV 2, auditor M1). Max 3 concurrent unconsumed tickets (down from 5 to match halved rate). Plus proxy-path IP rate limit: 20 connections/min/IP, in-memory sliding window.
- Cartesia API key: Fly secret only, never in Next.js env. `GEMINI_API_KEY` similarly; add `GEMINI_25_API_KEY` (separate key ok if billing split desired, else reuse).
- Camera OFF default preserved — no `getUserMedia({video:true})` anywhere.
- Transcripts in `session_turns.transcript` under RLS; never log raw at INFO; never include in Sentry extras.
- `window.location.href` on any tier flip triggered during session (edge case — shouldn't happen, but admin could).
- Pre-deploy Red Team: confirm service-role client writes to cogs_log are reachable only from proxy, not browser.
- **Same-origin check (auditor M5):** `x-forwarded-host` honored only when `process.env.VERCEL === '1'` OR `NODE_ENV !== 'production'`. Prod-non-Vercel deploys refuse forwarded-host.
- **Resume-ticket ownership check (auditor C1):** resume request must have `sessions.user_id == assertCallerFromSession().userId`. No exceptions. Server-side only; client-provided resume intent is always re-verified.
- **Admin voice-clone upload (auditor M7):** hard caps on size / duration / MIME, SHA-256 audit trail, 3 clones/day/admin rate limit. Never trust Content-Type header.
- **Tier TOCTOU (auditor C2):** proxy verifies `sessions.tier_at_session == ticket.expected_tier` post-insert; mismatch → 4007 close + teardown.
- **Migration safety (auditor C3):** `pipeline_kind` migration invalidates unconsumed tickets in the same transaction.

---

## Observability (NEW — auditor gap "what's missing")

- **Sentry tags on every WS lifecycle event:** `{session_id, user_id_hash, pipeline_kind, tier_at_session, model_used, build}`. `user_id_hash` is SHA-256 truncated to 16 chars (PII-safe).
- **PostHog events:**
  - `voice.session.open` {pipeline_kind, tier, creator_id, hook_id}
  - `voice.session.ttfa_ms` {p50_bucket} — per-surface rollups
  - `voice.turn.start` / `voice.turn.end` {turn_number, input_seconds, output_seconds}
  - `voice.bargein.detected` / `voice.bargein.cancelled`
  - `voice.error` {kind, close_code, pipeline_kind}
  - `voice.resume.attempted` / `voice.resume.accepted` / `voice.resume.rejected` {reason}
  - `voice.tier_flip_during_active_session`
  - `voice.quota.warning_90pct` / `voice.quota.hit_100pct`
- **Correlation:** every `cogs_log` row carries `session_id`; admin COGS viewer links by session to Sentry via `session_id` search URL (Sentry custom tag filter).
- **Build tag:** proxy sends `BUILD = FLY_MACHINE_ID` on `ready` frame; client logs → PostHog. A user-reported bug resolves to a single proxy machine + session in minutes.

## Rollback Flags

- `VOICE_MODEL_PRIMARY` — 3.1 → 2.5 instant swap (existing).
- `VOICE_MODEL_SECONDARY` — fallback pin (existing).
- `NEXT_PUBLIC_VOICE_PREWARM` — `1|0`, default `1`.
- `NEXT_PUBLIC_VOICE_BARGE_IN` — `1|0`, default `1`.
- `NEXT_PUBLIC_VOICE_SESSION_RESUMPTION` — `1|0`, default `1` (flip off if Gemini's resumption turns out unreliable; falls back to "session ended cleanly" UX with no reconnect).
- `VOICE_COGS_PRICING` — `seconds|tokens`, default `seconds`. Unit migration: token path still writes `daily_quotas.seconds_used` via token→seconds conversion so kill-switch latch is unaffected.
- `VOICE_CARTESIA_ENABLED` — `1|0`, default `1` (Fly-side only). Flip `0` kills Pro pipeline in 1 deploy.
- `VOICE_PIPELINE_OVERRIDE_ADMIN_ONLY` — `1|0`, default `1` in v1 (gates Pro path to admin accounts).
- `VOICE_PROXY_IP_RATE_LIMIT` — connections-per-minute-per-IP, default `20`. Tunable without redeploy via Fly secret.

---

## Testing

- **Unit.** FIR coefficient sum = 1.0. Decimation output sample count. Ring buffer read/write/flush semantics. Tier-to-model mapping. Close-code-to-error-kind mapping (Phase 7 contract).
- **Integration (mocked WS).** Full turn lifecycle. Multi-turn reuse. Barge-in flush semantics. Error-kind surfacing per close code. Pipeline routing (free vs admin-premium → correct bridge).
- **Real-API gated** (existing `RUN_REAL_API_TESTS=1`). Repurpose Spike A canned PCM round-trip to hit `/voice/session` on prod. Adds one Cartesia TTS call at `RUN_REAL_API_TESTS=1` — one canned prompt, assert audio chunks returned.
- **Device matrix** (Phase 9). Runbook-driven; not automatable this sprint.

---

## Deliverable Checklist (Day 12 EOD)

- [ ] Authenticated non-admin user taps Ask → conversation opens with correct tier pipeline.
- [ ] 5+ turns without reconnect on a single WS.
- [ ] Barge-in interrupts AI mid-sentence; TTS flushes in <100ms.
- [ ] Quota chip drains in real time; hitting 100% cleanly closes session.
- [ ] Kill-switch latch prevents new session; error toast explains.
- [ ] COGS log viewer shows per-session cost with input/output breakdown.
- [ ] Admin can flip own account to premium → next session uses Pro pipeline with cloned voice.
- [ ] Mobile matrix verified + measurements in `.claude_learnings.md`.
- [ ] All three rollback flags tested (flip each, verify behavior).

---

## Inherited Day-8 Items from Spike A Audit (merged into phases above)

a. Heartbeat write amplification — Phase 8.
b. `daily_quotas.day_utc` generated col + index — Phase 8.
c. Ghost reaper threshold 90s → 30s — Phase 8.
d. Token-based COGS pricing — feature-flagged in Phase 5, flip after 3-day validation.
e. `mic-processor.js` redesign — Phase 2.

## Out of Scope (Day 13+)

- Avatar / lipsync (Simli) integration — Day 13–14.
- iOS SourceBuffer/MediaSource TTS path (Web Audio AEC regression accepted per Spike A audit) — post-YC.
- Priming Window primitive (canned-audio) — post-YC unless Vuk approves in the approval gate.
- Hot-swap between free and Pro pipelines mid-session — out of scope per CLAUDE.md.
- Stripe billing — v2.
- Context compression beyond Gemini native (custom summarization layer) — post-YC; Gemini Live has built-in context compression per web research.

## Open Questions for Approval Gate

1. **Free-tier voice.** Is Puck (default Gemini voice) good enough for v1 demo, or do we want to audition the 30-voice set and pick a voice per creator? Picking is a lookup on `creators.voice_id_gemini` column (would need a migration). Recommendation: default to Puck for v1; add creator override post-YC.
2. **Pro pipeline: is the audio-billing-waste on the STT leg acceptable?** 3.1 Live's broken TEXT modality means we pay for audio-out we discard on the STT session (~$0.018/min output-audio cost per turn). Alternative: use 2.5-flash-native-audio with input-transcription + text-out combo — verify in Phase 5. Cost delta is ~$0.15/min in the worst case.
3. **Cartesia per-character USD.** Web research couldn't pull authoritative pricing from Cartesia's public docs. Vuk to check dashboard and confirm `QUOTED_AT` rate before proxy goes live with Pro pipeline; otherwise COGS `cost_usd` will be an estimate.
4. **Mid-synthesis reconnect billing.** Cartesia has no documented behavior for billing on a dropped WS mid-synthesis. If we care about accurate per-session cost, file a ticket with Cartesia support before YC demo.
5. **Should we ship the voice-clone admin tool in this sprint or Day 13–14 polish window?** Building it in Phase 5 means slightly less focus on the free-path golden experience. Recommendation: admin upload route ships Phase 5 (backend), admin UI page ships Day 13–14 (UX polish).

---

## REV 3 DELTA — Second-Audit Resolutions (overrides REV 2 where conflicting)

Second audit pass surfaced 5 new Criticals, 4 Residuals, 7 Mediums, 10 pre-gate TODOs. Resolutions below are authoritative for implementation; they override anything in REV 2 body.

### Blocker resolutions

**B1 — Gemini native session resumption unavailable in our SDK.** Installed `@google/genai@1.50.1`; grep for `Resumption` in its typedefs returns zero hits. REV 2's D5 assumed native resumption; we can't use what the SDK doesn't expose. **New D5: safe transcript-replay via SECURITY DEFINER RPC.**

- On reconnect, client sends `{hookId, resume:true, sessionId}` in the ticket mint body. RSC route enforces `sessions.user_id == assertCallerFromSession().userId`.
- Ticket row binds `resume_from_session_id` (new nullable column) **server-side at mint time**. Client-supplied sessionId on the WS URL is refused if it doesn't match ticket — kills auditor N-C1 entirely.
- Proxy on WS open, if `ticket.resume_from_session_id IS NOT NULL`, calls new RPC `voice_build_resume_context(p_session_id, p_caller_user_id)` SECURITY DEFINER with `WHERE sessions.user_id = p_caller_user_id` — fails with 4001 if not matched. RPC returns last-N turns' transcripts (capped 8 turns or 3.5k chars, whichever first).
- Returned transcripts are formatted into `systemInstruction` prefix at Gemini open time. No client-side context passing. No cross-user leak.
- **Same sessions row reused.** Proxy `openSession` takes `resume_from_session_id` path → UPDATE existing row (`status='active'`, new `last_heartbeat_at`) instead of INSERT. Quota bucket stays attached; auditor C1 quota-doubling risk eliminated.
- Sidesteps SDK dependency. If `@google/genai` ships resumption in a later minor, Phase 5 can opportunistically layer it behind `VOICE_GEMINI_NATIVE_RESUMPTION=1` flag.

### New-Critical resolutions

**N-C1 — Ticket-bound sessionId.** `voice_tickets` gets `resume_from_session_id uuid NULL REFERENCES sessions(id)`. RSC mint route binds it server-side; proxy ignores any `sessionId` on the WS URL query.

**N-C2 — Pro pipeline history persistence.** Pro bridge rebuilds `contents[]` from `session_turns.transcript` on every bridge-open (initial + resume). In-proxy memory is a cache only, never source of truth. Proxy restart mid-conversation → next turn the bridge re-reads from DB, no amnesia. One migration adds `session_turns.speaker` enum (`user|assistant`) if not already present so the rebuild reconstructs roles correctly.

**N-C3 — IP rate limit is per-machine + NAT-hostile.** Two-layer fix:
- Move sliding-window counter to Postgres: new RPC `voice_rate_limit_check(p_ip_hash, p_window_s, p_max_count)` using a bounded `voice_ip_counters` table with TTL cleanup via pg_cron. Global across machines.
- Per-IP budget raised to **120/min** (accommodates corporate NAT + YC demo room). Primary defense is per-user ticket rate (2/min/user).

**N-C4 — Ghost-reconnect 60s hole.** Add `POST /api/voice/session/end` callable via `navigator.sendBeacon` on `visibilitychange → hidden`. Body `{sessionId}`. Cheap: UPDATE `sessions SET status='ended', ended_at=now() WHERE id=$1 AND user_id=auth.uid()`. End-to-end ~200ms. Cooperating clients never hit reaper threshold.

**N-C5 — ffprobe not on Vercel; file-type WEBM ambiguity.** Voice-clone upload route **runs on the Fly proxy**, not Vercel. Fly container already needs ffmpeg/ffprobe. New proxy endpoint `POST /admin/voice-clone` behind admin-ticket auth (mint on Next.js with `assertAdminFromSession()`, consume on proxy). Allow-list MIME: `audio/wav`, `audio/mpeg`, `audio/ogg`, `audio/x-m4a`. WEBM excluded.

### Residual resolutions

**R1 — 4007 legitimate-upgrade UX.** Client auto-re-mints ticket ONCE on 4007 before surfacing error. If re-minted `expected_tier` matches inserted `tier_at_session`, session proceeds; otherwise `tier-changed` toast.

**R2 — `cogs_insert_turn_pro` guard + idempotency.** Migration adds `REVOKE EXECUTE … FROM public`, `GRANT … TO service_role`. Idempotency via unique partial index `(session_id, turn_number, service)` on cogs_log; RPC uses `ON CONFLICT DO NOTHING`. Turn number explicit from proxy.

**R3 — Proxy-side COGS drop mid-turn.** In-proxy in-memory dead-letter queue (bounded 1000 rows), flushed every 10s with exponential backoff. On proxy restart, DLQ is lost — acceptable loss is <10s of turns × <0.2% of sessions; budget is rounding error for YC demo. Post-YC: persist DLQ.

**R4 — sessions.last_heartbeat_at column.** Grep confirms column is added in `20260421000001_voice_spike_cogs_fields.sql`. Auditor mis-flagged; no action.

### Medium resolutions

**M-N1 — sessionResumption SDK path.** Moot (B1).

**M-N2 — STT leg audio-billing waste decision.** **Decision before Phase 5:** use `gemini-2.5-flash-native-audio-preview-12-2025` with `inputAudioTranscription: {}` + `responseModalities:[AUDIO]`. Pro path still wastes ~$0.15/min on discarded audio-out. Accept for v1 (Pro is admin-demo-only). Post-YC: evaluate audio-file-upload-per-turn model.

**M-N3 — Cartesia context-open handshake.** Phase 5 gate: measure Cartesia WS-connect + first-context init latency. If >150ms, fall back to single-context-per-session with client-side flush-only barge-in (accept ~1 leftover chunk). Measure first, decide later. Phase 6 blocked until Phase 5 reports.

**M-N4 — Pro history >4k-token single turn.** If last turn alone > 4k tokens, drop to last-turn-only (no history). If single turn > 8k tokens, abort with `error code='turn_too_long'`. User audio caps at ~30s anyway.

**M-N5 — 1011 reason split.** `1011 + reason='heartbeat_timeout'` → `network`; `1011 + reason='upstream_closed'` → `model`; `1011` unknown-reason → `network`.

**M-N6 — daily_quotas pre-mint kill-switch read auth.** Use `supabaseAdmin()` (service role) in the RSC route.

**M-N7 — Expired-resume UX.** On resume-ticket mint: if prior session `ended_at < now() - interval '2 hours'`, RPC returns empty-context and responds `200 {expired: true}`. Client shows "Your previous session expired — start fresh with $creator?" CTA.

### Pre-gate TODOs status (all 10 closed)

1. ✓ B1 abandons native resumption.
2. ✓ M-N2 decides STT shape.
3. ✓ N-C5 moves voice-clone to Fly.
4. ✓ MIME allow-list: wav/mp3/ogg/m4a only.
5. ⏳ M-N3 deferred to Phase 5 measurement (explicit gate, not vague).
6. ✓ New migration bullet below.
7. ✓ last_heartbeat_at already exists.
8. ✓ N-C1 server-binds sessionId.
9. ✓ N-C2 rebuild from session_turns.
10. ✓ R1 auto-re-mint-once on 4007.

### Additional migrations added in REV 3

- `20260427000003_voice_clone_uploads.sql` — audit table, RLS + zero policies, service-role grants.
- `20260427000004_voice_tickets_resume_from.sql` — adds `resume_from_session_id`.
- `20260427000005_voice_build_resume_context_rpc.sql` — SECURITY DEFINER RPC, ownership-join on user_id.
- `20260427000006_voice_ip_counters_and_rpc.sql` — `voice_ip_counters` + `voice_rate_limit_check` + pg_cron cleanup.
- `20260427000007_cogs_turn_idempotency_index.sql` — unique partial index on cogs_log for turn-level idempotency.
- `20260427000008_session_turns_speaker.sql` — `speaker user|assistant` column if missing.
- `20260428000001_cogs_insert_turn_pro.sql` — Pro pipeline COGS RPC (grants + idempotency codified here).

### Final hardened architecture (one paragraph)

**Free path:** Browser → Fly proxy → Gemini 3.1 Live native audio. Puck voice. Server-side transcript-replay on reconnect via SECURITY DEFINER RPC ownership-joined on user_id. **Pro path (admin-only in v1):** Browser → Fly proxy → [Gemini 2.5 native-audio STT with audio-out discarded + Gemini 2.5-flash streaming text + Cartesia Sonic 3 WS cloned-voice TTS]. History rebuilt from `session_turns.transcript` on every bridge-open. **Reconnect:** same sessions row reused (quota bucket preserved); server-side ownership join; ticket-bound sessionId prevents cross-session rides. **COGS:** four idempotent RPCs (turn-free, turn-pro, ephemeral-token, clone-upload); proxy dead-letter queue for transient Supabase flakes; token-pricing flag. **Rate limits:** 2/min/user ticket; 120/min/IP Postgres-global; 3/day/admin clone upload. **Barge-in:** client VAD with floor/ceiling + adaptive recal + spectral guard; `flushGeneration` counter drops stale frames; 4-byte turn-prefix on every audio frame. **Observability:** Sentry + PostHog event taxonomy per REV 2.

### Phase 0 (pre-Day-8, pre-coding; ~1 hour)

- Measure Cartesia WS context-open latency against the Fly proxy (resolves M-N3).
- Confirm Cartesia per-character USD from Vuk's dashboard (resolves REV 2 Open Q #3).
- Verify `gemini-2.5-flash-native-audio-preview-12-2025` supports `inputAudioTranscription` + audio modality simultaneously.
- (Optional) Upgrade `@google/genai` to latest minor; check if `sessionResumption` types appear — nice-to-have, not blocking.

---

## REV 4 DELTA — Third-Audit Resolutions (overrides REV 2/REV 3 where conflicting)

Third audit flagged 5 Criticals (schema-fact errors in REV 3), 11 Mediums, 10 Smalls, 1 data-governance flag. Decisions below are authoritative and MUST be reflected in the migration drafts before Phase 1 coding begins.

### Critical resolutions (must land in plan text / migration drafts pre-coding)

**N2-C1 — cogs_log has NO `turn_number` column; REV 3 R2 idempotency index is unbuildable.** Verified: `20260420000020_cogs_log.sql` defines columns `{id, created_at, user_id, session_id, service, operation, units, unit_label, cost_usd, metadata}` — no turn_number. `cogs_log_block_update` trigger strict-allow-lists columns. Existing `cogs_insert_turn` RPC (migration 0040) takes no turn number. An `ON CONFLICT` on a phantom column is a silent no-op.
- **Decision:** add a real `turn_number int NULL` column.
- `20260427000007_cogs_turn_idempotency_index.sql` is **replaced** by `20260427000007_cogs_log_turn_number_and_idempotency.sql`:
  1. `ALTER TABLE cogs_log ADD COLUMN turn_number int NULL`.
  2. Update `cogs_log_block_update` trigger's allow-list to permit NULL-preserving update on `turn_number` (still blocks finalized-row mutation; see trigger for the pattern — only the freshly-inserted row touches it).
  3. Partial unique index: `CREATE UNIQUE INDEX cogs_log_turn_idempotency ON cogs_log(session_id, turn_number, service) WHERE turn_number IS NOT NULL`.
  4. `CREATE OR REPLACE FUNCTION cogs_insert_turn(..., p_turn_number int, ...)` — add parameter at the END of the signature (append-only to preserve call sites); update the free-path call in proxy to pass it.
  5. `cogs_insert_turn_pro` RPC takes `p_turn_number int NOT NULL`.
- Free-path calls that genuinely aren't per-turn (admin voice-clone upload, ephemeral-token mint) pass `NULL` — partial index excludes them, no false collisions.

**N2-C2 — `20260427000008_session_turns_speaker.sql` is a duplicate column migration; DROP it.** Verified: `20260420000018_session_turns.sql` line 12 already declares `role session_turn_role NOT NULL` with enum `('user','assistant')` from `20260420000001_extensions_and_enums.sql`. REV 3 N-C2 and the Pro bridge rebuild path read `role` directly. Remove `20260427000008_session_turns_speaker.sql` from the migration list. Update N-C2 wording: "Pro bridge rebuilds `contents[]` from `session_turns` ordered by `turn_number` / `created_at`, mapping `role='user'` → `{role:'user', parts:[{text: transcript}]}` and `role='assistant'` → `{role:'model', parts:[{text: transcript}]}`."

**N2-C3 — Resume-same-row has a concurrent-connection race.** The unique partial index `sessions_one_active_per_user WHERE ended_at IS NULL` (migration 0040 line 19) does NOT stop two proxies from UPDATE-ing the same row when the prior WS died ungracefully and the 60s reaper hasn't fired. Two live bridges on one row = double Gemini billing against one quota bucket.
- **Decision:** resume UPDATE is conditional. Proxy's `openSession` resume path runs:
  ```sql
  UPDATE sessions
     SET status = 'active', last_heartbeat_at = now()
   WHERE id = $1
     AND user_id = $2
     AND (ended_at IS NOT NULL OR status IN ('ended','errored'))
  RETURNING id, tier_at_session;
  ```
  Zero rows returned → proxy closes WS with new code **4009 `resume_conflict`**. Client-side handler: show "Previous session still live — end and retry?" CTA that hits `/api/voice/session/end` explicitly, then re-mints a fresh ticket (non-resume). This path is the sanctioned way out.
- RSC resume-mint route pre-checks the same predicate before minting: if prior row is still live and unended, respond `409 {error:'prior_session_live', code:'resume_conflict'}`. Client prompts user to end prior.
- `N-C4 /api/voice/session/end` cooperation becomes load-bearing for clean resume. See N2-C5.

**N2-C4 — Transcript-replay via `systemInstruction` has three problems.** (a) systemInstruction is re-billed as prompt tokens on every turn post-resume — 8 turns × ~500 tokens × 60 post-resume turns = ~240k extra input tokens, unmetered by a seconds-based kill-switch. (b) User transcripts flow into an upstream system-prompt slot whose DPA treatment differs from `contents[]` input. (c) The existing `CLAUDE.md` §Voice note says "Use `send_client_content` only seeds initial history" — that's the right primitive.
- **Decision A (REQUIRED):** resume context is seeded via `contents[]` on `send_client_content` **once at bridge open**, NOT in `systemInstruction`. `systemInstruction` stays the creator's mentor prompt only, never user transcripts.
- **Decision B (REQUIRED):** cap at **2 turns / 1.5k chars** (halved from REV 3 B1's 8 turns / 3.5k chars). Rationale: the resumed session rarely needs deep context; last two turns cover "where we left off" without dragging costs.
- **Decision C (REQUIRED):** on every resume with non-empty context, write a `cogs_log` leg with `service='voice_proxy'`, `operation='voice_resume_context_tokens'`, `units=<estimated_tokens>`, `metadata={turns_replayed, char_count}`. Estimated-tokens = `ceil(char_count / 4)`. Fires once per resume, attributes the startup tax.
- **Decision D:** add env flag `VOICE_RESUME_REPLAY_ENABLED=1` (default on) — flip off if privacy review blocks before YC demo; resume still works, just with no context hint, and client banner explains.

**N2-C5 — `/api/voice/session/end` via `navigator.sendBeacon`: auth + Content-Type + idempotency.** REV 3 N-C4 underspecified the beacon contract. Browsers drop auth differently on beacons; iOS flicker fires 3–5 beacons; CORS + Origin-dropping cross-vendor inconsistencies.
- **Client contract:** `navigator.sendBeacon('/api/voice/session/end', new Blob([JSON.stringify({sessionId})], {type:'application/json'}))`. NEVER pass headers (beacon strips), NEVER call from cross-origin tab.
- **Route contract (`src/app/api/voice/session/end/route.ts`):**
  - `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`.
  - No same-origin check (Origin unreliably absent on beacons; relying on it causes silent data-loss on Safari).
  - Auth check: read session cookie → `getCallerUserId()`. If missing/expired → return `204` (no-op). User logged out in same tab is a legitimate state.
  - Content-Type tolerance: route parses Blob body as JSON; accepts `application/json` only — other types return 204 no-op (not 400 — we don't want iOS background-flicker noise in error telemetry).
  - Idempotent: `UPDATE sessions SET status='ended', ended_at=COALESCE(ended_at, now()) WHERE id=$1 AND user_id=$2 AND status IN ('starting','active')`. Zero rows affected is fine (already ended or not yours). Always returns `204`.
  - Rate limit: soft, 10/min/IP in-proxy — above that, silent drop. Beacons shouldn't exceed 1-2/session; 10 is 5× headroom.
- **Note:** this auth is the sole owner check (no cookie → no auth → no-op). Corollary: malicious actor with another user's sessionId cannot end their session without a valid session cookie → safe.

### Medium resolutions

**N2-M1 — Cartesia mid-synthesis cancel under-bills.** REV 2's C4 path says "Cartesia fails mid-synthesis: … COGS records Gemini legs only." But characters streamed to Cartesia pre-drop are billable. **Fix:** `CartesiaBridge` tracks `charactersShipped` monotonically per context; on ANY end-state (success/cancel/error), emit a `cogs_log` row via `cogs_insert_turn_pro` with `p_cartesia_characters = charactersShipped` and `metadata.cartesia_status = 'complete'|'partial'|'cancelled'|'errored'`. Unbilled-char bug closed.

**N2-M2 — Postgres-global IP rate-limit is write-hot.** REV 3 N-C3's `voice_ip_counters` + per-IP UPSERT at 120/min/IP can thrash one row with thousands of updates at NAT scale.
- Wrap the RPC write in `pg_advisory_xact_lock(hashtext(p_ip_hash))` inside the SECURITY DEFINER RPC, scoped to the tx. No deadlocks (single lock per call), cheap (in-memory).
- `fly.toml` audit: confirm single-machine (`auto_stop_machines=false`, `min_machines_running=1`, no `[processes]` fanout) **before shipping**; proxy-local in-memory counter is sufficient at that scale. If we multi-machine later, Postgres path is already there.
- pg_cron cleanup: **every 1 minute** (matches the sliding-window). Purge rows with `window_start < now() - interval '2 minutes'`.

**N2-M3 — Admin voice-clone upload: two-hop auth spelled out.** REV 3 N-C5 moves upload to Fly. Missing: token store, TTL, CORS, size gate.
- **Reuse `voice_tickets` with new enum value `purpose voice_ticket_purpose NOT NULL DEFAULT 'voice_session'`** (enum `('voice_session','voice_clone')`; default preserves existing rows). Migration `20260427000001` adds the enum + column + partial index `(admin_user_id)` for clone count.
- Voice-clone mint: RSC route `POST /api/admin/voice-clone/ticket` → `assertAdminFromSession()` → inserts ticket with `purpose='voice_clone'`, `expires_at=now()+interval '60 seconds'` (tighter than session tickets; single upload), UA-hash bound.
- Fly endpoint `POST /admin/voice-clone`: atomic consume matching `purpose='voice_clone'` AND UA-hash. Rejects `purpose='voice_session'` tickets (no cross-use).
- Size gate: HTTP reverse-proxy layer on Fly caps `Content-Length` at 10 MB; if header missing, stream with 10 MB byte-counter and abort on overflow (don't buffer).
- CORS on Fly endpoint: allow-list `https://${VERCEL_DOMAIN}` only. Origin header required (browser-only; beacon doesn't apply here).
- Index: add `voice_clone_uploads_admin_day_idx ON voice_clone_uploads(admin_user_id, created_at DESC)` for the 3/day count.

**N2-M4 — Reaper lock lives inside the RPC.** REV 2 Phase 8 wraps the caller in `pg_try_advisory_lock`; REV 4 moves the lock **inside** `reap_stale_sessions` RPC body as `pg_try_advisory_xact_lock(hashtext('voice_reaper'))`. No-op early-return on contention. Single source of truth. Update the RPC signature default to `p_threshold_seconds int default 60` (was 90) so prod contract is locked; proxy call-site drops the explicit arg.

**N2-M5 — Heartbeat aggregate-flush code path.** REV 2 Phase 8 implies this but doesn't spell the refactor. Add task: *Replace per-pong `sessions.last_heartbeat_at` UPDATE with in-memory `Map<sessionId, lastPongAt>`; interval timer every 10s builds a single UPSERT statement with `unnest()` array-params to flush all dirty keys in one round-trip. Empty map → skip flush. On proxy shutdown, final flush synchronously awaited (race-safe against reaper).*

**N2-M6 — Pro pipeline per-session USD ceiling (hard kill).** Seconds-based latch can't catch a feedback loop spewing 20k Cartesia chars + 8k Gemini-2.5 tokens in 30s.
- New column `sessions.cost_usd_cap_cents int NOT NULL`, set at insert by `sessions_enforce_tier_and_kill_switch` trigger: `free=0` (no cap; seconds-latch holds), `premium=300` ($3), `boardroom=1000` ($10).
- Proxy maintains in-memory running `cost_cents` per session; when it crosses `cost_usd_cap_cents`, emit `kill_switch_fired` with `reason='usd_cap'`, close WS with 4003, mark session `ended_reason='usd_cap_hit'`.
- COGS RPC writes authoritative cents into the session row (`sessions.total_cost_cents` column added same migration) on every insert via trigger AFTER INSERT on cogs_log; proxy cross-checks against its in-memory number every 5 turns (drift alarm).

**N2-M7 — Admin-role revocation mid-flight.** Two-part fix:
- (a) **Pro ticket invalidation trigger:** `20260427000009_admin_roles_revocation_trigger.sql` — AFTER DELETE on `admin_roles` fires: `DELETE FROM voice_tickets WHERE user_id = OLD.user_id AND purpose='voice_session' AND consumed_at IS NULL AND expected_tier IN ('premium','boardroom')`. Unconsumed Pro tickets die instantly.
- (b) **Proxy post-insert admin check:** for `ticket.expected_tier IN ('premium','boardroom')`, proxy additionally runs `SELECT 1 FROM admin_roles WHERE user_id=$1` post-session-insert; if empty → close 4007 `tier_changed` (same code; client already handles via R1 auto-re-mint-once).

**N2-M8 — Replace 4-byte turn-prefix with control frame.** REV 2 Phase 6's 4-byte big-endian per-audio-frame prefix is an easy source of first-sample bugs. **Replace:** proxy sends a single JSON control frame `{type:'turn_boundary', turn:<n>}` IMMEDIATELY before the first audio frame of each turn. Client keeps `currentTurn` counter; on boundary, sets `currentTurn=n` and treats any binary arriving thereafter as turn-n. Drop-stale-frame semantic same as before, minus the strip-bytes bug surface. Update Phase 6 text and all diagrams.

**N2-M9 — AudioContext({sampleRate:16000}) honor runtime probe.** Browsers (notably iOS 17+) may ignore the hint. Add to Phase 2: after `audioCtx` creation, fire PostHog event `voice.audioctx.sample_rate` with `{hint: 16000, actual: ctx.sampleRate}`. Surface a Sentry warning if `actual !== 16000` exceeds 0.5% of iOS sessions. Mic worklet already defensively reads actual rate via constructor options — no correctness fallout, but visibility is essential.

**N2-M10 — Resume-ticket 2h TTL lives in the RSC mint route.** REV 3 B1 scatters the TTL check across mint and RPC. **Single location:** in `/api/voice/session/ticket` when `body.resume===true`, select `sessions.ended_at` and refuse mint (`200 {expired:true}`) if `> now() - interval '2 hours'`. Proxy side skips the check (trusts the ticket). Co-locates ownership + TTL + prior-row-state predicates in one place.

**N2-M11 — Cartesia single-shot reconnect budget.** REV 3 Pro pipeline has zero retry on Cartesia WS drop mid-turn. Flaky WiFi makes this feel broken. **Policy:** on Cartesia WS close with code ≠ 1000 during active synthesis, one automatic reopen attempt with **300ms backoff**, same `context_id`; if the reopen errors OR the second WS drops within 1s, surface `tts_mid_turn_failure`. Bound retry budget to exactly 1 per turn; state machine strictly forbids a second retry this turn.

### Small resolutions

**N2-S1 — Pre-warm on pointerDown only loads worklet modules; pointerUp mints the ticket and opens the WS.** Prevents ticket burns on scroll-past. Phase 4 text updated: *"pointerDown: `audioCtx = new AudioContext({sampleRate:16000})`, preload mic + tts worklet modules (parallel `addModule` calls), **DO NOT** call mint or WS-open. pointerUp: mint ticket, open proxy WS, `audioCtx.resume()`, `getUserMedia`, first `turn_start`."*

**N2-S2 — Bug #2238 link.** Track as [`googleapis/google-genai#2238` (Gemini 3.1 Live TEXT-only WS closes with 1011)](https://github.com/googleapis/js-genai/issues/2238). If upstream closes it fixed, revisit REV 2 D2 (drop the 2.5-flash streaming leg, consolidate on 3.1 Live). Phase 0 checks issue state.

**N2-S3 — Flag polarity flipped.** `VOICE_PIPELINE_OVERRIDE_ADMIN_ONLY` is retired. New positive-polarity flag `VOICE_PRO_PIPELINE_PUBLIC=0` (default off; flip to `1` for public Pro launch). Safer default — a missing env var leaves Pro admin-gated instead of opening the floodgates.

**N2-S4 — tier-changed retry affordance.** After R1's single auto-re-mint, if the re-mint also fails, surface toast with inline "Tap to continue" CTA (not a dead-end error). Button → fresh mint + connect. Bound to 1 manual retry before hard fail.

**N2-S5 — Admin tier-flip PostHog fires server-side.** On the admin tier-flip server action: post-UPDATE, `SELECT id FROM sessions WHERE user_id=$target AND status IN ('starting','active')` — if non-empty, fire PostHog `voice.tier_flip_during_active_session` with `{admin_user_id, target_user_id, from_tier, to_tier, active_session_ids}`. Proxy can't observe the flip (locked-tier design) so the emit point must be the mutation itself.

**N2-S6 — Load test in Phase 9.** Add runbook step: **50 concurrent 5-min sessions** against prod proxy (or a Fly staging clone). Success criteria: p50 TTFA unchanged vs. 1-session baseline; memory stable (no leak >50 MB over 5 min); reaper zero false-positives; proxy CPU < 80%. Script sketch: `k6` with browser-like WS framing against a `/voice/session/loadtest` endpoint (mints a load-test ticket behind `LOAD_TEST_TOKEN=…` secret; **never ships to prod runtime**).

**N2-S7 — Cross-user resume integration test.** Add to Phase 9 test suite: craft a ticket mint body with `{resume:true, sessionId:<victim_user_session_id>}` as attacker. Assert RSC route returns `403 {error:'not_owner'}`. Then craft a WS URL with arbitrary `sessionId` query param + legitimate ticket. Assert proxy ignores URL sessionId, uses `ticket.resume_from_session_id` only. Both paths close clean.

**N2-S8 — Upgrade @google/genai at Phase 0.** Already in Phase 0 checklist; promote from optional to **mandatory**. If latest minor exposes `SessionResumption` types, layer a flag-gated opportunistic path (`VOICE_GEMINI_NATIVE_RESUMPTION=1`) on top of B1 — native wins when available, transcript-replay is the fallback. Removes C4's token-tax if native is reachable.

**N2-S9 — Resume overhead COGS row.** Covered by N2-C4 Decision C.

**N2-S10 — FIR resample cost split measured.** Phase 4 measurement table splits TTFA-contribution-of-worklet-resample by surface: desktop Chrome (expected <2ms), iOS Safari iPhone 11 (expected 8–15ms based on Voicer notes). Surfaced column in `.claude_learnings.md` table.

### Data-governance flag (non-blocking, pre-demo checklist)

**N2-G1 — Three-vendor data path in Pro pipeline.** User audio → Google (STT), text → Google (2.5), synthesized audio chars → Cartesia. Not a plan change; a Vuk checklist item: before YC Pro demo, (a) confirm DPA in place with Google (audio + text retention), (b) confirm DPA in place with Cartesia (voice-clone material + TTS input), (c) document retention windows in `docs/DATA_GOVERNANCE.md` (new doc; one page, creator-facing). Free path is Google-only and already covered by existing DPA.

### Migration list — REV 4 final

Replacing REV 3's migration section in full. In order:

1. `20260427000001_voice_tickets_pipeline_hook_and_purpose.sql` — adds `pipeline_kind`, `expected_tier`, `hook_id`, `purpose` enum + column (merges REV 3 `20260427000001` + voice-clone purpose from N2-M3). Per D8 invalidation sequence.
2. `20260427000002_sessions_gemini_resumption.sql` — `sessions.gemini_resumption_handle text` (kept in case S8 Phase 0 upgrade unlocks native resumption).
3. `20260427000003_voice_clone_uploads.sql` — audit table + RLS zero-policies + `admin_user_id, created_at DESC` index (N2-M3).
4. `20260427000004_voice_tickets_resume_from.sql` — `resume_from_session_id uuid NULL REFERENCES sessions(id)`.
5. `20260427000005_voice_build_resume_context_rpc.sql` — SECURITY DEFINER, ownership-joined, cap `2 turns / 1.5k chars` (N2-C4 Decision B).
6. `20260427000006_voice_ip_counters_and_rpc.sql` — with `pg_advisory_xact_lock` inside RPC + pg_cron 1m cleanup (N2-M2).
7. `20260427000007_cogs_log_turn_number_and_idempotency.sql` — **REPLACES** REV 3's idempotency-only migration. Adds `turn_number`, extends `cogs_log_block_update` allow-list, partial unique index, updates `cogs_insert_turn` signature (N2-C1).
8. ~~`20260427000008_session_turns_speaker.sql`~~ — **REMOVED** (N2-C2, duplicate).
9. `20260427000009_admin_roles_revocation_trigger.sql` — AFTER DELETE on admin_roles kills unconsumed Pro tickets (N2-M7a).
10. `20260427000010_sessions_cost_cap.sql` — `cost_usd_cap_cents`, `total_cost_cents`, AFTER INSERT trigger on cogs_log maintains running total; `sessions_enforce_tier_and_kill_switch` extended to set cap per tier (N2-M6).
11. `20260427000011_reap_stale_sessions_threshold_60s_and_lock.sql` — RPC body adds `pg_try_advisory_xact_lock`, default threshold 60s (N2-M4).
12. `20260428000001_cogs_insert_turn_pro.sql` — unchanged from REV 3; takes explicit `p_turn_number` per N2-C1.

### Phase 0 update (mandatory, not optional)

- Upgrade `@google/genai` to latest minor (`npm view @google/genai versions --json | tail`). Grep `node_modules/@google/genai/dist/*.d.ts` for `SessionResumption|resumption`. If present, write a one-pager on native-vs-replay cost math and whether to collapse C4.
- Check [`googleapis/js-genai#2238`](https://github.com/googleapis/js-genai/issues/2238) state. If fixed/closed, test 3.1 Live TEXT modality locally; if stable, update REV 2 D2 Pro pipeline to a single-WS path.
- Confirm `fly.toml` is single-machine for the voice proxy (`auto_stop_machines=false`, `min_machines_running=1`, no `[processes]` fanout). Gates whether in-memory rate limit (simple) vs. Postgres-global (N-C3) is the active path.
- Existing Phase 0 items retained (Cartesia latency, per-character pricing, 2.5-flash-native-audio capability).

### Hard contract (what must be true before Phase 1 implementation starts)

- All 12 migrations above drafted as SQL files in `supabase/migrations/` (not applied yet — reviewed first).
- `scripts/sanity-check-cogs-turn-idempotency.ts` exists and asserts the partial index is queryable.
- `fly.toml` audit completed; rate-limit mode (in-memory vs Postgres) decided in writing.
- Phase 0 results posted to this doc as a trailing § "Phase 0 Measurements" before Day 8 morning.

### Approval gate — REV 4

```
[1] Approve REV 4 & auto-execute Phase 0 → 1 → 2 … (TDD per step, strike-through as I go)
[2] Approve REV 4 & confirm each phase
[3] Keep planning (which REV 4 item feels underspecified?)
[4] Changes: ___
```

---

## REV 5 DELTA — Fourth-Audit Resolutions (overrides REV 2/3/4 where conflicting)

Fourth audit flagged 1 inverted-predicate Critical, 8 Mediums, 7 Smalls, 2 non-bug confirmations. All decisions below are authoritative for migration drafts and code.

### Critical resolution

**N3-C1 — Resume-TTL predicate was WRITTEN BACKWARDS in REV 4 N2-M10.** REV 4 text read "refuse mint if `> now() - interval '2 hours'`" which rejects fresh resumes and accepts stale ones. **Correct predicate:** expired = `ended_at < now() - interval '2 hours'`. RSC ticket-mint resume branch:
```sql
-- Expired branch: respond {expired:true} (client shows "start fresh" CTA).
SELECT 1
  FROM sessions
 WHERE id = $sessionId
   AND user_id = $callerUid
   AND ended_at IS NOT NULL
   AND ended_at < now() - interval '2 hours';
-- If one row: expired. If zero: fall through to conflict / ok branches.
```
Order of resume-mint checks (locked contract):
1. Ownership: `sessions.user_id = caller`. Fail → 403.
2. Live-conflict: `ended_at IS NULL AND status IN ('starting','active')`. Fail → 409 with end-and-retry CTA (N2-C3 path).
3. Expired: `ended_at < now() - interval '2 hours'`. Match → `200 {expired:true}` (empty-context).
4. Otherwise: mint ticket with `resume_from_session_id = $sessionId`, RPC replay context.

Copy this predicate verbatim into `20260427000004_voice_tickets_resume_from.sql` RSC-route sibling.

### Medium resolutions

**N3-M1 — Cost-cap accounting decoupled from triggers; single source of truth is the proxy.**
REV 4 N2-M6's AFTER INSERT trigger on cogs_log is dropped. Revised model:
- `sessions.total_cost_usd numeric(10, 4) NOT NULL DEFAULT 0` (dollars, not cents-int — stops rounding-drift on `$0.00005` rows).
- `sessions.cost_usd_cap numeric(10, 4) NULL` (NULL = no cap; free-tier default). **Sentinel fix per N3-M6: NULL not 0.**
- Proxy maintains in-memory `costAccum` per session as it calls COGS RPCs. On **every** `turn_end` (not every 5), proxy writes `UPDATE sessions SET total_cost_usd = $accum WHERE id = $sid` in the same statement batch as the turn-end bookkeeping (no new round-trip — piggybacks the existing heartbeat flush if feasible; otherwise one statement). On crossing `cost_usd_cap`, proxy closes WS 4003 with `reason='usd_cap_hit'` **within the same turn that tripped it** — no 5-turn drift.
- No DB trigger. Avoids row-lock contention between cogs_log insert and session UPDATE; if the COGS insert rolls back (FK cascade or whatever), the proxy's costAccum simply isn't advanced — consistent either way.
- Cross-check: every 20 turns, proxy runs `SELECT SUM(cost_usd) FROM cogs_log WHERE session_id=$sid` and compares to its in-memory `costAccum`. Delta > $0.05 → Sentry warning with both numbers. Drift alarm only, not enforcement.

**N3-M2 — Cartesia per-character USD is a HARD Phase 0 blocker for Pro activation.** Elevated from REV 4's "accounting nicety." Without the rate, the proxy cannot compute the running `total_cost_usd` for Pro sessions, so the USD cap cannot fire. Fallback policy codified:
- If Phase 0 cannot confirm Cartesia rate from dashboard or support by Day 8 AM: **Pro pipeline ships with admin-only gate AND a hard 10-minute wall-clock cap** per session (per `sessions.created_at`). No USD cap. Flag `VOICE_PRO_FALLBACK_WALLCLOCK_S=600`.
- If rate confirmed: USD cap path is live per N3-M1; flag remains as emergency override.
- Track as row #1 in Phase 0 checklist. Exit code `blocker` if unresolved.

**N3-M3 — sendBeacon 10/min/IP in-memory rate limit is DROPPED.** REV 4 N2-C5's soft cap assumed a persistent in-memory map, which Next.js serverless routes do not provide. Browsers throttle beacons to ~1-2/unload anyway. Revised beacon route behavior: NO rate limit at the route level. Defense is caller-owned (auth cookie) plus idempotent UPDATE (no effect after first call). If abuse proves real post-launch, move to Postgres-global via the RPC already used by N-C3 (not now).

**N3-M4 — `AudioBridge` interface gains `seedContents`.** Explicit additions to `src/lib/voice/audio-bridge.ts`:
```typescript
export interface AudioBridge {
  open(opts: OpenOptions): Promise<void>;
  seedContents?(turns: ReplayTurn[]): Promise<void>;  // NEW, optional (STT-only bridges skip)
  turnStart(): void;
  sendAudio(frame: AudioFrame): void;
  turnEnd(opts?: TurnEndOptions): Promise<TurnMetrics>;
  cancel(): void;
  close(): Promise<void>;
}
export type ReplayTurn = { role: 'user' | 'model'; text: string };
```
Call order (locked contract) when proxy opens a resume session:
1. `await bridge.open({model, sessionId, systemInstruction})`
2. `await bridge.seedContents(replayTurns)` — AWAITED (not fire-and-forget). Resolves when `send_client_content` ack is observed OR 2s timeout elapses (seed is best-effort; timeout → log Sentry warning, continue).
3. `bridge.turnStart()` — first live user turn.

Implementation notes:
- **Gemini native (free path):** `GeminiBridge.seedContents(turns)` calls `session.sendClientContent({turns: turns.map(t => ({role: t.role, parts:[{text: t.text}]})), turnComplete: false})` once. `turnComplete: false` is deliberate — we're seeding history, NOT triggering a response.
- **Pro pipeline:** `GeminiLiveSTTBridge.seedContents` is a no-op (STT session is per-turn stateless). `Gemini25TextBridge` stores replay turns in its rolling `contents[]` history. `ProPipelineBridge.seedContents` forwards to Gemini25TextBridge only.

Phase 5 tasks updated to match.

**N3-M5 — Admin role-name filter for Pro pipeline.** Existing `admin_roles.role_name` enum is `('superadmin','reviewer')` per `20260420000001_extensions_and_enums.sql`. Pro pipeline = **`superadmin` only** in v1 (reviewer is for content moderation, not demo privileges). Every admin-check site pinned:
- RSC ticket-mint Pro gate: `EXISTS (SELECT 1 FROM admin_roles WHERE user_id=$uid AND role_name='superadmin')`.
- Proxy post-insert admin re-check (N2-M7b): same filter.
- Revocation trigger (N2-M7a, migration `0009`): fires on `AFTER DELETE ON admin_roles` **only when** `OLD.role_name = 'superadmin'`. Reviewer role changes don't touch voice tickets.
- Voice-clone upload: already admin-gated; clarify to `superadmin` only (reviewers don't clone voices).

**N3-M6 — Cap sentinel is NULL, not 0.** Codified in N3-M1. `cost_usd_cap` column type changes to `numeric(10,4) NULL`. Trigger `sessions_enforce_tier_and_kill_switch` sets: free → NULL, premium → 3.00, boardroom → 10.00. Proxy logic: `if (sessionRow.cost_usd_cap !== null && costAccum >= sessionRow.cost_usd_cap) fireCostKill()`. Removes "$0 is the cap" ambiguity.

**N3-M7 — Cartesia context_id reconnect semantic to verify in Phase 0.** N2-M11's "one reconnect, same context_id" is unverified. Docs emphasize context_id uniqueness per connection; a second WS may or may not resume synthesis. **Phase 0 test:**
- Open Cartesia WS, start TTS with `context_id='test-001'`, stream ~2s of output, force-close client WS.
- Reopen Cartesia WS, attempt to continue `context_id='test-001'`.
- Observe: (a) does server accept the context_id? (b) does it resume or start fresh? (c) is re-billed for already-shipped chars?

Outcomes drive policy:
- If continues: N2-M11 stands as written ("1-reconnect budget, same context").
- If rejects: rename to "1-reopen-with-fresh-context budget; user hears ~200–400ms gap." Proxy opens a new `context_id`, feeds remaining-text-buffer (what hadn't been sent yet), surfaces `tts_mid_turn_gap` (not `_failure`) to Sentry at info-level.
- If rejects AND re-bills: 1-reconnect is cost-amplifying; drop the retry entirely and go straight to `tts_mid_turn_failure`.

Document actual behavior in Phase 0 results § before any reconnect code is written.

**N3-M8 — Cross-resume cost accounting.** Resumed sessions reuse the same `sessions` row → `total_cost_usd` is lifetime-of-session, so a 14-min Pro run at $2.90 that drops and resumes gets only 10¢ of cap left. Documented behavior locked:
- **No reset on resume.** Cap is session-lifetime, not per-connection. Protects against reconnect-looping to escape the cap.
- Client UX: the quota chip (Phase 8) shows remaining-cap as `($cap - $total_cost_usd)` numerically; on resume the chip reflects prior burn. Short-session resume is fine; long-session resume sees "<10¢ left, wrap up" naturally.
- Accounting column `sessions.resume_prior_cost_usd numeric(10,4) NULL` added for analytics (snapshot at resume time; NULL on first connection). Not used for enforcement.
- Wording added to N2-C4 / B1 body: "Resume preserves quota bucket AND cost accumulator. This is intentional."

### Small resolutions

**N3-S1 — Migration numbering renumbered, no hole.** REV 4 left slot `0008` strikethrough. **Renumber down:** `0009 → 0008` (admin-roles revocation trigger), `0010 → 0009` (sessions cost cap), `0011 → 0010` (reap_stale_sessions 60s+lock), `0428000001` unchanged. Final migration list in REV 5:
1. `20260427000001_voice_tickets_pipeline_hook_and_purpose.sql`
2. `20260427000002_sessions_gemini_resumption.sql`
3. `20260427000003_voice_clone_uploads.sql`
4. `20260427000004_voice_tickets_resume_from.sql`
5. `20260427000005_voice_build_resume_context_rpc.sql`
6. `20260427000006_voice_ip_counters_and_rpc.sql`
7. `20260427000007_cogs_log_turn_number_and_idempotency.sql`
8. `20260427000008_admin_roles_revocation_trigger.sql` (was `0009`)
9. `20260427000009_sessions_cost_cap.sql` (was `0010`; cap column NULL-able numeric, `total_cost_usd`, `resume_prior_cost_usd`; **NO cogs_log AFTER INSERT trigger** — dropped per N3-M1)
10. `20260427000010_reap_stale_sessions_threshold_60s_and_lock.sql` (was `0011`)
11. `20260428000001_cogs_insert_turn_pro.sql`

**N3-S2 — `cogs_log_block_update` trigger clause pinned exactly.** Migration `0007` extends the trigger body with:
```sql
-- Allow ONLY rows where every protected column is unchanged.
-- turn_number is append-only post-insert (never mutated, even by FK cascade).
IF NEW.turn_number IS DISTINCT FROM OLD.turn_number THEN
  RAISE EXCEPTION 'cogs_log.turn_number is immutable after insert';
END IF;
-- (existing allow-list checks for other columns retained)
```
Use `IS DISTINCT FROM` — not `=` or `<>` — so NULL-to-NULL counts as unchanged. Copy this block verbatim into the migration.

**N3-S3 — Beacon route `getCallerUserId` try/catch wrap.** N2-C5 spec tightened with exact skeleton:
```typescript
export async function POST(req: NextRequest): Promise<Response> {
  let userId: string;
  try {
    userId = await getCallerUserId();
  } catch {
    return new Response(null, { status: 204 });
  }
  // ... parse Blob → sessionId (also tolerant), UPDATE, return 204
}
```
Any auth error → 204 no-op. Any body-parse error → 204 no-op. Only successful + idempotent UPDATE paths return 204. **Only non-204 is 405** for non-POST (browsers sometimes retry as GET during keep-alive transitions — safer to 405 than silently accept).

**N3-S4 — Force-end CTA preserves context on retry.** N2-C3 path: user sees "Previous session still live — end and retry?" After tap: (a) client calls `/api/voice/session/end` with prior sessionId, awaits 204, (b) client re-mints ticket with **`resume: true`** (not fresh) against the now-ended sessionId, (c) proxy builds replay context from `session_turns`, conversation continues. Fresh-start is a separate CTA labeled "Start over" — explicit user choice to lose context.

**N3-S5 — Sanity-check script assertions pinned.** `scripts/sanity-check-cogs-turn-idempotency.ts` MUST assert:
```
(a) EXPLAIN (FORMAT JSON) SELECT 1 FROM cogs_log
    WHERE session_id = $fixture_sid AND turn_number = 1 AND service = 'voice_proxy'
    → plan node must contain "Index Scan" AND "Index Name" = "cogs_log_turn_idempotency"
(b) Two INSERTs with identical (session_id=$sid, turn_number=1, service='voice_proxy')
    → second raises Postgres error code '23505' (unique_violation)
(c) Two INSERTs with (session_id=$sid, turn_number=NULL, service='voice_clone_upload')
    → both succeed (partial index WHERE turn_number IS NOT NULL excludes NULLs)
```
Each assertion is its own `test()` block; failing any = exit 1. Script invoked in Phase 1 post-migration apply.

**N3-S6 — Pro-pipeline USD cap gated by Phase 0.** Added to hard-contract block (below): "Cartesia-rate confirmation from Phase 0 is a **gating** result for Pro pipeline activation. If unresolved by Day 8 AM standup, ship Pro with admin-gate + 10-min wall-clock cap fallback (N3-M2); revisit USD-cap path post-YC."

**N3-S7 — Resume-context token estimate is observability-only.** `ceil(char_count / 4)` is English-biased (CJK/punctuation-heavy can be 1.5–2× actual tokens). N2-C4 Decision C wording updated: "Estimate is for `cogs_log` attribution and COGS viewer UX **only**; never used to enforce the USD cap or kill-switch. Real token usage lands through the usual per-turn cogs path during the resumed session."

### Non-bug confirmations (pin in plan to deter future "helpful" reviewers)

**N3-N1 — `status='ending'` deliberately excluded from resume predicate.** REV 4 N2-C3's UPDATE condition `ended_at IS NOT NULL OR status IN ('ended','errored')` does NOT include `'ending'` — this is intentional. `ending` is a transient cleanup state (teardown in flight); resuming into it races the cleanup. Added to plan as a warning: **do not add `'ending'` to the resume allow-list. If your PR does, someone misunderstood this note.**

**N3-N2 — pg_cron is already provisioned.** Migration `20260425000003_ratelimit_cleanup_pgcron.sql` establishes pg_cron; N2-M2's 1-minute cleanup on `voice_ip_counters` is reachable. No new extension install needed.

### Hard contract (REV 5, supersedes REV 4)

Before Phase 1 coding begins:

1. All 11 migrations above drafted as SQL files in `supabase/migrations/` (not applied yet — reviewed first). Migration numbering has no holes.
2. `scripts/sanity-check-cogs-turn-idempotency.ts` exists with the 3 assertions pinned in N3-S5.
3. `fly.toml` audit completed; rate-limit mode (in-memory vs Postgres) decided in writing.
4. **Phase 0 Cartesia rate confirmation is a gate for Pro pipeline activation.** Unconfirmed → Pro ships with admin-gate + 10-min wall-clock cap fallback only; USD-cap path deferred.
5. **Phase 0 Cartesia context-id reconnect semantic test** result documented (N3-M7); drives N2-M11 retry code.
6. `src/lib/voice/audio-bridge.ts` interface edited to add `seedContents` before any bridge implementation change (N3-M4).
7. Phase 0 results posted to this doc as a trailing § "Phase 0 Measurements" before Day 8 morning.

### Approval gate — REV 5

```
[1] Approve REV 5 & auto-execute Phase 0 → 1 → 2 … (TDD per step, strike-through as I go)
[2] Approve REV 5 & confirm each phase
[3] Keep planning (which REV 5 item feels underspecified?)
[4] Changes: ___
```

---

## Phase 0 Measurements

Hard contract item 7 — full results live in [`PHASE_0_MEASUREMENTS.md`](PHASE_0_MEASUREMENTS.md).

**Confirmed (static audits):**
- `@google/genai@1.50.1` exposes `SessionResumptionConfig`, `LiveServerSessionResumptionUpdate`, and `inputAudioTranscription` — native-resumption path reachable behind `VOICE_GEMINI_NATIVE_RESUMPTION=1` (migration 0002's `gemini_resumption_handle` is the slot). Overturns REV 3 B1.
- `server/voice-proxy/fly.toml` currently `auto_stop_machines='stop'`, `min_machines_running=0`. **Rate-limit decision: Postgres-global (migration 0006)** regardless of machine count. Separate non-blocking recommendation: raise `min_machines_running=1` to avoid cold-start 4002 on first session of the day.
- All 11 migrations drafted in `supabase/migrations/`; sequence contiguous; not applied.
- `AudioBridge.seedContents(turns: ReplayTurn[])` added between `open` and `turnStart` per N3-M4.
- `scripts/sanity-check-cogs-turn-idempotency.ts` drafted with the 3 N3-S5 assertions.

**Deferred to Vuk's `scripts/voice-phase0-verify.mjs` run** (needs `GEMINI_API_KEY`, `CARTESIA_API_KEY`, `CARTESIA_TEST_VOICE_ID`):
- Cartesia WS reachability + one-phrase TTS round-trip.
- Cartesia context-id reconnect semantic test (3-part: fresh id, reuse after graceful close, reuse after abrupt socket loss) — drives N2-M11 retry behavior.
- Cartesia per-character USD rate confirmation from dashboard — **gating result for Pro pipeline USD-cap activation.** Unconfirmed → Pro ships with admin-gate + 10-minute wall-clock cap fallback (N3-M2); USD-cap path deferred post-YC.
- Gemini 2.5-flash native-audio `inputAudioTranscription` surfacing — must match 3.1's behavior, otherwise the 2.5 fallback is transcript-blind.

**Phase 1 unblocked** on the static items. Free-path coding (3.1 Flash Live + ticket mint + `voice_build_resume_context`) is independent of the deferred Cartesia gates; Pro-path USD-cap waits on item 4.

---

## REV 5.1 — Pipeline α' delta (2026-04-22, post Phase 0 live run)

**Why REV 5.1:** Phase 0 live run (`scripts/voice-phase0-verify.mjs`) proved
literal Pipeline α (Gemini 3.1 Flash Live with `responseModalities=[TEXT]`) is
not supported on the 3.1 preview model. Server slams the WS with "Internal
error encountered." on open. A fallback architecture was verified in the same
run and is adopted as the new default.

### What α' actually is

- Same config as production's `server/voice-proxy/gemini-bridge.js` today
  (`responseModalities=[AUDIO]` + manual VAD + system instruction) with ONE
  addition: `outputAudioTranscription: {}` in `LiveConnectConfig`.
- Google streams `serverContent.outputTranscription.text` chunks alongside
  audio output. Proxy forwards those text chunks into Cartesia TTS.
- Gemini's audio output bytes are **discarded** at the proxy boundary.
- User hears Cartesia cloned voice only. Same voice UX goal as α, different
  plumbing.
- Phase 0 live-run evidence (2026-04-22, fixture
  `scripts/fixtures/voice-test-vuk-hello.wav`):
  ```
  setupComplete=true turnComplete=true transcript_events=3
  text="Yes, I can hear you clearly."
  sessionResumptionUpdate.newHandle=<opaque> resumable=true
  ```

### What collapses / what changes

**Schema / migrations:**
- `supabase/migrations/20260428000001_cogs_insert_turn_pro.sql` is **deleted**.
  Superseded by `20260428000001_cogs_insert_turn_voice.sql` — a single 4-leg
  RPC that covers every tier.
- The 2-leg Spike-A `cogs_insert_turn` function from migration 0040 (last
  re-created in migration 0051 with `p_turn_number`) is dropped inside the
  new 0055 migration body. Any rows already written stay; the callable path
  is removed.
- New migration `20260428000002_voice_usage_counters.sql` (migration 12 of
  12) adds the forever-scalable minutes-cap infrastructure:
  - `profiles.voice_daily_cap_seconds int NOT NULL DEFAULT 300` (5 min)
  - `profiles.voice_weekly_cap_seconds int DEFAULT 900` (15 min, NULL = no
    weekly cap)
  - `profiles.voice_monthly_cap_seconds int` (NULL = unlimited)
  - `voice_usage_daily (user_id, day)` — O(1) upsert counter
  - `voice_usage_weekly (user_id, iso_week_mon)` — O(1) upsert counter
  - `voice_usage_record(user_id, seconds)` RPC — called at turn-end flush
  - `voice_usage_ticket_check(user_id)` RPC — called at session-open
    ticket-mint; returns `min(daily_remaining, weekly_remaining,
    monthly_remaining)` so proxy clamps session max-duration.

**Migration count goes from 11 → 12 of 12.** One renamed (0055 voice not
pro), one added (0056 usage counters).

**Bridge interface:**
- `src/lib/voice/audio-bridge.ts` gains:
  - `OpenBridgeOptions.enableOutputTranscription?: boolean`
  - `OpenBridgeOptions.enableInputTranscription?: boolean`
  - `BridgeEvent` variant `{ kind: 'output_transcription_chunk'; at: number; text: string }`
  - `BridgeEvent` variant `{ kind: 'input_transcription_chunk'; at: number; text: string }`
  - `TurnEndMetrics.outputTranscript?: string` (concatenated α' transcript)
- Phase 1 proxy work: `GeminiBridge` forwards both transcription events,
  `VoiceProxy` ignores `audio_out` chunks when `enableOutputTranscription`
  was requested, and Cartesia WS consumes `output_transcription_chunk.text`
  directly.

**Tier semantics (reinforced in REV 5, unchanged in REV 5.1):**
- `profiles.tier` enum unchanged. `tier_at_session` snapshot unchanged.
- Tier no longer maps to a pipeline. Tier maps to three cap knobs on
  `profiles` only. Admin console sets caps at tier-flip time.
- Free: daily=300s, weekly=900s, monthly=NULL. ~65 min/month effective.
- Pro (direction, not committed): daily=300, weekly=NULL, monthly=9900s (165
  min). ~45% margin at $9/mo given $0.03/min COGS.
- Premium/Boardroom: TBD post-YC. `monthly=NULL` = unlimited.

**Retired:**
- The "Pro pipeline USD-cap activation" gate tied to Cartesia rate
  confirmation is **not retired** — still the source of truth for kill-switch
  math. It just no longer gates pipeline selection, because there's only one
  pipeline.
- REV 5 hard-contract item 4 ("Cartesia rate confirmation") remains a gate
  on the admin dashboard's cost-per-session display being real vs
  placeholder. Proxy can run without it using a `QUOTED_AT` constant.

### Phase 1 go-conditions (updated by REV 5.2)

Ready when:
- ✅ α' runtime-verified (2026-04-22 — PASS)
- ✅ Migrations 0045–0054 drafted (unchanged from REV 5)
- ✅ Migration 0055 `cogs_insert_turn_voice` (4-leg) — REV 5.2 fixed leg-1 op
  name back to `voice_audio_input_seconds` + documented natural-key span
  correlation
- ✅ Migration 0056 `voice_usage_counters` — REV 5.2 fixed the IMMUTABLE-
  predicate blocker, added `voice_usage_turns` idempotency ledger, switched
  RPC to exactly-once semantics with `p_turn_started_at`
- ✅ `AudioBridge` extended with transcription events
- ✅ CLAUDE.md + memory + PHASE_0_MEASUREMENTS.md updated to α'
- ⏳ Vuk runs migrations batch against Supabase (first-time application —
  entire 12-migration sequence). **Spike-A proxy will lose its 2-leg RPC
  when 0055 applies — ensure the Spike-A harness is offline before running
  the batch.** See REV 5.2 delta §M3 below.
- ⏳ Sanity-check helper SQL installed once in Supabase SQL Editor
  (`scripts/install-sanity-helper.sql`)
- ⏳ Sanity-check script green (`scripts/sanity-check-cogs-turn-idempotency.ts`)

Phase 1 proxy code lands behind these gates.

---

## REV 5.2 delta (2026-04-22, post-audit on REV 5.1)

REV 5.1 shipped the α' pivot. An adversarial audit on the REV 5.1
migrations caught two true blockers and five tighten-ups. This section
records the fixes. **Read this after REV 5.1 when implementing Phase 1.**

### C1 — migration 0056 would not have applied (FIXED)

The REV 5.1 partial index on `voice_usage_daily`
(`WHERE day > (current_date - interval '30 days')`) would have failed at
CREATE INDEX time: `current_date` is `STABLE`, not `IMMUTABLE`, and PG
requires `IMMUTABLE` for index predicates. Even if it had applied, the
30-day window would have frozen to a wall-clock boundary at migration time
and silently drifted out of relevance.

**Fix:** plain btree on `(day)` — supports admin range scans and monthly
rollups without an invalid predicate.

### C2 — counter double-count on proxy retry (FIXED)

REV 5.1 `voice_usage_record` used an additive ON CONFLICT UPDATE with no
idempotency key. A transient error → proxy retry would apply the same
seconds twice, silently halving the user's effective daily cap.

**Fix:** new `voice_usage_turns (user_id, session_id, turn_number)` PK
table. RPC now does `INSERT ... ON CONFLICT DO NOTHING` on that table
first; only if the row was claimed (ROW_COUNT=1) does it increment the
daily + weekly counters. Exactly-once per turn, retry-safe.

**Signature change:** `voice_usage_record(uuid, uuid, int, numeric, timestamptz)`
— proxy must pass `session_id`, `turn_number`, `p_turn_started_at` alongside
`seconds`. Returns `boolean` (true = counters incremented, false = idempotent
no-op from retry). Phase 1 proxy code calls:

```sql
SELECT public.voice_usage_record(
  p_user_id         := :user_id,
  p_session_id      := :session_id,
  p_turn_number     := :turn_number,
  p_seconds         := :cartesia_audio_seconds,
  p_turn_started_at := :turn_started_at
);
```

### M1 — span correlation (DOCUMENTED, no code change)

`cogs_insert_turn_voice` stays `RETURNS void`. Phase 1 proxy correlates
Sentry spans + admin-dashboard rows via the natural key
`(session_id, turn_number)`, which every voice row (cogs_log leg 1–4 +
voice_usage_turns) already carries. Returning row IDs would duplicate
what the natural key already gives us.

### M2 — leg-1 operation string preserved (FIXED)

Leg 1 operation renamed from `voice_audio_in_seconds` →
`voice_audio_input_seconds` to match the legacy 2-leg Spike-A RPC. Admin
COGS dashboard `GROUP BY operation` queries now see one continuous series
across pre-α' and α' rows. Leg 2 keeps `voice_audio_out_tokens` because the
unit genuinely changed (seconds → tokens, different billable).

### M3 — migration-order note vs Spike-A proxy

Migration 0055 drops the legacy 2-leg `public.cogs_insert_turn(...)`. The
Spike-A harness at `server/voice-proxy/index.js` still calls it. **Order
of operations for Vuk:**

1. Stop / scale-to-zero the Spike-A Fly machine (`flyctl scale count 0`).
2. Apply the 12-migration batch (includes 0055 drop of the 2-leg RPC).
3. Phase 1 proxy swap ships `cogs_insert_turn_voice` caller.
4. Re-scale the Fly machine on the new proxy.

If the Spike-A harness needs to run post-migration for any reason before
Phase 1 code lands, it will fail with `function cogs_insert_turn does not
exist` and refuse to flush turns — by design. No silent mis-shaped rows.

### M4 — turn-start-anchored day buckets (FIXED)

REV 5.1 anchored `v_day` to `now()` at flush time. A 23:58 → 00:05 turn
would book entirely to the next day. REV 5.2 signature takes
`p_turn_started_at timestamptz` (nullable, defaults to `now()` for
back-compat / tests). Turn books to the day it started, matching user
intuition and admin "usage per day" reports.

### M5 — verify script control stability (FIXED)

`scripts/voice-phase0-verify.mjs` now sleeps 10s between check #7
(Pipeline α' proof) and check #8 (bare AUDIO control) so the preview's
concurrent-session cap releases before the second open. Check #8 is
informational only — not in the mandatory-pass filter — so flakes don't
gate Phase 1 even if the sleep turns out insufficient.

### Small polish

- **S1** — audio-bridge.ts comment no longer references "Pro pipeline."
- **S2** — `voice_usage_ticket_check` uses `FLOOR(used)::int` so
  fractional-second totals never round up into denying the last ≤0.5s of
  quota.
- **S3** — PHASE_0_MEASUREMENTS.md clarifies check #4 PASSes on
  *config acceptance* + populated field, not on transcribing silence into
  words.
- **S5** — day→week math uses idiomatic `date_trunc('week', v_day)::date`.
- **S6** — `voice_weekly_cap_seconds` column comment spells out
  `NULL = disabled (not zero)`.

### Migration count unchanged: 12

The 12-migration batch (0045 … 0056) still applies as one sequence. REV
5.2 rewrote 0056 in place and patched 0055; no new file added.

