# Spike B — Avatar Provider: Simli Trinity-1 (free) + Tavus Phoenix-4 (premium/boardroom), tier-routed

Status: **REV 5 — tier-routed architecture (option D)**
Owner: Vuk + Claude
Created: 2026-04-21
Last revised: 2026-04-21
Deadline: YC S26 app 2026-05-06 (14 days)
Spike window: Apr 22–24 (Day 3–Day 5)

> **2026-05-27 note** — Tavus scrapped post-Spike B (see memory `project_tavus_scrapped`). Simli rate references below (`$0.015/min conservative`, projections @ $0.015) are HISTORICAL. The live BEST_ESTIMATE is now `$0.011/min` in [src/lib/avatar/cost.ts](../src/lib/avatar/cost.ts), pinned to empirical Hobby Plan billing ($10/1000min = $0.01) + 10% buffer. CEILING ($0.05) unchanged by design.

---

## Framing (read this first — Rev 5 reframe)

**Both providers ship.** The economics force a tiered architecture, not a single-provider pick:

| | Simli Trinity-1 | Tavus Phoenix-4 |
|---|---|---|
| Architecture | Gaussian neural, optimized for speed/cost | Gaussian-diffusion, emotional intelligence + active listening, full-duplex |
| Claimed latency | <300ms audio→video | **sub-600ms end-to-end conversational** (per Tavus launch Feb 19 2026) |
| Output | lipsync-accurate, upper-face slightly stiff | 40fps 1080p HD, dynamic micro-expressions, nodding/blinking while user speaks |
| Price (pay-as-you-go) | ~$0.01/min (**conservative: $0.015/min — pending written quote**) | $0.32–$0.37/min |
| At 600K min/mo, 100% traffic | ~$9K/mo | ~$200K/mo — **uneconomic** |
| Role in v1 | **Free-tier primary** (all free sessions) | **Premium/boardroom-tier primary** (admin-flipped users in v1, Stripe paid users in v2) |

This lands inside CLAUDE.md's new **provider-agnostic architecture** principle: one `AvatarBridge` interface, both providers behind it, routed at session-open from `sessions.tier_at_session`. We ship Simli + Tavus Phoenix-4 in parallel. YC pitch: "The face is a commodity; the brain is the moat. Simli and Tavus are in a price war to zero — we plug in whoever wins each tier."

**The two qualification questions Spike B answers:**
1. **Does Simli clear the free-tier engagement floor?** (lipsync "good enough," mobile stable, iOS PWA recovers) — if yes, free tier ships with Simli. If no, free tier ships voice-only.
2. **Does Tavus Phoenix-4 hit the premium-tier bar?** (wins on active-listening / emotional intelligence, works in echo mode at sub-600ms, stable on mobile) — if yes, premium/boardroom tier ships with Tavus. If no, premium/boardroom UI stays "coming soon" until Phoenix-5 or competitor.

**v1 tier reality:** no Stripe = premium/boardroom is admin-flip-only. Vuk + a few testers reach those tiers for the YC demo. 99% of v1 traffic flows through Simli. Tavus code ships to main with full interface parity so the demo can show the tier router in action and v2 billing switch is one env flip.

---

## Decisions locked (Rev 5 — tier-routed)

1. **Both providers get a real matrix** (Rev 5 shift — Tavus is no longer "reference cell only" because Tavus IS the premium-tier primary). Simli matrix: full 10-clip × dual chunk-size × 3 iter on desktop + 3-clip × 3-iter on Pixel + 3-clip × 2-iter on iPhone. Tavus matrix: 10-clip × 3-iter on desktop (single chunk path — Tavus uses Daily.co transport, no dual-size) + 3-clip × 3-iter on Pixel + 3-clip × 2-iter on iPhone. **Counting convention**: "N clips × M iter" = M runs per unique clip (so "3 × 3" = 9 total runs).
2. **Same source footage for both replicas, plus a reference clip.** Vuk records Video A (2-min, replica training material for both providers) and Video B (2-min, raw reference shown once to Vuk-naïve raters at start of scoring).
3. **Replica training starts TONIGHT (Apr 21 evening).** Tavus kicked off **first** (longer unknown SLA); Simli in parallel.
    - **Symmetric defer rules** (fixed from Rev 2):
      - Simli replica not ready by Apr 22 18:00 → defer Phase 2-Simli to Apr 23 PM; bridge wiring against stock allowed but not measurement.
      - Tavus replica not ready by Apr 23 12:00 → defer Tavus cell to Day 11, auto-select branch (a) conditional on Simli passing absolute gate.
      - **Either replica not ready by Apr 23 09:00 → defer entire spike 24h.** Do not measure one provider's real replica against the other's stock.
4. **Transport for Simli**: Simli JS SDK + WS control (START/SKIP/DONE). `is_trinity_avatar` flag layer (session-param vs replica-param vs account-param) must be confirmed in Phase 0 **before** SimliBridge is written. If it's a training-time setting, Simli retraining is Apr 22 AM, not Apr 21 — timeline tightens by 12h.
5. **Transport for Tavus**: Phase 0 probes canonical echo ingest (RTC track publish vs `sendAppMessage`). Use canonical path; document the finding. All Tavus clips offline-resampled to 24k (`ffmpeg -ar 24000 -sample_fmt s16`), mandatory.
6. **Echo mode only, not Tavus LLM/TTS.**
7. **Rater pool split (fixed from Rev 2)**:
    - **4 Vuk-naïve raters** — gate-relevant. They judge lipsync alignment (1–10) and "mouth in sync with audio" (y/n). They see Video B once as "this is who the avatar is trying to be" but have no prior relationship with Vuk.
    - **2 Vuk-knowers** — side-channel only, non-gating. They judge resemblance + uncanny-valley + "would listen 5 min". These scores appear in the report as context but do not enter the decision gate.
    - Vuk himself does not rate.
    - Sentinels: 2 per rater session. **If ≥2 of 4 Vuk-naïve raters fail sentinel (inconsistent scores by >2), abort scoring and re-run with fresh raters** — do not compute means on n≤2.
8. **Blind rater lipsync-alignment is the PRIMARY signal.** Automated mouth-ROI is **advisory only, not in the gate** (fixed from Rev 2). The luminance-variance method cannot cleanly separate blinks / breathing / idle jitter from first phoneme without per-session idle-baseline calibration + lip-contour displacement detection — that's a week of OpenCV/ML work, out of spike scope. We report the automated number as diagnostic, do not gate on it. Measurement timers that ARE kept:
    - `t0→t1` audio-enqueue → first-chunk-sent (buffering, per chunk-size variant)
    - `t1→t2` first-chunk-sent → first-video-frame-at-all (handshake/I-frame)
    - No `first-mouth-motion` auto-timer in the gate.
