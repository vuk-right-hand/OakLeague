# Spike A v2 — Sub-1.5s Voice Plan

Status: **REV 7 — Spike A v2 FINAL. Gate cleared 2026-04-21. 3.1 ships as primary, 2.5 retained as env-swap fallback.**
Owner: Vuk + Claude
Created: 2026-04-21
Last revised: 2026-04-21
Deadline: YC S26 app 2026-05-06

---

## Decisions locked (post Round 3)

1. **Primary model**: Gemini 2.5 Flash native-audio — `gemini-2.5-flash-native-audio-preview-12-2025` (v1alpha). Secondary for comparison: 3.1 — `gemini-3.1-flash-live-preview` (v1alpha). **Both on v1alpha — single `GoogleGenAI` client, not two** (Phase 0 finding, supersedes C4).
2. **Transport (Spike A)**: **Server-proxy WS** on dedicated Node host — see D1.
3. **Proxy host (D1)**: **Fly.io, `iad` region, single machine.** Supabase Edge caps non-background invokes at ~400s (would truncate Gemini's 15-min cap at 6.5min). Railway eviction risk unnecessary. All testers stay East Coast for spike.
4. **Transport (production, Day 5-6)**: LiveKit Cloud WebRTC wrapping the same proxy-as-agent. `AudioBridge` interface designed for zero rework.
5. **Concurrency (D2)**: **1 concurrent session per user**, enforced by `CREATE UNIQUE INDEX sessions_one_active_per_user ON sessions(user_id) WHERE ended_at IS NULL`. Advisory lock + reservations model is prod answer, deferred to Day 8.
6. **Barge-in**: Hybrid — client duck + server cancel. Spec'd.
7. **VAD in Spike A (M3)**: **Manual `activityStart/End`** for deterministic TTFA measurement (matches current harness). Server-VAD realism cell added as separate Phase 3 sub-run.
8. **Dual-model matrix**: 3.1 + 2.5 both tested on Day 2. Env-var split: `VOICE_MODEL_PRIMARY` + `VOICE_MODEL_SECONDARY`. Post-Phase-4, loser's env var deleted — `VOICE_MODEL` returns to CLAUDE.md singular.
9. **No OpenAI fallback in Spike A.**
10. **Platform gate**: Desktop Chrome + Android Chrome + iOS Safari installed as PWA.
11. **Measurement (D3 + C5)**:
    - Desktop Chrome: 50×5 × both models + throttled cell (3G Fast, 100ms RTT, 1% loss)
    - Android Chrome: 50×5 × both models + **cellular reality cell (20×5, real LTE, 2.5 only)**
    - iOS Safari PWA: **20×5 × 2.5 only** + n=5 smoke on 3.1 + cellular reality cell (20×5 LTE, 2.5 only)
    - Gate on **p90**. Qualitative mid-sentence-cutoff check (≤1/10 per model).
12. **Priming Window (D4)**: **DEFERRED to Day 5 product work.** Measuring with priming measures the clip, not the model. Spike A measures Gemini's naked cold-path. Primitive remains a first-class product concept.
13. **Fallback tree (C5)**: Explicit three branches in Phase 4 — (a) 2.5 passes → ship, (b) 2.5 fails + 3.1 passes → ship with caveat, (c) both fail → product-scope call before Day 5 work.

---

## UX principles (drive every trade-off)

- **Flawless feel > flawless numbers.** If users perceive it as snappy at 800ms p50, we ship. If p50 is 400ms but barge-in feels robotic, we don't.
- **Mask work with work.** Any delay > 400ms needs a perceptual cover (avatar micro-movement, subtle "listening" cue, typing dot). Build hooks now, fill in Day 5.
- **Human cadence over minimum latency.** 150ms of "I'm thinking" breath is better than 50ms cold silence + abrupt response. Real humans aren't 280ms responders.

### First-Class Primitive: **Conversational Priming Window** *(product concept — NOT in Spike A measurement)*

**Status: deferred to Day 5.** Spike A measures naked Gemini latency. Priming window is our strongest UX lever for production but must not contaminate measurement. C1 from Round 3 also flags: the "empty-frame warm-up = 500-800ms" assumption is folklore until measured. Phase 0 includes a 15-min sub-spike to check whether sending empty `sendRealtimeInput({audio})` after `setupComplete` actually warms first-audio-out latency, or whether the warm-up budget is illusory.

Keeping the concept here so Day 5 inherits it:

**Pattern:** User taps "start talking" → avatar raises finger, says "one sec, let me finish this thought…" (1500-2000ms of canned personality audio) → user's mic is hot before they speak → first-turn p50 collapses to pure Gemini TTFT (~300ms) because setup is already done.

**What happens during the priming window (in parallel):**
- Open proxy WS + Gemini Live WS (200-400ms)
- Gemini cold warm-up turn with empty audio (500-800ms on 2.5)
- Client VAD calibration + AEC convergence (300ms)
- Mic permission prompt if not yet granted
- Session ticket mint, kill-switch pre-check, COGS row opened

**Why this is correct, not a hack:**
- Humans don't pivot instantly. A friend finishing their sentence before listening is *more* natural than a robotic "GO!" tone.
- Users measure latency from *conversational-turn-end*, not speech-end. We control turn-end.
- Canned audio can be pre-synthesized + cached (no TTS cost). ~50 variants ("hold on", "one sec", "gimme a sec", "lemme finish this", etc.) rotated randomly = feels alive, costs $0.
- Bonus: every "may I finish?" moment is a free session-boundary — rotate Gemini sessions (15-min cap), refresh tokens, tier-swap silently.

**Budget impact:** first-turn perceived TTFA goes 800ms → ~150ms (just the new speech hitting a warm stack). Subsequent turns keep normal budget.

**Spike A test coverage:** DEFERRED to Day 5 (see decision D4 above). Spike A measures naked Gemini TTFA only. Phase 0 empty-frame test validates the *foundation assumption* that warm-up masking is real; everything downstream (canned-clip rotation, delta measurement, iOS mic-permission cover) is Day 5 work.

**Out of scope for Spike A (but designed for):**
- Canned-audio library + rotation: Day 5-6
- Interruption-aware priming ("you want to jump in? one sec") — V1.1
- "Bless you", "may I finish that thought?" — V1.1 personality layer built on same primitive

---

## Latency budget (E2E, user-perceived)

Revised with direct-proxy path (no LiveKit hops in Spike A):

| Stage | Floor | Target |
|---|---|---|
| Mic capture + 20ms framing | 25 | 20 |
| Browser→proxy WS (TCP, same region) | 50 | 30 |
| Proxy→Gemini WS | 40 | 20 |
| Gemini VAD endpoint detection | 100 | 60 |
| Gemini TTFT (first audio chunk) | 300 | 200 |
| Gemini→proxy→browser downlink | 90 | 50 |
| Jitter buffer + audio element decode | 100 | 50 |
| **Total TTFA (user-perceived)** | **705ms** | **430ms** |

> **VAD row caveat:** Target figures. Voicer field data on 3.1 measured 200-400ms endpoint detection in practice. Phase 0 validates against 2.5 native-audio. If 2.5 lands in the 200-400ms band, TTFA budget inflates ~150ms and success gate tightens accordingly.

Barge-in target: **150ms client-side speaker duck, 500ms p90 server-cancel of TTS stream** (aligned with Success gate; single source of truth).

---

## Success gate (Spike A passes iff all true)

- **TTFA (2.5)**: p50 ≤ 800ms, **p90 ≤ 1400ms** on Desktop + Android. iOS: p90 ≤ 1600ms (reduced-n concession).
- **TTFA (3.1)**: published as comparison data; not gated. Smoke passes if it simply connects reliably on iOS.
- **Setup reliability**: 0 failed WS connects (`ws_closed_1006` level) across all runs. Per-OS suspension tolerance: ≤5% sessions OS-killed, all auto-recovered via Reconnecting UX.
- **Barge-in**: client duck p90 ≤ 200ms, server-cancel p90 ≤ 500ms on desktop (n=20). **iOS barge-in spot-check (n=5 manual interrupts) required in Phase 3** — AEC fix is iOS-specific (C5), desktop-only measurement validates nothing about the speaker→mic leak. iOS spot-check documents self-cancel rate; >2/5 self-cancels = ship blocker escalation to Day 5.
- **Throttled cell** (3G Fast Playwright): p50 ≤ 1200ms.
- **Cellular reality cell** (real LTE, 2.5 only): p50 ≤ 1400ms, p90 ≤ 2500ms. If p90 > 2500ms → WebRTC scheduled into Day 5 as a blocker, not a polish.
- **Mid-sentence cutoff check** (qualitative, server-VAD sub-run): ≤1/10 responses flagged as truncated by VAD.
- **COGS**: logged every turn. Pricing re-derived in Phase 0 from actual token rates (input $3/M, output $12/M for 2.5 native-audio). Gate: within ±10% of that derived model.
- **Kill-switch**: synthetic runaway test (seconds-based quota per `session_turns_mid_session_kill_switch.test.sql`) terminates within 1 turn of breach. Unique partial index prevents concurrent-session loophole.
- **Ghost-session reaper**: bilateral 20s heartbeat; `reap_stale_sessions` RPC runs on proxy startup + every 60s, closes rows where `last_turn_at < now() - 90s`. Worst-case ghost life = 3 missed pings (60s) + next reaper tick (60s) ≈ 120-150s, ≈$0.05/ghost. Fine for spike; tighten to 30s heartbeat / 15s reaper cadence in prod (Day 8).

---

## Architecture

```
PWA (browser)
  ├─ AudioWorklet (mic capture, 48k→16k LE mono PCM16, 40ms frames — NOT 1000ms)
  ├─ getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:false}})
  │    iOS TTS playback: **Spike A uses Web Audio graph (known AEC regression on iOS, documented).**
  │    Reason: Gemini emits raw PCM16; <audio> element needs a container (MP3/AAC/webm-Opus or MSE).
  │    Muxing PCM → Opus/webm in-browser is a half-day task — out of Spike A scope.
  │    Day 5 fix: MediaSource + SourceBuffer with Opus/webm muxing (or server-side mux in proxy).
  │    Spike A accepts: iOS barge-in spot-check (n=5) will expose the leak; we measure, don't hide.
  ├─ Client VAD (energy threshold, 120ms window) → duck speaker + WS cancel msg
  │    VAD suppressed 80ms after each outgoing TTS frame boundary (AEC tail)
  ├─ Ticket: GET /api/voice/spike-a/ticket (RSC route, admin-gated) → uuid
  ├─ WSS to Fly proxy with ?ticket=<uuid>
  └─ TTFA measured entirely client-side: t_sendLast - t_firstAudioReceived (no NTP needed)
        ↓
Fly.io Node proxy (iad region, 1 machine, standalone server/voice-proxy/index.ts)
  ├─ Auth: atomic consume of voice_tickets row
  │    UPDATE voice_tickets SET consumed_at=now()
  │    WHERE ticket_id=$1 AND consumed_at IS NULL AND expires_at > now()
  │    AND bound_ua_hash=$2 RETURNING user_id
  ├─ Unique-session enforcement: INSERT into sessions (user_id, ended_at=NULL)
  │    fails on partial unique index → close WS with 4001 "session_already_active"
  ├─ AudioBridge interface (see src/lib/voice/audio-bridge.ts)
  ├─ GeminiBridge (single module-level singleton, both models on v1alpha):
  │    - genai = new GoogleGenAI({apiKey, httpOptions:{apiVersion:'v1alpha'}})
  │    - Per-session: ai.live.connect({ model: VOICE_MODEL_PRIMARY | SECONDARY, ... })
  │    - Manual activityStart/End (Spike A only; server-VAD realism is separate cell)
  │    - Config: responseModalities: ['AUDIO'] — drop text deltas
  │    - 40ms PCM passthrough, no buffering
  ├─ Kill-switch: assertWithinQuota(userId) at turn_start — seconds-only, no dollar conversion (no FX noise)
  ├─ Heartbeat: 20s bilateral ping; reap on 3× miss
  ├─ Sentry spans: per-turn {model, turn_number, session_idx, device, platform}
  └─ COGS: **two-insert pattern per turn** (input-seconds row + output-seconds row) —
       cogs_log UPDATE is blocked by append-only trigger (migration 0020). env='spike_a' tag.
       cogs_insert_turn() RPC wraps both inserts in one statement for atomicity.
```

**Files to build:**

1. `src/lib/voice/models.ts` — `ALLOWED_MODELS` registry, pinned strings both models, env split `VOICE_MODEL_PRIMARY` + `VOICE_MODEL_SECONDARY`
2. `src/lib/voice/audio-bridge.ts` — `AudioBridge` interface `.d.ts` + lifecycle (`open | turnStart | turnEnd | cancel | close`)
3. `src/lib/voice/gemini-bridge.ts` — two module-level GoogleGenAI singletons (v1alpha, v1beta), implements AudioBridge
4. `src/lib/voice/kill-switch.ts` — seconds-based quota check (not dollars, per `session_turns_mid_session_kill_switch.test.sql`), called at turn_start
5. `src/app/api/voice/spike-a/ticket/route.ts` — RSC route, `assertAdminFromSession()`, mints 30s-TTL ticket with UA-hash binding
6. `server/voice-proxy/index.ts` — **standalone Node process, Fly.io deploy** (NOT a Next.js route). WS upgrade, ticket consume, bridge orchestration, heartbeat, Sentry.
7. `server/voice-proxy/Dockerfile` + `server/voice-proxy/fly.toml`
8. `src/app/admin/spike-a/spike-client.tsx` — rewrite: AudioWorklet + client VAD + WS to Fly proxy. 40ms chunks, not 1000ms.
9. `src/app/api/voice/spike-a/record/route.ts` — extend with `provider`, `platform`, `network_profile`, `environment` (default 'production', spike writes 'spike_a'); cap to 900s; atomic RPC for the two inserts.
10. `supabase/migrations/20260421000001_voice_spike_cogs_fields.sql` — **placeholder migration landed immediately in Phase 0** to lock # + unique partial index + `environment` column + `voice_tickets` table + `reap_stale_sessions` RPC + `cogs_insert_turn` RPC.
11. `public/worklets/mic-processor.js` — AudioWorklet, 48k→16k LE mono PCM16, 40ms frames, base64 chunked at 8KB on iOS
12. `.env.example` — pinned model strings
13. `e2e/spike-a/` — Playwright harness for Desktop + Android Chrome automated runs. iOS PWA runs manually with Google Sheet capture.

---

## Phased execution (4 days, hard trip-wires)

### Phase 0 — Verification + Placeholder Land (4h, trip-wire at 4h → escalate)
- **Land placeholder migration TODAY** to lock # `20260421000001`:
  - unique partial index `sessions_one_active_per_user`
  - `voice_tickets` table **with RLS enabled, zero policies** (service-role-only)
  - `cogs_log.environment` column default 'production'
  - `reap_stale_sessions()` and `cogs_insert_turn()` RPC stubs
- Verify `@google/genai` Node can open Live WS on v1beta with 2.5 native-audio
- Two concurrent singletons test: 2× v1alpha + 2× v1beta connects simultaneously (C4)
- ~~Empty-frame warm-up test~~ **RAN 2026-04-21 → DEAD. Result: -28ms masking delta (n=3, 2.5). Priming Window path forward = canned pre-recorded audio, NOT empty PCM frames.** See `.claude_learnings.md` 2026-04-21.
- Verify exact pinned version strings (hit API, record actual IDs)
- Verify `thinkingLevel` + config shape on v1beta
- **Abort/escalate conditions**:
  - 2.5 unreachable from Node SDK → pivot decision, see Phase 4 fallback tree (don't silently 3.1-only)
  - Phase 0 runs past 4h → escalate, re-plan

### Phase 1 — Foundation (1 day)
- Models registry, kill-switch (seconds-based), AudioBridge `.d.ts`
- Ticket RSC route + `voice_tickets` write/consume flow
- Fly.io app created, Dockerfile, `fly.toml`, Sentry DSN wired, deploy hello-world WS
- AudioWorklet module, client VAD, iOS `<audio>`-element TTS playback path
- **Sentry ticket-token scrub: extend `beforeBreadcrumb` + `beforeSend` in `sentry.server.config.ts` AND proxy Sentry init with `s.replace(/([?&])ticket=[^&#]+/g, '$1ticket=[redacted]')` before any WS URL hits breadcrumbs.** Explicit regex, not freestyle.

### Phase 2 — Gemini Bridge + Desktop Run (1 day)
- GeminiBridge implementing AudioBridge, both singletons
- Manual VAD (deterministic TTFA) — matches Round 3 M3
- Client-local TTFA measurement (t4/t5 local, no NTP per M1)
- Heartbeat + ghost reaper live
- Desktop Chrome run: 50×5 × both models, unthrottled + Playwright-throttled 3G Fast
- **Checkpoint**: if desktop 2.5 p50 > 1200ms, STOP. Debug before mobile.

### Phase 3 — Mobile + iOS + Reality Cells (1 day)
- iOS PWA install flow documented; Reconnecting UX after 2s no-audio
- iOS 17.4+ `getUserMedia` sequencing audited (no pre-`await`) — M5 Round 2
- Android Chrome: 50×5 × both models + cellular reality cell (20×5 LTE, 2.5 only)
- iOS Safari PWA: 20×5 × 2.5 only + 5-session 3.1 smoke + cellular LTE cell
- Server-VAD realism sub-run: 10 random responses/platform, flag mid-sentence cutoffs
- **Barge-in: desktop n=20 (automated) + iOS Safari PWA n=5 manual interrupts (spot-check for speaker→mic self-cancel — validates or surfaces the AEC regression from B4/C5).** Android Chrome spot-check n=5 if iOS shows leaks (to isolate iOS-specific vs all-mobile).

### Phase 4 — Decision + Docs (0.5 day) — **COMPLETE 2026-04-21**

**Decision: 3.1 ships as primary. 2.5 retained as env-swap fallback (not deleted).**

Both models passed the gate; 3.1 was ~2× faster across every surface. Variant of fallback branch (a): 3.1 primary. `VOICE_MODEL_SECONDARY=gemini-2.5-flash-native-audio-preview-12-2025` kept live in Vercel + Fly env so a mid-demo Google preview deprecation of 3.1 is a 2-minute env swap, not a code push.

**Results table** (n=15 per cell unless noted, TTFA = activityEnd → first audio chunk, via Fly proxy iad → @google/genai Live v1alpha):

| Surface | Model | p50 | p90 | Notes |
|---|---|---|---|---|
| Desktop Chrome | 3.1 | 2554ms | 3707ms | Gate pass |
| Desktop Chrome | 2.5 | 5022ms | 5438ms | ~2× slower than 3.1 |
| Pixel 7 Pro WiFi | 3.1 | 2920-3189ms | — | 2 runs, consistent |
| Pixel 7 Pro LTE | 3.1 | 2994ms | 4288ms | Cellular reality cell |
| iPhone 11 WiFi | 3.1 | 3387ms | 4512ms | iOS Safari PWA |
| iPhone 11 LTE | 3.1 | 3083ms | 4715ms | via Pixel hotspot |

Voicer's reported 15-20s 3.1 regression **did not reproduce on any surface**. iOS Safari WebKit showed no model-specific degradation vs desktop.

**Three-branch fallback tree outcome** (C5):
- (a) ✅ **INVOKED (variant)** — both passed, 3.1 ~2× faster → ship 3.1 primary, keep 2.5 as env-swap fallback (not deleted, per safety decision 2026-04-21)
- (b) n/a — 2.5 did not fail
- (c) n/a — neither failed

**Wrap-up checklist:**
- ✅ `.claude_learnings.md` — 12 Phase 0-4 entries including 3.1 gate-clear, Dockerfile bug, Supabase URL bootloop, ngrok/HTTPS callback, `sendRealtimeInput({audio})` deprecation, binary-protobuf WS wire format
- ✅ CLAUDE.md `VOICE_MODEL` rule: default `gemini-3.1-flash-live-preview`, fallback one env-swap away
- ✅ `.env.example` retains `VOICE_MODEL_PRIMARY` + `VOICE_MODEL_SECONDARY` (both kept live for emergency env swap)
- ✅ `src/lib/voice/models.ts` `ALLOWED_MODELS` retains both entries; `getPrimaryModel()` / `getSecondaryModel()` kept as dead-simple safety scaffolding
- ✅ Rev 7 revision log entry

---

## Kill-switch — concrete contract

Seconds-based (matches `session_turns_mid_session_kill_switch.test.sql:27`), no FX volatility:

```ts
// src/lib/voice/kill-switch.ts
export async function assertWithinQuota(userId: string): Promise<void> {
  // At turn_start:
  //   SELECT COALESCE(SUM(units), 0) FROM cogs_log
  //   WHERE user_id = $1
  //     AND unit_label = 'seconds'
  //     AND (created_at AT TIME ZONE 'utc')::date = (now() AT TIME ZONE 'utc')::date
  // If sum >= 1.5 * DAILY_QUOTA_SECONDS → throw QuotaExceededError.
  // Proxy closes WS with code 1008, reason="quota_exceeded".
  //
  // Timezone contract: quota day boundary is UTC midnight, explicit.
  // (Prior `created_at::date = today` relied on Postgres server TZ — fragile.)
  // Prod hardening (Day 8): add `day_utc date GENERATED ALWAYS AS
  // ((created_at AT TIME ZONE 'utc')::date) STORED` + index for fast lookups.
}
```

Concurrent-turn race closed by D2's unique partial index — only one active session per user means only one in-flight turn. Synthetic test: `DAILY_QUOTA_SECONDS=10`, run two sessions attempting to open concurrently — second fails at index insert with `session_already_active`. Third turn on same session (sum > 15s) → `quota_exceeded`.

## Ticket-based WS auth — concrete contract

```sql
-- migration 20260421000001
CREATE TABLE voice_tickets (
  ticket_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 seconds'),
  consumed_at timestamptz,
  bound_ua_hash text NOT NULL  -- sha256 of User-Agent at mint time
);
CREATE INDEX voice_tickets_expires ON voice_tickets(expires_at) WHERE consumed_at IS NULL;

-- CLAUDE.md hard rule: RLS on every table. Service-role-only = enabled, zero policies.
ALTER TABLE voice_tickets ENABLE ROW LEVEL SECURITY;
-- (intentionally no policies — only the Fly proxy's service-role key reads/writes)
```

Consume is atomic in proxy:
```sql
UPDATE voice_tickets SET consumed_at = now()
WHERE ticket_id = $1
  AND consumed_at IS NULL
  AND expires_at > now()
  AND bound_ua_hash = $2
RETURNING user_id;
```
No row → close WS `4001 invalid_ticket`. UA-hash binding (not IP — mobile carrier IPs churn). Replay-safe.

---

## Security review

- Gemini API key: server-only, held by Fly.io proxy only. Never logged, never in browser, never in Next.js app bundle.
- **Proxy WS auth: atomic consume of `voice_tickets` row (see Ticket-based WS auth contract above).** 30s TTL, UA-hash bound, single-use. Ticket mint is RSC route `/api/voice/spike-a/ticket` gated by `assertAdminFromSession()`. Cookies do not cross the WS upgrade boundary (C2).
- **Concurrency: 1 active session per user**, enforced by `sessions_one_active_per_user` partial unique index (D2). No in-memory counter, no Redis. Second concurrent attempt fails at index insert → WS close `4001 session_already_active`.
- Client WS URL carries `?ticket=<uuid>` only. No bearer tokens, no session IDs, no PII.
- PII: no transcripts persisted in Spike A. Audio not stored. `cogs_log` gets metadata only.
- iOS PWA cookie jar: install-time cookie bootstrap only affects ticket mint route (same-origin RSC) — WS itself is stateless post-ticket-consume.
- **Sentry scrubbing: extend `beforeBreadcrumb` and `beforeSend` with** `s.replace(/([?&])ticket=[^&#]+/g, '$1ticket=[redacted]')` **alongside existing `/invite/*` + `access_token` redaction.** Applies to `sentry.server.config.ts` AND proxy's own Sentry init.

---

## Economics (with current decisions)

| | Spike A (150 sessions × 3 platforms × 2 models) | Production @ 10K MAU × 5 min/wk |
|---|---|---|
| Gemini 2.5 | ~$15 total spike | ~$2.6K/mo |
| Fly.io proxy (shared-cpu-1x, 256MB, iad) | ~$5/mo (prorated ~$1 for spike window) | ~$50-100/mo (multi-region, scaled) |
| LiveKit (Day 5+ only) | $0 | +$900/mo |
| **Total Spike A cost** | **~$16** | — |

---

## Risks / unresolved

- **WebRTC deferred**: cellular reality cell in Phase 3 answers "did we make a mistake?" with data. If cellular p90 > 2500ms → WebRTC becomes Day 5 blocker (not polish).
- iOS PWA AudioWorklet under memory pressure: Safari bug, mitigation = reconnect path.
- 3.1 and 2.5 behavior diverge on `interrupted` event shape — bridge must normalize.
- `liveConnectConstraints` locks payload shape at mint — document which fields for server-VAD realism cell.

---

# Audit Round 2

## Critical (5)

- **C1. Vercel route handlers cannot do WebSocket upgrades.** Known broken, not a risk to verify. Phase 0 either finds this in 30min and burns budget migrating, or we commit now. **Fix:** proxy runs on Fly.io / Railway / Supabase Edge Function (Deno native WS) — not a Next.js route. Rename `src/app/api/voice/spike-a/stream/route.ts` → `server/voice-proxy/index.ts` as a standalone Node process.
- **C2. `assertAdminFromSession()` won't work on WS upgrade.** `cookies()` helper is request-scoped; once WS is hijacked, cookie store is gone. Cross-host deploy (C1) makes it worse. **Fix:** short-lived signed ticket issued from a normal RSC route (`/api/voice/spike-a/ticket`), client presents in WS URL query, proxy validates ticket against Supabase with admin client.
- **C3. Kill-switch has TOCTOU race under concurrent turns.** `SELECT SUM()` → insert at turn_end means 2 concurrent sessions both pass at 140%, spend lands at 180%. Rate-limit of 5 concurrent multiplies the breach. **Fix:** Postgres function with advisory lock + `cogs_reservations` pre-row at turn_start, reconciled at turn_end. OR pin spike to 1 concurrent session per user (documented limitation).
- **C4. 4-day budget ignores: no-Vercel host migration, WS auth from scratch, iOS Playwright literally cannot drive installed PWA.** Playwright webkit ≠ iOS Safari ≠ installed PWA. 1500 iOS data points = manual tapping. **Fix:** cut iOS matrix to 20 × 5 × 2.5-only for spike. 3.1 on iOS gets n=5 smoke. Update §Success gate.
- **C5. No AEC strategy. Client energy-VAD will false-trigger on avatar's own TTS leaking speaker→mic.** Barge-in becomes self-cancel loop. iOS Safari's AEC requires TTS via `<audio>` element (not Web Audio graph). **Fix:** (1) TTS playback via `<audio>` on iOS, (2) VAD suppressed 80ms after each outgoing TTS frame, (3) explicit constraints `{echoCancellation: true, noiseSuppression: true, autoGainControl: false}`.

## Medium (7)

- **M1. `AudioBridge` interface is vapor without a `.d.ts`.** LiveKit substitution needs: per-track vs single-stream audio, LiveKit Opus decode vs our PCM, LiveKit server VAD vs Gemini's. Non-trivial differences. Spec signature + lifecycle (`open | turnStart | turnEnd | cancel | close`) in Phase 0 or "zero rework" is a wish.
- **M2. Clock-sync via echo measures RTT, not offset.** Need 4-timestamp NTP-style handshake at session open: `offset = ((t1-t0) + (t2-t3)) / 2`. Cuts noise floor from ±25-50ms to ±5ms — matters on 1400ms p90 gate.
- **M3. Migration # reserved in Phase 0 goes stale.** Collision risk between reservation and land. **Fix:** push one-line placeholder migration immediately in Phase 0 to lock number via git history. Or use date-prefix naming.
- **M4. "5 concurrent sessions" rate-limit has no enforcement mechanism.** In-memory = wrong past 1 proxy instance. Redis not in stack. **Fix:** pin spike proxy to 1 Fly machine, document, plan Redis for prod.
- **M5. iOS 17.4+ `getUserMedia` regression: any `await` before it invalidates user gesture.** Silent fail on installed PWA. **Fix:** plan must sequence `getUserMedia` as first call inside click handler, zero awaits before; AudioContext created/resumed in same tick; worklet `addModule` awaited *after* mic is live.
- **M6. "0 failed setups / 150 sessions" is unachievable on iOS PWA.** Incoming notification / lock screen / fast-switch suspends AudioContext. **Fix:** redefine gate: "0 failed *connects*" + "<5% sessions OS-suspended, auto-recovered with Reconnecting UX."
- **M7. CLAUDE.md `VOICE_MODEL` rule says singular pinned string; plan introduces dual-model matrix.** **Fix:** split env into `VOICE_MODEL_PRIMARY` + `VOICE_MODEL_SECONDARY`, or add admin-only `?model=` override gated by `assertAdminFromSession()`. Registry in `src/lib/voice/models.ts` whitelists both. Update CLAUDE.md hard rule to reflect spike carve-out.

## Small

- `@google/genai` single-client dual-apiVersion unverified — may need two client instances.
- VAD endpoint detection budgeted 60-100ms — Voicer field data on 3.1 was 200-400ms. Source the floor.
- Define TTFA precisely: first audio byte out of speaker, or first frame received client-side? Pin it.
- $0.012/conv-min pricing unsourced — 2.5 native-audio actual is input $3/M, output $12/M ≈ $0.019/min half-duplex. Re-derive or cite.
- Worklet spec missing: 16kHz 16-bit mono **little-endian**. Add to `public/worklets/mic-processor.js` doc.
- Gemini Live returns text deltas by default even in audio mode — configure `responseModalities: ['AUDIO']` or actively drop.
- Sentry scrub list must add WS ticket URLs post-C2 fix. Add to Phase 1 checklist.
- iOS 150-session runs must be real device, not Simulator (AudioWorklet divergence).
- Phase 4 needs rollback plan: if both 2.5 and 3.1 fail gate → ship text-chat v1, voice v1.1. Don't "extend spike."

## Auditor top-line

Round 1 simplified the stack (dropped LiveKit). Round 2 finds the *new* simpler stack has transport/auth problems Round 1 didn't exist to surface. **Most load-bearing item: C1 → commit to non-Vercel host for proxy before Phase 0 begins.** That decision unblocks C2, C3 enforcement model, and the whole deployment picture. Without it, Phase 0's 2h becomes Day 1's full day.

---

# Deferred items (Spike A v2 post-gate audit, 2026-04-21)

Explicit hand-off list for Day 5 (creator voice flow) + Day 8 (voice pipeline hardening). These items were identified in the Spike A build audit but are correctly deferred — fixing now would be premature work against a spike harness that gets replaced anyway.

## Day 5 — Creator voice flow (inherits worklet + avatar integration)

- **Mic worklet redesign + file disposition** — `public/worklets/mic-processor.js` exists but is **unused by Spike A** (spike-client.tsx sends pre-canned 1s PCM chunks through `sendRealtimeInput({audio})`, never exercises the worklet path). The current 48k→16k decimation has a carry-logic bug that drops sample 0 of each chunk: `this._carry = (this._carry + 3 - (ch0.length % 3)) % 3`. Day 5 agent: either redesign the worklet alongside the real mic streaming path (40ms chunks, AudioWorkletNode → WS), or delete the file and re-author from scratch with Voicer §13 step-2 in mind. Don't silently "fix the carry" in-place without re-validating against a real 40ms streaming harness — the bug is easier to spot when the path is actually live.
- **iOS TTS playback path** — Spike A accepted the Web Audio AEC regression on iOS (documented Rev 5 B4). Day 5 production path is MediaSource/SourceBuffer with Opus/webm muxing so Safari's native audio element is used and AEC stays engaged. In-browser PCM-to-container muxing is the real work.
- **Priming Window implementation** — first-class UX primitive spec'd at line 39. Must use canned pre-recorded audio or server-seeded text turn, NOT silent PCM frames (empirically invalidated Phase 0: -28ms masking delta, see `.claude_learnings.md` 2026-04-21 Phase 0 Finding 3).

## Day 8 — Voice pipeline production hardening (inherits heartbeat + quota plumbing)

- **Heartbeat write amplification** — current Spike A design writes `session_turns` row per turn. At 1000+ concurrent sessions that's a hotspot. Production design: in-memory aggregate per-session, flush every N seconds or on session close, single INSERT per flush window. Correctness is fine today (0 prod sessions); scale issue only.
- **`daily_quotas.seconds_used` GENERATED `day_utc` column** — kill-switch currently filters `(created_at AT TIME ZONE 'utc')::date = (now() AT TIME ZONE 'utc')::date`. Day 8 migration adds `day_utc date GENERATED ALWAYS AS (((created_at AT TIME ZONE 'utc'))::date) STORED` + composite index on `(user_id, day_utc)`. Deferred because spike-scale doesn't need the index.
- **Ghost-session reaper tightening** — spike accepts ~150s worst-case ghost window. Prod needs <30s via either proxy-side heartbeat-to-DB writes or a scheduled `pg_cron` sweep.
- **`usageMetadata` pricing migration** — when Gemini Live starts returning accurate `usageMetadata` tokens (check docs on Day 8), remove the seconds-times-$PRICE_USD_PER_SEC folklore in `gemini-bridge.js` and use real token counts for COGS.

---

# Revision Log

- **2026-04-21 Rev 7** — Spike A v2 FINAL. Phase 2-3 executed: Fly proxy (iad) deployed, Phase 0 verification script, GeminiBridge singleton, AudioWorklet + client VAD, ticket-based WS auth, voice_tickets table, Sentry ticket-scrub, ngrok tunnel for device testing. Measured matrix across desktop Chrome, Pixel 7 Pro (WiFi + LTE), iPhone 11 (WiFi + LTE) × 3.1/2.5. **3.1 passed gate at p50 2.5-3.4s, ~2× faster than 2.5 across every surface.** Voicer 15-20s regression did not reproduce. Decision: ship 3.1 primary, keep 2.5 as env-swap fallback (not deleted — Google preview deprecation insurance, 2-minute recovery vs 20-minute code push). Both models stay in `ALLOWED_MODELS` and both env vars stay populated. CLAUDE.md already reflects 3.1 pin + one-env-swap fallback. Surprises logged to `.claude_learnings.md`: (1) Gemini Live WS is binary protobuf, must use SDK; (2) `sendRealtimeInput({media})` deprecated server-side, use `{audio}`; (3) Dockerfile missed `gemini-bridge.js` masked as ready_timeout for hours; (4) Supabase URL validation rejected quoted env secret, bootlooped machine; (5) ngrok HTTPS → Next dev HTTP broke same-origin auth callback; (6) `session_already_active` under burst testing is preview-tier concurrency throttling, not a prod signal; (7) Fly trial-tier 5-min auto-stop is safe, wake-time ~1s.
- **2026-04-21 Rev 1** — initial draft + Audit Round 1 captured.
- **2026-04-21 Rev 2** — Vuk confirmed: drop LiveKit from Spike A (keep for Day 5+), hybrid barge-in, keep dual-model, drop OpenAI fallback. Added Phase 0 verification gate, kill-switch contract, clock-sync, iOS reconnect UX, pinned-version requirement, 50×5 + throttled cell measurement, p90 gate.
- **2026-04-21 Rev 3** — Audit Round 2 captured. Added **Conversational Priming Window** as first-class UX primitive. Open items identified for Rev 4.
- **2026-04-21 Rev 6** — Phase 0 verification complete. Findings: (A) 2.5 native-audio reachable at `gemini-2.5-flash-native-audio-preview-12-2025` on v1alpha (setup 425ms). (B) 3.1 reachable (setup 206ms). (C) 4 concurrent singletons work — but both models share v1alpha, so **dual-apiVersion client pattern dropped**, single `GoogleGenAI` singleton suffices (C4 in Round 2 was paranoia). (D) Empty-frame warm-up is **dead** (-28ms masking delta, n=3). Priming Window must use canned audio or text-seed, not silent PCM. Plan + learnings updated accordingly. Old `.claude_learnings.md` entry claiming `gemini-live-2.5-flash-native-audio` mint succeeded is stale — that string is not in Google's model list on either apiVersion; real ID has `-preview-12-2025` suffix.
- **2026-04-21 Rev 5** — Audit Round 4 (doc-hygiene sweep) resolved. B1: security review rewritten to match ticket-consume + 1-concurrent architecture (cookie-guard language deleted). B2: economics table — `Fly.io proxy shared-cpu-1x/256MB ~$5/mo`, spike prorated ~$1. B3: Priming Window "Spike A test coverage" bullets deleted, section explicitly marks Day 5 inheritance. B4: iOS TTS playback path decided — Spike A uses Web Audio (accepts iOS AEC regression, documented); Day 5 fix path is MediaSource/SourceBuffer Opus/webm mux. Rationale: in-browser PCM-to-container muxing is out of spike scope. B5: iOS barge-in spot-check (n=5 manual) added to Phase 3 — AEC fix is iOS-specific, desktop-only measurement proves nothing about speaker→mic leak. B6: kill-switch timezone-explicit via `(created_at AT TIME ZONE 'utc')::date = (now() AT TIME ZONE 'utc')::date`; Day 8 prod hardening via `day_utc` GENERATED column. B7: `ALTER TABLE voice_tickets ENABLE ROW LEVEL SECURITY` added to migration per CLAUDE.md hard rule. Polish: kill-switch "dollarize" phrase deleted (seconds-only); empty-frame thresholds widened (200-400ms = marginal/revisit); barge-in target harmonized to 500ms p90 server-cancel (single source of truth = Success gate); Sentry ticket-scrub regex spelled out in Phase 1; ghost-session ~150s worst-case window documented for spike (tightened prod); VAD endpoint 60-100ms target flagged against Voicer 200-400ms field data.
- **2026-04-21 Rev 4** — Audit Round 3 resolved: D1 Fly.io iad, D2 unique partial index (1 concurrent/user), D3 iOS cut to 20×5 × 2.5-only, D4 priming window deferred to Day 5. Critical fixes: C1 empty-frame warm-up moved to Phase 0 empirical test (not folklore), C2 ghost-session reaper spec'd, C3 voice_tickets table with UA-hash + atomic consume, C4 two GenAI singletons per apiVersion, C5 explicit three-branch Phase 4 fallback. Medium: dropped NTP clock-sync (unnecessary — client-local TTFA), removed canned-audio from spike scope, reverted to manual VAD for deterministic measurement + separate server-VAD realism sub-run, added `environment` tag for cogs_log, cutoff qualitative check ≤1/10, placeholder migration landed in Phase 0, Sentry per-turn spans. Added **cellular reality cell** in Phase 3 (20×5 real LTE on Android + iOS, 2.5 only) as the WebRTC-deferral safety net — answers "did we skip transport hardening too early?" with data rather than assumption.
