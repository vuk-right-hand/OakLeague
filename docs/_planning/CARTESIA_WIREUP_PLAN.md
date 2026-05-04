# Cartesia Sonic 3 Wire-Up Plan — Pipeline α' Leg

**Window:** Day-of-α'-cutover (this sprint).
**Audit history:** Round 1 (5C/6M/5S), Round 2 (4C/5M/Smalls), Round 3 (5C/7M/9S — Vuk's audit). All resolutions inline. Round 3 fixes are tagged **R3-Cn / R3-Mn / R3-Sn** below.
**Predecessors:** Spike-A cleared (proxy + GeminiBridge live). Phase 0 verified
Cartesia open=193ms / TTFB=343ms / context-id reconnect accepted (2026-04-22).
Migrations 0047 (`voice_clone_uploads`) and 0055 (`cogs_insert_turn_voice`
4-leg α' RPC) already shipped; Cartesia legs are reserved at 0 + flagged
`metadata.cartesia_pending=true` until this PR flips the proxy to write real
characters/seconds/cost.
**Deliverable:** Server-side `CartesiaTTSBridge` in the Fly proxy that takes
streaming Gemini transcript text per turn, calls Sonic 3 over WS with the
creator's IVC `cartesia_voice_id`, streams PCM s16le 24kHz back to the user
WS — replacing the current Gemini-audio-bytes path. Plus the admin upload
route + UI cell that creates the IVC clone for `creators.voice_id`. Plus
Cartesia legs 3+4 of `cogs_insert_turn_voice` flipping from 0/`pending` to
real values. Plus `VOICE_CARTESIA_ENABLED=0` rollback flag.

This plan is for the **Cartesia leg only**. Simli rewire and the
mic→proxy→bridge→Simli session pipe land in #2 and #3. Cartesia frames go
out over the existing user WS for now (binary, like Gemini did) — Simli
attaches in #2.

---

## Verified facts (web + repo)

- **Cartesia WS:** `wss://api.cartesia.ai/tts/websocket`. Auth = `X-API-Key`
  header (server-side; never expose key to browser). Query param
  `cartesia_version=2026-03-01` (latest as of this plan).
- **Request shape:** JSON `{ model_id: 'sonic-3', transcript, voice:{mode:'id', id}, output_format:{container:'raw', encoding:'pcm_s16le', sample_rate:24000}, context_id, continue }`.
- **Response shape:** JSON `{type:'chunk', data:'<base64-pcm>', context_id, done:false}` per chunk; `{type:'done', done:true}` ends a context. Errors:
  `{type:'error', error_code, title, message, status_code, context_id}`.
  (Wire format is locked by the Phase-0 re-run gate below — strict JSON
  on `2026-03-01`. No binary fallback in this plan.)
- **Streaming pattern:** same `context_id` with `continue:true` for each
  Gemini transcript chunk; final chunk `continue:false` (which Cartesia treats
  as end-of-input for that turn). One context = one assistant turn.
- **Cancel/barge-in:** `{context_id, cancel:true}` halts not-yet-started work
  only. **Per Cartesia docs, cancel cannot retract already-emitted audio.** A
  *new* context per turn is mandatory for clean barge-in; mid-turn flush
  needs `{context_id, flush:true}` followed by a fresh context_id.
- **Voice clone (IVC):** `POST https://api.cartesia.ai/voices/clone` (multipart),
  headers `Authorization: Bearer <key>` + `Cartesia-Version: 2026-03-01`,
  fields `clip` (binary), `name`, `language` (required), `description?`,
  `base_voice_id?`. Response: `{id, user_id, name, language, is_public, created_at}`.
  Per Cartesia: ~5s clean clip is the sweet spot.
- **Pricing:** Cartesia public pricing is not authoritative-discoverable
  via docs. Vuk reads the per-character rate from the Cartesia dashboard
  and pastes it into the Fly secret `CARTESIA_USD_PER_CHAR` **before
  merge** + sets `CARTESIA_QUOTED_AT='YYYY-MM-DD'` Fly secret. **No code
  default** — `proxy-handlers.js` does `Number(process.env.CARTESIA_USD_PER_CHAR)`
  and throws on `Number.isNaN` at module load (fail-closed, no placeholder
  fallback). Audit C2 fix.
- **Cartesia version pin:** `2026-03-01` (latest as of plan). Phase 0 used
  `2024-11-13`. **Phase 0 re-run is a hard gate before Phase 2 starts**:
  - (1) Confirm open/TTFB ≤ Phase-0 baselines.
  - (2) Confirm message envelope is JSON-base64 per docs.
  - (3) Confirm `continue:false` actually flushes within ≤1s
    (no separate `flush:true` needed) — audit R2-M3.
  If (1) fails: investigate before pinning. If (2) fails (binary frames
  observed): **STOP. This plan is invalidated for `2026-03-01`.** Either
  pin `2024-11-13` and rewrite Phase 2 against the binary-decode wire (new
  spec, separate PR) OR remain on `2026-03-01` and add a binary-decoder
  branch — author chooses, but the strict-JSON Phase 2 cannot ship.
  If (3) fails: switch §A3 to send `flush:true` then close-of-context
  before resolving `turnEnd`. Audit R2-C4 fix.

## Repo state confirmed

- `server/voice-proxy/gemini-bridge.js` does NOT yet enable
  `outputAudioTranscription` — it's still Spike-A AUDIO-only. The α'
  bridge interface (`src/lib/voice/audio-bridge.ts`) declares the
  `enableOutputTranscription` flag and `output_transcription_chunk` event
  type, but the Node bridge hasn't implemented them. **This plan owns
  that upgrade** (Phase 1 below) — Cartesia is fed from those events.
- `creators` table has `voice_id text` ([0011_creators.sql:24]). We re-purpose
  that column: it stores the Cartesia voice UUID (the IVC clone id).
  No migration needed (column already nullable, indexed only by
  brain_status / published).
- `voice_clone_uploads` table audit log + per-row `cartesia_voice_id`
  fill-in-once trigger already shipped ([0047_voice_clone_uploads.sql]).
  This plan wires the proxy upload endpoint that writes both rows.
- `cogs_insert_turn_voice` 4-leg RPC already shipped ([migration 0055]).
  Today the proxy passes `p_cartesia_characters=0, p_cartesia_cost=0,
  p_cartesia_audio_seconds=0, metadata={cartesia_pending:true}`
  ([proxy-handlers.js:128-167]). Phase 4 flips real values in.
- `use-session-pipe.ts` opens Gemini directly from the **client** today
  via ephemeral token, and pipes Gemini audio bytes straight to Simli
  ([use-session-pipe.ts:213-214]). The CartesiaTTSBridge lives **server-side
  in the proxy** (Cartesia API key cannot ship to browsers). The α' cutover
  on the client (route Gemini through proxy, drop direct ephemeral path)
  is #3 in the user's roadmap, not this plan. **This plan ships the
  bridge + admin upload + COGS legs; the client cutover that consumes
  the bridge ships in #3.** Until then we ship a server-side smoke test
  (Phase 5) that proves the proxy path end-to-end against a canned
  transcript.

---

## Architecture decisions

**A1 — Bridge lives in `server/voice-proxy/cartesia-bridge.js`, JS not TS.**
Mirrors `gemini-bridge.js` placement; proxy is plain Node ESM. Implements
`AudioBridge`-shaped lifecycle: `open → turnStart → sendText → turnEnd → close`.
Not the literal `AudioBridge` interface (that's TS, browser-side); a
parallel JS contract documented in the file header, identical event
shape so a future TS port is a copy job.

**A2 — One Cartesia WS per session, opened EAGERLY at session-open
(serial, after Gemini).** Cartesia docs: "Do many generations over a
single WebSocket; just use a separate context for each generation." We
`await gemini.open()` first, then `await cartesia.open()` (R3-C3 / R4-S8;
serial avoids the parallel-rejection race). Cartesia's 193ms hides under
tap-to-first-audio. Reuse for the session's duration; fresh `context_id`
per assistant turn. Idle-window reconnect on close per R3-M2 / R4-M2.

**A3 — Streaming text-in pattern.** GeminiBridge emits
`output_transcription_chunk{text}` events as Gemini ships them. CartesiaTTSBridge:
- On first chunk of a turn: send `{context_id: <session.turn_n>, model_id:'sonic-3', transcript: chunk, voice:{mode:'id', id: voiceId}, output_format:{container:'raw', encoding:'pcm_s16le', sample_rate:24000}, continue:true}` and seed character counter.
- On subsequent chunks: send `{context_id, transcript: chunk, continue:true}`.
- On Gemini `turn_complete`: send `{context_id, transcript:'', continue:false}` to flush.
- Accumulate chars across a turn; emit `turn_end` event with `{characters, audioSeconds}` for the COGS leg.

**A4 — Output sample rate = 24kHz.** Matches what Gemini produced before, so
the existing client tts-worklet (when wired) and Simli ingest don't change
their assumptions. PCM s16le LE mono. Bridge emits `audio_out{bytes, mimeType:'audio/pcm;rate=24000'}`.

**A5 — Per-turn context_id format = `<sessionId>:<turnNumber>`.** Deterministic,
debuggable in Cartesia logs, makes `cancel` correlation trivial. Per-turn
unique guarantees no cross-turn leak even if Cartesia retries internally.

**A6 — Barge-in semantics.** When the user WS sends `cancel`:
1. Bridge sends `{context_id, cancel:true}` to Cartesia (halts un-started work).
2. Bridge sets `_turnDead=true` AND `cartesiaTurnDead.set(sessionId,
   true)` in the proxy relay map **synchronously, before the cancel WS
   send** (R3-M1, Voicer §4.6 "active flag set BEFORE await"). Both
   gates check on every audio_out forward; flag cleared on next
   `turnStart`. Bridge gating alone races with chunks already in the
   WS receive buffer.
3. Next turn opens a fresh `context_id`. Audio already in the client's tts
   ring buffer is flushed by the worklet (out of scope for this plan; #2/#3 owns it).

**A7 — Frame format on the proxy↔client WS unchanged.** Today the proxy sends
binary PCM frames as `ws.send(bytes, {binary:true})`. Cartesia bridge does
the same: base64-decode the JSON `data` field once, forward as binary. The
client doesn't notice the change.

**A8 — One env var to disable.** `VOICE_CARTESIA_ENABLED=0` (Fly secret). When
0, the bridge is never instantiated; proxy continues forwarding Gemini
audio bytes (current Spike-A behavior). Lets us flip back instantly if a
Cartesia outage hits during YC demo. The flag is read at session-open
and snapshotted onto the session — no mid-session swap (CLAUDE.md hard rule).

**A9 — IVC clone is a one-time admin tool, not a creator self-service flow.**
v1 ships an admin route `POST /api/admin/voice-clone` that: (a) authenticates
admin via `assertAdminFromSession`; (b) validates the clip server-side; (c)
calls `voices/clone`; (d) writes both `voice_clone_uploads` (audit) and
`creators.voice_id` (live). The route runs on Next.js (not the Fly proxy)
because Vercel handles multipart uploads natively and we already have the
admin auth helpers there. Cartesia API key is held in the Vercel env
*alongside* the Fly env (only used at upload time, not on the audio path).

**A10 — COGS legs flip in the same PR as the bridge. Partial = permanent zero.**
Decision (audit R2-C1): when `cartesia.turnEnd()` times out or errors,
`cogs_insert_turn_voice` is called once with Cartesia legs at zero +
`metadata.cartesia_partial=true`. The 4-leg RPC writes all legs in one
transaction guarded by the partial unique index — **a later "rescue
write" of real Cartesia values is impossible** (`ON CONFLICT DO NOTHING`
silently drops). We accept the COGS undercount on partial turns; the
admin dashboard filters `cartesia_partial=true` rows out of the headline
$ figure (mirrors the existing `cartesia_pending` exclusion gate). This
is intentional. No retry RPC is added.

**A10b — COGS legs flip in the same PR as the bridge (cont).** When the bridge
ships, `proxy-handlers.js logTurnCogs` MUST switch from
`p_cartesia_characters=0` to the real values *and remove* the
`metadata.cartesia_pending=true` flag. The dashboard's `cartesia_pending_rows`
counter then naturally drops to zero on new turns; old pending rows remain
for history. Cost: `chars * CARTESIA_USD_PER_CHAR`. Audio-seconds leg
(leg 4) computed from `output_bytes / (24000 * 2)` — observability only,
`cost_usd=0`, drives the minutes-per-day cap RPC in #4.

**A11 — Per-character pricing constant pinned in env, no default.**
`CARTESIA_USD_PER_CHAR` + `CARTESIA_QUOTED_AT` are Fly secrets. Vuk pastes
both in pre-merge from the Cartesia dashboard. Module-load reads them via
`Number(process.env.CARTESIA_USD_PER_CHAR)` and throws on `Number.isNaN`.
**No fallback default in code** (audit C2 fix) — a missing env is a
hard-fail at proxy boot, not a silent ship-at-placeholder.

---

## Round-3 critical resolutions (read first)

### R3-C1 — Kill-switch must cover Cartesia spend (REVISED by R4-C1)

**R4-C1 supersedes the chars/14 projection below.** Round-4 audit caught a
triple-count: today's [index.js:430] already sums `inputSeconds +
outputSeconds`, where `outputSeconds` is Gemini's *discarded* audio
output. Adding `chars/14` on top counts the same spoken second twice
(plus user mic). At free-tier 300s/day the latch would actually trip at
~150s of real conversation.

**Final rule** (R4-C1):
- When `useCartesia === true` at session-open, the proxy's `accumulateSeconds`
  call sums **`inputSeconds + cartesiaAudioSeconds`** — `outputSeconds`
  (Gemini-discarded audio) is **dropped**. `cartesiaAudioSeconds` comes
  from leg 4's existing math: `output_bytes / (24000 * 2)`. Real, not
  chars-derived.
- When `useCartesia === false` (rollback): unchanged — sum stays
  `inputSeconds + outputSeconds` (Gemini-direct path, audio is what the
  user hears).
- `CARTESIA_CHARS_PER_SECOND` env var is **deleted** from this plan. Not
  needed anymore — real Cartesia audio_seconds are known by the time
  `cartesia.turnEnd()` resolves.
- Pre-turn-start gate (`voice_check_quota`) unchanged — same
  `seconds_used` counter, just populated from the right two legs.

**Original R3-C1 spec retained for context:**

`voice_check_quota` ([0042 line 17-60]) reads only `daily_quotas.seconds_used`,
which `voice_accumulate_seconds` increments from Gemini input seconds. A
runaway Gemini transcript (200k chars synthesized) bills full Cartesia
characters with **zero quota gate** because Cartesia spend never enters
the latch math. Fix: project Cartesia chars → equivalent-seconds inside
the proxy and accumulate them into the same `daily_quotas.seconds_used`
counter via the existing `voice_accumulate_seconds` RPC (no new RPC, no
schema change — the latch fires at 150% regardless of whether seconds
came from mic or TTS).

- ~~Conversion constant: `CARTESIA_CHARS_PER_SECOND = 14`~~ — superseded
  by R4-C1, no chars-derived projection.
- ~~Per-turn: `cartesiaEquivSeconds = characters / CARTESIA_CHARS_PER_SECOND`.~~
- Per-turn: `accumulateSeconds(sessionId, geminiInputSeconds + cartesiaAudioSeconds)`
  when `useCartesia`; legacy sum when not.

`voice_check_quota` ([0042 line 17-60]) reads only `daily_quotas.seconds_used`,
which `voice_accumulate_seconds` increments from Gemini input seconds. A
runaway Gemini transcript (200k chars synthesized) bills full Cartesia
characters with **zero quota gate** because Cartesia spend never enters
the latch math. Fix: project Cartesia chars → equivalent-seconds inside
the proxy and accumulate them into the same `daily_quotas.seconds_used`
counter via the existing `voice_accumulate_seconds` RPC (no new RPC, no
schema change — the latch fires at 150% regardless of whether seconds
came from mic or TTS).

- Conversion constant: `CARTESIA_CHARS_PER_SECOND = 14` (Phase-0
  measurable; placeholder until smoke-test empirically derives — Phase 6
  computes `audio_seconds / characters` mean across the canned-transcript
  run and Vuk pastes the result into a Fly secret
  `CARTESIA_CHARS_PER_SECOND` before merge). Module-load throws on unset.
- Per-turn: `cartesiaEquivSeconds = characters / CARTESIA_CHARS_PER_SECOND`.
- Proxy `accumulateSeconds(sessionId, geminiInputSeconds + geminiOutputSeconds + cartesiaEquivSeconds)`.
- Pre-turn-start gate: `voice_check_quota` already returns `over_150_pct`
  using the same counter — no signature change, latch fires across all
  three legs.
- `cogs_log` row for leg 4 (`voice_tts_audio_seconds`, cost=0) records
  the actual Cartesia audio seconds for cost-dashboard reconciliation;
  the quota counter uses the chars-derived projection so we don't wait
  for the synth-end before gating.

### R3-C2 — `bufferedAmount` watchdog ships in this PR

Multi-tenant Fly VM: one slow-LTE client backs up `ws.bufferedAmount`,
heap pressure climbs, **all concurrent sessions on that machine OOM**.
Cannot defer. Watchdog spec:

- After every `ws.send(bytes, {binary:true})` to user WS in the Cartesia
  forwarding loop, check `ws.bufferedAmount`. Threshold: **2 MB** (~42s of
  24kHz s16le at 48 KB/s — well past any acceptable jitter).
- On breach: emit `{type:'error', code:'client_too_slow'}` then
  `closeWs(ws, 4012, 'backpressure')`. Tear down both bridges. New close
  code `4012 backpressure` documented in [index.js:11-21] header table
  and `src/lib/voice/client/errors.ts` (mapped to `network` kind).
- Sentry breadcrumb at 1 MB (50% threshold) with sessionId for early-warning
  dashboards.

### R3-C3 — Eager parallel open uses `Promise.race`, not `Promise.allSettled`

`Promise.allSettled` waits for both bridges; if Cartesia rejects in 200ms
while Gemini is still in setup (handshake ~500-1500ms), Gemini accepts
the user-mic forwarding loop in the proxy event handler before teardown
fires. Audit R2-C3's `allSettled` decision is wrong. Replace with:

```js
const geminiP   = openGemini();
const cartesiaP = openCartesia();
// Race a rejection — first failure tears the other down before either resolves
try {
  await Promise.race([
    Promise.all([geminiP, cartesiaP]),  // success path: both done
    geminiP.then(() => cartesiaP, () => Promise.reject(new GeminiOpenError())),
    cartesiaP.then(() => geminiP, () => Promise.reject(new CartesiaOpenError())),
  ]);
} catch (e) {
  // Whichever opened — close it. Use .catch on the other to swallow late errors.
  geminiP.then(g => g.close()).catch(() => {});
  cartesiaP.then(c => c.close()).catch(() => {});
  throw e;
}
```

Or pragmatically: open Gemini first, await it, **then** open Cartesia
(serial). The 193ms Cartesia open Phase 0 measured is a TTFA-on-first-turn
cost we accept to avoid the race. Decision: **serial open, Gemini first**.
Saves ~$0 in tokens (Gemini doesn't bill mic input until first
`activityStart`/audio frame, and the proxy doesn't forward user audio to
Gemini until after `ready` is sent to the user WS), and the Cartesia
193ms hides under the user's tap-to-first-audio budget. Audit R2-C3
superseded by R3-C3 = serial.

### R3-C4 — Transcript length cap + Sentry context scrub

- **Length cap**: cap `_currentTurnOutputTranscript` at **4000 chars**
  per turn (≈300 spoken seconds at Cartesia's ~14 chars/sec — well past
  any normal model response). On overrun: emit
  `{kind:'transcript_runaway', at, characterCount}` event from
  GeminiBridge, stop forwarding chunks to Cartesia for the remainder of
  the turn, log Sentry at level=`warning` with **only** `{sessionId,
  turnNumber, characterCount}` extras (NEVER the text). Bridge still
  resolves `turnEnd` with the truncated `outputTranscript` so the
  Cartesia COGS row reflects what was actually billed.
- **Sentry scrub**: extend `server/voice-proxy/sentry.js` `beforeSend`:
  after the existing header/url scrub, also walk `event.extra` and
  delete keys named `transcript`, `outputTranscript`,
  `_currentTurnOutputTranscript`, `text`, `chunkText`. Add a unit test in
  the proxy test suite (`sentry.test.js` new) feeding a mocked Sentry
  event with those keys, asserting they're removed. Beats audit M1's
  "wrap console.error" — doesn't matter who logs, scrub is centralized.

### R3-C5 — `voice_clone_finalize` migration body in this plan

Migration `20260502_xxxxxx_voice_clone_finalize.sql` (NEW), body spec:

```sql
CREATE FUNCTION public.voice_clone_finalize(
  p_admin_user_id  uuid,
  p_upload_id      bigint,
  p_creator_id     uuid,
  p_voice_id       text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
  v_upload   record;
BEGIN
  -- Only service_role may call this. Mirrors cogs_insert_turn_voice guard.
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'voice_clone_finalize: service_role only'
      USING ERRCODE = '42501';
  END IF;

  -- Caller-supplied admin must match the upload row's admin_user_id AND
  -- the upload's creator_id must match p_creator_id. No cross-row writes.
  SELECT admin_user_id, creator_id, cartesia_voice_id
    INTO v_upload
    FROM public.voice_clone_uploads
   WHERE id = p_upload_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'upload % not found', p_upload_id USING ERRCODE = '23503';
  END IF;
  IF v_upload.admin_user_id IS DISTINCT FROM p_admin_user_id THEN
    RAISE EXCEPTION 'admin mismatch on upload %', p_upload_id
      USING ERRCODE = '42501';
  END IF;
  IF v_upload.creator_id IS DISTINCT FROM p_creator_id THEN
    RAISE EXCEPTION 'creator mismatch on upload %', p_upload_id
      USING ERRCODE = '42501';
  END IF;
  IF v_upload.cartesia_voice_id IS NOT NULL THEN
    RAISE EXCEPTION 'upload % already finalized', p_upload_id
      USING ERRCODE = '23505';
  END IF;
  IF p_voice_id IS NULL OR char_length(p_voice_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid voice_id length' USING ERRCODE = '22023';
  END IF;

  -- Both UPDATEs in this single transaction.
  UPDATE public.voice_clone_uploads
     SET cartesia_voice_id = p_voice_id
   WHERE id = p_upload_id;

  UPDATE public.creators
     SET voice_id = p_voice_id
   WHERE id = p_creator_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_clone_finalize(uuid, bigint, uuid, text)
  FROM public, anon, authenticated;
```

CLAUDE.md compliance: `SET search_path`, `REVOKE` from non-service roles,
caller identity verified, cross-row referential check, append-only
behavior preserved (the existing fill-once trigger still fires and
allows the NULL→non-NULL transition).

---

## Phases

### Phase 1 — GeminiBridge α' upgrade (precursor)

Cartesia can't take input until Gemini emits transcript chunks. The
existing bridge runs in AUDIO-only mode.

- [ ] `server/voice-proxy/gemini-bridge.js`:
  - [ ] In `open()`, when `enableOutputTranscription` (new constructor flag, default `false` for Spike-A back-compat), pass `outputAudioTranscription: {}` in the `live.connect.config`. Phase 0 verified this is accepted by 3.1 Live preview.
  - [ ] In `_onMessage`, when `m?.serverContent?.outputTranscription?.text` is present, emit `{kind:'output_transcription_chunk', at:Date.now(), text}` AND accumulate into `_currentTurnOutputTranscript` (string). **Cap at 4000 chars/turn** (R3-C4): on overrun, emit `{kind:'transcript_runaway', at, characterCount}`, stop emitting further chunks for the turn, and log Sentry warn with `{sessionId, turnNumber, characterCount}` only. When the new `discardAudioOut` flag (R3-S3) is set, skip base64 decode + audio_out emission entirely; otherwise audio_out fires and the proxy relay loop discards.
  - [ ] `turnEnd()` returns `{inputSeconds, outputSeconds, outputTranscript, usageMetadata}` — `outputTranscript` is the accumulated string. Empty when α' off.
  - [ ] Reset `_currentTurnOutputTranscript=''` on every `turnStart()`.
- [ ] `server/voice-proxy/gemini-bridge.test.js`: extend with one fixture
  asserting `output_transcription_chunk` events fire when the flag is on,
  and that `turnEnd().outputTranscript` matches concatenated chunks.
  Real-API gated test (`RUN_REAL_API_TESTS=1`) confirms Gemini still pins.
- [ ] Add the `enableOutputTranscription` flag to the proxy `index.js` connection-setup path. Default-on when `VOICE_CARTESIA_ENABLED=1`; off otherwise (preserves Spike-A audio-out path under the rollback flag).

**Cost guard**: leg 2 of `cogs_insert_turn_voice` already bills the
discarded audio-out tokens. No COGS change here.

### Phase 2 — CartesiaTTSBridge

- [ ] `server/voice-proxy/cartesia-bridge.js` (NEW). EventEmitter-style,
  same shape as `GeminiBridge`. Public surface:

  ```js
  new CartesiaTTSBridge({ apiKey, voiceId, sampleRate=24000 })
  await open()                              // opens WS to Cartesia
  turnStart(turnContextId)                  // resets per-turn counter
  sendText(text)                            // streams a transcript chunk
  async turnEnd()                           // sends final continue:false; returns { characters, audioBytes, audioSeconds }
  cancel()                                  // sends {context_id, cancel:true} for the current turn
  on(listener)                              // events
  async close()
  ```

  Events:
  - `audio_out`: `{bytes:Buffer, mimeType:'audio/pcm;rate=24000'}` per Cartesia chunk (after base64 decode).
  - `done`: when Cartesia emits `{type:'done'}` for the active context.
  - `error`: terminal — bridge dead after fire. Maps Cartesia `error_code` strings to a small const-union (`bad_voice_id | rate_limited | model_not_found | other`).
  - `closed`: WS closed.

- [ ] **Message parsing — STRICT** (audit C4 fix): every Cartesia message
  must be valid JSON conforming to the documented envelope (`type` ∈
  {`chunk`,`done`,`timestamps`,`error`,`flush_done`}). Parse failure OR
  unknown `type` → emit `error{code:'protocol_violation'}`, kill the
  bridge, teardown the proxy WS with `4005 upstream_error`. **No silent
  fallback to raw-PCM forwarding** — that path could leak error JSON
  bytes to the user as audio and play noise. The ambiguity from Phase 0's
  binary-detection is closed by the Phase-0 re-run on `2026-03-01`
  (above) — pick one wire format, code to it.
- [ ] **Reconnect logic**: WS close while a turn is in-flight → emit `error`
  with code `connection_lost`; the proxy translates to a `tts_mid_turn_failure`
  to the client and tears down the turn (per
  [DAYS_8_12_VOICE_PLAN.md:128]). No silent retry; Cartesia bills again on
  same context_id reconnect per Phase 0 manual cross-check.
- [ ] **`turnEnd` MUST take a timeout** (audit C1 fix). Signature:
  `async turnEnd({ timeoutMs = 5000 } = {})`. On timeout: emit
  `error{code:'turn_end_timeout'}` and resolve with `{characters: <accumulated>,
  audioBytes: <accumulated>, audioSeconds: <accumulated>, partial: true}` —
  do NOT throw. Caller (proxy) MUST receive a result so it can still write
  the Gemini legs (1+2) of cogs_insert_turn_voice with `metadata.cartesia_partial=true`.
  Cartesia hang must NOT block Gemini billing.
- [ ] **Mid-turn error handling** (audit M5 fix). `cartesia.on('error', ...)`
  post-bridge-open: proxy `index.js` registers a handler that
  `ws.send({type:'error', code:'tts_failed', detail})` to user, calls
  `logTurnCogs` with current Gemini metrics + `metadata.cartesia_partial=true`
  + zero Cartesia legs, then `closeWs(1011, 'tts_failed')` and tears down.
  No leaked turn rows.
- [ ] **Backpressure**: Cartesia chunks arrive faster than client can drain
  on slow networks. Bridge does NOT buffer — forwards each chunk
  immediately to its caller. Proxy enforces `ws.bufferedAmount` watchdog
  per **R3-C2** (2 MB hard cap → close 4012). Ships in this PR. NOT
  deferred.
- [ ] **Tests** (`cartesia-bridge.test.js`, mock `ws` like
  `gemini-bridge.test.js` does):
  - Open with valid key + voice id → emits `setup_complete` (proxy mock returns 101).
  - `sendText` followed by `turnEnd` → assert outbound JSON shape: first
    message has full config + `continue:true`; subsequent has only
    `{context_id, transcript, continue:true}`; final has `continue:false`.
  - On inbound `{type:'chunk', data}` → emits `audio_out` with decoded bytes.
  - On inbound `{type:'error', error_code:'voice_not_found'}` → emits
    `error{code:'bad_voice_id'}`.
  - `cancel()` mid-turn sends `{context_id, cancel:true}` and stops
    relaying chunks even if more arrive.
  - Real-API gated test: open against real Cartesia, send "hello",
    assert ≥1 audio chunk arrives within 1s. Skips when
    `RUN_REAL_API_TESTS!=1` or `CARTESIA_API_KEY` unset.

### Phase 3 — Wire the bridge into proxy `index.js`

- [ ] On WS connection-open (after `openSession` succeeds, before bridge
  open):
  - Read `VOICE_CARTESIA_ENABLED` env var **and** `VOICE_MODEL` once;
    snapshot to local `useCartesia` and `model`. **Single read, single
    frame** (audit R2-M2): if `useCartesia=true` then `enableOutputTranscription`
    must be passed to GeminiBridge.open in the same call frame using the
    snapshotted variable, never re-read from env.
  - **Hard model gate** (audit R2-M5): if `useCartesia=true` and
    `model !== 'gemini-3.1-flash-live-preview'` (the only Phase-0-verified
    `outputAudioTranscription` model), refuse to open. Close WS with
    `4010 model_not_compatible_with_cartesia` (new code; documented in
    index.js header + errors.ts in this PR). Sentry warning is not enough
    — silent fallback would let Gemini bill while Cartesia synthesizes
    silence.
  - If `useCartesia`: SELECT `creators.voice_id` for the session's
    `creator_id`. **Fail-closed**: if `voice_id` IS NULL, close WS with
    `4009 cartesia_no_voice` (new code). Per-creator gate
    (`creators.cartesia_enabled`) is **not** added — at flip-time only
    Vuk-as-creator-#1 has a clone, so only Vuk's hooks are surfaced in
    v1's invite-only feed; other creators 4009 by design and admin
    onboards them via the same upload route before publishing
    (audit R2-M4 documented decision).
  - **Serial open, Gemini first** (R3-C3 supersedes R2-C3 parallel):
    `await gemini.open()` then `await cartesia.open()`. If Cartesia
    rejects: `await gemini.close()` before WS close to user (Gemini
    hasn't yet accepted any user audio because the proxy doesn't forward
    until `ready` is sent). The 193ms Cartesia open cost hides under
    the user's tap-to-first-audio budget. Both errors → close user WS
    with `4005 upstream_error`.
  - On bridge `error` mid-session (post-ready), Phase 3 mid-turn
    handler (already specced) tears down both bridges.
- [ ] On `bridge.gemini.on(output_transcription_chunk)` → call
  `cartesia.sendText(chunk.text)`.
- [ ] On `cartesia.on(audio_out)` → forward to user WS as binary
  (`ws.send(bytes, {binary:true})`). Replace the prior Gemini audio_out
  forwarding when `useCartesia` is true; Gemini audio bytes are
  discarded server-side.
- [ ] On user-control `turn_start`: call `cartesia.turnStart(<sessionId>:<turnNumber>)`.
- [ ] On user-control `turn_end`: after Gemini `turnEnd()` resolves with
  `outputTranscript`, await `cartesia.turnEnd({timeoutMs:5000})` to get
  final `{characters, audioBytes, audioSeconds, partial?}`. **Always**
  call `logTurnCogs` next (success and timeout paths) so Gemini legs 1+2
  always land. Set `metadata.cartesia_partial=true` when `partial=true`.
  (Audit C1.)
- [ ] On user-control `cancel`: call `cartesia.cancel()`.
- [ ] Teardown order: `cartesia.close()` BEFORE `gemini.close()` (so an
  in-flight Cartesia turn doesn't try to send to a half-closed pipe; if
  Gemini died first, cartesia just emits `done` against an empty queue).

### Phase 4 — COGS legs 3 + 4 flip live

- [ ] `server/voice-proxy/proxy-handlers.js`:
  - [ ] Add `CARTESIA_USD_PER_CHAR` env var read with `Number(process.env.CARTESIA_USD_PER_CHAR ?? NaN)`. If `Number.isNaN`, throw at module-load (fail-closed). Mirror with `CARTESIA_QUOTED_AT`.
  - [ ] Extend `logTurnCogs` to take `{cartesia: {characters, audioBytes, audioSeconds}}` (optional; absent when `useCartesia` is false on this session). When present:
    - `p_cartesia_characters: characters`
    - `p_cartesia_cost: Number((characters * CARTESIA_USD_PER_CHAR).toFixed(6))`
    - `p_cartesia_audio_seconds: Number(audioSeconds.toFixed(4))`
    - Drop `metadata.cartesia_pending` from `meta` when payload includes Cartesia values; replace with `metadata.cartesia_quoted_at: CARTESIA_QUOTED_AT`.
  - [ ] When `useCartesia` is false (rollback flag flipped): keep the old
    `cartesia_pending:true` flag + zeros so the dashboard's
    `cartesia_pending_rows` counter is meaningful.
  - [ ] **Quota gate parity** (R3-C1): proxy's `accumulateSeconds` call
    at `turn_end` adds `cartesiaEquivSeconds = characters /
    CARTESIA_CHARS_PER_SECOND` to the existing
    `geminiInputSeconds + geminiOutputSeconds` sum. One call to
    `voice_accumulate_seconds`, kill-switch latch covers all three
    spend sources. `CARTESIA_CHARS_PER_SECOND` env var fail-closed at
    module load (no default).
- [ ] Update `cogs-rpc.test.js` with two new cases: cartesia-on path
  asserts the four legs are written with non-zero leg 3/4; cartesia-off
  path is the existing assertion.
- [ ] Update [SPIKE_A_DEFERRED_FIXUP_PLAN.md:230-237] cartesia leg
  deferral spec to status=DONE in this PR's commit message; the
  doc itself stays for history.

### Phase 4.5 — Migrations bundled in this PR

- [ ] `voice_clone_finalize` RPC migration — body in **R3-C5** above.
- [ ] `creators.voice_id` repurpose migration — body in **R3-M5** above.
- [ ] (No `cogs_insert_turn_voice` change. Quota gate change is purely
  proxy-side via `voice_accumulate_seconds(seconds_with_cartesia_projection)`
  per R3-C1; existing RPC signature absorbs the bigger number.)

### Phase 5 — Admin voice-clone upload (Vuk-as-creator-#1)

- [ ] `src/app/api/admin/voice-clone/route.ts` (NEW). POST handler:
  - `assertAdminFromSession()` (existing helper).
  - Same-origin check (mirror existing admin routes; reject if `Origin` host ≠ self host, with `x-forwarded-host` honored only on Vercel/dev per [DAYS_8_12_VOICE_PLAN.md:227]).
  - `multipart/form-data` body: `clip` (file), `creatorId` (uuid), `name` (string, ≤80 chars), `language` (string, default 'en').
  - Hard validations server-side (NEVER trust the browser):
    - `Content-Length` ≤ 10 MB (matches `voice_clone_uploads.bytes` upper bound 20 MB but we're stricter at the route layer; the table accepts up to 20 MB to absorb a future relax).
    - Sniff actual MIME with file-type pkg (add as Vercel dep). Allowed: `audio/wav | audio/mpeg | audio/ogg | audio/x-m4a | audio/mp4` (matches table CHECK).
    - Probe duration. Server-side ffprobe is a Vercel cold-start anti-pattern → use the `music-metadata` pure-JS lib (no native bin) which extracts duration from headers without decoding. Range: 3.0 ≤ duration ≤ 120.0 s (matches table CHECK; lowers floor to 3s per Cartesia "5s clean clip" guidance, leaves margin for shorter samples).
  - Compute SHA-256 hex of bytes.
  - Rate limit: at most 3 successful clones/day/admin. Implement via SELECT count(*) WHERE admin_user_id = caller AND created_at > now() - interval '24 hours'. Reject 429 if ≥ 3.
  - INSERT `voice_clone_uploads` row with `cartesia_voice_id=NULL` first (the trigger lets this column transition NULL→non-NULL exactly once).
  - POST to `https://api.cartesia.ai/voices/clone` with `Authorization: Bearer ${CARTESIA_API_KEY}`, `Cartesia-Version: 2026-03-01`, multipart fields `clip`, `name`, `language`, `description?`.
  - **Overwrite path** (audit R2-C2 fix): when `?force=1` is set on a
    creator with non-NULL `voice_id`, the route INSERTs a **new**
    `voice_clone_uploads` row (initial `cartesia_voice_id=NULL`) and
    UPDATEs `creators.voice_id`. It NEVER touches the prior upload row's
    `cartesia_voice_id` column — the fill-once trigger
    ([0047_voice_clone_uploads.sql:35-65]) blocks any non-NULL→non-NULL
    transition regardless of role. The old Cartesia voice id is leaked
    in Cartesia's account (deletion is post-YC, audit M6 R2).
  - On success: parse `{id}`, then call new SECURITY DEFINER RPC
    `voice_clone_finalize(p_upload_id bigint, p_creator_id uuid, p_voice_id text)`
    which performs both UPDATEs in a single SQL transaction (audit C3
    fix). Service-role gate inside the RPC. New migration ships in this
    PR alongside the route. Without the RPC, the Supabase JS client
    cannot atomically update two tables — a failure between the two
    `.update()` calls would lock `voice_clone_uploads.cartesia_voice_id`
    (per fill-once trigger) without populating `creators.voice_id`,
    bricking re-upload.
  - **Overwrite guard** (audit C5 fix): before calling Cartesia, route
    SELECTs `creators.voice_id` for the target creator. If non-NULL,
    require explicit `?force=1` query param **and** log a
    `voice_clone_overwrite_attempt` admin_audit row with prior + new
    upload sha256s. Without `?force=1` → return 409 with the prior
    upload's `created_at` so the UI can show "this creator already has a
    voice trained on YYYY-MM-DD; pass force=1 to replace."
  - On Cartesia failure: leave the audit row with `cartesia_voice_id=NULL` (visible as a failed attempt), return 502 with the error_code from Cartesia (sanitized — never bubble raw `message` field).
- [ ] `src/app/admin/creators/[id]/page.tsx` ([line 80-]): add a "Upload voice clip" form cell beside the existing voice_clone_uploads list. Multipart upload to the route above. Show the resulting `voice_id` once written.
- [ ] **Duration parsing pre-merge sanity** (audit M6): manually verify
  `music-metadata` returns finite `duration` for: an iOS Voice Memo m4a
  (moov-at-end), an Audacity-exported ogg, a 16kHz mono WAV, an MP3 from
  ffmpeg. If any return undefined → escalate to a Vercel-compatible
  fallback (e.g. shipping a small WASM ffprobe) before merge. Don't
  trust header-only parsing without proof.
- [ ] **Close-code + client-error-mapping in the same PR** (audit M1):
  `4009 cartesia_no_voice` documented in `index.js` close-code header;
  added to `src/lib/voice/client/errors.ts` with friendly toast "voice
  not yet trained for this creator." Don't punt to the Days-8-12 plan.
- [ ] **Vuk-as-creator-#1 seed run**: documented as a manual one-off, not a migration:
  1. Vuk records ~10s clean clip (his preferred phrasing — "Hey, I'm Vuk, founder of OakLeague…"), saves WAV.
  2. Logs into admin console, opens his own creator page.
  3. Uses the upload cell. Cartesia returns voice id.
  4. `creators.voice_id` populated → next session for that creator uses real cloned voice.
  5. Verify: open a session against Vuk's hook, hear his cloned voice on first turn. Captured in `.claude_learnings.md`.

### Phase 6 — End-to-end smoke test (no client cutover yet)

- [ ] `scripts/cartesia-smoke.mjs` (NEW): canned-text harness for the proxy.
  **Path decision** (audit R2-S "or"-elimination): a new dedicated debug
  WS path `/voice/cartesia-smoke` mounted only when
  `NODE_ENV !== 'production'`, mints its own ticket via service-role for
  a known test user. Not the admin path — keeps the smoke test orthogonal
  to admin auth. Sends a 3-sentence canned transcript including a
  multi-digit turn number (≥10) to exercise full `<sessionId>:<turnNumber>`
  context_id length (audit R2-S, R3-S2). Asserts ≥1 PCM frame arrives within
  2s, asserts a `cogs_log` row lands with non-zero `voice_tts_characters`
  + `metadata.cartesia_partial=false`. Real-API gated; ships per R3-S9
  rules (blocking on Cartesia/proxy diff PRs, advisory elsewhere).
- [ ] **Backpressure assertion** (R3-C2 verify): smoke harness opens a
  second mock client that drains its WS at 1 KB/s; asserts
  `ws.bufferedAmount` climbs past 2 MB and the proxy closes with `4012
  backpressure` within 5s. No production traffic affected.
- [ ] **Quota latch end-to-end** (R3-C1 verify): smoke harness opens a
  session for a user whose `daily_quotas.daily_limit_s = 60`, then runs
  a turn whose Cartesia output is 2000 chars (~143 equivalent seconds at
  the seed `CARTESIA_CHARS_PER_SECOND=14`). Asserts the next
  `turn_start` returns `kill_switch_fired_at IS NOT NULL` and the proxy
  closes 1008 `quota_exceeded`.
- [ ] **Sentry scrub assertion** (R3-C4 verify): mock Sentry transport;
  pass an extras blob containing `{transcript: 'secret'}`; assert it's
  removed before transmit.

### Phase 6.5 — Smalls + edge cases

- [ ] **`VOICE_CARTESIA_ENABLED` parse**: pin to strict `=== '1'` (string).
  Avoid `'true' | 'TRUE' | 'on'` ambiguity. Document.
- [ ] **2.5 fallback path**: hard-gated at session-open per Phase 3
  (close `4010 model_not_compatible_with_cartesia`). Documented decision
  audit R2-M5: Cartesia + 2.5 will never co-exist; if Vuk flips to 2.5,
  flip `VOICE_CARTESIA_ENABLED=0` in the same secret update so sessions
  fall back to Gemini stock voice cleanly. Both flags moved together =
  one runbook step.
- [ ] **`audio/mp4` vs `audio/x-m4a`**: keep both in MIME allowlist —
  iOS reports `audio/mp4`, Android reports `audio/x-m4a` for the same
  container; rejecting either breaks one platform.
- [ ] **`context_id` length**: `<sessionId>:<turnNumber>` = uuid(36) + `:`
  + int → up to ~40 chars. Cartesia documented limit not in the public
  docs; verify at first smoke test that 40-char ids are accepted. If
  rejected, switch to `crypto.randomUUID()` per turn (loses turn-number
  debuggability but always fits).
- [ ] **Sentry breadcrumb hygiene** (no transcript leaks): wrap the
  bridge's internal `console.error` calls so the `text` field of any
  `output_transcription_chunk` never lands as a Sentry extra. Only
  `characters_count` + `chunk_index` ever surface.
- [ ] **Backpressure SHIPS in this PR per R3-C2** — superseded item.
  See R3-C2 for spec. Smoke test (Phase 6) artificially throttles a
  test client (1 KB/s) and asserts `4012 backpressure` close fires.
- [ ] **`creators.voice_id` index** (audit M2): not needed for the
  per-session lookup (PK lookup). If a future admin dashboard adds a
  "trained creators" filter, add `CREATE INDEX creators_voice_id_idx ON
  creators(voice_id) WHERE voice_id IS NOT NULL` then. **Out of scope
  this PR.**
- [ ] **CI Cartesia key isolation** (audit M7): real-API gated test uses
  a separate `CARTESIA_CI_API_KEY` Vercel/GH secret pointing to a
  separate Cartesia account funded $5/month. Production
  `CARTESIA_API_KEY` never leaks into CI. Document in `.env.example`.

### Phase 7 — Documentation + rollback

- [ ] Update `CLAUDE.md` Voice section: line about Cartesia legs being
  pending → done; specify `VOICE_CARTESIA_ENABLED=0` rollback flag.
- [ ] Append a `.claude_learnings.md` entry: title, root cause, fix, lesson —
  for both (a) Gemini outputAudioTranscription wiring, (b) any Cartesia
  oddities discovered during the smoke test (e.g., if 24kHz isn't actually
  delivered).
- [ ] `docs/_planning/SPIKE_A_DEFERRED_FIXUP_PLAN.md` cartesia leg
  deferral spec: mark "D-α'-cutover bridge half: SHIPPED in Cartesia
  Wire-Up PR; client cutover (#3) outstanding."

---

## Hard rules / security

- `CARTESIA_API_KEY` is a Fly secret on the proxy AND a Vercel env on
  Next.js (admin upload route only). Never `NEXT_PUBLIC_*`.
- Never log raw transcript bytes at INFO. Cartesia's transcripts are
  user-conversation content; same posture as session_turns.transcript.
- Admin upload route refuses any clip whose sniffed MIME doesn't match the
  table CHECK. Content-Type header is ignored entirely (per
  [DAYS_8_12_VOICE_PLAN.md:228]).
- Service-role-only writes to `voice_clone_uploads` and `creators.voice_id`
  — both go through the Next.js route's server-side supabase admin client.
  No browser writes.
- 3-clones/day/admin rate limit is **per admin user**, not global. Multiple
  admins each get 3.
- WS close code `4009 cartesia_no_voice` is documented in the
  [index.js:11-21] header comment block alongside the existing 400x codes.
- `CARTESIA_USD_PER_CHAR` unset → proxy fails closed at module-load
  (the bridge isn't even instantiated). Fly logs surface this loudly.
- COGS metadata `cartesia_quoted_at` lets the YC-demo cost dashboard
  trust the figure without hand-waving.

## Testing

- **Unit:** `cartesia-bridge.test.js` covers open/turnStart/sendText/turnEnd,
  base64 decode of inbound chunks, error mapping, cancel semantics.
  `cogs-rpc.test.js` extended with cartesia-on/off branches.
- **Real-API gated:** `RUN_REAL_API_TESTS=1` adds one Cartesia round-trip
  per **merge to main** only (NOT every PR push) — gated by GH Actions
  `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`.
  Single canned phrase ~50 chars, $0.0005 incremental. Caps CI Cartesia
  spend ≤ $5/month (audit R2-M1). Caught silent Cartesia API regressions
  in main before they hit prod.
- **Manual:** Vuk seeds his own clone post-merge, verifies first session
  plays his voice. PostHog event `voice.cartesia.first_chunk_ms` per
  session for ongoing TTFA monitoring.

## Rollback

`VOICE_CARTESIA_ENABLED=0` on Fly (one secret flip; no redeploy).
Proxy reverts to forwarding Gemini audio bytes; transcript chunks
discarded; legs 3+4 zero with `cartesia_pending=true` again.

## Round-3 Medium + Small resolutions (additive — phase tasks reference these)

- **R3-M1** — `cartesia.cancel()` race: bridge sets `_turnDead = true` AND
  proxy's relay-loop `cartesiaTurnDead.set(sessionId, true)` **synchronously
  before** the `ws.send({context_id, cancel:true})` call. No await between
  flag-set and send. Mirrors Voicer §4.6 "active flag set BEFORE await."
- **R3-M2** — Cartesia mid-session reconnect: NOT out-of-scope. On
  Cartesia WS `close` event when `currentTurn === null` (no in-flight
  turn): bridge auto-reopens once with exponential backoff (200ms,
  500ms, 1s — 3 attempts max). On reopen: emit
  `{kind:'reconnected'}` event so the proxy resets per-turn caches.
  Mid-turn close stays terminal (`tts_mid_turn_failure`, no retry —
  Cartesia would re-bill the same context_id per Phase 0). 5–55 min
  session length means an idle ≥5min Cartesia drop is plausible; one
  reconnect saves the demo.
- **R3-M3** — Frame format coherence (24kHz s16le mono, container=raw,
  byte length % 2 == 0, no header) is a **Phase 0 re-run gate item**,
  not a post-merge `.claude_learnings.md` entry. Add to the re-run
  script's pass criteria: parse first 3 chunks, assert `bytes.length %
  2 === 0` and `mimeType` from `output_format` echoes `pcm_s16le`.
- **R3-M4** — `cogs-rpc.test.js` extended with mixed-rows scenario:
  insert N normal turns + M `cartesia_partial=true` turns + K
  `cartesia_pending=true` turns; assert the `live` route headline-filter
  SQL (`metadata->>'cartesia_partial' IS NULL AND
  metadata->>'cartesia_pending' IS NULL`) returns only the normal N
  rows' summed `cost_usd`. Otherwise reconciliation is vibes.
- **R3-M5** — `creators.voice_id` re-purpose migration:
  `20260502_xxxxxx_creators_voice_id_cartesia_comment.sql`. Body:
  ```sql
  -- Pre-flight: voice_id is currently a free-text column repurposed as
  -- the Cartesia IVC voice UUID. Verify no rows hold legacy values.
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM creators WHERE voice_id IS NOT NULL) THEN
      RAISE EXCEPTION 'creators.voice_id has rows; cannot repurpose';
    END IF;
  END $$;
  COMMENT ON COLUMN public.creators.voice_id IS
    'Cartesia IVC voice UUID set by voice_clone_finalize RPC. Null until clone uploaded.';
  ALTER TABLE public.creators
    ADD CONSTRAINT creators_voice_id_shape
      CHECK (voice_id IS NULL OR char_length(voice_id) BETWEEN 1 AND 128);
  ```
- **R3-M6** — `?force=1` overwrite path calls `DELETE
  https://api.cartesia.ai/voices/{prior_voice_id}` immediately after
  `voice_clone_finalize` succeeds with the new voice id. On Cartesia
  delete failure (404 = already gone, anything else): write an
  `admin_audit` row `{action: 'voice_clone_orphaned', actor_id:
  admin_user_id, target: prior_voice_id, reason: <error>}`. GDPR
  right-to-erasure + cost hygiene.
- **R3-M7** — Phase 0 re-run script: `scripts/cartesia-phase0-rerun.mjs`
  (NEW, this PR). Adapted from `voice-phase0-verify.mjs` checks #2/#3,
  pinned to `cartesia_version=2026-03-01`, with new assertions:
  (a) JSON envelope shape; (b) `continue:false` flushes within 1s;
  (c) frame coherence (R3-M3); (d) `<sessionId>:<turnNumber>` context_id
  with multi-digit turnNumber accepted (S2). Output written to
  `docs/_planning/CARTESIA_PHASE_0_RERUN.md`. **Merge-blocking**: PR
  cannot land until that file is present + all checks PASS in the
  committed output.

- **R3-S1** — Eager Cartesia open on every session abandons cost on
  ghost sessions (mic-tap → user closes tab before audio). Quantify:
  Phase 6 smoke run logs Cartesia open count vs `ws.send(ready)` count
  per minute for 24h post-merge. Net loss is measured, not assumed; if
  abandonment > 30% of opens, switch to lazy-on-first-`turn_start`. Per
  R3-C3 we serial-open, so this is "post-Gemini-ready Cartesia open"
  cost — should be negligible since user has by that point opted in.
  Tracked as a metric, not a blocker.
- **R3-S2** — `<sessionId>:<turnNumber>` length verified in R3-M7's
  re-run script (multi-digit turnNumber).
- **R3-S3** — `GeminiBridge` constructor takes `discardAudioOut: bool`
  (default `false`). When `true`, the `_onMessage` audio-out parsing
  loop **skips** the `Buffer.from(b64, 'base64')` decode and the
  `audio_out` event emission entirely. Saves a per-chunk allocation
  on every α' turn. Set to `true` whenever `enableOutputTranscription`
  is true.
- **R3-S4** — PostHog: emit `voice.cartesia.first_chunk_ms` (Cartesia
  source) and `voice.gemini.first_chunk_ms` (Gemini direct, rollback
  path) as **separate** events with `pipeline_source: 'cartesia'|'gemini'`
  property. Dashboard rolls up by source for clean rollback comparisons.
- **R3-S5** — Allowed-MIME list (`'audio/wav' | 'audio/mpeg' |
  'audio/ogg' | 'audio/x-m4a' | 'audio/mp4'`) exported from
  `src/lib/voice/voice-clone-mimes.ts` and imported by both the upload
  route and the migration's CHECK comment (cross-reference, not a SQL
  import). Single source of truth.
- **R3-S6** — `cogs-rpc.test.js`: add precision assertion that for the
  worst-case turn (4000-char R3-C4 cap × `CARTESIA_USD_PER_CHAR` ceiling
  ~$0.0015/char hypothetical = $6.00/turn), `cost_usd` is rendered to 6
  decimal places in the `cogs_log` row and not floor()'d to integer
  pennies.
- **R3-S7** — `enableOutputTranscription` derived from `=== '1'` strict
  parse of the snapshotted `VOICE_CARTESIA_ENABLED` (R2-M2's "single
  frame" requirement subsumes this; documented once in Phase 3 and
  reused). No standalone `'true'|'on'|'yes'` parsing anywhere.
- **R3-S8** — `enableOutputTranscription` flag is a transitional knob.
  Follow-up issue tracked: once `VOICE_CARTESIA_ENABLED=1` has been
  stable for 14 days post-merge, file a PR to remove the flag and make
  outputAudioTranscription always-on (it's free if AUDIO modality is
  on). Linked from `.claude_learnings.md` so the dead-code-debt isn't
  forgotten.
- **R3-S9** — Merge-to-main Cartesia smoke test is **blocking** on PR
  branches that touch `server/voice-proxy/cartesia-bridge.js`,
  `proxy-handlers.js`, or migration `voice_clone_finalize.sql`.
  **Advisory** on all other branches (Cartesia ought to behave
  identically; CI cost stays bounded). GH Actions `paths:` filter
  encodes the rule.

## Round-4 audit resolutions (read after R3 — R4 supersedes on conflict)

### Critical

- **R4-C1** — Quota math triple-count fix. See revised R3-C1 above.
  `useCartesia=true` → sum is `inputSeconds + cartesiaAudioSeconds`
  (drop Gemini-discarded `outputSeconds`). `useCartesia=false` → unchanged.
  `CARTESIA_CHARS_PER_SECOND` env var deleted.
- **R4-C2** — `voice_accumulate_seconds` 22003 (oob) does NOT close
  the WS today ([index.js:218-247]); fatal-only path covers P0002.
  Under the 4000-char R3-C4 cap a worst-case turn = ~600s combined,
  well under the 3600s RPC limit, so 22003 is theoretically unreachable.
  But "theoretically" is not "guaranteed" once anyone bumps the cap.
  Two-part fix:
  1. **Hard ceiling doc**: pin in CLAUDE.md voice section that the
     R3-C4 transcript cap is **load-bearing for the quota gate** —
     bumping past 4000 chars without re-deriving the per-turn second
     ceiling breaks the kill-switch. Add a comment to the cap constant
     in the bridge code referencing R4-C2.
  2. **Defense in depth**: extend `accumulateSeconds` in the proxy to
     map `error.code === '22003'` to `{ok:false, fatal:true,
     reason:'quota_oob'}` (same shape as P0002), wired to the same
     `4006 quota_state_inconsistent` close path. Today the only
     non-P0002 error returns `fatal:false` and the WS keeps running
     with a desync'd `seconds_used`. R4 promotes 22003 to fatal.
- **R4-C3** — `?force=1` overwrite + `DELETE /voices/{id}` mid-session
  cliff. Fix in admin route:
  1. Before calling Cartesia clone-create on a `?force=1` overwrite:
     `SELECT count(*) FROM sessions WHERE creator_id=$1 AND ended_at
     IS NULL` (active-session count).
  2. If count > 0: refuse with **409 `creator_has_active_sessions`**;
     the UI shows "N active sessions; retry in a few minutes." No clone
     created, no swap performed.
  3. If count = 0: proceed with clone create + `voice_clone_finalize`
     RPC + DELETE the prior voice id (per R4-M3 below).
  4. Race window between the count check and the swap: tiny but
     non-zero. Acceptable — admin overwrite is a deliberate human
     action, not a hot path. A session that opens in the 200ms gap and
     gets the new voice is fine; the *delete* of the old voice id is
     the sharp edge, and R4-M3 defers it 60s after the swap.
- **R4-C4** (round-2 revisit) — Inbound Cartesia→proxy WS buffering is
  unbounded by default in Node `ws`. Fix: pass `{ maxPayload: 1 *
  1024 * 1024 }` (1 MB) to the `new WebSocket(...)` opening to
  Cartesia; on overrun, the `ws` library closes with code 1009 and
  fires `close` event. Bridge maps to `error{code:'message_too_large'}`,
  proxy tears down with `4005 upstream_error`. Documents that the
  per-session 2 MB **outbound** cap (R3-C2) bounds memory client-side;
  the inbound cap bounds Cartesia-side runaway frames.

### Medium

- **R4-M1** — Tab close between `await gemini.open()` resolving and
  `await cartesia.open()` resolving leaves a half-open Cartesia.
  Phase 3 close handler must check `cartesia` instance existence
  (`if (cartesia) await cartesia.close()`), NOT a boolean
  `cartesiaOpened===true` flag. Same for Gemini. Pattern: keep the
  bridge instance refs nullable; null-check on teardown; `close()` on
  the bridge is idempotent.
- **R4-M2** — Reconnect during idle (R3-M2): a user `turn_start`
  arriving inside the 1.7s reconnect-backoff window has no defined
  behavior. Spec:
  - If reconnect attempt is in flight: bridge **rejects** the
    `turnStart` synchronously with `error{code:'tts_reconnecting'}`.
    Proxy maps to user-WS close `4011 tts_reconnecting` (new code,
    documented in [index.js:11-21] header + errors.ts). Client retries
    after the next `ready`.
  - No buffer-and-replay: simpler, deterministic, and saves us writing
    a transcript replay path that would re-bill on reconnect.
- **R4-M3** — `DELETE /voices/{id}` on overwrite path (R3-M6): NOT
  synchronous. Sequence:
  1. Admin route awaits `voice_clone_finalize` RPC. UI returns 200
     with new `voice_id` immediately.
  2. Route schedules a 60s-deferred DELETE via a fire-and-forget
     `setTimeout(() => deletePriorVoice(...), 60_000)` with a hard 5s
     fetch timeout (`AbortController`). Vercel serverless functions
     don't survive 60s post-response, so the deferred DELETE runs in a
     **proxy-side queue** instead: route POSTs `{ voice_id, due_at }`
     to a new proxy endpoint `POST /admin/voice-delete-queue`; proxy
     holds it in-memory + persists to a tiny `voice_delete_queue` table
     (one column: `voice_id text PRIMARY KEY, due_at timestamptz NOT
     NULL`) for crash-recovery. Worker tick every 30s.
  3. On Cartesia DELETE failure (any non-404, non-200): admin_audit row
     `voice_clone_orphaned` per R3-M6 still fires.
  4. 5s timeout via `AbortController.signal`; orphan logged on timeout.
- **R4-M5** — `CARTESIA_CHARS_PER_SECOND` deleted by R4-C1, so the
  derivation step in Phase 6 + the chars-based latch test are deleted.
  Quota latch test (Phase 6) uses real Cartesia audio_seconds: feed a
  canned transcript long enough that real `audio_seconds > daily_limit_s
  * 1.5` (e.g., 100s of synthesis against a 60s daily cap). No
  fixture-derivation coupling.
- **R4-M6** — `model === 'gemini-3.1-flash-live-preview'` strict
  equality breaks on versioned pins. Replace with allowlist:
  ```js
  const CARTESIA_COMPATIBLE_MODELS = new Set([
    'gemini-3.1-flash-live-preview',
    // future versioned variants added here once Phase-0-verified
  ]);
  ```
  No `startsWith` (too forgiving — would match an unverified
  `-experimental` build); explicit allowlist forces a re-verify
  before any new model wires up.
- **R4-M7** — Cartesia API outage at PR-merge-time blocks all merges
  if the smoke test is blocking (R3-S9). Escape hatch: a
  `cartesia-bypass` GitHub PR label tells GH Actions to skip the
  Cartesia smoke step. Documented in `CONTRIBUTING.md` (or the
  PR-template description) as: "Use only when Cartesia status page is
  red and the PR change does not touch the bridge." Required-checks
  config keeps the smoke step blocking by default; the label adds a
  `if: !contains(github.event.pull_request.labels.*.name, 'cartesia-bypass')`
  guard.
- **R4-M8** — Sentry scrub coverage gap (R3-C4 only covered
  `event.extra`). Extend `beforeSend` in `server/voice-proxy/sentry.js`
  to also walk:
  - `event.contexts` — recursive key walk.
  - `event.breadcrumbs[].data` — array iteration + key walk.
  - `event.message` — regex strip any string > 100 chars that contains
    only printable ASCII (heuristic for transcript leakage).
  - `event.exception.values[].value` — same regex strip.
  Single helper function `scrubTranscriptKeys(obj)` reused at every
  site. Test fixture per channel asserts removal.

### Small

- **R4-S1** — Bridge cancel sync-ordering note: the R3-M1 fix is
  correct only if the JS engine guarantees no microtask runs between
  the flag set and the `ws.send`. Document: keep both lines in the
  same synchronous block, no `await` between them. Comment in code
  pinning the rule.
- **R4-S2** — `voice_clone_finalize` migration body (R3-C5) needs a
  rationale comment explaining the two-UPDATE transaction: "Supabase
  JS client cannot bundle two `.update()` calls in one transaction;
  this RPC exists to atomicize the upload-row finalization with the
  creators-row swap so a partial failure doesn't lock the upload at
  fill-once + leave creators.voice_id NULL."
- **R4-S3** — `Number(process.env.X)` returns `0` for empty string,
  which `Number.isNaN` does NOT catch — the fail-closed pricing guard
  silently passes at $0. Fix: `Number.isFinite(rate) && rate > 0`.
  Apply to `CARTESIA_USD_PER_CHAR` and any other env-derived numeric.
- **R4-S4** — 24h rate limit on admin clone uploads (`3/day/admin`):
  count must exclude failed Cartesia attempts (rows where
  `cartesia_voice_id IS NULL`). Today's plan SELECTs all rows in the
  window; failed attempts shouldn't burn admin's daily quota. Update
  query: `WHERE admin_user_id=$1 AND created_at > now() - interval
  '24h' AND cartesia_voice_id IS NOT NULL`.
- **R4-S5** — `cogs_log.cost_usd` verified `numeric(10,6)` at
  [0020_cogs_log.sql:15] — max ~$9999.999999/row, ample for $6 worst-case
  turn. No migration needed. Test suite still asserts 6-decimal rendering
  per R3-S6 to catch any future column-type drift.
- **R4-S6** — "PCM s16le LE mono" — `s16le` already encodes
  little-endian; drop the redundant trailing "LE" everywhere in plan
  copy + code comments.
- **R4-S7** — Smoke-test 2s PCM-frame assertion is flaky on cold CI
  (cold Fly machine + cold Cartesia connect). Bump to **5s**. Phase 0
  observed 343ms TTFB on warm; cold-start budget is 3-4s.
- **R4-S8** — §A2 wording: "eager parallel open" is now eager **serial**
  (Gemini first, Cartesia second) per R3-C3. Update the §A2 prose to
  match. Done in this PR.
- **R4-S9** — File the post-YC GH issues NOW (in this PR's commit), not
  "later":
  - "Remove `enableOutputTranscription` flag" (R3-S8).
  - "Add `creators.voice_id` index when admin filter ships" (R2-M2).
  - "Cartesia voice deletion + retention policy" (out-of-scope above).
  - "Backpressure metric: ghost-session ratio" (R3-S1).
  - "Voice delete queue persistence audit" (R4-M3).
  Issue links written into `.claude_learnings.md` post-merge.
- **R4-S10** — MIME list TS↔SQL drift unit test: `voice-clone-mimes.ts`
  exports a `MIME_ALLOWLIST` array; a vitest case reads
  `supabase/migrations/20260427000003_voice_clone_uploads.sql` text and
  asserts every TS entry appears in the table CHECK literal. Catches
  drift if either side adds/removes a MIME without updating the other.

### §A2 wording fix (R4-S8)

- Client cutover that drops the ephemeral-Gemini path and consumes the
  proxy's Cartesia-bytes WS frames — owned by #3 (use-session-pipe.ts
  rewrite).
- Simli ingest of Cartesia frames — owned by #2.
- Checkpointed mid-turn Cartesia reconnect (Cartesia would re-bill the
  same context_id per Phase 0 cross-check). Idle-window auto-reconnect
  IS in scope — see R3-M2.
- Cartesia free-character monthly floor accounting — flag-tracked in env
  `CARTESIA_FREE_CHAR_FLOOR` for awareness; v1 doesn't model it in COGS
  (we just bill chars × rate; ledger reconciliation can come post-YC).
- Voice clone deletion + rotation flow — admin can upload new ones, old
  ones stay live in Cartesia. Clean-up post-YC.