9. **Mobile is the gate.** Desktop is PoC. **iOS PWA stress test (fixed from Rev 2)**: 5-min continuous session, then provoke: (a) **lock screen 30s minimum, 2 min soft target**, (b) pull Control Center 10s, (c) trigger real incoming notification, (d) wait for auto-dim. Log first second of `iceConnectionState=disconnected|failed` OR remote track `.muted=true`.
    - "Recovers" means: within 5s of foregrounding, audio resumes + video track unfreezes + no user-visible error toast. Logged per event.
10. **Pipe-stays-warm tested hard**: 3-min silence → resume; 10-min session-boundary (send at min 9/11/14); **plus one 32-min Tavus session** probing the 30-min TTL rollover (M7 from Rev 2 — small cost, large insurance for Day 13–14).
11. **No new `cogs_log` columns** — `service` enum already includes `simli|tavus`, `environment` CHECK includes `spike_b` (confirmed in migrations 0001 and 0040). New tables: `spike_b_runs` (run metadata), `spike_b_rater_scores` (rater submissions), `spike_b_rater_tokens` (rater magic-link auth, voice_tickets pattern).
12. **Tier-routed decision tree** (Rev 5):
    - **Simli passes free-tier gate AND Tavus passes premium-tier gate** → ship both, tier-routed at session-open via `sessions.tier_at_session` (`AVATAR_PROVIDER_FREE=simli`, `AVATAR_PROVIDER_PREMIUM=tavus`, `AVATAR_PROVIDER_BOARDROOM=tavus`).
    - **Simli passes, Tavus fails** → ship Simli on all tiers; premium/boardroom UI shows "premium experience coming soon" placeholder; revisit Tavus at next Phoenix drop.
    - **Simli fails, Tavus passes** → free-tier ships voice-only (no avatar); premium/boardroom avatar-enabled with Tavus; revisit Simli at next Trinity drop.
    - **Both fail** → voice-only v1 across all tiers; avatar to v1.1.

    Runtime error-swap (the Rev 4 "primary→secondary on error taxonomy" concept) is **retired** — tier routing is deterministic from session metadata, not reactive. If Simli fails mid-session for a free user, the session closes with an error code; we do not silently swap a free user onto a $0.37/min Tavus pipe (cost event).
13. **Dual-WebRTC co-existence moved from Day 6 to Day 12 afternoon** (fixed from Rev 2 M4). Day 6 is Feed per CLAUDE.md 22-day plan; avatar+voice on same page only exists once the voice pipeline (Days 8–12) stabilizes. Spike B Phase 4 handoff writes a 2h task into Day 12 PM with a **hard backstop at end of Day 13** if voice pipeline slips: "avatar WebRTC + voice WebRTC/WS co-existence smoke on one page — 2× ICE, 2× TURN, getUserMedia contention, audio-device arbitration."
14. **Rater auth is token-bearing, not admin-session** (Rev 4 C1). Raters are friends/colleagues, not admins. Scoring route is `/rate/[token]` — NOT under `/admin/*`. Token-only auth via `spike_b_rater_tokens` table (voice_tickets shape: `rater_id uuid`, `expires_at`, `consumed_at`, `ua_hash`). `assertAdminFromSession()` would 403 them.
15. **Rater scores persisted to `spike_b_rater_scores`** (Rev 4 C2). Per-row: rater-id, clip-id, randomized-side→provider mapping, lipsync-alignment, mouth-in-sync, sentinel-flag, submitted-at. RLS enabled / zero policies. Raters submit via service-role INSERT from `/api/rate/submit`. CSV export is a server query, not the storage of record.
16. **Same-origin check on every Spike B route** (Rev 4 C3). Copy the `isSameOrigin()` helper used by Spike A's `/api/voice/spike-a/record` (honoring `x-forwarded-host`, forbidding bare `Host`). `/api/spike-b/session`, `/api/spike-b/record`, `/api/rate/submit` — all three.
17. **Spike B does not touch `public.sessions`** (Rev 4 M8). Writes only to `spike_b_runs`, `spike_b_rater_scores`, `cogs_log`. Zero risk of colliding with `sessions_one_active_per_user` (migration 0040:19) if Spike A voice tests run in parallel.
18. **Do NOT route through `cogs_insert_turn` RPC** (Rev 4, post-migrations 0043–0045 note). That RPC is service-role-gated and hardcodes `operation='voice_audio_{input,output}_seconds'` (0045:181,187). Spike B uses `operation='avatar_lipsync_seconds'` and INSERTs directly via `supabaseAdmin().from('cogs_log').insert(...)` — the append-only trigger accepts service-role writes.

---

## UX principles carried over from Spike A

- **Flawless feel > flawless numbers.** A 400ms lipsync that looks *alive* beats a 200ms lipsync that looks like a mannequin.
- **Mask work with work.** Priming Window is Day 5 product work, not in this spike.
- **Pipe stays warm.** Avatar WebRTC never tears down mid-session. Pause audio, don't close connection.

---

## Architecture

```
PWA (browser)
  ├─ Gemini voice output (PCM16 LE mono 16kHz from Fly proxy — reused from Spike A)
  │
  ├─ AvatarBridge interface (src/lib/avatar/avatar-bridge.ts)
  │     open() | sendAudio(pcm16@16k) | cancel() | close()
  │     onVideoTrack(MediaStreamTrack) | onReady() | onError(code, cause, recoverable)
  │     Error taxonomy (const union, enforced):
  │       connect_timeout | token_expired | replica_not_ready | rtc_ice_failed
  │       audio_format_rejected | quota_exceeded | replica_not_found
  │       app_message_too_large | session_idle_killed | session_ttl_expired
  │
  ├─ Tier router (src/lib/avatar/resolver.ts)
  │     resolveAvatarProvider(tier) → 'simli' | 'tavus' | null
  │     Reads sessions.tier_at_session (or Spike-B harness override)
  │     free → AVATAR_PROVIDER_FREE (simli)
  │     premium | boardroom → AVATAR_PROVIDER_PREMIUM / _BOARDROOM (tavus)
  │     Deterministic. No error-swap. No mid-session hot-swap.
  │     On primary failure → close session with taxonomy code; do NOT silently
  │     route free-tier user to premium pipe (cost event).
  │
  ├─ SimliBridge (src/lib/avatar/simli-bridge.ts)        ← free-tier primary
  │   ├─ /compose/token via our server route
  │   ├─ RTCPeerConnection + WS control
  │   ├─ PCM16@16k chunking — dual test 6000B (187ms floor) vs 1920B (60ms)
  │   ├─ Trinity-flag layer per Phase 0 finding (session/replica/account — TBD)
  │   └─ Video track → <video>
  │
  ├─ TavusBridge (src/lib/avatar/tavus-bridge.ts)        ← premium/boardroom-tier primary
  │   ├─ /v2/conversations via our server route (pipeline_mode='echo')
  │   ├─ Replica model: Phoenix-4 (Gaussian-diffusion, full-duplex, sub-600ms)
  │   ├─ daily-js join(conversation_url)
  │   ├─ Audio ingest per Phase 0 finding (RTC track publish preferred)
  │   ├─ conversation.interrupt on barge-in
  │   └─ Video track → <video>
  │
  ├─ Spike B client (src/app/admin/spike-b/spike-b-client.tsx)
  │     ├─ admin-gated via assertAdminFromSession() + isSameOrigin() on all POSTs
  │     ├─ Two <video> panels; blind-mode randomizes side per clip, logs mapping
  │     ├─ Canned-clip selector (10 clips, 16k for Simli, 24k pre-resampled for Tavus)
  │     ├─ Two-timer instrumentation (t0→t1, t1→t2) per run
  │     └─ Recording: MediaRecorder on desktop/Android; QuickTime-over-cable fallback
  │           on iPhone 11 PWA (Phase 0 verifies MediaRecorder codec support)
  │
  └─ Rater scoring client (src/app/rate/[token]/page.tsx) — TOKEN-AUTH only, NOT under /admin/*
        ├─ Token → spike_b_rater_tokens lookup (expires_at, consumed_at, ua_hash bind)
        ├─ Randomized clip order server-side; blind side mapping
        └─ POST /api/rate/submit with same-origin check + token revalidation

Persistence (all RLS-enabled, zero policies, service-role writes only):
  - spike_b_runs          (run metadata + timers + costs)
  - spike_b_rater_scores  (rater submissions — per-clip scores, sentinel flags)
  - spike_b_rater_tokens  (voice_tickets shape: rater_id, expires_at, consumed_at, ua_hash)

Spike B never writes to public.sessions. No unique-index collision risk with parallel Spike A voice tests.
```

