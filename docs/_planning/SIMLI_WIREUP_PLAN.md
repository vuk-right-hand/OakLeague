# Simli Full Wire-Up Plan (Feature #2)

**Goal:** Verifiably ship lipsynced creator-face video on `/s/[id]` from
the moment the user taps Ask. End-to-end: user speaks → Gemini transcribes
+ thinks → Cartesia synthesizes the creator's cloned voice → **Simli
renders the creator's face mouthing those exact words at <600ms p95
lipsync** → user sees + hears the creator answer back.

This is the moment the app goes from "voice chatbot with a poster" to
"talking to the actual person." Bar = consumer-app polish, not a working
demo. Ship behind a flag, flip live during the day.

**Out of scope:** voice architecture changes, schema, Tavus, premium-tier
avatar provider swap. Those are LOCKED per `DAYS_13_14_HANDOFF.md`.

**Revision history:** v1 wrong premise (Cartesia exists in proxy);
v2 corrected. v3 folded audits #1+#2. **v4 folds audit #3 (R3) — see
§13 for the full delta.** v4 adds a chunker inside the bridge,
multi-tab ticket reuse, drain-only old WS during rollover overlap,
per-session sample-rate, replica-deleted UX, voice_id env scoping,
GDPR erasure, dropped-frame + drift instrumentation, Cartesia-down
session-client state, plus a tightened Phase A2 / Phase E. Cartesia
+ Simli wired at `server/voice-proxy/index.js:606`; cutover is
client-side onto `/voice/spike-a`.

---

## 0. State of the world (verified, 2026-05-04)

The Simli scaffolding is mature; the proxy is mature. What's broken is
the production `/s/[id]` audio source path.

### What exists and works

| Component | File | State |
|---|---|---|
| Simli bridge (LiveKit transport) | `src/lib/avatar/simli-bridge.ts` | mature, error-mapped, track-renegotiation handled |
| Simli mint (server) | `src/lib/avatar/mint-simli.ts` | mature, COGS-audited |
| Simli compose token in session-open envelope | `src/app/api/sessions/open/route.ts:236-244` | shipping |
| Cartesia bridge in proxy | `server/voice-proxy/cartesia-bridge.js` | mature, pipecat-aligned |
| Proxy `audio_out` binary relay over WS | `server/voice-proxy/index.js:606` | shipping; Cartesia PCM bytes go to client |
| Voice ticket auth (single-use, UA-bound) | `voice_tickets` table + `index.js:86-104` | shipping (Spike-A path) |
| Lipsync-latency capture | `simli-bridge.ts:75-77` (t1→t3) | shipping; PostHog event `simli_lipsync_latency_ms` |

### What's actually broken (the bug Feature #2 closes)

The production `/s/[id]` page does **not** use the proxy. It opens a
direct browser→Gemini Live WS via `@google/genai`:

- `src/app/s/[id]/use-session-pipe.ts:226-232` — `client.live.connect(
  { model, config: { responseModalities: [Modality.AUDIO], … } })`.
- `:251-258` — Gemini's `inlineData.data` PCM bytes (24kHz, Gemini's
  output rate) are forwarded **directly** to `bridgeRef.current?.sendAudio`.

This is broken in **three** independent ways (R1-C2):

1. **Cloned voice is bypassed.** Cartesia never sees the transcript;
   user gets Gemini stock voice. **Sev-0 violation** of
   CLAUDE.md "Cloned voice everywhere."
2. **Sample-rate mismatch.** Gemini emits 24kHz; Simli requires
   16kHz ([Simli docs][simli-js]). 24k bytes interpreted as 16k = 1.5×
   speed playback + lipsync drift — exactly the symptom that audit #1
   flagged.