---

## Files to build

1. `src/lib/avatar/avatar-bridge.ts` — interface `.d.ts` + error-taxonomy `const union`
2. `src/lib/avatar/resolver.ts` — `resolveAvatarProvider(tier)` tier router (session-open, deterministic, no hot-swap)
3. `src/lib/avatar/simli-bridge.ts` — Simli driver; dual chunk-size harness (free-tier primary)
4. `src/lib/avatar/tavus-bridge.ts` — daily-js driver; Phase-0-confirmed audio path (premium/boardroom primary; Phoenix-4)
5. `src/lib/avatar/cost.ts` — per-provider rates with **pinned `QUOTED_AT` timestamp constant**; **ceiling rates** for kill-switch estimation (`SIMLI_CEILING_USD_PER_MIN=0.05`, `TAVUS_CEILING_USD_PER_MIN=0.50`) until written quote lands
6. `src/lib/avatar/mouth-roi.ts` — advisory automated-metric only (not in gate)
7. `src/app/api/spike-b/session/route.ts` — RSC route, `assertAdminFromSession()` **+ `isSameOrigin()` (copy from Spike A `/api/voice/spike-a/record/route.ts`)**, **pre-run quota check using `total + ESTIMATED_RUN_COST >= cap` with ceiling rates**, plus `count(*) >= MAX_RUNS_PER_DAY` backstop (default 300). Accepts `provider` in body (spike-only override; production reads from tier).
8. `src/app/api/spike-b/record/route.ts` — per-run POST, `assertAdminFromSession()` **+ `isSameOrigin()`**, service-role direct INSERT into `cogs_log` (service=simli|tavus, environment='spike_b', operation='avatar_lipsync_seconds') + INSERT into `spike_b_runs`. **Do NOT call `cogs_insert_turn` RPC** — voice-specific, hardcodes `voice_audio_*_seconds` operation names (migration 0045:181,187). Use a single typed `insertAvatarCogs()` helper so the operation string is defined once, matching Spike A's post-audit M7 drift pattern.
9. `src/app/admin/spike-b/page.tsx` — admin-gate
10. `src/app/admin/spike-b/spike-b-client.tsx` — side-by-side harness
11. `supabase/migrations/20260422000001_spike_b_runs.sql` — three tables: `spike_b_runs`, `spike_b_rater_scores`, `spike_b_rater_tokens`. All RLS enabled, zero policies. **Placeholder landed tonight Apr 21** to lock the migration number.
12. **`artifacts/spike-b/audio/`** (NOT `public/`) — canned WAV clips. **Phase 0 creates Supabase Storage bucket `spike-b-clips` (private, service-role only, no RLS policies). Signed URLs 12h TTL, minted only by admin-gated route.**
13. `scripts/spike-b-phase-0-verify.mjs` — dry-connect Simli + Tavus, check replica status, probe Simli Trinity-flag layer, probe Tavus echo ingest path, **confirm Tavus replica_type accepted on Starter tier (Phoenix-4 or documented alternative)**, probe MediaRecorder codec support, verify Storage bucket exists
14. `.env.example` — `SIMLI_API_KEY`, `TAVUS_API_KEY`, `SIMLI_REPLICA_ID`, `TAVUS_REPLICA_ID`, **`AVATAR_PROVIDER_FREE=simli`**, **`AVATAR_PROVIDER_PREMIUM=tavus`**, **`AVATAR_PROVIDER_BOARDROOM=tavus`**, `SPIKE_B_HARD_CAP_DOLLARS=25`, `SPIKE_B_MAX_RUNS_PER_DAY=300`, `SIMLI_CEILING_USD_PER_MIN=0.05`, `TAVUS_CEILING_USD_PER_MIN=0.50`
15. Private scoring UI: **`src/app/rate/[token]/page.tsx` (NOT `/admin/*`)**, token-auth only via `spike_b_rater_tokens` (voice_tickets pattern). Per-rater magic link. Server-randomized clip order. `/api/rate/submit` writes to `spike_b_rater_scores`. CSV export is an admin-gated query route.
16. Phase-1 acceptance: **kill-switch fires cleanly** — `cap=$0.01`, `MAX_RUN_SECS=60`, `SIMLI_CEILING=0.05` → `estimatedRunCost = $0.05 >= $0.01` → 429 + no provider call.

---

## Phased execution

### Phase 0 — Access + training + probes + clip recording (TONIGHT Apr 21, ~4h)

- [ ] Vuk: record **Video A** (2-min replica training) + **Video B** (2-min rater reference) + **10 canned clips** per spec:
  - Clips: 48kHz / 24-bit source; normalize to −16 LUFS integrated; true-peak −3 dBFS; noise gate −55 dBFS
  - Clip 10 whispered: −24 to −28 dBFS (loud-whisper, not breath-whisper) — otherwise it sits at Simli's ingest noise floor and the measurement is dominated by provider AGC, not fidelity
  - Trim silence head/tail; resample offline to 16k (Simli) + 24k (Tavus) via `ffmpeg -ar {16000|24000} -sample_fmt s16`
  - Save to `artifacts/spike-b/audio/NN_<label>_{16k,24k}.wav`
- [ ] Vuk: Tavus Starter tier ($59/mo); submit Video A via `POST /v2/replicas` **first**
- [ ] Vuk: Simli account; upload best frame from Video A → start training in parallel
- [ ] Claude: **land placeholder migration** `20260422000001_spike_b_runs.sql` TONIGHT (three tables: `spike_b_runs`, `spike_b_rater_scores`, `spike_b_rater_tokens`) to reserve the number
- [ ] Claude: **create Supabase Storage bucket `spike-b-clips`** — private, service-role only, no RLS policies; verified by verify script
- [ ] Claude: **update Sentry scrub** (`sentry.server.config.ts` + `sentry.client.config.ts`) — extend `redactInvitePath()` (or add a peer `redactSpikeB()`) to scrub URL query + JSON body string occurrences of: `simli_token`, `compose_url`, `conversation_url`, `daily_room_url`, `api_key`, `token`. Explicit regex, before Phase 1 writes any provider call.
- [ ] Claude: `scripts/spike-b-phase-0-verify.mjs` — checks:
    - Simli key validity + compose-token dry mint
    - Tavus key validity + `GET /v2/replicas` status + **confirm Starter-tier-accepted `replica_type` for echo mode (phoenix-3 or documented alternative)** — wrong type = 24h of wasted training
    - **Simli `is_trinity_avatar` flag layer**: session / replica / account — read docs.simli.com, SDK code, or ask support
    - **Tavus echo canonical ingest**: RTC track publish vs `sendAppMessage` — read docs, daily-js SDK, Tavus Discord
    - **MediaRecorder codec support** on target devices — run `MediaRecorder.isTypeSupported(...)` on desktop Chrome + Pixel 7 Pro Chrome + iPhone 11 Safari PWA; if iPhone PWA fails, commit to QuickTime-over-cable for iOS Phase 3 recordings. **Log the result either way** (including negative results) so future spikes don't re-verify.
    - Supabase Storage `spike-b-clips` bucket exists; signed-URL mint path works end-to-end
- [ ] Claude: **email Simli support** for written Trinity-tier per-minute pricing at 100K/mo commit. Quote attaches to plan before Phase 4.
- **Trip-wires**:
    - Simli replica not ready by Apr 22 18:00 → Phase 2-Simli defers to Apr 23 PM
    - Tavus replica not ready by Apr 23 12:00 → Tavus cell defers to Day 11
    - Either replica not ready by Apr 23 09:00 → whole spike defers 24h
    - Simli Trinity-flag is a training-time param (not session) → retrain kicks off immediately; Phase 1 Simli work slips by training duration
    - Phase 0 over 6h → escalate, re-plan

### Phase 1 — Bridges + harness + kill-switch test (1 day, Apr 22)

- [ ] `AvatarBridge` interface + error-taxonomy `const union`
- [ ] **Tier router `resolveAvatarProvider(tier)`**:
    - Deterministic mapping from `free | premium | boardroom` → `simli | tavus | null`.
    - Reads `AVATAR_PROVIDER_FREE | _PREMIUM | _BOARDROOM` env vars so swap is one-env-flip.
    - **No error-swap semantics**. On primary failure during a session, bridge emits taxonomy code + closes; tier router is NOT re-invoked mid-session. This prevents silent free→premium cost events.
- [ ] SimliBridge: compose-token → PC + WS → audio chunking (both sizes) → skip/done; one clip desktop smoke. Code references confirmed Trinity-flag layer from Phase 0.
- [ ] TavusBridge: conversation create (Phoenix-4) → daily-js join → confirmed audio ingest path → echo → interrupt; one clip desktop smoke
- [ ] `/api/spike-b/session`: **`assertAdminFromSession()` + `isSameOrigin()`** (copy helper from `src/app/api/voice/spike-a/record/route.ts` — honors `x-forwarded-host`); pre-run quota gate; `MAX_RUNS_PER_DAY` backstop; accepts `provider` override for spike harness
- [ ] `/api/spike-b/record`: **`assertAdminFromSession()` + `isSameOrigin()`**; direct `supabaseAdmin().from('cogs_log').insert(...)` via `insertAvatarCogs()`; `cost_usd` clamped to `min(reported, RUN_SECONDS × CEILING_USD_PER_MIN)`
- [ ] `/api/rate/submit`: **`isSameOrigin()` + token revalidation against `spike_b_rater_tokens`**; service-role INSERT into `spike_b_rater_scores`; no admin gate
- [ ] Canned library served via Supabase Storage signed URLs (12h expiry) from `spike-b-clips` bucket
- [ ] Spike B client UI: dual `<video>`, blind-mode side-randomization with logged mapping, clip selector, metrics panel
- [ ] Recording: MediaRecorder desktop/Android; iPhone uses QuickTime-over-cable if Phase 0 confirmed PWA MediaRecorder unreliable
- [ ] **Kill-switch acceptance**: `cap=$0.01`, `MAX_RUN_SECS=60`, `SIMLI_CEILING=0.05` → `estimatedRunCost = $0.05 >= $0.01` → 429 + no provider call. Log in `.claude_learnings.md`.
- [ ] **Error-taxonomy acceptance**: one forced failure per category; bridge emits correct code; Sentry tag present
- [ ] **Tier-router acceptance**: mock session with `tier='free'` → resolver returns `simli` + SimliBridge opens. Set `tier='premium'` → resolver returns `tavus` + TavusBridge opens. Force Simli to fail during a free session → session closes with `rtc_ice_failed` (NO silent swap to Tavus). Confirm no `cogs_log` row for a provider the session wasn't routed to.
- [ ] **Same-origin acceptance**: POST to each spike-b route with forged `Host: evil.example.com` and valid admin cookie → 403.

### Phase 2 — Run, measure, stress (0.5–1 day, Apr 23)

**Desktop Chrome:**
- [ ] 10 clips × Simli × 3 iter × 2 chunk-sizes (6000B vs 1920B) = 60 runs
- [ ] 10 clips × Tavus × 3 iter = 30 runs  (Rev 5: full matrix, Tavus is premium-tier primary — no longer "reference cell")
- [ ] Barge-in: 5 clips × both providers; SKIP/interrupt mid-playback; **measurement method**: frame-by-frame inspection of the 30fps recording timeline (Premiere/DaVinci/VLC frame-step), manually timestamp the frame where the avatar's mouth visibly closes or transitions to rest. Known precision floor: **±33ms (one frame @ 30fps)**. Record raw frame numbers in `spike_b_runs.metadata.bargein_frames`.
- [ ] 10-min live-Gemini stability × both providers
- [ ] **Pipe-stays-warm**: 3-min silence → resume (≤400ms target); 10-min session-boundary (audio at min 9/11/14)
- [ ] **30-min TTL probe (Tavus)**: one 32-min continuous session, audio every 2 min; observe minute-30 rollover. ≈ $12.
- [ ] **Simli session cap probe**: read `max_idle_time` + absolute session limit from Phase 0 docs; one run deliberately hitting whichever is hit first
- [ ] **Tavus active-listening capture** (Rev 5): during two 60s Tavus runs, leave mic open with user speaking (NOT sending to echo) → record Phoenix-4's active-listening behavior (nods, micro-expressions). This is the premium-tier differentiator; must be visibly present vs. Simli's idle loop.