3. **Pipeline α' is bypassed.** `outputAudioTranscription` is not
   enabled, so the very mechanism CLAUDE.md mandates ("read transcript,
   discard audio") is inactive. The audio Google synthesized is the
   audio that ships.

**Implication (R1-C2):** nobody has actually heard `/s/[id]` produce
intelligible audio. The first task in this plan is to confirm by
recording what `/s/[id]` outputs today before we cut over — a 30-minute
diagnostic, not a redesign.

### Other gaps closed by this plan

4. **No visible video element** — bridge falls back to creating its own
   offscreen 1×1 video (`simli-bridge.ts:271-282`). UX shell needs a
   styled `<video>` ref wired to `videoRef`, sized to 9:16, with poster
   fallback + loading shimmer + error overlay.
5. **Lipsync latency is captured but not gated.** No dashboard, no
   alert, and the metric measured (t1→t3) isn't the user-perceived
   one (R1-M1 — see §3).
6. **No real-device verification** for the avatar path under live
   network conditions, lock-screen, low-power, call interrupt.
7. **Pipe-warm rule is silently violated on rollover** (R1-M5).
   `use-session-pipe.ts:373-376` calls `bridgeRef.current?.close()`
   inside the rollover effect and re-mints. CLAUDE.md: "Avatar pipe
   stays warm. Never tear down the WebRTC connection to the avatar
   provider mid-session." Inheriting this would re-introduce a
   handshake gap mid-session.

This plan closes 1–7.

---

## 1. Architectural cutover: client onto proxy WS

The Fly proxy already does the right thing (Gemini in, Cartesia out,
binary `audio_out` to client). The browser just needs to talk to it
instead of going direct to Gemini.

```
[browser mic worklet]
    │ binary PCM16 16k frames
    ▼
[Fly voice-proxy WS  /voice/spike-a]   ← existing path, no changes
    │
    ├──→ Gemini 3.1 Live (AUDIO + outputAudioTranscription)
    │       │ outputTranscription.text
    │       ▼
    └──→ Cartesia Sonic 3 (cloned voice)  → PCM16 (rate TBD §3)
            │
            ▼   binary frames over client WS
    [proxy → browser]
            │
            ▼  bridge.sendAudio(pcm16le16k)
    SimliBridge → LiveKit RTC → <video>/<audio> → user
```

The path is `/voice/spike-a` — name is historical; per
`DAYS_13_14_HANDOFF.md` the Spike-A scaffolding is the production proxy
path post-Days 8–12. Verify this in Phase A1; if a separate
production-only path is intended, clarify with Vuk before §B.

---

## 2. Auth + session attach: reuse `voice_tickets` with a `session_id` column (R1-C4, R2-C1, R2-C2)

Audit #1 was right that inventing HMAC reinvents what's there. The
proxy already validates a single-use UA-bound `voice_tickets` row at
WS open (`index.js:86-104`).

**Critical correction from audit #2 (R2-C1):** `/api/sessions/open`
calls the `session_open` RPC which inserts a row into `sessions`
guarded by the partial-unique index `sessions_one_active_per_user`.
The proxy's own `openSession()` at `voice-proxy/index.js:166-184`
**also** inserts a `sessions` row. As-is, `/s/[id]` cutover would hit
`23505` on the second insert and the WS would close `4002
session_already_active` on the first user tap.

**Fix the plan must require:**
- New migration `20260504_voice_tickets_session_id.sql` — add
  `session_id uuid NOT NULL REFERENCES sessions(id)` to `voice_tickets`,
  with CHECK that `session_id` belongs to `user_id`.
- `consumeTicket` (`voice-proxy/index.js:142-160`) returns the
  `session_id` alongside `user_id, creator_id`.
- Proxy replaces `openSession()` with an **attach** path: SELECT the
  existing `sessions` row by `(id, user_id, status='active')` and
  proceed; do NOT INSERT.
- **R4-C1 — single-WS-per-session enforcement.** The proxy already
  has a `wsRegistry` (`voice-proxy/index.js:78`). On each new attach,
  before registering: if registry has a live WS for the same
  `session_id`, close the older with `4002 session_already_active`
  + audit `cogs_log` row `voice_ws_evicted`. Without this, a
  takeover (R3-C2) re-mint with both tabs alive sends mic frames
  on TWO live WSs → double Gemini billing and undefined turn state.
- `/api/sessions/open` mints session row first, then the voice ticket
  pinned to that `session_id`. `mint-voice-ticket.ts` takes
  `(user_id, creator_id, session_id, ua_hash)`. **TTL = 120s**
  (R4-S — bumped from 60s to leave buffer for slow-LTE round-trip;
  still short enough to prevent hoarding).

**R3-C2 — multi-tab ticket replay.** Two tabs hitting
`/api/sessions/open`: Tab A mints session+ticket; Tab B's
`session_open` RPC hits `sessions_one_active_per_user` partial-unique
→ 23505. Today the route maps that to an error. Worse: if Tab A's WS
connect fails, Tab A's ticket sits unconsumed and Tab B is locked out
until the reaper.

**Fix:** `/api/sessions/open` catches 23505 → SELECT the existing
active session for the user → re-mint a fresh voice_ticket for THAT
session_id (and a new Simli compose token if the prior one is
near-expired) → return the same envelope shape as a fresh open. The
client can't tell the difference; the second tab takes over the live
session. Add an audit `cogs_log` row with operation
`sessions_open_takeover` (cost=0) for ops visibility.

**R3-M5 + R4-C2 — migration sequence (idempotent, replay-safe):**
voice_tickets are 60s-TTL single-use; "where derivable" backfill is
unnecessary — at most one user re-taps. Spell each step with
`pg_constraint` / `information_schema` lookups so re-runs are no-ops:

```sql
-- step 1: add column nullable (idempotent via IF NOT EXISTS)
ALTER TABLE voice_tickets ADD COLUMN IF NOT EXISTS session_id uuid;

-- step 2: nuke ALL existing rows (60s-TTL, single-use, costs at most
-- one re-tap per affected user). Avoids brittle backfill.
DELETE FROM voice_tickets;

-- step 3: FK (idempotent — drop-if-exists pattern not needed since
-- DELETE in step 2 left zero rows; a failed first run replays cleanly)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voice_tickets_session_id_fkey') THEN
    ALTER TABLE voice_tickets ADD CONSTRAINT voice_tickets_session_id_fkey
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;
  END IF;
END $$;

-- step 4: NOT NULL (safe after step 2)
ALTER TABLE voice_tickets ALTER COLUMN session_id SET NOT NULL;

-- step 5: CHECK belongs-to-user
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voice_tickets_session_user_match') THEN
    ALTER TABLE voice_tickets ADD CONSTRAINT voice_tickets_session_user_match
      CHECK (
        (SELECT user_id FROM sessions WHERE id = session_id) = user_id
      ) NOT VALID;
    -- NOT VALID: don't re-check the (now empty) table; new inserts validate.
  END IF;
END $$;
```

Apply with `supabase migration repair` semantics in mind: each step
re-runnable.

**§9 "no schema migrations" was wrong** (R2-C2). Correct: ONE migration
to add `voice_tickets.session_id`, no other schema change.

**Other auth notes:**
- The voice-ticket mint route is currently admin-gated. **Decision
  locked:** pre-mint via service-role from `/api/sessions/open`
  (avoids the second client RTT — R2-M6). The admin route stays as-is
  for the spike-a harness; non-admin callers don't hit it.
- Envelope adds `voice_ticket: string`. Browser opens
  `wss://${NEXT_PUBLIC_VOICE_PROXY_URL}/voice/spike-a?ticket=…`.
- `gemini.token` in the envelope **stays** during the flag-on/off
  window (R2-C3) — flipping the flag must not break the off path.
  The cleanup PR after 24h-green deletes the field AND the
  `@google/genai` import together.

---

## 3. Sample-rate handling: Cartesia 16k output (verify, fall back to worklet)

Cartesia supports 16kHz raw PCM output natively
([Cartesia sample_rate docs][cartesia-sr]). `cartesia-bridge.js:56`
defaults to 24000; flip the proxy default to 16000.

**Concern from audit #1 (R1-C5):** the COGS audio-seconds math is
`audioBytes / (sampleRate * 2)` — rate-independent for seconds, so the
4000-char kill-switch ceiling derivation in CLAUDE.md ("R4-C2 load-bearing")
is **unaffected**. Verify by running existing `cogs-rpc.test.js`
unchanged after the rate flip; if green, math holds. The
audio-bytes-per-row metadata changes, but no aggregator gates on it.

**Fallback:** if subjective listening at 16k regresses (unlikely for
speech-only content), keep proxy at 24k and add browser-side
24→16 resampler worklet:
- `/worklets/pcm-resample.js` — anti-alias FIR low-pass (~16-tap @
  cutoff 7.5kHz, audit #1 small-fry called this out — naive
  every-Nth-sample is forbidden) then 2:3 decimation.
- Out: 6000-byte cadence (Simli's preferred chunk @ 16k = 187.5ms,
  [Simli docs][simli-js]).
- Unit test: 1kHz sine in @24k → assert 1kHz @16k with <0.5dB error.

**Default = Cartesia 16k (option A); worklet (option B) is contingency.**

**R3-C1 — chunker is mandatory regardless of option A/B.** Cartesia
emits arbitrary-sized PCM frames (its WS chunking is timing-driven,
not byte-aligned). Simli wants ~6000-byte / 187.5ms @16k buffers
(`simli-bridge.ts:17`). Mismatched cadence = drift indistinguishable
from the original bug. Add a ring-buffer chunker **inside
`simli-bridge.sendAudio`**:
- Append incoming bytes to internal `Uint8Array` ring (capacity 64KB
  matches Simli's documented max).
- Flush in 6000-byte chunks until <6000 remain; carry remainder for
  next call.
- On `cancel()` / `close()`: drop the ring (do NOT flush partial — leaks
  prior turn into next).
- Unit test: feed 1000 bytes then 5500 bytes → assert exactly one
  6000-byte flush + 500 bytes carried.

**R3-M1 — sample rate is per-session, not a global flip.**
`cartesia-bridge.js:82` constructor already takes `sampleRate`; the
plan's "flip DEFAULT_SAMPLE_RATE=16000" was global, which would silently
break the spike-a harness, Phase 0 fixtures, and the Cartesia-leg COGS
tests. Instead: leave `DEFAULT_SAMPLE_RATE=24000`; the proxy's
session-open path constructs the bridge with `sampleRate: 16000`
explicitly when `useCartesia && simliPath`. Spike-a harness keeps 24k.

**Phase A2 must include a real-API roundtrip test (R2-C5):** Cartesia
Sonic-3 raw `pcm_s16le` at 16kHz has not been verified in our codebase.
Subjective listen alone is insufficient — add a fixture under
`RUN_REAL_API_TESTS=1` that synthesizes a known phrase, runs forced
duration alignment (±10% of expected speech-rate), AND a 1kHz sine
roundtrip if Cartesia accepts it. If 16k regresses, ship option B.

**Backpressure caps must be re-sized (R2-M3).** `voice-proxy/index.js:71`
has `USER_WS_BACKPRESSURE_MAX_BYTES=2MB` sized for 24kHz (~42s buffer);
at 16kHz the same cap is ~64s — slow-client problems hide longer.
Re-pin to ~1.4 MB hard / 700 KB warn for the same seconds-of-audio
invariant.

---

## 4. Pipe-warm rollover (R1-M5)

CLAUDE.md is explicit: avatar pipe stays warm across the 15-min Gemini
rollover. Today `use-session-pipe.ts:373-376` closes both Gemini AND
Simli on rollover and re-opens both.

**Fix:** rollover swaps only the proxy WS (which transparently
swaps Gemini under it). Simli compose token's `maxSessionLength`
already clamps to 600s in `mint-simli.ts:75`, but Simli session can run
longer than Gemini's 15min.

**However (R2-M1):** the proxy's Cartesia bridge closes when the
client WS closes (`voice-proxy/index.js:388-401`'s teardown path).
A naive "close old WS, open new WS" produces a TTS warmup gap of a few
hundred ms mid-conversation — silent to the user but disturbing UX.

**Mitigation:** *overlap the swap.* Browser opens the new proxy WS
**before** closing the old one. Drain the in-flight turn on the old
WS, then close it. The Simli pipe never sees a gap because new audio
frames flow from the new WS directly. Spec this in `proxy-client.ts`
as `swapTo(newTicket): Promise<void>`.

**R3-C3 — overlap router rules (NON-NEGOTIABLE):**
- **Mic frames go to the NEW WS only**, from the moment new WS opens.
  Sending to both = double Gemini cost.
- Old WS is **read-only-drain** for ≤2s — no `turn_start` or audio
  send; only its in-flight `audio_out` frames are forwarded to
  `bridge.sendAudio`. Hard timeout at 2s → force-close.
- `cancel` from the user during overlap → cancel BOTH WSs (route
  `bridge.cancel()` on first; cancel ctrl message on both proxies).
- Write a single `cogs_log` row per overlap with operation
  `voice_rollover_overlap`, units = overlap_ms, cost = 0. Lets ops
  see how often we double-billed Gemini and bound the blast radius.

Specifically:
- `/api/sessions/rollover` mints **only** a new voice_ticket (and a
  new Simli token if approaching Simli's TTL, else reuse).
- Browser closes old proxy WS, opens new proxy WS with new ticket.
- `bridgeRef.current` is **untouched**.
- If Simli token nears expiry, browser does a clean swap *only then*:
  `bridge.close()` + new `createSimliBridge()` — but treat this as a
  rare event, not the default path.

Verify Simli compose token actual TTL behavior in Phase A1 (Simli docs
say "tokens scoped to maxSessionLength" but the binding is fuzzy).

---

## 5. UX shell

`src/app/s/[id]/session-client.tsx`:

- Full-bleed `<video ref={videoRef} playsInline className="absolute
  inset-0 h-full w-full object-cover">` — 9:16 cover. Confirm Simli's
  emitted track aspect ratio in Phase A1 (R1-S1) so we don't
  crop the mouth.
- Hidden-but-present `<audio ref={audioRef}>` for Simli's audio track.
  Position offscreen, **don't** use `hidden` attr (R1-S3 — iOS pauses
  hidden audio after backgrounding):
  `style={{ position: 'fixed', top: '-9999px', width: 1, height: 1 }}`.
- States: `pre-ready` (poster) → `ready` (live face) →
  `listening`/`speaking`/`reconnecting` → `ended`.
- Loading shimmer with 600ms grace before showing "Connecting…" so
  the fast happy path is silent.
- Poster: SSR-fetch `creators.avatar_url` (existing column).

### iOS autoplay activation (R1-M4)

Critical iOS PWA gotcha: between mic-tap and `onVideoTrack` firing
there's a Simli mint round-trip (~hundreds of ms). User activation may
expire by the time we call `videoEl.play()`.

**Fix:** at mic-tap (synchronous in user-activation), prime the
`<video>` with a 1-frame data-URL muted source and call `play()` to
acquire the activation. When `onVideoTrack` fires, swap `srcObject`
without re-calling `play()` — autoplay continues since the element is
already playing.

**R2-C4 — track rebinds outlive the activation.** `simli-bridge.ts:106`
re-binds `currentVideoTrack` on every LiveKit ICE restart / WiFi↔LTE
handoff / simulcast layer change. Each rebind on iOS WebKit re-evaluates
autoplay against the *current* user activation, which is gone 90s in.
- Hold a "trampoline" gesture: when reconnect overlay shows, the user
  tap on it counts as fresh activation.
- For silent rebinds (no overlay), `simli-bridge.ts` itself must call
  `videoEl.play()` inside the rebind — wrapped in try/catch since it
  may reject; on rejection, surface to consumer for the overlay.
- **R3-M2 — `play()` alone won't retrigger autoplay on iOS** for an
  element whose `srcObject` is the same MediaStream. On overlay-tap
  recovery: `videoEl.srcObject = null; videoEl.srcObject = stream;
  await videoEl.play();` — full re-bind of the source.
- **R4-M5 — `play()` rejection needs a reducer state.** When the
  silent rebind `videoEl.play()` rejects (no fresh activation), the
  consumer has no signal. Add reducer transition `video_autoplay_lost`
  + UX row §11: "Avatar paused — tap to resume" overlay (provides the
  fresh activation). State distinct from `audio_context_failed` so
  ops can tell which media element lost autoplay.
- Add this case to Phase E: "force ICE restart by toggling network,
  confirm video doesn't go black" + the airplane-mode-toggle test
  below (R4-YC-Day).

### Reconnect path (R1-M7, R2-M7)

`audio_context_failed` reconnect overlay must NOT silently retry against
a dead WS. UX: "Tap to reconnect."

**Don't blank-redirect to the cold hook page (R2-M7).** If the failure
happened mid-first-turn, the user has zero indication their question
was even sent. Instead:
- Stash the last user transcript in sessionStorage on each
  `mic_stopped`.
- Reconnect overlay shows: "*Your question:* '…'  — connection lost.
  [Try again] / [Back to feed]"
- "Try again" mints a fresh session (window.location.href to
  `/s/new?hook=${hookId}&resume=${transcriptId}`).
- "Back to feed" → `window.location.href = /h/${hookId}`.

### End-of-session graceful close (ordering matters)

Per `avatar-bridge.ts:21-39`:
1. mediaRecorder.stop() (if recording active)
2. compositor.stop()
3. mixer.disconnectAvatar()
4. proxy WS close with `cancel`
5. **bridge.close()** — releases Simli replica slot promptly (saves
   ghost-billed time)
6. mixer.close()
7. releaseStream() on mic
8. audioContext.close()
9. POST /api/sessions/close

---

## 6. Observability + alerting

### Lipsync latency: split into two metrics (R1-M1)

The bridge metric `simli_lipsync_latency_ms` (t1=first sendAudio →
t3=first video frame) is a **Simli-health** metric.

The **user-perceived** metric is t0 (mic-tap-release / VAD-end) → t3
(first frame of Simli speaking).

**R2-M5 fix:** t0 is **mic-tap-release**, NOT `gemini_turn_complete`.
Turn-complete is server-side ("Gemini decided it's done generating") —
which is *after* the entire model-thinking window. Measuring from
turn-complete tracks Cartesia+Simli only and hides Gemini latency
regressions.

**R3-M7 lock:** `/s/[id]` uses Gemini server-VAD
(`use-session-pipe.ts:233`), so user "stopped talking" is a server
signal, not a client mic-stop. Lock the metric to **client-side VAD-end
inferred from `serverContent.turnComplete` arrival's *first* sibling-
free silence window** is too fragile. Cleaner: lock to **mic-tap-release
on the press-and-hold UI** (`mic_stopped` reducer transition) since the
v1 UX is press-and-hold, not free-form VAD. Document the contract in
`use-session-pipe.ts` JSDoc and add a unit test asserting the event is
fired exactly once per turn from `mic_stopped`. If we move to
hands-free VAD post-YC, redefine then.

| Event | Source | Used for |
|---|---|---|
| `simli_lipsync_latency_ms` | bridge t1→t3 | Simli-upstream health |
| `user_perceived_response_ms` | proxy turn-end → first audio | UX quality |

### Dashboards + alerts

- Admin tile (new `/admin/voice-health/page.tsx`): p50/p95/p99 of both
  metrics over rolling 1h.
- Sentry alert (R4-M7 — pending §12 Q4 decision: source-controlled
  `sentry/alerts/lipsync.json` + `sentry-cli` in CI **preferred**;
  fall back to UI-configured + tech-debt log if YC time forces it):
  fire when `simli_lipsync_latency_ms` p95 > 1200ms over 10min AND
  total session count >= 10.
- **Two-metric clarification (R4-S):** `simli_lipsync_latency_ms`
  (Simli health, t1→t3) feeds the **1200ms regression alert**.
  `user_perceived_response_ms` (UX, mic-stop→t3) feeds the **800ms
  ship gate** in Phase E. Different metrics, different thresholds —
  document on the dashboard tile so reviewers don't conflate.
- Bridge error funnel: weekly digest of `avatar_<code>` Sentry events.
- Daily Simli COGS budget alert at 150% of forecasted spend — same
  kill-switch shape as voice (already wired in mint-simli audit row).

**R3-M3 — Simli minute-level reconciliation.** Today Simli COGS is a
$0 mint-time row only; nothing reconciles actual minutes consumed.
Lid-close mid-session with no clean teardown = ghost-billed minutes
in Simli's books that we never see, kill-switch math wrong both
directions. Add:
- `bridge.close()` writes a `cogs_log` row with operation
  `simli.video_minutes_bridge_close` and `units = (Date.now() -
  openedAtMs) / 60000` using the QUOTED_AT Trinity-1 rate from a new
  `SIMLI_USD_PER_MIN` env (parallel to Cartesia's pricing env).
- Reaper's `reap_stale_sessions` writes
  `simli.video_minutes_reaper` using `last_heartbeat_at - started_at`.
- **R4-M3 — distinct operation strings** so a rollover (which
  generates a bridge.close + a fresh open) cannot be silently
  double-summed with a later reaper row. Aggregator MUST sum each op
  separately and pick `MAX(bridge_close, reaper)` per session, never
  add. Test: rollover sequence yields 2 bridge_close rows + 0 reaper
  rows; aggregator returns max of the two for kill-switch math.
- Daily admin tile: "Simli minutes (mint-implied vs reconciled)" drift
  metric. Sustained drift = Simli-side billing investigation.

**R3-M4 — Replica failure-mode UX.** The bridge maps
`replica_not_found` (404) and `replica_not_ready` (409) to distinct
error codes. Today both surface as generic "Avatar warming up." Split:
- `replica_not_ready` (409, training/warming): "Avatar warming up,
  10s…" + auto-retry once with backoff. Common case after a fresh
  approval.
- `replica_not_found` (404, deleted/GDPR): "This creator's avatar is
  unavailable" + admin Sentry breadcrumb. Permanent — auto-retry
  pointless.
- New admin tile `/admin/creators/[id]/health`: replica status
  (`creators.simli_face_id` set + last successful mint timestamp +
  last `replica_not_ready` timestamp). One-click "force-retrain" CTA
  → admin RPC enqueues a brain-training job (R3-Missing-2 lands here).

---

## 7. Feature flag (R1-C3)

Cutover ships behind `NEXT_PUBLIC_VOICE_PROXY_PATH=1` read by
`use-session-pipe.ts`:
- Flag off → existing direct-Gemini path (broken, but stable).
- Flag on → new proxy path.

Flip during business hours, watch Sentry + the lipsync dashboard for
30min. Rollback = flip env var + redeploy (~2min). The current path is
broken, but it's *predictably* broken; the new path could fail in new
ways and we want a one-flag exit during the YC window.

After 24h green at flag-on, delete the old code path in a follow-up PR.
Pre-deadline cleanup is OK — the flag itself is the safety net.

**R3-M6 — rollback sequence (NOT just "flip env + redeploy").** The
naive sequence leaves a 90s split-brain window (existing WSs from old
build still running against proxy that may have rotated, plus a
proxy-redeploy WS-reject window during Fly's rolling deploy):
1. Flip `NEXT_PUBLIC_VOICE_PROXY_PATH=0` on Vercel.
2. Trigger Vercel redeploy (~90s build + propagation). New page loads
   immediately use direct-Gemini path; existing tabs keep proxy WS.
3. Existing proxy-WS sessions naturally end at user-tap-close OR at
   Gemini's 15-min cap; reaper cleans the rest at 60s post-heartbeat.
4. **Do NOT** redeploy the Fly proxy during a rollback (that drops
   in-flight sessions hard, doubles user-visible failures). The proxy
   stays up; the client just stops opening new WSs against it.
5. Watch Sentry for 30min post-flip; if the issue was proxy-side, the
   rollback's success is measured by absence-of-new-errors, not
   proxy-quietness (proxy stays loaded with old sessions).
Document this exact sequence in `docs/RUNBOOKS/voice-proxy-rollback.md`
before flag-on day.

---

## 8. Phased rollout

### Phase A — Diagnostic + decisions (≤4h)

A1. **Record `/s/[id]` today.** Open a session as Vuk, talk, capture
the audio. **Capture method (R2-M2):** force `setLocalPlayback(true)`
on the bridge so the `<audio>` element is audible (`simli-bridge.ts:
118-120`); attach a `MediaRecorder` to a `MediaStream` constructed
from `bridgeRef.current.getCurrentTracks().audio`. Browser-tab audio
recording will not work if the recording-controller path is silencing
the element. Confirm: is it Gemini stock voice (expected per code read),
is it sped-up 1.5×, or does it not produce intelligible audio at all?
This quantifies the bug.

**R3-C4 — diagnostic must NOT leak to production.** Gate the forced
`setLocalPlayback(true)` behind `NEXT_PUBLIC_VOICE_DIAGNOSTIC=1`
**and** a hard-coded `if (process.env.NODE_ENV !== 'production')`
guard. Reason: if it ships, avatar audio feeds back into the mic
worklet on every session (echo-loop, broken barge-in). Add a checkbox
to the v4 PR review checklist: "DIAGNOSTIC env removed before merge."

**R4-M4 — iOS Safari PWA can't `MediaRecorder` a remote LiveKit
track.** Safari throws `NotSupportedError` on
`new MediaRecorder(remoteStream)`. The diagnostic as written fails on
the platform we most need data from. **Two options, pick one:**
- (a) **Capture proxy-side**: add a 30s recording mode to the proxy
  (env-flagged, env-flagged again) that Tee's `audio_out` bytes to
  a Supabase Storage object during the diagnostic window. Cleaner —
  bypasses browser limitations entirely.
- (b) **Scope A1 to desktop Chrome only**, accept that we cannot
  diagnose the iOS path with this method, and rely on Phase E real-
  device runs to confirm the cutover works on iOS even if we can't
  characterize the *current* iOS bug.

**Pick (b)** for speed; (a) is a 4h detour that doesn't change the
cutover plan. The current iOS `/s/[id]` bug is whatever it is — Phase
E will confirm the new path fixes it regardless of root cause.

A2. **Confirm Cartesia 16k output works.** Set
`cartesia-bridge.js:56 DEFAULT_SAMPLE_RATE=16000`, run
`/admin/spike-a/proxy` harness end-to-end against Vuk's voice_id.
Subjective listen + assert `cogs-rpc.test.js` still green.

A3. **(deleted — locked in §2: pre-mint via service-role.)**

A4. **(deleted — `voice-proxy/index.js:326` hardcodes
`/voice/spike-a`; this is the production path.)**

A5. **Confirm Simli compose-token TTL behavior** under our typical
session length. Output: ROLLOVER_NEEDS_NEW_SIMLI_TOKEN: yes/no/sometimes.

A6. **Verify Cartesia Phase-0 fixture still works at 16k** —
`scripts/cartesia-phase0-rerun.mjs` (referenced by
`cartesia-bridge.js` header) is pinned at 24k; re-pin or version it.

### Phase B — Client cutover (1 day)

B1. `src/lib/voice/proxy-client.ts` — typed WS client (open, sendBinary,
sendControl, onAudioOut, onError, close). Mirrors the existing
spike-a/proxy/proxy-client.tsx surface but as a lib, not a page.

B2. `src/lib/voice/mint-voice-ticket.ts` — server-only ticket mint.

B3. `/api/sessions/open` — add ticket to envelope, **delete**
`gemini.token` field.

B4. `use-session-pipe.ts` — flag-gated cutover:
- Remove `GoogleGenAI` import + direct Gemini path under the new flag.
- Mic worklet writes binary frames to proxy WS.
- `audio_out` frames go straight to `bridge.sendAudio` (or through
  resampler in option B).
- `cancel` control message replaces `serverContent.interrupted` handling.
- Rollover swaps proxy WS only, leaves bridge alone (R1-M5).

B5. Auditor pass before merge.

### Phase C — UX shell (1 day)

C1. `session-client.tsx` — full-bleed video, states, poster, mic CTA
states. iOS autoplay-activation prime. Reconnect overlay redirects to
hook page.

C2. `page.tsx` — SSR-fetch `creators.avatar_url`.

### Phase D — Observability (4h)

D1. `simli_lipsync_latency_ms` already fires; add
`user_perceived_response_ms`.

D2. Admin tile `/admin/voice-health/page.tsx`.

D3. Sentry alert config (in `instrumentation.ts`).

D4. PostHog saved view + Slack/email digest cron (existing
infrastructure if available, else manual weekly review for first 2w).

### Phase E — Real-device matrix (4h, pre-flag-on gate)

Devices × networks:

| Device | Network | Pass criteria |
|---|---|---|
| Desktop Chrome | WiFi | Live face within 2s of mic tap, p95 latency <800ms |
| Desktop Safari | WiFi | Same |
| iPhone 11 PWA installed | WiFi | Same |
| iPhone 11 PWA installed | LTE | Same; WiFi↔LTE handoff doesn't black-frame |
| Pixel 7 Pro PWA | LTE | Same |
| Pixel 7 Pro PWA | WiFi | Same (R3-S — Android WiFi was missing) |

**R4-YC-Day — black-square watcher + airplane-mode test (NON-OPTIONAL
PRE-FLAG-ON GATE).** The most-likely demo-day failure is iOS PWA
autoplay across LTE↔WiFi handoff during Simli mint: prime / rebind
play / full-rebind each silently no-op on rejection, so "video has a
track but is paused" goes uncaught.
- **Watcher**: `session-client.tsx` runs a 1Hz check —
  `if (videoEl.paused && videoEl.srcObject) timeAccumulator += 1000;
  if (timeAccumulator >= 2000) dispatch(video_autoplay_lost);` — reset
  on `playing` event. PostHog event `simli_video_paused_with_track`
  fires with elapsed-ms.
- **Test**: in Phase E, on iPhone 11 PWA, force airplane-mode toggle
  mid-session (kill network for 3s, restore). Confirm: video resumes
  within 5s; if not, `video_autoplay_lost` UX shows; tap-to-resume
  works first try.

This is the test that breaks demo day if missed.

Per-device **failure-mode tests** (R1-M6):
- Lock screen 30s + 2min → unlock → live face still streams.
- Backgrounding for 60s → return → mic still works.
- Incoming-call interrupt mid-session (iOS) → after dismiss, session
  recovers or gracefully closes (no orphan COGS).
- Low-power mode (Pixel + iPhone) → audio doesn't underrun, lipsync
  doesn't drift.

For YC-demo MVP: **desktop Chrome + iPhone 11 WiFi MUST pass**. Other
cells: pass-or-document, ship anyway.

---

## 9. Files touched (canonical list)

| File | Change |
|---|---|
| `server/voice-proxy/cartesia-bridge.js` | `DEFAULT_SAMPLE_RATE = 16000` (option A; verify Phase A2). |
| `src/lib/voice/mint-voice-ticket.ts` | NEW — server-only ticket mint. |
| `src/app/api/voice/ticket/route.ts` (or extend existing) | Widen for non-admin caller (Phase A3). |
| `src/app/api/sessions/open/route.ts` | Add `voice_ticket`, delete `gemini.token`. |
| `src/app/api/sessions/rollover/route.ts` | Mirror — ticket only, gemini server-side. |
| `src/app/s/[id]/use-session-pipe.ts` | Flag-gated cutover; preserve bridge across rollover. |
| `src/app/s/[id]/session-client.tsx` | UX shell. |
| `src/app/s/[id]/page.tsx` | SSR `creators.avatar_url`. |
| `src/lib/admin/voice-health-aggregations.ts` | NEW. |
| `src/app/admin/voice-health/page.tsx` | NEW. |
| `supabase/migrations/20260504_voice_tickets_session_id.sql` | NEW — `session_id` FK on voice_tickets, sequenced per R3-M5. |
| `supabase/migrations/20260504_creators_voice_id_dev.sql` | NEW — `voice_id_dev` column for DEV/PROD scoping (R3-Missing-1). |
| `supabase/migrations/20260504_creator_erasure_queue.sql` | NEW — GDPR queue (R3-Missing-3). |
| `server/voice-proxy/index.js` | Replace `openSession()` insert with attach; re-size backpressure caps; pass `sampleRate:16000` per session for simli path. |
| `server/voice-proxy/voice-delete-worker.js` | Extend to drain Simli `DELETE /faces/:id` from `creator_erasure_queue` (R3-Missing-3). |
| `src/lib/avatar/simli-bridge.ts` | Add ring-buffer chunker (R3-C1); `getStats()` 5s poll → `onVideoStats` (R3-Missing-4); rebind `play()` retry (R2-C4); full re-bind on overlay tap (R3-M2); `bridge.close()` writes minute-billed cogs row (R3-M3). |
| `src/lib/voice/proxy-client.ts` | NEW — typed proxy WS client with `swapTo(newTicket)` overlap (R3-C3). |
| `src/app/api/sessions/open/route.ts` | 23505 → re-mint takeover (R3-C2); env-scoped voice_id read (R3-Missing-1). |
| `src/app/api/admin/voice-clone/route.ts` | Env-scoped voice_id write (R3-Missing-1). |
| `src/app/api/admin/simli-retrain/route.ts` | NEW (R3-Missing-2). |
| `src/app/admin/creators/[id]/health/page.tsx` | NEW — replica/voice health + force-retrain CTAs (R3-M4 + R3-Missing-2). |
| `docs/RUNBOOKS/voice-proxy-rollback.md` | NEW — flag-flip sequence (R3-M6). |
| Sentry alert config | In Sentry web UI or `sentry/alerts/lipsync.json` (NOT instrumentation.ts). |
| `(worklets) /worklets/pcm-resample.js` | ONLY if option A regresses. |

**Three** schema migrations (R3 expanded scope):
- `voice_tickets.session_id` FK (R2-C2 + R3-M5 sequence).
- `creators.voice_id_dev` column (R3-Missing-1).
- `creator_erasure_queue` table (R3-Missing-3).

---

## 10. Tests

- Unit: `proxy-client.ts` (open/close/reconnect/cancel/audio_out routing,
  `swapTo` overlap with mic-route invariant).
- Unit: `mint-voice-ticket.ts` roundtrip.
- Unit: ring-buffer chunker (R3-C1) — feed irregular sizes, assert
  6000-byte cadence + cancel-drops-remainder.
- Unit: 23505 takeover (R3-C2) — second `/api/sessions/open` call
  returns same envelope shape with new ticket.
- Unit: `mic_stopped` → `user_perceived_response_ms` fires once per
  turn (R3-M7).
- Unit: resampler — only if option B fires (32-tap min).
- Integration (real-API gated, `RUN_REAL_API_TESTS=1`): single fixture
  WAV → proxy (Cartesia 16k) → forced-alignment duration ±10% (R2-C5)
  → assert `bridge.sendAudio` called with PCM16 16k buffers totaling
  sane duration.
- Migration test: voice_tickets sequence runs idempotently on a copy
  of staging.
- Manual matrix from §Phase E.

---

## 11. Failure modes + responses

| Failure | Surface | UX |
|---|---|---|
| Simli mint 4xx | session-open 503 | "Avatar warming up — try again" + auto-retry with backoff |
| Bridge `connect_timeout` | fatal_error | Reconnect overlay → redirect to hook page |
| Bridge `rtc_ice_failed` mid-session | fatal_error | Same |
| Lipsync p95 >2s sustained | Sentry alert | No UX change (ops signal) |
| Cartesia 16k regression | proxy boot | Fall back to option B (browser worklet) |
| iOS PWA AudioContext suspended | `audio_context_failed` | "Tap to reconnect" → redirect to hook page |
| iOS `<video>` autoplay blocked | autoplay-prime check | Mic-tap path re-primes before swap |
| Proxy WS dropped | new `ws_closed` reducer state | Reconnect overlay |
| Voice ticket mint widening fails | session-open 500 | "Service unavailable" — log + Sentry; flag-off path still works |
| Simli compose-token expired mid-session, free tier (R3-S) | bridge `session_ttl_expired` | "Time's up — back to feed in 3s" + auto-redirect to hook page; surface ms-remaining in dev tools for debugging |
| Cartesia down mid-session (close 4011 `tts_reconnecting`) | session-client `cartesia_reconnecting` state (R3-Missing-6) | Avatar stays visible muted; banner "Voice catching up…"; auto-resume on `tts_reconnected`; hard-fail to reconnect overlay after 5s |
| Replica deleted (404 `replica_not_found`, GDPR or admin action) | bridge `replica_not_found` (R3-M4) | "This creator's avatar is unavailable" — no retry; back to feed |

---

## 12. Open questions for Vuk

(R4-M1 + R4-M2: Q1 and Q3 deleted — plan body locks them.)

1. `/admin/voice-health` as a new page, or a tab on the existing
   `/admin/cogs`?
2. Acceptable to flip the flag live during business hours, or do you
   want a staged rollout (5% → 25% → 100%)?
3. R3-Missing-4/M3/M4/Missing-2 all anchor on `/admin/creators/[id]/health`
   — confirm OK to merge them as one page with three sections (replica
   health, voice-id status, force-retrain CTA), not three pages.
4. Sentry alerts (R4-M7): commit `sentry/alerts/lipsync.json` + add
   `sentry-cli apply` to CI now, OR ship configured-in-UI for v1 + log
   as tech-debt for week-2 cleanup?

---

## 12a. Missing-entirely items from audit #3 (now in scope)

These are not nice-to-haves; each is a real production hole audit #3
surfaced. All folded into the file table §9 and the relevant phases.

### 12a.1 — DEV vs PROD voice_id scoping (R3-Missing-1 + R4-M6)

`creators.voice_id` is a single column. First local-dev clone of a
creator's voice on `vukpjescic@gmail.com` → push → **prod voice_id is
nuked** with the dev row. Sev-1 the day a second creator onboards.

**Fix (5-min schema change):** add `creators.voice_id_dev TEXT NULL`
+ `creators.voice_id_preview TEXT NULL`, gate writes by **`VERCEL_ENV`**
in `/api/admin/voice-clone`, and read the env-appropriate column in
`/api/sessions/open` voice-trained gate (`route.ts:110`). Backfill:
copy current `voice_id` into whichever column matches the env it was
minted in (admins know). Migration:
`20260504_creators_voice_id_env_scoped.sql`.

**R4-M6 — `NODE_ENV` is wrong gate; Vercel preview deploys run as
`NODE_ENV=production`.** A preview-branch voice-clone test would
overwrite the prod creator's voice_id. Use `process.env.VERCEL_ENV`
(`production` | `preview` | `development`) — three columns:
`voice_id` (production), `voice_id_preview`, `voice_id_dev`. Locally
without VERCEL_ENV set, default to `development`.

### 12a.2 — Admin "force-retrain creator" flow (R3-Missing-2)

Will happen during YC week ("Vuk's voice clone broke, fix it now").
Today there's no admin RPC. Add `/admin/creators/[id]/health` page
(R3-M4 anchor) with two CTAs:
- "Re-clone voice" → POSTs to existing `/api/admin/voice-clone` with
  `force=true` (bypass the 3/24h success cap via existing
  `VOICE_CLONE_RATE_LIMIT_BYPASS` env list per CLAUDE.md).
- "Re-train Simli replica" → new `/api/admin/simli-retrain` server
  action that posts to Simli's compose-replica endpoint with the
  creator's stored source frame.
Both write `cogs_log` audit rows.

### 12a.3 — GDPR data-erasure for Simli + Cartesia on creator delete (R3-Missing-3 + R4-C3)

Sev-1 for any EU traffic. Today `creator_delete` (admin RPC) sets
`creators.deleted_at` but leaves the Simli replica + Cartesia voice
clone live in those vendors' systems → 30-day SAR violation.

**Fix:** new `creator_erasure_queue` table (creator_id, simli_face_id,
cartesia_voice_id, enqueued_at, processed_at NULL). `creator_delete`
RPC enqueues a row. Reuse the existing `voice_delete_worker.js`
infrastructure (`server/voice-proxy/voice-delete-worker.js`) — extend
to drain Simli `DELETE /faces/:id` calls in addition to Cartesia
`DELETE /voices/:id`. Worker writes processed_at on success;
`SELECT * FROM creator_erasure_queue WHERE processed_at IS NULL AND
enqueued_at < now() - interval '7 days'` is a daily Sentry alert.
Migration: `20260504_creator_erasure_queue.sql`.

**R4-C3 — race vs in-flight session.** Worker DELETE-ing the Simli
replica while a live session is mid-frame surfaces as
`replica_not_found` mid-conversation (worse: the bridge can't tell
this from "creator never existed" → wrong UX). Force-retrain has the
same race. Two locks:
- **Worker query gate:** `WHERE NOT EXISTS (SELECT 1 FROM sessions
  WHERE creator_id = q.creator_id AND ended_at IS NULL)`. Worker skips
  rows with active sessions; retries 60s later. Guaranteed forward
  progress because session TTL is bounded (15min Gemini cap).
- **Force-retrain RPC:** acquires
  `pg_advisory_xact_lock(hashtext('creator_retrain:' || creator_id))`
  AND `RAISE EXCEPTION 'creator_has_active_session'` if any
  `sessions.ended_at IS NULL` for that creator. Admin UI surfaces
  the error with a "kick active sessions" CTA that calls the
  existing `admin_force_close_session` RPC per creator.

### 12a.4 — Video-frame backpressure / dropped-frame instrumentation (R3-Missing-4)

LiveKit (Simli's transport) exposes an RTCPeerConnection `getStats()`
API — `framesDropped`, `framesReceived`, `jitterBufferDelay` per
inbound video track. Without this, "the avatar froze for 4s" is
unmeasurable.
- `simli-bridge.ts` opens a 5s-cadence `getStats()` poll on the
  internal `RTCPeerConnection`. Fires `onVideoStats(stats)` to
  consumer.
- `use-session-pipe.ts` accumulates and flushes a PostHog event
  `simli_video_stats` every 30s with rolling p50/p95 of
  `framesDropped / framesReceived` ratio.
- Admin tile (R3-Missing-4 + R3-M4 share the same page): drop ratio
  per-creator over 7d. >2% sustained = call Simli support.

### 12a.5 — Audio drift monitor (R3-Missing-5)

Cartesia + Simli have independent clocks. Long sessions drift.
`use-session-pipe.ts` already has `audio_chunk` events; add
sample-count + arrival-time accumulation. Compute
`(samples_received / 16000) - (wall_clock_elapsed_s)`; flush as
`simli_clock_drift_ms` PostHog event every 60s. **Drift > 400ms** =
audio-out-of-sync alert (R4-S — raised from 200ms because that was
below Cartesia's own 187.5ms chunk cadence; 400ms = 2× chunk and is
unambiguously real drift).

### 12a.6 — Cartesia-down session-client state (R3-Missing-6)

Proxy already closes WS with `4011 tts_reconnecting` per CLAUDE.md;
session-client today has no state for it. Add to the reducer:
`cartesia_reconnecting` (subset of `speaking`). UX per §11 row.

---

## 13. Audit revisions log (for traceability)

- **R1-C1 (premise wrong):** v1 claimed `cartesia-bridge.js` didn't
  exist. Verified false; bridge is shipping at
  `server/voice-proxy/cartesia-bridge.js` with `audio_out` binary frames
  emitted at `index.js:606`. Plan rewritten around the real state.
- **R1-C2 (bug bigger than stated):** v1 claimed direct-Gemini path
  ships stock voice; auditor noted it ALSO ships at wrong sample rate
  AND lacks `outputAudioTranscription`. Plan now treats the diagnostic
  as Phase A1.
- **R1-C3 (no flag = reckless):** added `NEXT_PUBLIC_VOICE_PROXY_PATH`
  flag.
- **R1-C4 (HMAC reinvents tickets):** dropped HMAC; reuse `voice_tickets`.
- **R1-C5 (4000-char cap chain):** verified seconds math is rate-
  independent; cap holds. Phase A2 re-runs the test as final check.
- **R1-M1 (wrong t0):** added `user_perceived_response_ms`.
- **R1-M3 (dead `gemini.token`):** removed from envelope; proxy mints
  Gemini server-side.
- **R1-M4 (iOS autoplay activation expiry):** prime `<video>` at
  mic-tap.
- **R1-M5 (pipe-warm violation):** rollover preserves bridge.
- **R1-M6 (device matrix gaps):** added lock-screen, call-interrupt,
  low-power.
- **R1-M7 (reconnect into dead WS):** redirect to hook page, not silent
  retry.
- **R1-S small-fry:** anti-alias FIR before decimation (32-tap min);
  offscreen-positioned `<audio>` not `hidden` attr.
- **R2-C1 (proxy session collision):** proxy attaches via ticket
  `session_id`; doesn't INSERT a new row. New migration.
- **R2-C2 (migration needed after all):** `voice_tickets.session_id` FK.
  §9 corrected.
- **R2-C3 (rollback hazard):** keep `gemini.token` in envelope during
  flag-on/off window; delete in cleanup PR after 24h-green.
- **R2-C4 (iOS activation across rebinds):** bridge calls
  `videoEl.play()` inside every track rebind; reconnect overlay is the
  fresh-activation source.
- **R2-C5 (Cartesia 16k unverified):** Phase A2 adds real-API roundtrip
  with forced-alignment duration check.
- **R2-M1 (TTS warmup gap on rollover):** overlap proxy WS swap so old
  WS drains while new one is open.
- **R2-M2 (A1 capture method):** force `setLocalPlayback(true)` +
  MediaRecorder against bridge audio track.
- **R2-M3 (backpressure caps):** re-size to 1.4 MB hard / 700 KB warn
  for 16kHz.
- **R2-M4 (Sentry alert location):** Sentry web UI or
  `sentry/alerts/*.json`, not `instrumentation.ts`.
- **R2-M5 (user-perceived t0):** mic-tap-release / VAD-end, NOT
  `gemini_turn_complete`.
- **R2-M6 (A3/B3 conflict):** locked decision = pre-mint via
  service-role inside `/api/sessions/open`.
- **R2-M7 (reconnect into dead state):** stash last user transcript;
  overlay surfaces it with retry/back actions.

### Round 3 (audit #3)

- **R3-C1 (chunker):** ring-buffer chunker inside `simli-bridge.sendAudio`
  enforcing 6000-byte cadence, regardless of Cartesia rate option.
- **R3-C2 (multi-tab ticket replay):** `/api/sessions/open` 23505 path
  re-mints ticket against existing active session, returns same envelope
  shape. `cogs_log` op `sessions_open_takeover` for ops visibility.
- **R3-C3 (overlap router rules):** mic to NEW only; old WS read-only-
  drain ≤2s; cancel routes both; one `voice_rollover_overlap` cogs_log
  row per overlap.
- **R3-C4 (diagnostic leak):** Phase A1 audible `setLocalPlayback(true)`
  gated by `NEXT_PUBLIC_VOICE_DIAGNOSTIC=1` AND `NODE_ENV !== production`;
  PR review checkbox "diagnostic env removed."
- **R3-M1 (per-session sample rate):** keep `DEFAULT_SAMPLE_RATE=24000`;
  proxy passes `sampleRate: 16000` per-session for the simli path.
  Spike-a + Phase 0 fixtures unaffected.
- **R3-M2 (iOS rebind):** full re-bind `srcObject = null; srcObject =
  stream; await play();` on overlay tap.
- **R3-M3 (Simli minute reconciliation):** `bridge.close()` writes
  minute-billed cogs_log row using `SIMLI_USD_PER_MIN` env; reaper
  writes same row for ghosted sessions; admin drift tile.
- **R3-M4 (replica failure modes split):** `replica_not_ready` retries;
  `replica_not_found` permanent + admin tile.
- **R3-M5 (NOT NULL migration sequence):** nullable → cleanup → backfill
  → SET NOT NULL → CHECK constraint.
- **R3-M6 (rollback sequencing):** runbook documenting flag-flip,
  no-Fly-redeploy rule, drain window.
- **R3-M7 (VAD t0 lock):** `mic_stopped` reducer transition; unit-test
  one-fire-per-turn.
- **R3-Missing-1 (DEV/PROD voice_id):** `voice_id_dev` column +
  env-gated read/write.
- **R3-Missing-2 (force-retrain flow):** admin CTAs on
  `/admin/creators/[id]/health`.
- **R3-Missing-3 (GDPR):** `creator_erasure_queue` + extended
  voice-delete-worker → also DELETEs Simli faces.
- **R3-Missing-4 (frame backpressure):** `getStats()` poll →
  `simli_video_stats` event + admin tile.
- **R3-Missing-5 (drift):** `simli_clock_drift_ms` rolling event.
- **R3-Missing-6 (Cartesia-down UX):** `cartesia_reconnecting` reducer
  state.

### Round 3 small-fries

- **R3-S audio iOS17:** offscreen-positioned `<audio>` confirmed
  approach (`opacity:0` 1×1 in-flow; not `top:-9999px`).
- **R3-S 32-tap resampler (option B):** lock to 32-tap min; delete the
  v3 "16-tap" reference.
- **R3-S §6 D3 reference:** scrubbed Sentry-config-file references; alerts
  configured in Sentry web UI or `sentry/alerts/*.json`.
- **R3-S §12 Q2:** deleted (resolved by `voice-proxy/index.js:326`
  hardcoding `/voice/spike-a`).
- **R3-S COGS aggregator post-rate-change:** Phase A2 verifies
  `cogs-aggregations.test.ts` stays green (rate-independent math but
  metadata.audio_bytes_out changes).
- **R3-S ticket TTL:** 60s, documented in §2.
- **R3-S Simli token expired UX:** §11 row added.
- **R3-S Phase E Android WiFi:** added to matrix.

### Round 4 (audit #4) — final pre-code pass

- **R4-C1 (dual-WS attack surface):** proxy `wsRegistry` evicts older
  WS with 4002 + audit row on attach.
- **R4-C2 (idempotent migration):** explicit pg_constraint guards +
  blanket DELETE FROM voice_tickets (60s/120s-TTL — at most one re-tap).
- **R4-C3 (GDPR/retrain race):** worker `WHERE NOT EXISTS active
  session`; force-retrain RPC takes pg_advisory_xact_lock + raises
  if active session.
- **R4-M1, R4-M2 (fake open questions):** §12 Q1 (resampler) and Q3
  (ticket route widening) deleted — locked in plan body. Renumbered.
- **R4-M3 (Simli minute double-count):** distinct ops
  `simli.video_minutes_bridge_close` vs `simli.video_minutes_reaper`;
  aggregator picks MAX per session, never sums.
- **R4-M4 (iOS MediaRecorder limit):** Phase A1 scope locked to
  desktop Chrome. Proxy-side capture deferred (4h not worth it pre-YC).
- **R4-M5 (autoplay-rejection state):** `video_autoplay_lost` reducer
  state + UX row §11.
- **R4-M6 (`VERCEL_ENV` not `NODE_ENV`):** three voice_id columns
  scoped by VERCEL_ENV.
- **R4-M7 (Sentry alert source-control):** preferred path =
  `sentry/alerts/lipsync.json` + sentry-cli in CI; YC fallback =
  UI-config + tech-debt log entry. Decision in §12 Q4.

### Round 4 small-fries

- **R4-S `proxy-client.ts` duplicate:** removed redundant entry from §9.
- **R4-S sample-rate contradiction:** §3 R3-M1 wins (per-session,
  default stays 24k); §Phase A2 + §9 reconciled to per-session pass-in.
- **R4-S `session_ttl_expired` taxonomy:** verified already present
  at `avatar-bridge.ts:60` — no change.
- **R4-S 800ms vs 1200ms metric clarification:** §6 now spells out
  which metric feeds which threshold.
- **R4-S ticket TTL bumped 60→120s** for slow-LTE buffer.
- **R4-S drift threshold raised 200→400ms** (above Cartesia chunk
  cadence of 187.5ms).
- **R4-S `/admin/creators/[id]/health`:** locked as ONE page with
  three sections (R3-M4 + R3-Missing-2 + R3-Missing-4). §12 Q3
  confirms.

### R4 YC-Day pre-flag-on gate

- 1Hz `video.paused && video.srcObject` watcher in `session-client.tsx`
  → `video_autoplay_lost` after 2s + PostHog event
  `simli_video_paused_with_track`.
- Phase E iPhone 11 PWA airplane-mode-toggle test (kill-network 3s
  mid-session) before flag-on. **This is the test that would break
  demo day if missed.**

---

[simli-js]: https://docs.simli.com/api-reference/simli-client
[cartesia-sr]: https://docs.cartesia.ai/api-reference/tts/tts