**Pixel 7 Pro Chrome (WiFi + LTE):**
- [ ] 3 clips × Simli × 3 iter = 9 runs
- [ ] 3 clips × Tavus × 3 iter = 9 runs  (Rev 5: Tavus needs mobile qualification too)

**iPhone 11 Safari installed PWA (WiFi):**
- [ ] 3 clips × Simli × 2 iter = 6 runs
- [ ] 3 clips × Tavus × 2 iter = 6 runs  (Rev 5: Tavus full mobile cell)
- [ ] **iOS PWA stress (M1-fixed)**: 5-min continuous per provider. Provoke:
    - Lock screen 30s → verify no drop
    - Lock screen 2 min → verify drop behavior (expected), measure recovery
    - Control Center pull 10s
    - Real incoming notification
    - Auto-dim wait
    - Log ICE state + track muted events with timestamps
    - "Recovers" = audio resumes ≤5s of foregrounding AND video unfreezes ≤5s AND no error toast
- [ ] Record runs via MediaRecorder (if Phase 0 confirmed) OR QuickTime-over-cable

### Phase 3 — Blind scoring (0.5 day, Apr 24 AM)

- [ ] Extract 20 A/B clip pairs from Phase 2 recordings (10 desktop + 5 Android + 5 iPhone). **Provider split is now roughly 50/50 Simli/Tavus** (both are ship candidates, both need independent scoring). Each A/B pair is same clip, different provider, randomized side.
- [ ] Randomize provider-to-side per clip; log mapping server-side in `spike_b_rater_scores.side_provider_map`
- [ ] **Sentinels are NOT revealed to raters.** Same A/B clip pair injected twice at randomized positions; drift between the two ratings of the same clip is the sentinel signal.
- [ ] **Vuk-naïve raters (n=4, gate-relevant)**: 2 × 10-clip sessions with 5-min break; see Video B once at start; rate each clip on lipsync-alignment (1–10) + "mouth-in-sync" (y/n) + **new Rev 5 axis: "feels alive" (1–10)** — captures Phoenix-4's active-listening advantage without raters needing to know what they're looking for
- [ ] **Vuk-knower raters (n=2, side-channel)**: same set; rate resemblance, uncanny-valley flag, "would listen 5 min"
- [ ] **Sentinel abort rule**: if ≥2 of 4 Vuk-naïve raters show >2-point drift between the two showings of the same clip, abort, re-run with fresh raters
- [ ] Compute per-provider: mean lipsync-alignment, mouth-in-sync y-rate, **feels-alive mean** (Vuk-naïve); resemblance/uncanny/would-listen (Vuk-knower, context only). Simli and Tavus scored independently against their respective tier gates.

### Phase 4 — Decision + docs (0.5 day, Apr 24 PM)

- [ ] Fill Results table (per-provider, per-tier-gate)
- [ ] Tier-qualification decision tree (Rev 5): Simli free-tier gate pass/fail × Tavus premium-tier gate pass/fail → 1 of 4 outcomes
- [ ] Update CLAUDE.md: `AVATAR_PROVIDER_FREE | _PREMIUM | _BOARDROOM` pinned with today's providers; Day 13–14 migration plan for `creators.avatar_replica_id` + `avatar_provider` enum noted
- [ ] Write 2h task into **Day 12 PM** for dual-WebRTC co-existence smoke, with **hard backstop: must land by end of Day 13**
- [ ] PR merges to main (both bridges land + tier router; premium/boardroom UI has "coming soon" placeholder except for admin-flipped testers)
- [ ] `.claude_learnings.md` entry: Phase 0–3 surprises; Trinity-flag resolution; Tavus echo ingest path; MediaRecorder device matrix (incl. negatives); kill-switch fired; TTL behavior; 24k→16k resample requirement for Day 5; Phoenix-4 active-listening captured in `feels-alive` axis

---

## Success gates (Rev 5 — two independent gates, one per tier)

Both providers are evaluated against their OWN tier bar. A provider can pass its tier gate while the other fails theirs — outcome space is 2×2, not binary.

### Free-tier gate: Simli passes iff all true

- **Blind fidelity (Vuk-naïve raters)**: mean lipsync-alignment ≥ **6.0/10** (slightly lower bar than premium — free tier is "good enough"); mouth-in-sync y-rate ≥ **65%**
- **Automated latency (diagnostic)**: `t0→t1` and `t1→t2` reported per chunk-size variant
- **iOS PWA**: 0/6 cold-connect failures AND 5-min stress recovers from ≥3/4 provoked events. **Recovery mechanism**: automatic — on `iceConnectionState=disconnected|failed` OR track `.muted=true` for >2s, bridge issues `restartIce()`; if that fails within 3s, emits `rtc_ice_failed` and closes. No user-tap button. Lock-2min characterized, not gated.
- **Barge-in**: visible lip-close ≤ **400ms** after SKIP, median of 5, frame-stepped at 30fps (±33ms precision)
- **Stability**: 10-min continuous, 0 forced reconnects, 0 frozen frames > 1s
- **Pipe-stays-warm**: 3-min silence resume ≤ 400ms; 10-min session-boundary sends land without rebuild
- **Cost sanity**: Simli spike spend ≤ $5; written quote received OR conservative $0.015/min default

### Premium/boardroom-tier gate: Tavus Phoenix-4 passes iff all true

- **Blind fidelity**: mean lipsync-alignment ≥ **7.5/10** (higher bar — this is the premium UX promise); mouth-in-sync y-rate ≥ **80%**
- **"Feels alive" axis** (Rev 5, new): mean ≥ **7.0/10** — captures active-listening / micro-expressions / nodding. Must exceed Simli's feels-alive mean by ≥ **1.5** (otherwise Phoenix-4's premium differentiator isn't visible to users → no reason to ship premium path).
- **Latency**: end-to-end conversational latency ≤ **800ms** (Tavus claims sub-600ms; give 200ms echo-mode overhead budget)
- **iOS PWA**: same recovery contract as free-tier gate (restartIce + 3s timeout)
- **Barge-in**: `conversation.interrupt` produces visible lip-close ≤ **500ms** (Tavus's transport is heavier; slightly wider budget)
- **Stability**: 10-min continuous, 0 forced reconnects, 0 frozen frames > 1s
- **30-min TTL**: either clean rollover OR documented closure behavior with user-visible error AND a Day 13–14 plan for mitigation
- **Cost sanity**: Tavus spike spend ≤ $20 (incl. 32-min TTL probe)

**Strict-AND with one-override exception for each gate**: if a provider passes everything except one mobile-cell failure (iPhone OR Android, not both), tier ships **conditional on a Day 5 mobile-fix spike**. Two mobile cells failing → that tier's provider does NOT ship; tier shows "coming soon" placeholder.

### Outcome matrix (2×2)

| Simli free-tier gate | Tavus premium-tier gate | Ship decision |
|---|---|---|
| PASS | PASS | Tier-routed: free→Simli, premium/boardroom→Tavus. Full provider-agnostic architecture live. YC pitch intact. |
| PASS | FAIL | Ship Simli on all tiers; premium/boardroom UI = "premium experience coming soon"; revisit Tavus at next Phoenix drop. |
| FAIL | PASS | Free-tier ships voice-only (no avatar); premium/boardroom ships Tavus for admin-flipped testers. Revisit Simli at next Trinity drop. |
| FAIL | FAIL | Voice-only v1 across all tiers; avatar to v1.1. |

---

## Decision tree — superseded by 2×2 outcome matrix above (Rev 5)

See "Outcome matrix (2×2)" in Success gates. Rev 5 retires the Rev 4 primary/secondary runtime-fallback concept because tier routing is now deterministic at session-open — silent cross-tier swap on error would create unconsented cost events ($0.01/min free user suddenly at $0.37/min on Tavus). On primary failure, the session closes with an error code; the user sees a visible error, not a hidden cost surprise.

**v1 tier reality**: premium/boardroom are admin-flip-only until Stripe lands in v2. Tavus path ships fully wired; real user traffic hits it only for admin-flipped testers. UI shows "premium experience — coming soon" for non-premium users viewing premium-gated surfaces.

---

## Test library spec (`artifacts/spike-b/audio/`)

10 clips, each 3–8s, PCM16 LE mono. Two versions per clip: `_16k.wav` + `_24k.wav`. Recording spec: 48kHz/24-bit source, −16 LUFS integrated, −3 dBFS true peak, −55 dBFS noise gate, trimmed.

| # | Clip | Target | Focus |
|---|---|---|---|
| 01 | "Hey, welcome to OakLeague." | greeting baseline | mixed |
| 02 | "Papa Bear packed bags." | bilabial repetition | /p/ /b/ |
| 03 | "She sells seashells." | fricatives | /s/ /ʃ/ |
| 04 | "Oooo, ahhhh, eeee." | vowel hold | sustained |
| 05 | "Ha. Ha ha ha. Hahaha!" | laugh escalation | glottal + non-speech |
| 06 | "I really really really mean it, seriously." | fast speech | elision |
| 07 | "Wait… are you serious?" | question, pause | prosody |
| 08 | "His name is Przemysław." | hard name | clusters |
| 09 | "Look. I need you to listen." | emphasis | stress |
| 10 | "*loud whisper* between you and me" | low amplitude (−24 to −28 dBFS) | AGC stress |

---

## Kill-switch — concrete contract (fixed from Rev 2, numbers cleaned in Rev 4)

```ts
// src/app/api/spike-b/session/route.ts (pre-run, before minting anything)
const SIMLI_CEILING  = Number(process.env.SIMLI_CEILING_USD_PER_MIN ?? 0.05);
const TAVUS_CEILING  = Number(process.env.TAVUS_CEILING_USD_PER_MIN ?? 0.50);
const CAP            = Number(process.env.SPIKE_B_HARD_CAP_DOLLARS ?? 25);
const MAX_RUNS       = Number(process.env.SPIKE_B_MAX_RUNS_PER_DAY ?? 300);
const MAX_RUN_SECS   = 60; // longest planned clip + buffer

const estRate = provider === 'tavus' ? TAVUS_CEILING : SIMLI_CEILING;
const estimatedRunCost = (MAX_RUN_SECS / 60) * estRate;

const rows = await supabaseAdmin
  .from('cogs_log')
  .select('cost_usd')
  .in('service', ['simli','tavus'])
  .eq('environment', 'spike_b')
  .gte('created_at', startOfUtcDay());

const total = (rows.data ?? []).reduce((s, r) => s + Number(r.cost_usd), 0);
const runCount = rows.data?.length ?? 0;

if (total + estimatedRunCost >= CAP)       return json({error:'quota_exceeded'}, 429);
if (runCount + 1 > MAX_RUNS)                return json({error:'run_count_exceeded'}, 429);
```

And on record:
```ts
// src/app/api/spike-b/record/route.ts (post-run, when inserting cogs_log)
const ceilingRate = service === 'tavus' ? TAVUS_CEILING : SIMLI_CEILING;
const ceilingCost = (durationSeconds / 60) * ceilingRate;
const clampedCost = Math.min(reportedCost, ceilingCost);
// INSERT with cost_usd = clampedCost
```

**Phase 1 acceptance (exact numbers, no alternates)**: set `SPIKE_B_HARD_CAP_DOLLARS=0.01`, keep defaults `MAX_RUN_SECS=60` and `SIMLI_CEILING_USD_PER_MIN=0.05`. On the first run, `estimatedRunCost = (60/60) × 0.05 = $0.05` and `0 + 0.05 >= 0.01` → route returns 429 `quota_exceeded`, no provider call made. Confirm via Sentry breadcrumb + provider dashboard (no new session minted).

---

## Security review

- `SIMLI_API_KEY`, `TAVUS_API_KEY`: server-only.
- Tavus `conversation_url` is **time-scoped** via `max_call_duration=1800` (30 min) — not single-use; URL-accessible until TTL. Not a security claim, a lifecycle claim.
- Simli compose token: TTL-bound, single-session (verify Phase 0).
- **Admin gate**: `/api/spike-b/*` + `/admin/spike-b/*` via `assertAdminFromSession()`.
- **Same-origin gate** (Rev 4 C3): `/api/spike-b/session`, `/api/spike-b/record`, `/api/rate/submit` each call `isSameOrigin(req)` (copy verbatim from `src/app/api/voice/spike-a/record/route.ts`, which honors `x-forwarded-host` — that pattern was debugged twice post-Spike-A per `.claude_learnings.md` 2026-04-21 ngrok entry). Forged `Host: evil.example.com` with a valid admin cookie → 403.
- **Rater auth gate** (Rev 4 C1): `/rate/[token]` and `/api/rate/submit` are NOT admin-gated. Auth is exclusively via `spike_b_rater_tokens` row lookup — `expires_at > now()`, `consumed_at IS NULL`, `ua_hash` matches current request UA hash. Single-use: consume on first successful submission.
- Recordings in `artifacts/spike-b/` `.gitignore`d; shared via Supabase Storage signed URL 12h expiry from private bucket `spike-b-clips`.
- **Sentry scrub** (`sentry.server.config.ts` + `sentry.client.config.ts`, Rev 4 C4): extend `redactInvitePath()` or add a peer `redactSpikeB()`. Both must scrub **URL query AND JSON body string occurrences** (conversation_url/compose_url often appear in error payloads, not just URLs):
    - `Authorization: *` header variants (already covered)
    - Query params + body strings: `api_key`, `token`, `conversation_url`, `compose_url`, `simli_token`, `daily_room_url`
    - Explicit regex per name, not a single greedy pattern. Lands **before** Phase 1 writes any provider call.
- **Env-var replica IDs are spike-only**. Day 13–14 migrates to `creators.avatar_replica_id text` (opaque string, not uuid — both providers use opaque strings) + `avatar_provider` enum appended to `20260420000001_extensions_and_enums.sql`.

---

## Economics (Rev 5 — tier-routed, both ship)

| | Spike B cost | Production unit economics | Production @ hypothetical 600K min/mo tier split |
|---|---|---|---|
| Simli Trinity (free tier, @ $0.015/min conservative) | ~$0.30 (75 runs across desktop + 2 mobile cells) | $0.015/min | At 95% free traffic → **~$8.6K/mo** |
| Tavus Phoenix-4 (premium/boardroom tier) | ~$16 (45 runs + 32-min TTL probe + active-listening capture) + **$59 Starter tier** = **~$76** | $0.32–0.37/min | At 5% premium traffic → **~$10K/mo** (30K min × $0.33) |
| Replica training | Simli $0; Tavus $0 (within Starter) | One-time per creator | — |
| **Spike B total** | **~$76** | — | **~$18.6K/mo combined** vs. $200K/mo all-Tavus = **10× cheaper with tiered routing** |

Note on traffic split: 95/5 is an early-v2 assumption. The full provider-agnostic architecture means the split doesn't lock us in — at 10K DAU we renegotiate with either provider (or a third entrant) and the code changes are `AVATAR_PROVIDER_FREE=<winner>` + ship.

---

## Risks / unresolved

- iOS PWA WebRTC for both Simli and Daily.co unverified in installed-PWA context → Phase 0 30-min smoke
- Simli training SLA unverified → pre-committed defer rules
- Simli `is_trinity_avatar` flag layer unverified → Phase 0 resolves BEFORE bridge code
- Tavus canonical echo ingest unverified → Phase 0 resolves
- Tavus `persona_id=null` compatibility in echo mode unverified → Phase 0 smoke
- **Tavus Starter-tier replica_type support** (Rev 5 updated) — **Phoenix-4** launched Feb 19 2026 (verified via tavus.io + BusinessWire Feb-2026 launch announcement). Phase 0 confirms Phoenix-4 is the accepted echo-mode replica type on Starter; `POST /v2/replicas` docs checked before training starts. Wrong type = 24h of wasted training.
- **Tavus active-listening in echo mode** (Rev 5) — Phoenix-4's big differentiator is active listening / dynamic nodding during user speech. Echo mode is server-driven audio playback, NOT conversational. Phase 2's 2-minute active-listening capture test verifies whether the listening behavior actually surfaces when we drive Tavus via echo. If not, the premium-tier differentiator collapses to "slightly better lipsync" — the `feels-alive` axis in the premium gate exists to catch this.
- Blind-score n=4 → directional only
- Dual-WebRTC co-existence → Day 12 PM task with Day 13 EOD hard backstop
- MediaRecorder in iPhone 11 PWA unverified → Phase 0; QuickTime-over-cable fallback pre-staged
- **24k→16k resample upstream of SimliBridge** (Rev 4 small) — Gemini Live outputs PCM16@24k; AvatarBridge contract is `sendAudio(pcm16@16k)`. Day 5 production wire-up needs a resampler (AudioWorklet or server-side). Not a spike-scope bug; documented now so it's not a Day 5 surprise.

---

## CLAUDE.md compliance checklist

- [x] Every paid API call → `cogs_log` (service, environment, clamped cost) — direct INSERT, NOT `cogs_insert_turn` (voice-specific)
- [x] Kill-switch: hard cap + run-count backstop + pre-run estimate; Phase 1 acceptance fires the gate with exact numbers
- [x] RLS every table; `spike_b_runs`, `spike_b_rater_scores`, `spike_b_rater_tokens` all service-role only, zero policies
- [x] `assertAdminFromSession()` on admin routes; `/rate/[token]` uses token-auth ONLY (raters aren't admins)
- [x] `isSameOrigin()` on every Spike B POST route (Spike A pattern)
- [x] Error taxonomy `const union`, Sentry-tagged, one test per code
- [x] **Tier router (Rev 5)**: deterministic at session-open from `sessions.tier_at_session`; no mid-session hot-swap; no error-driven cross-tier fallback (prevents silent cost events)
- [x] **Provider-agnostic architecture (Rev 5)**: both providers behind same `AvatarBridge`; swap cost = one env var; matches new CLAUDE.md principle
- [x] Sentry scrub: URL query + JSON body for all provider URL/token names, explicit regex
- [x] No silent catches
- [x] No hardcoded founder: env-var replica IDs flagged spike-only; Day 13–14 migration committed
- [x] Server routes: getCaller → same-origin → gate → whitelist → mutate → revalidate
- [x] No `router.push()` for auth/role changes (N/A)
- [x] Pre-deploy red team at Phase 4 close
- [x] `avatar_provider` enum + `creators.avatar_replica_id text` pre-committed for Day 13–14
- [x] Spike B never writes `public.sessions` → no collision with `sessions_one_active_per_user` (migration 0040)
- [x] **v1 tier reality (Rev 5)**: premium/boardroom admin-flip-only; UI placeholder "coming soon" for non-premium users viewing premium surfaces; Stripe wire-up is v2 one-env-flip

---

## Revision log

- **2026-04-21 Rev 1** — initial draft.
- **2026-04-21 Rev 2** — Round 1 resolved: C1 rebutted (schema already supports), C2 adopted (pixel-diff→raters+OffscreenCanvas), C3 dual-chunk-size, C4 Phase-0 echo probe + pre-resample, C5 rater-reference + pre-commit defer rule; M1–M6 adopted; branch tree → two-branch.
- **2026-04-21 Rev 3** — Round 2 resolved.
    - **C1**: automated mouth-ROI dropped from gate → advisory only; blind raters = sole gate signal. Noise-floor calibration not solvable in spike scope. `first-mouth-motion` timer removed; only `t0→t1` (buffering) + `t1→t2` (handshake) remain.
    - **C2**: rater pool split. 4 Vuk-naïve (gate-relevant, lipsync + mouth-in-sync). 2 Vuk-knowers (side-channel only, resemblance/uncanny/would-listen — not gating). Vuk himself does not rate.
    - **C3**: kill-switch changed from `total >= cap` to `total + estimatedRunCost >= cap` with ceiling rates. Phase 1 acceptance now fires cleanly. Run-count backstop added.
    - **C4**: `AVATAR_PROVIDER_SECONDARY` added; TavusBridge ships to main as runtime fallback (not feature branch). Runtime resolver swaps on specific error codes, once per session.
    - **C5**: Simli defer rules symmetric with Tavus (Apr 22 18:00 / Apr 23 09:00 cliffs).
    - **M1**: iOS lock 30s min + 2-min soft target; ICE-state + track-muted logging.
    - **M2**: clip recording ownership, schedule, full audio spec (LUFS, dBFS, noise gate, whisper level) added to Phase 0.
    - **M3**: `cost_usd` clamped to ceiling in record-route; `QUOTED_AT` timestamp in cost.ts.
    - **M4**: dual-WebRTC co-existence moved from Day 6 to Day 12 PM (matches 22-day plan).
    - **M5**: MediaRecorder codec probed in Phase 0; QuickTime-over-cable fallback pre-staged for iOS.
    - **M6**: Simli `is_trinity_avatar` flag layer resolved in Phase 0 BEFORE SimliBridge code; retrain risk acknowledged.
    - **M7**: 32-min Tavus TTL probe added to Phase 2.
    - **Smalls**: counting convention stated; clips moved to `artifacts/`; migration reserved tonight; Sentry scrub list expanded (`conversation_url`, `compose_url`, `simli_token`); sentinel abort rule on n≤2; strict-AND with mobile-override exception defined; `creators.avatar_replica_id` typed as `text`; "recovers" defined (audio ≤5s, video ≤5s, no toast).
- **2026-04-21 Rev 4** — Round 3 resolved.
    - **C1 (rater-auth path collision)**: scoring UI moved from `/admin/spike-b/rate?token=...` to `/rate/[token]`; token-auth only via new `spike_b_rater_tokens` table (voice_tickets shape). Raters are friends/colleagues — `assertAdminFromSession()` would 403 them.
    - **C2 (rater scores had no storage)**: added `spike_b_rater_scores` table (rater_id, clip_id, side→provider map, lipsync score, mouth_in_sync, sentinel flag, submitted_at). RLS enabled / zero policies. CSV export is a query, not the storage of record.
    - **C3 (same-origin missing)**: `isSameOrigin()` required on `/api/spike-b/session`, `/api/spike-b/record`, `/api/rate/submit`. Copy helper verbatim from Spike A's record/route.ts (honors `x-forwarded-host`).
    - **C4 (Sentry scrub code-level)**: `redactInvitePath()` (or peer `redactSpikeB()`) gets explicit regex for `simli_token | compose_url | conversation_url | daily_room_url | api_key | token` in **both URL query and JSON body strings**. Lands before Phase 1 writes any provider call.
    - **M5 (kill-switch numbers contradictory)**: acceptance fixed to cap=$0.01, MAX_RUN_SECS=60, SIMLI_CEILING=0.05 → estimate=$0.05 ≥ $0.01 → 429 fires cleanly. Alternate numbers deleted.
    - **M6 (resolver state lifecycle)**: per-session scope (request-scoped server, per-open() client); swap-once semantics; secondary failure after swap is terminal (no flap).
    - **M7 (iOS recovery mechanism)**: automatic — bridge issues `restartIce()` on ICE fail or track-muted >2s; if restart fails within 3s, emit `rtc_ice_failed` + close. No user-tap recovery button within the 30s/CC/notification scope.
    - **M8 (barge-in measurement)**: explicit — frame-by-frame annotation of 30fps recording; ±33ms precision acknowledged. Distinct from dropped auto-mouth-ROI metric — no Rev 3 contradiction.
    - **M9 (Storage bucket undefined)**: Phase 0 creates private `spike-b-clips` bucket (service-role only, no RLS policies). Signed URL 12h TTL, minted only from admin-gated route.
    - **M10 (sentinel wording)**: clarified — sentinels are NOT revealed. Same clip injected twice at randomized positions; drift between ratings is the check. Raters can't "pass" by spotting them.
    - **M11 (public.sessions note)**: architecture now states Spike B writes only to `spike_b_runs` / `spike_b_rater_scores` / `cogs_log`; zero collision risk with `sessions_one_active_per_user`.
    - **M12 (cogs_insert_turn drift guard)**: one-line directive on file item 7 — do NOT route through the RPC (voice-specific, hardcodes `voice_audio_*_seconds` per migration 0045:181,187). Use direct INSERT with `operation='avatar_lipsync_seconds'` through a single typed helper.
    - **Smalls**: Tavus `replica_type` verified in Phase 0 (phoenix-3 or tier-accepted alternative); Day 12 PM gets Day 13 EOD backstop; MediaRecorder iPhone PWA result logged either way (including negative); 24k→16k resample flagged as Day-5 production task (not spike-scope).
- **2026-04-21 Rev 5** — Architectural reframe to provider-agnostic tier routing (option D).
    - **Framing shift**: from "pick Simli or Tavus" to "both ship, tier-routed." CLAUDE.md updated with new **Core Architecture Principle — Provider-Agnostic** section and tier-specific provider env vars (`AVATAR_PROVIDER_FREE | _PREMIUM | _BOARDROOM`). Stack line in CLAUDE.md updated: Simli Trinity-1 (free) + Tavus Phoenix-4 (premium/boardroom), tier-routed.
    - **Phoenix-4 verified** (web search confirmed): Tavus launched Phoenix-4 Feb 19 2026 — Gaussian-diffusion, real-time emotional intelligence, full-duplex (listens + responds simultaneously), 40fps 1080p, sub-600ms end-to-end conversational latency. Justifies premium tier at $0.32+/min.
    - **Runtime resolver retired**: Rev 4's primary→secondary error-swap concept removed. Replaced with deterministic tier router (`resolveAvatarProvider(tier)`). Cross-tier silent swap would create unconsented cost events (free user suddenly on $0.37/min Tavus pipe). On primary failure, session closes with taxonomy code — user sees visible error, not hidden cost.
    - **Tavus matrix upgraded** from 3-clip reference cell to full parity with Simli: 10 × 3 desktop + 3 × 3 Pixel + 3 × 2 iPhone = 45 runs (vs. 13 in Rev 4). Tavus is now a ship candidate for premium tier, not an informational reference.
    - **Two independent tier gates**: Simli free-tier gate (lipsync ≥ 6.0, mouth-in-sync ≥ 65%). Tavus premium-tier gate (lipsync ≥ 7.5, mouth-in-sync ≥ 80%, plus new "feels alive" axis ≥ 7.0 and ≥1.5 above Simli). 2×2 outcome matrix replaces the Rev 4 two-branch tree.
    - **"Feels alive" rater axis added**: captures Phoenix-4's active-listening / micro-expression advantage without raters being told what to look for. Required for premium gate (ensures premium differentiation is user-visible, not just on Tavus's marketing page).
    - **Active-listening echo-mode capture**: new Phase 2 probe (2 × 60s Tavus runs with mic open) to verify Phoenix-4's active listening surfaces in echo mode, not just conversational mode.
    - **v1 tier reality explicit**: premium/boardroom UI = "coming soon" placeholder for non-admin-flipped users until Stripe (v2). Tavus path ships wired so demo can show the router; real premium traffic is ~0% until billing. 2×2 outcome matrix codifies what ships under each outcome.
    - **Economics table updated**: spike ~$76 (mostly Tavus — Simli runs are ~$0.30). Production @ 95/5 tier split ≈ $18.6K/mo vs. $200K/mo all-Tavus (10× savings from tiered architecture).
