# React/Duet Capture — v1 Implementation Plan (DRAFT — pre-audit)

**Owner:** Vuk · **Target:** YC S26 demo (deadline 2026-05-06) · **Status:** Draft for auditor

---

## 1. Goal in one paragraph

A `React` button (a.k.a. Tap-to-Duet) is visible in **all four feed surfaces**: vertical hook feed, horizontal lesson row inside a creator's drawer, long-form `/v/[id]` viewer, and `/s/[id]` Ask session. One tap captures a 9:16 split-screen clip — user selfie on top half, source content (hook / long-form / live avatar) on bottom — with mixed audio (source + mic + avatar) and produces a shareable MP4. UX bar = 11/10: zero modal speedbumps after first permission grant, zero broken states across iOS Safari 17+, iOS PWA, Android Chrome, desktop Chrome. The recording UX is **the same in every mode**; only the bottom-half source differs.

## 2. UX state machine (the contract)

```
IDLE ──tap React──▶ PRIMING (acquire cam+mic, ~200ms) ──▶ ARMED (red dot)
                            │ deny → DENIED_FALLBACK (audio-only "voice memo" path)
                            │ revoked → REVOKED_TOAST (one tap to retry)
ARMED ──tap React again──▶ STOPPED ──▶ PREVIEW (scrub/trim) ──▶ SHARE | DISCARD
ARMED ──swipe vertically──▶ TEARDOWN (release cam) ──▶ IDLE  (next clip starts cold)
ARMED ──swipe horizontally (lesson rail / hook within creator) ──▶ ARMED (kept warm)
ARMED ──tap Ask (mic icon)──▶ ARMED + Ask scene transitions in (capture continues uninterrupted)
ARMED ──60s elapsed──▶ STOPPED (hard cap; v1)
ARMED ──app backgrounds──▶ STOPPED (iOS will kill us anyway; we own the moment)
```

**Single capture session** spans IDLE→STOPPED. Whatever happens in between (carousel, Ask scene swap-in, audio ducking) does not break the recording. This is the "always-on toggle" the other agent named.

## 3. Architecture — single capture pipeline

```
┌─ user-cam (getUserMedia) ─────────────────┐
│                                            │
│                                            ▼
│                                     [CompositeCanvas 540×960 @30fps]
│                                            │
└─ source-video <video> el (HLS / WebRTC) ──┘
                                             │
                                  canvas.captureStream(30) → videoTrack
                                             │
[Web Audio AudioContext]                     │
   ├─ mic MediaStreamSource ─┐               │
   ├─ source <video> tap ────┤── GainNodes ──┤── MediaStreamDestination → audioTrack
   └─ avatar audio track ────┘    (ducker)   │
                                             ▼
                              new MediaStream([videoTrack, audioTrack])
                                             │
                              MediaRecorder.start(timeslice=1000) ──▶ Blob[]
```

**One pipeline, three sources.** The compositor swaps which source feeds the bottom half:
- **Hook mode**: bottom = current `<video>` element from `HookPanel` (HLS via MuxVideo).
- **Long-form mode**: bottom = `<video>` from `LongFormPlayer`.
- **Ask mode**: bottom = `<video>` element whose `srcObject` was populated by `simli-bridge.ts` from `onVideoTrack`. We attach `onAudioTrack` output into the audio mixer.

Crossing modes mid-recording (e.g. hook → tap Ask → avatar replaces source) is just a swap of the `sourceVideoEl` ref the canvas RAF reads from. **No teardown.**

**Why not `getDisplayMedia`?** Not supported on iOS Safari (any version through 18). Even on Android, it shows a permission picker and risks user picking "Entire screen" leaking notifications. Canvas-composite path works everywhere we ship.

## 4. Mode-specific source bridges

### 4a. Hook & long-form (HLS via Mux)

- Mux serves CORS headers on `stream.mux.com`. We set `crossOrigin="anonymous"` on every `MuxVideo` we want to capture from. **Without it, canvas becomes tainted and `MediaRecorder` is silently empty.** (Verified: caniuse + MDN CORS-enabled image.)
- `<video>` element's audio is captured via `audioContext.createMediaElementSource(videoEl)`. Note: this re-routes audio away from the default speaker — we MUST also re-pipe to `audioContext.destination` so the user still hears playback. Web Audio gotcha #1.
- We do `ctx.drawImage(videoEl, 0, 480, 540, 480)` per RAF tick.

### 4b. Ask mode (Simli WebRTC)

- `simli-bridge.ts` already exposes `onVideoTrack(track)` and `onAudioTrack(track)`. We add a tiny `RecordingTap` to the bridge consumers that subscribes to those callbacks and forwards the tracks to:
  - A hidden `<video>` element whose `srcObject = new MediaStream([videoTrack])` for canvas drawImage.
  - `audioContext.createMediaStreamSource(new MediaStream([audioTrack]))` for the mixer.
- **No SDK type leaks past the bridge.** This stays inside the bridge contract (CLAUDE.md §Provider-Agnostic Rule 1).
- **Ask-during-recording flow**: when the user taps React on a hook → ARMED → then taps Ask, `/api/sessions/open` mints, scene transitions in, but we **do not close the source `<video>`**. The compositor's `sourceVideoEl` ref is swapped from hook video → avatar video on `onVideoTrack`. The audio mixer adds the avatar audio gain branch. The user's mic gain branch was already there. Hook audio gain ducks to 0.

### 4c. Audio ducking (the 11/10 polish)

Three GainNodes feeding the destination:
- `gainSource` (hook/long-form/avatar audio)
- `gainMic`
- `gainAvatar` (only when in Ask mode; otherwise null and skipped)

A simple VAD on the mic stream (peak-detect over a 50ms window) ducks `gainSource` to 0.2 when user speaks, ramps back to 1.0 over 250ms when silent for 400ms. **Avatar audio (Ask mode) does NOT duck mic** — we want both audible. Source-content audio (hook MP4 audio) DOES duck for mic.

## 5. Permission choreography

```
First-ever React tap, anywhere:
  → getUserMedia({video, audio}) prompt
  → on grant: store permission state in IndexedDB key "react.permission.granted=true"
  → arm immediately (no extra modal)
  → on deny: show one-line inline tooltip "Add camera + mic in browser settings to react", offer audio-only fallback button

Subsequent React taps:
  → call navigator.permissions.query({name: 'camera'}) where supported
  → if state==='granted', call getUserMedia silently (no UI delay perceived)
  → if state==='prompt' or 'denied', surface inline tooltip

Permission revoked mid-session:
  → MediaStreamTrack 'ended' or 'mute' event fires
  → STOPPED with toast "Camera turned off — tap React to retry"
```

**iOS Safari quirk:** `navigator.permissions.query({name:'camera'})` returns `Not supported` on Safari (still in 2026). Fallback: optimistically call `getUserMedia` — if it resolves <50ms the permission was already granted; if a prompt appears, that's first-time UX and is fine.

**Wake-up on vertical scroll** (per Vuk's spec): when scroll-snap settles on a new hook, we tear down the active capture (release tracks, `mediaRecorder.stop()` discarded). The next React tap re-acquires. Horizontal scroll within a creator's lesson rail keeps the pipeline armed (we only swap `sourceVideoEl`).

## 6. Output & encoding

| Browser | mimeType (probed in order) | Container |
|---|---|---|
| iOS Safari 17+ | `video/mp4;codecs=avc1.42E01E,mp4a.40.2` | mp4 |
| Android Chrome | `video/webm;codecs=vp9,opus` then `vp8,opus` | webm |
| Desktop Chrome | `video/webm;codecs=vp9,opus` | webm |
| Desktop Safari | `video/mp4;codecs=avc1,mp4a.40.2` | mp4 |

We probe with `MediaRecorder.isTypeSupported()` and pick first match. **Output is whatever the browser produces** — we do not transcode in v1. Web Share API on iOS accepts mp4 natively; on Android Chrome accepts webm to most apps but TT/IG/X often prefer mp4 — for v1 we accept this UX cost and surface "Save & Share" on Android (download the webm, user can share via system after). Cross-container transcode = post-YC.

**Resolution:** 540×960 (9:16, ~518kbps target). Bitrate `videoBitsPerSecond: 2_000_000`, `audioBitsPerSecond: 128_000`.

**Hard cap 60s** in v1. Long-form duets are post-YC.

## 7. Watermark + content credentials

- **Visible watermark**: SVG-rendered logo bottom-right, 12% opacity, 14% width, drawn each RAF tick onto the canvas. Cannot be removed without re-encoding. Position rotates corner randomly per second to defeat trivial cropping.
- **Invisible C2PA**: post-record, we attach a content-credentials manifest using `c2pa-js` (WASM) before the share/download. Manifest claims: `oakleague.com` actor, `creator_id`, `clip_id`, `recorded_at`, `app_version`. This adds ~20-50KB per file and ~100ms sign time (verified). C2PA-JS is ~2.5MB WASM — **lazy-loaded** only when the user actually hits "Share" (not on the recording path).
- We do NOT embed PII (no user_id, no email). The `creator_id` is already public.

## 8. Web Share API + invite link

```ts
// post-record
const file = new File([blob], `oakleague-${shortId}.mp4`, { type: 'video/mp4' });
const shareData = { files: [file] };
if (navigator.canShare?.(shareData)) {
  await navigator.share(shareData);
} else {
  // Android webm fallback or desktop: trigger download
  triggerDownload(blob);
}
```

**iOS Safari quirk** (verified): `navigator.share({files, text, url})` *fails on iOS* if you include text or url alongside files. iOS shares files alone. We bake the invite URL into the **video itself** as a 1.5s end card (rendered onto canvas in last 1.5s of recording) AND into C2PA manifest. We do NOT pass `url` or `text` in the share payload on iOS.

End card content: "@vuk on OakLeague" + short URL `oakl.gg/r/<token>`. The token is a server-signed referral token (HMAC, 90-day TTL).

### 8a. Invite token system (extends existing)

- **Reuse `src/lib/invite-tokens.ts`** HMAC primitive. Add a *separate* token type — current invite is one-time creator onboarding; we need a **personal referral token**.
- New table `referral_tokens`:
  ```sql
  create table referral_tokens (
    token_hash  text primary key,           -- HMAC of plaintext token
    user_id     uuid not null references profiles(id) on delete cascade,
    creator_id  uuid references creators(id) on delete set null,  -- which creator the duet was about
    clip_id     uuid,                                              -- which hook/video
    recording_id uuid,                                             -- which duet
    created_at  timestamptz not null default now(),
    expires_at  timestamptz not null default now() + interval '90 days',
    redeemed_count int not null default 0,
    last_redeemed_at timestamptz
  );
  -- RLS: service-role-only (no policies)
  ```
- New table `referral_redemptions`:
  ```sql
  create table referral_redemptions (
    id          uuid primary key default gen_random_uuid(),
    token_hash  text not null references referral_tokens(token_hash),
    new_user_id uuid not null references profiles(id),
    device_fp   text not null,             -- sha256(ua + screen + tz + ipPrefix24)
    ip_prefix   text not null,             -- first 3 octets only (privacy)
    redeemed_at timestamptz not null default now(),
    credit_event text not null check (credit_event in ('landing','first_session','first_paid')),
    unique (token_hash, new_user_id, credit_event)
  );
  ```
- **Credit-on-first-conversation**: redemption fires from `/api/sessions/open` (after first successful mint) with `credit_event='first_session'`. Landing fires from `/r/[token]` route with `credit_event='landing'`. Dedup by `(token_hash, new_user_id, credit_event)` unique. Device+IP dedup is signal-only — `device_fp` and `ip_prefix` are stored for fraud review, not enforced (avoids dorm-room false positives).

## 9. Schema additions

```sql
-- 20260430000001_recordings.sql
create type recording_kind as enum ('hook_duet','long_form_duet','ask_duet');
create type recording_status as enum ('uploading','ready','failed','deleted');

create table recordings (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references profiles(id) on delete cascade,
  creator_id      uuid not null references creators(id) on delete cascade,
  kind            recording_kind not null,
  source_hook_id  uuid references hooks(id) on delete set null,
  source_video_id uuid references videos(id) on delete set null,
  source_session_id uuid references sessions(id) on delete set null,
  duration_ms     int not null check (duration_ms between 1000 and 90000),
  client_mime     text not null,
  storage_key     text,                       -- supabase storage; null if local-only
  share_token     text references referral_tokens(token_hash),
  c2pa_manifest_sha text,
  watermark_version int not null default 1,
  created_at      timestamptz not null default now(),
  status          recording_status not null default 'ready'
);
-- RLS: user_id = auth.uid() for select; service role for insert/update.
-- Index on (user_id, created_at desc), (creator_id, created_at desc).

-- v1 quota
alter table profiles
  add column recording_daily_cap int not null default 5,    -- 5 duets/day free
  add column recording_weekly_cap int not null default 15;

create table recording_usage_daily (
  user_id uuid not null references profiles(id) on delete cascade,
  day     date not null,
  count   int not null default 0,
  primary key (user_id, day)
);
-- weekly mirror omitted — v1 ships with daily only; weekly is one-line follow-up.
```

**Storage decision (v1):** uploads optional, local-first. The recording lives as a Blob in memory, gets shared via Web Share, and only gets uploaded if the user taps "Save to my profile" (post-YC feature). For v1 we **do not upload**. `storage_key` stays NULL. We still write the `recordings` row for analytics and quota — not the bytes. **This avoids ~$300/mo Mux ingest + Supabase storage costs on day one.**

## 10. Server actions / RPCs

- `recording_open_check_rpc(user_id)` — called BEFORE arming. Returns `{ allowed, reason, daily_used, daily_cap }`. Prevents user from filling 60s, hitting STOPPED, then getting "you exceeded cap". **Fail loud at arm time, not at share time.**
- `recording_finalize_action({ kind, source_id, duration_ms, mime })` server action — writes `recordings` row, mints `referral_token` (returns plaintext token to client for end-card embed), increments `recording_usage_daily`. Whitelist fields, never spread.
- `redeem_referral_landing_action(token)` — `/r/[token]` route handler. Sets a cookie `ref=token_hash`, captures device_fp + ip_prefix, writes `referral_redemptions` with `credit_event='landing'`. Strips token from URL via `window.location.replace`.
- Wire `credit_event='first_session'` into existing `/api/sessions/open` after RPC success.

## 11. Telemetry

PostHog events (via `captureSafe`):
- `react_button_visible` (hook_id, mode)
- `react_tap` (mode, has_permission)
- `react_armed` (mode, ms_to_arm)
- `react_permission_denied` (reason)
- `react_capture_error` (code, mode)
- `react_stopped` (mode, duration_ms, stop_reason: user|cap|background|error)
- `react_share_opened` (mode, duration_ms)
- `react_share_completed` (mode) — note: iOS doesn't reliably fire share success; track via best-effort
- `referral_landing` (token_hash_prefix)
- `referral_first_session` (token_hash_prefix)

Sentry: `Sentry.captureException` only on truly broken paths (canvas taint, MediaRecorder.start throw, mixer wiring failure). Permission-denied is NOT an exception.

## 12. Onboarding for shared-link landings

- New route `src/app/r/[token]/page.tsx`. SSR validates token, renders the duet's source clip (hook or long-form thumbnail) + "Watch @creator's full mentorship" CTA.
- Cookie-set redemption fires server-side. Then redirect to `/` with `?ref=token_hash_short` query param to hint at first-session credit.
- New users from referral land on the **referenced creator's drawer**, not the standard cold-start feed. This is the moment of magic — they came for that creator.
- After first session opens, fire `referral_first_session` and pop a one-line toast "@vuk gets credit for inviting you".

## 13. File-by-file delivery list

**New files:**
- `src/lib/recording/composite-canvas.ts` — RAF compositor (top=cam, bottom=src, watermark)
- `src/lib/recording/audio-mixer.ts` — Web Audio graph + VAD ducker
- `src/lib/recording/media-recorder-driver.ts` — mime probe, start/stop, blob assembly
- `src/lib/recording/recording-controller.ts` — state machine (IDLE→ARMED→STOPPED→PREVIEW)
- `src/lib/recording/permission.ts` — getUserMedia wrapper, IDB cache, denial detection
- `src/lib/recording/types.ts` — branded types (RecordingId, ShareToken)
- `src/lib/recording/c2pa.ts` — lazy WASM loader, manifest builder
- `src/lib/recording/end-card.ts` — last-1.5s URL/handle overlay
- `src/components/recording/ReactButton.tsx` — the tap target (used in 4 surfaces)
- `src/components/recording/RecordingPreview.tsx` — scrub/trim/share
- `src/components/recording/SelfieOverlay.tsx` — portal that mounts user-cam preview during ARMED state
- `src/app/r/[token]/page.tsx` — referral landing
- `src/app/r/[token]/redeem/route.ts` — POST handler
- `src/app/api/recording/open-check/route.ts` — pre-arm quota check
- `src/app/api/recording/finalize/route.ts` — finalize + token mint
- `supabase/migrations/20260430000001_recordings.sql`
- `supabase/migrations/20260430000002_referral_tokens.sql`

**Modified files:**
- `src/app/(feed)/hook-panel.tsx` — add ReactButton next to Ask, wire sourceVideoEl ref, set `crossOrigin="anonymous"` on MuxVideo
- `src/app/v/[id]/long-form-player.tsx` — same
- `src/app/s/[id]/page.tsx` — add ReactButton, wire avatar tracks into recording controller via existing bridge handlers
- `src/app/s/[id]/use-session-pipe.ts` — surface the existing `onVideoTrack`/`onAudioTrack` to the recording controller without a refactor
- `src/lib/avatar/simli-bridge.ts` — **no changes**. We consume existing handlers.
- `src/app/api/sessions/open/route.ts` — emit `referral_first_session` redemption when cookie `ref` is present and this is the user's first session.
- `instrumentation.ts` / `sentry.client.config.ts` — add `recording.*` paths to scrub list (token plaintext)
- `next.config.ts` — add `unsafe-eval` exception or wasm-eval CSP for c2pa-js if we choose to ship C2PA in v1 (might defer)

## 14. Test plan

- Vitest unit: `composite-canvas.test.ts` (frame layout math), `audio-mixer.test.ts` (gain ramp, VAD threshold), `permission.test.ts` (denial path), `recording-controller.test.ts` (state machine — every transition).
- Integration (real browser, Playwright on CI, 4 matrices: iOS-safari-17 / iOS-safari-pwa / android-chrome-126 / desktop-chrome): hit the React button on a hook page, assert `MediaRecorder.state === 'recording'` within 500ms, stop, assert blob.size > 50KB, assert `MediaStreamTrack.kind` count.
- **Manual mobile parity matrix** (we will not have full Playwright iOS coverage in v1 — be honest): Vuk runs the matrix on his actual iPhone + a borrowed Android once before YC. Document the matrix in `docs/_planning/REACT_DUET_MOBILE_MATRIX.md`.
- Real-API gate (`RUN_REAL_API_TESTS=1`): Ask-mode capture against a live Simli session — assert avatar audio track lands in mixer and bytes are non-silent.
- RLS: `recordings` table reads only by `user_id = auth.uid()`. Test via supabase test harness (existing pattern).

## 15. WebRTC track capture spike (DAY 1 GATE)

**Before committing to the architecture above**, a 2-hour spike on actual hardware (desktop + Vuk's iPhone) to verify:

1. `simli-bridge.ts` `onVideoTrack` fires reliably with a `MediaStreamTrack` we can attach to a hidden `<video>` and draw to canvas.
2. `simli-bridge.ts` `onAudioTrack` fires reliably with a `MediaStreamTrack` Web Audio can `createMediaStreamSource` from.
3. `MediaRecorder` running on the composited stream produces a non-empty mp4 on iOS Safari for ≥10s without dropping the recording when the avatar's WebRTC pipe has a brief jitter spike.

**Spike result is a go/no-go.** If iOS Safari WebRTC track → MediaRecorder fails (a real risk per known WebKit bugs around recording from RTC-sourced tracks), Ask-mode duet falls back to "audio-only with avatar still photo overlay" for v1 demo. Ship the hook + long-form duet either way.

## 16. Day-by-day delivery (calendar from 2026-04-30 → 2026-05-06)

| Day | Task |
|---|---|
| **Apr 30** | Spike #15 (2h). Schema migrations. Permission lib + IDB cache. Audit-applied revisions integrated. |
| **May 1** | composite-canvas + audio-mixer. Vitest. ReactButton mounted in hook-panel only. Hook-mode end-to-end on desktop. |
| **May 2** | Long-form mode wiring. iOS Safari mp4 probe path. Manual iOS test. End card. |
| **May 3** | Ask-mode wiring (track tap from existing bridge handlers). Audio ducking. State machine final pass. |
| **May 4** | Preview/trim component. Web Share. Referral token mint + landing page. |
| **May 5** | Manual mobile parity matrix. Quota enforcement. Sentry/PostHog wiring. C2PA (defer if behind). |
| **May 6** | Buffer / cut features behind flags / record demo / ship. |

C2PA, in-app save-to-profile, weekly cap, fraud-review UI = post-YC.

## 17. Known risks / open questions

1. **iOS Safari MediaRecorder + WebRTC source track**: known WebKit instability historically. Spike (#15) is the gate.
2. **Mux CORS**: confirmed supported, but we have not enabled it on any existing `<video>` element. Need to verify the `mux-video-react` component honors `crossOrigin` prop pass-through, not just on the wrapper. *(Action: read mux-video-react source on May 1 morning before wiring.)*
3. **Audio context unlock on iOS**: AudioContext starts suspended on iOS until user-gesture. The React tap IS the gesture, so we resume() inside the tap handler synchronously — confirmed pattern.
4. **Memory pressure on long recordings**: 60s @ 2Mbps ≈ 15MB blob in RAM. iOS low-memory devices will wobble. We use `timeslice: 1000` and chunk to IndexedDB if `navigator.deviceMemory < 4`. This is the only reason we'd persist locally before share.
5. **Watermark cropping defeats**: rotating-corner is good-enough for v1. Real solution is post-record server-side re-encode with embedded watermark (post-YC).
6. **C2PA bundle weight**: 2.5MB WASM. We MUST lazy-load on first share, not on app boot. If lazy load complicates demo, drop C2PA from v1.
7. **Avatar "knows we're recording"**: NOT necessary. The avatar is a content provider — it doesn't change behavior. Creator already consented to being cloned; recording the cloned voice is within consent scope (creator T&Cs to add: "user-generated duets may include your cloned voice").
8. **Creator T&Cs update**: needs one-line addition to existing creator agreement covering duet rights. Legal task, not engineering.
9. **Camera-denied fallback UX**: audio-only "voice memo" duet (cam disabled, top half = animated waveform of mic). Build only if denial rate >5% in v1 telemetry. Do NOT build day-one.

## 18. Out of scope (explicit, post-YC)

- Server-side re-encode / watermark bake
- Upload to Mux, in-app feed of duets
- 3-way duet (user + avatar + reference clip)
- iOS native share sheet success callback
- Cross-container transcode (webm→mp4 for Android)
- Stripe credit payout for referrals
- Long-form duets (>60s)
- Public duet feed
- Duet editor (cuts, captions, music)

## 19. Auditor Round 1 Findings — 2026-04-30

### Critical

**C1. `MediaRecorder` cannot survive a mid-recording source-element swap when audio is tapped via `createMediaElementSource`.**
`createMediaElementSource` is one-shot per HTMLMediaElement (second call throws `InvalidStateError`) and the source node cannot be detached. On horizontal lesson-rail swap, every new `<video>` adds a dangling MediaElementAudioSourceNode that holds the element alive. Memory grows linearly; iOS Safari OOMs ~12-15 swipes.

**C2. `crossOrigin="anonymous"` + Mux HLS pass-through unverified.** `mux-video-react` is a thin wrapper; not confirmed it forwards `crossOrigin` to underlying `<video>`. If it doesn't, canvas is tainted and `MediaRecorder` produces zero-byte blobs silently. Must verify TODAY before architectural commit.

**C3. RLS gap on `referral_redemptions`.** Plan defines table with no RLS clause. Must explicitly `ENABLE ROW LEVEL SECURITY` with zero policies (CLAUDE.md hard rule). Anon-key reading device_fp / ip_prefix / redemption graph = harassment + competitive-intel vector.

**C4. `crossOrigin="anonymous"` shipped to existing `hook-panel.tsx` is a Day-1 production change touching the freshly-stabilized D5 TikTok-style audio path.** Historical iOS Safari muted-autoplay regressions tied to `crossOrigin`. Must feature-flag via `NEXT_PUBLIC_REACT_CAPTURE_ENABLED` so revert is independent of the React feature itself.

**C5. iOS Safari `createMediaElementSource(videoEl)` on HLS-fed `<video>` is a known-broken path (WebKit #211394 family).** Produces silence in AudioContext while still playing audio to system speaker. If true on iOS 17/18, hook + long-form duets capture **silent audio** on the platform that matters most for sharing. Day-1 spike must verify with PCM-decode of resulting blob.

### Medium

- **M1.** FK convention check (`hooks`, `videos`, `sessions` tables exist — confirmed; SET NULL semantics OK).
- **M2.** Browser-side peak-detect is **not** VAD — will duck constantly during loud playback. Drop ducking from v1; use static gain (mic 1.0, source 0.7, avatar 0.9).
- **M3.** Avatar audio double-routed: Simli's `audioEl.autoplay=true` (simli-bridge.ts L184) AND mixer destination = audible echo. Must mute Simli's audioEl in Ask-mode + route through AudioContext only.
- **M4.** Quota race: arm-check + finalize-increment lets two concurrent ARMED sessions both pass the cap. Need pending-counter at arm time with TTL sweep.
- **M5.** Referral cross-token landing dedup unspecified. Must be explicit "last-clicked-wins" + uniqueness on `(any_token, new_user_id, 'first_session')` so first session credits exactly one referrer.
- **M6.** iOS getUserMedia blocks JS thread = scroll-snap target loss + visual jump. Disable touch on feed container while prompt open; restore on dismiss.
- **M7.** C2PA in v1 is ceremony — TT/IG/X don't verify it, 2.5MB WASM kills share-moment latency on 4G. Cut entirely from v1.

### Small (high-signal subset; full list in plan history)

- S2. Diagram audio routing redraw.
- S3. mime probe order: include `avc1.4D401E` (Main) before `42E01E` (Baseline).
- S4. Drop watermark rotation (security theater); pre-rasterize SVG once.
- S6. Reconcile 60s vs 90s in schema check.
- S10. `token_hash_prefix` event prop will be **dropped by existing PostHog scrub** (`/token/` regex). Rename to `ref_id_prefix`.
- S12. Use `wasm-unsafe-eval` not `unsafe-eval` if C2PA stays. (Moot if M7 cuts C2PA.)
- S13. Explicit deny-policy on `recordings` INSERT for authenticated role; service-role only.
- S15. Calendar realism: state explicit cut order — Ask-mode → long-form → iOS-only-fallback.
- S17. `navigator.deviceMemory` unsupported on iOS — replace with iOS-UA always-chunk heuristic.
- S18. Cookie flags missing per CLAUDE.md (`httpOnly, secure, sameSite=lax`).
- S19. `onVideoTrack`/`onAudioTrack` are one-shot per AvatarBridge JSDoc. Add `track.onended` → STOP with `stop_reason='rtc_track_ended'`.
- S22. Hook→Ask transition gap (1-3s ICE establish): plan must state whether bottom half freezes, plays, or shows a deliberate "connecting…" state.

---

## 20. Revised plan — addressing R1 audit (2026-04-30)

### 20.1 Audio mixer architecture — REVISED (fixes C1, C5)

**Drop `createMediaElementSource` entirely. Use `videoEl.captureStream()` for hook/long-form audio; `createMediaStreamSource` for everything.**

```
Source <video> (HLS) ──captureStream()──▶ MediaStream ──createMediaStreamSource──┐
                                                                                  │
mic stream ──────────────────────────────────────────createMediaStreamSource────┤
                                                                                  ├─ GainNodes ─▶ Destination ─▶ recorded audio track
avatar audio MediaStreamTrack (Simli) ──new MediaStream([track])─createMediaStreamSource┘
```

Why this fixes both C1 and C5:
- `videoEl.captureStream()` (Chrome desktop, Android Chrome) returns a fresh MediaStream — many such streams can coexist; on horizontal swap we disconnect the old source node (plain `node.disconnect()`) and connect the new one. **No one-shot constraint.** No GC root leak.
- `videoEl.captureStream()` taps the post-decode pipeline at the element level, **not** Web Audio's MSE-routed path that breaks on iOS HLS. Audio goes through the same path the speaker hears.
- iOS Safari **does not support `videoEl.captureStream()`** (verified: WebKit doesn't expose it on HTMLMediaElement). Therefore, on iOS, hook/long-form duets in v1 are **video-only** (top half = mic'd selfie audio, bottom half = silent video frames). This is an honest UX trade — better than shipping silent broken audio. Document on share-modal: "Original audio not yet supported on iOS."
- On iOS, **Ask-mode duet still has full audio** because Simli's audio track comes from WebRTC, which iOS WebKit handles correctly via `createMediaStreamSource`. Ask-mode is the most demo-able mode anyway.

### 20.2 Mux CORS verification — DAY 0 (today) gate (fixes C2)

Before any other work: 30-minute spike — mount `<MuxVideo>` with `crossOrigin="anonymous"`, draw to canvas, call `canvas.toDataURL()`. If it throws SecurityError → tainted → either patch `mux-video-react` or fall back to `<video>` directly with manual HLS player. If clean → proceed.

### 20.3 RLS — REVISED (fixes C3, S13)

```sql
alter table recordings enable row level security;
create policy "recordings owner read" on recordings for select using (user_id = auth.uid());
-- no insert/update/delete policies → service role only

alter table referral_tokens enable row level security;
-- zero policies → service role only

alter table referral_redemptions enable row level security;
-- zero policies → service role only

alter table recording_usage_daily enable row level security;
create policy "usage owner read" on recording_usage_daily for select using (user_id = auth.uid());
-- no write policies
```

### 20.4 Feature flag — NEW (fixes C4)

`NEXT_PUBLIC_REACT_CAPTURE_ENABLED` env var gates:
- `crossOrigin="anonymous"` attribute on every MuxVideo (off by default until spike #2 passes)
- `<ReactButton/>` mount in hook-panel, long-form, ask
- `/r/[token]` route — kept on (referrals can pre-launch even if capture is gated)

Revert path = flip env var, redeploy. Existing playback survives.

### 20.5 Audio: drop VAD, drop double-route, mute Simli audioEl in record-mode (fixes M2, M3)

- Static gains: mic=1.0, source=0.7, avatar=0.9. No VAD in v1.
- When entering Ask-mode-during-recording, set the Simli `audioEl.muted = true` and route avatar audio exclusively through the AudioContext destination (which both feeds the mixer and the speaker).
- Add a `mute` option to `AvatarBridge.open()` opts (small bridge contract additon — keeps it inside the bridge, no SDK leak).

### 20.6 Quota race — pending counter (fixes M4)

```sql
alter table recording_usage_daily
  add column pending_count int not null default 0,
  add column pending_armed_at timestamptz;

-- recording_open_check_rpc:
--   pending_count + count + 1 must be <= cap
--   if pass: increment pending_count, set pending_armed_at=now()
-- recording_finalize_action:
--   decrement pending_count, increment count
-- pg_cron sweep every 60s:
--   if pending_armed_at < now() - interval '90 seconds': decrement pending_count
```

### 20.7 Referral semantics — explicit (fixes M5)

- `/r/[token]` cookie set is **last-write-wins**.
- `referral_redemptions` adds a partial unique index: `unique (new_user_id) where credit_event = 'first_session'` — exactly one first-session credit per new user, ever.
- No cross-token first-session double-credit possible.

### 20.8 Permission UX — block-touch-on-prompt (fixes M6)

While `getUserMedia` is pending, set `document.body.style.touchAction = 'none'` and apply a 1-pixel transparent overlay over the feed scroll area. On promise resolve/reject, restore. Scroll-snap target preserved.

### 20.9 C2PA — CUT FROM V1 (fixes M7, S12)

Removed from §13 file list, §16 day plan, §17.6, §18 (now in Out-of-Scope).

### 20.10 Hook→Ask transition (fixes S22)

When user taps Ask while ARMED, the bottom half of the canvas continues to draw the hook `<video>` until either: (a) `onVideoTrack` fires from Simli (success path, ~1.5s), at which point `sourceVideoEl` ref swaps to the Simli video element, OR (b) 3s timeout, at which point we stop recording with `stop_reason: 'ask_open_timeout'` and surface preview as-is. **Hook video continues playing** during the gap — no freeze, no "connecting…" overlay (which would be in the recording). The 1-2s of hook tail in the recording is acceptable; this is a duet of the user's reaction to the hook, then their conversation about it. That's the product.

### 20.11 RTC track ended — STOP signal (fixes S19)

In `recording-controller.ts`, on `track.onended` for either avatar video or audio track during ARMED: STOP with `stop_reason='rtc_track_ended'`, fire PostHog event, present preview from already-captured chunks (MediaRecorder always produces a usable blob from `requestData()` even on partial capture).

### 20.12 Watermark — pre-rasterize once (fixes S4, S21)

SVG → offscreen canvas at component init. Each RAF tick blits the offscreen canvas (single `drawImage`). Drop the rotating-corner pretense — fixed bottom-right with 12% opacity. iPhone 11 CPU profile: <2% per RAF tick.

### 20.13 Calendar — explicit cut order (fixes S15)

> **SUPERSEDED — see §27 Option A-prime locked decision (2026-04-30) and §23.10 for the live cut order. Do not implement against this list; §20.13 is preserved for revision history only.**

### 20.14 Schema reconcile (fixes S6, S10, S17, S18)

- `recordings.duration_ms` check: `between 1000 and 65000` (60s + 5s slack).
- PostHog event prop renamed `token_hash_prefix` → `ref_id_prefix` (avoids existing scrub regex).
- iOS detection via UA always chunks to IndexedDB (`navigator.deviceMemory` unreliable on iOS).
- `redeem_referral_landing_action` cookie: `httpOnly: true, secure: prod, sameSite: 'lax'`.

---

## 21a. Auditor Round 2 Findings — 2026-04-30

**Verdict: APPROVE-WITH-CONDITIONS.** All R1 criticals resolved (C1, C3, M2, M3, M5, M6, M7), partial (C4 — see NC2), or deferred-correctly (C2, C5 → spike-gated). 3 new criticals + 5 mediums surfaced; 5 are blocking pre-implementation conditions.

### New Critical
- **NC1.** Pending-counter sweep race: stale ARMED tab can recover its pending slot via 90s sweep, then re-finalize. **Fix:** finalize RPC takes idempotency token `pending_armed_at` and rejects if cleared/changed since arm; row-lock on `(user_id, day)`.
- **NC2.** `NEXT_PUBLIC_REACT_CAPTURE_ENABLED` is client-only — server routes ungated. **Fix:** add server-only `RECORDING_ENABLED` env on `/api/recording/*` and `/r/[token]/redeem` for kill-switch parity.
- **NC3.** 3s ask-open timeout collides with `/api/sessions/open` 10/min rate limit (429) — recording stops with no surfaced reason on rapid Ask cycles. **Fix:** controller distinguishes 429 (toast + stay ARMED) from network timeout (STOP); bump timeout to 5s.

### New Medium
- **NM1.** `videoEl.captureStream()` audio track is silent if element is muted/paused at capture-start (Chrome autoplay policy). **Fix:** assert `!muted && !paused` before captureStream(); force-unmute + play() inside React-tap gesture.
- **NM2.** `AvatarBridge.open({mute})` leaks presentation concerns into bridge. **Fix:** replace with runtime `bridge.setLocalPlayback(boolean)` method; controller toggles on ARM, reverts on STOP.
- **NM3.** Hook→Ask sourceVideoEl swap = hard cut in recording bottom half. **Fix:** 300ms alpha-blend crossfade in compositor.
- **NM4.** Android `.webm` share path is a viral-loop dead-end — TT/IG/X reject webm. **Fix:** Android Save modal degrades to "Save preview + copy referral link"; explicit UI copy. Server-side transcode is post-YC.
- **NM5.** End-card-only attribution is trivially trimmed; with C2PA cut and watermark at 12% bottom-right, the referral funnel collapses. **Fix:** raise watermark opacity to 25% AND bake `oakl.gg/r/<short>` URL as small persistent text under the watermark for the full duration.

### Final Approval Conditions (all must land before May 1 implementation start)
1. NC1 — finalize-RPC idempotency token + row lock (~15 min schema patch).
2. NC2 — server-side `RECORDING_ENABLED` env gate on new API routes (~10 min).
3. NC3 — controller 429-vs-timeout distinction; 5s timeout (~20 min).
4. NM1 — captureStream pre-condition assertion + gesture-time unmute (~10 min).
5. NM4 — Android-degraded UX copy + copyable referral link in Save modal (hard pre-condition for Android funnel).

NM2, NM3, NM5 = strongly recommended but Vuk's call to take or punt.

---

## 21b. Conditions integrated into plan

The 5 blocking conditions are now folded into the plan body:

- **§9 schema** updated: `recording_usage_daily.pending_armed_at` is the idempotency token; `recording_finalize_action` requires the client-supplied `armed_at` value to match the stored `pending_armed_at` AND holds row-lock via `SELECT … FOR UPDATE`. Mismatch → 409 Conflict, surface as "session expired" toast.
- **§10 API** updated: `/api/recording/open-check` and `/api/recording/finalize` first-line check `if (!process.env.RECORDING_ENABLED) return new Response(null, { status: 404 })`. Same on `/r/[token]/redeem`.
- **§20.10 controller** updated: on `/api/sessions/open` 429 response, controller emits `react_ask_throttled` PostHog event, surfaces toast "Slow down — try again in a sec", recording stays ARMED. Only network/ICE failure or 5s elapsed without `onVideoTrack` triggers `stop_reason='ask_open_timeout'`.
- **§4a video tap** updated: before `videoEl.captureStream()`, assert `!videoEl.muted && !videoEl.paused`; if either fails, the React-tap handler synchronously calls `videoEl.muted=false; videoEl.play()` (the tap is a valid user gesture for autoplay-policy purposes). Vitest covers both paths.
- **§6 + §8 share** updated: Android share modal copy = "Save preview & Copy invite link." Two buttons, side by side. Webm download remains for users who want the local file. Copy-link button writes to clipboard via `navigator.clipboard.writeText(`https://oakl.gg/r/${token}`)` and shows ✓ confirmation. The viral funnel survives Android.

NM2 (bridge setLocalPlayback), NM3 (canvas crossfade), NM5 (watermark beefup + URL-baked-in) are accepted into the plan as well — implementation cost is small (10-30 min each), polish payoff is real:
- NM2: replace `open({mute})` with `bridge.setLocalPlayback(audible: boolean)` runtime method on AvatarBridge interface.
- NM3: 300ms alpha crossfade in `composite-canvas.ts` on `sourceVideoEl` swap.
- NM5: watermark = 25% opacity bottom-right (pre-rasterized), with `oakl.gg/r/<short>` text below the logo for the full duration. End card supplements (1.5s).

---

## 22. Auditor Round 3 Findings — 2026-04-30 (external audit, BLOCK verdict)

A 3rd-party audit returned **BLOCK** with 5 new criticals (C1-C5) + 7 mediums. R1/R2 missed real issues. This section folds them into the plan via §23.

### R3 Critical
- **R3-C1.** iOS canvas→MediaRecorder is **unverified at the canvas-source level**, not just WebRTC. WebKit bugs 229611 / 181663 / 216832 indicate canvas-captureStream → MediaRecorder mp4 may emit blank or corrupt output on iOS. The Day-0 spikes only test Mux CORS + Ask-mode WebRTC. **Need a third spike: iOS hook-mode canvas → MediaRecorder validity.**
- **R3-C2.** `simli-bridge.ts:242,253` — `loadedmetadata` listeners are `{ once: true }` and fire once on session open. **Tracks are not cached on the bridge.** A recording controller that subscribes AFTER session-open (user enters Ask → starts conversing → THEN taps React) never receives tracks. The plan's "no changes to simli-bridge, just consume existing handlers" claim is broken for the most-likely UX path.
- **R3-C3.** Pending-counter race collapses under multi-tab: `pending_armed_at` is a single column on `(user_id, day)`. Two tabs arming in parallel → second one 409s with first's slot held. Need a child table keyed by `arm_id`.
- **R3-C4.** CLAUDE.md cost-kill-switch violated for `kind='ask_duet'`. Recording extends a Simli session that has its own voice cap. `recording_open_check_rpc` for ask_duet must AND-gate on `voice_usage_ticket_check`, not just recording quota — otherwise a user at voice-cap can re-extend by recording.
- **R3-C5.** Calendar's bottom of cut order = "ship a half-broken capture button." Violates `feedback_youtube_tiktok_polish_bar.md` ("v1 for YC must hit consumer-app polish, not 'working demo'"). Floor must be a polished referral-only ship.

### R3 Medium
- **R3-M1.** Referral self-credit via `<img src="/r/<my-token>">` embedded on any page → free credit harvest. Add `Sec-Fetch-Dest: document` check on `/r/[token]` route; ignore credit unless top-level document navigation.
- **R3-M2.** `device_fp` + `ip_prefix` collected, never reviewed, never enforced = pure GDPR exposure. **Cut from schema unconditionally.**
- **R3-M3.** Token mint timing: end-card URL is drawn before finalize confirms the binding. Mint at open-check instead so in-video URL == share URL.
- **R3-M4.** `crossOrigin="anonymous"` regression risk: ship as its own PR 24h before React work, so D5 audio regression is independently revertable.
- **R3-M5.** "Half-broken capture" (R3-C5 floor) — covered by C5.
- **R3-M6.** Privacy/consent of bystanders in selfie capture: documented post-YC; no v1 mitigation. Acceptable.
- **R3-M7.** Takedown / moderation flag on `recordings`: post-YC. Acceptable.

---

## 23. R3 Revisions integrated into plan

### 23.1 PWA-first → native-later escape hatch (NEW context)

**v1 ships as PWA. v2 ships as native iOS + Android shell apps.** Native iOS uses `AVAssetWriter` (reliable) — solves any Safari MediaRecorder gaps natively. **This means: if R3-C1 spike fails (iOS PWA canvas→MediaRecorder blank/corrupt), iOS PWA capture can be deferred to the native app without abandoning the architecture.** The native shell loads the same web app + supplies a JS bridge to native AVFoundation for recording. Web Audio + canvas compositor stay; only the MediaRecorder leaf swaps.

This unlocks a cleaner v1 ship: Android + desktop PWA capture works fully; iOS PWA gets a "Coming to iOS soon — install our app" moment when React is tapped. iOS users still get the share + referral end of the funnel by reacting on desktop or Android. Demo at YC = Vuk on Android or desktop.

### 23.2 Day-0 spike list — REVISED (3 spikes, ~2.25h, all today before any code)

| # | Spike | Time | Pass | Fail |
|---|---|---|---|---|
| 1 | **Mux CORS pass-through** — mount MuxVideo with `crossOrigin="anonymous"`, draw to canvas, `toDataURL()` succeeds. | 30 min | proceed | patch `mux-video-react` or fall back to manual HLS player |
| 2 | **iOS canvas→MediaRecorder validity (NEW per R3-C1)** — color-fill canvas + `drawImage` of a local mp4 → `MediaRecorder` 5s on Vuk's iPhone → AirDrop to Mac → QuickTime plays clean, non-empty, non-blank. | 1 h | iOS PWA capture viable — proceed Option A | iOS PWA capture deferred to native app — ship Option A-prime |
| 3 | **simli-bridge multi-subscriber refactor cost (NEW per R3-C2)** — sketch + verify `getCurrentTracks()` accessor + cache tracks on bridge instance, no JSDoc breakage. | 45 min | trivial diff — proceed | budget 2h on Day 1 |

### 23.3 Decision tree post-spikes

- **Spike 1 fail** → Option B: cut React capture entirely; ship referral-only "Invite friends" CTA. **The polished referral funnel demoed live beats a half-broken duet button at YC.** ~1 day total to ship.
- **Spike 2 fail + Spike 1 pass** → **Option A-prime**: ship Android + desktop PWA capture (full feature) + iOS PWA capture deferred to native shell (post-YC). iOS PWA shows "Coming to iOS — try desktop" CTA + referral copy-link. Hook + long-form + Ask all ship on Android/desktop.
- **All 3 spikes pass** → **Option A**: full plan as written.

The cut order's floor (R3-C5 fix) is **Option B — polished referral-only**, not "half-broken capture." If the calendar slips in Days 4-6, we cut to referral-only and ship a tight thing.

### 23.4 AvatarBridge contract addition (fixes R3-C2)

```ts
// src/lib/avatar/avatar-bridge.ts
export interface AvatarBridge {
  // ... existing members ...

  // Returns the currently-active video + audio tracks if the session is past
  // loadedmetadata, else null. Allows late subscribers (e.g. recording
  // controller spawned mid-session) to pick up tracks without waiting on
  // event re-fire. Tracks are guaranteed to be the same MediaStreamTrack
  // instances as those previously dispatched via onVideoTrack/onAudioTrack.
  getCurrentTracks(): { video: MediaStreamTrack | null; audio: MediaStreamTrack | null };

  // NM2: runtime audible-output toggle. When false, bridge ensures the
  // provider's <audio> element is muted so the consumer's AudioContext
  // destination is the only audible path (avoids double-route echo during
  // recording). Idempotent. Default true.
  setLocalPlayback(audible: boolean): void;
}
```

`simli-bridge.ts` change: cache `currentVideoTrack` + `currentAudioTrack` instance fields populated inside the existing `loadedmetadata` handlers (they remain `{once:true}` — the cache is the late-subscriber path). `getCurrentTracks()` returns the cached values. `setLocalPlayback(audible)` toggles `audioEl.muted = !audible`. **No SDK type leaks**; bridge contract intact.

### 23.5 Schema — REVISED (fixes R3-C3, R3-M2)

```sql
-- 20260430000001_recordings.sql (REVISED)
-- recordings: unchanged
-- recording_usage_daily: drop pending_armed_at (was R2 NC1 fix; replaced)
create table recording_pending_arms (
  arm_id     uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  day        date not null,
  armed_at   timestamptz not null default now(),
  -- NULL = still pending; set on finalize success or sweep
  resolved_at timestamptz,
  resolution text check (resolution in ('finalized','timeout','aborted'))
);
create index recording_pending_arms_open_idx
  on recording_pending_arms (user_id, day) where resolved_at is null;
-- RLS: enable + zero policies (service-role only).
```

**Quota count for cap-check** = `count(*)` from `recording_usage_daily` (finalized only) **plus** `count(*)` from `recording_pending_arms where resolved_at is null and user_id=$u and day=$today`. Multi-tab safe — each arm gets its own row, idempotency keyed by `arm_id`.

`recording_open_check_rpc` returns `arm_id`. Client passes it to `recording_finalize_action`. Finalize:
1. `SELECT … FROM recording_pending_arms WHERE arm_id=$arm_id FOR UPDATE`
2. If `resolved_at IS NOT NULL` → 409 (sweep already cleared)
3. Else `UPDATE … SET resolved_at=now(), resolution='finalized'` + `INSERT INTO recordings`.

pg_cron sweep every 60s sets `resolution='timeout'` for any row with `armed_at < now() - interval '90 seconds' AND resolved_at IS NULL`.

`referral_redemptions` table — **drop `device_fp` + `ip_prefix` columns**. Schema is now `(id, token_hash, new_user_id, redeemed_at, credit_event)` only. Fraud detection deferred until we have signal volume + a reviewer.

### 23.6 Voice cap AND-gate for ask_duet (fixes R3-C4)

`recording_open_check_rpc(user_id, kind, source_session_id)`:
- If `kind = 'ask_duet'`:
  - First: call `voice_usage_ticket_check(user_id)`. If denied → return `{ allowed: false, reason: 'voice_cap_hit' }`.
  - Then: check recording quota.
- If `kind in ('hook_duet', 'long_form_duet')`:
  - Recording quota only.
- Both checks pass → insert `recording_pending_arms` row, return `{ allowed: true, arm_id }`.

This honors CLAUDE.md "Every paid API call writes to cogs_log with kill-switch at 150% of user quota." Recording during an active Simli session continues to consume Simli minutes; the gate prevents blowing through voice quota via the recording side door.

### 23.7 Referral landing — `Sec-Fetch-Dest: document` check (fixes R3-M1)

```ts
// src/app/r/[token]/page.tsx (server component)
export default async function ReferralLanding({ params }, headers: Headers) {
  const dest = headers.get('sec-fetch-dest');
  if (dest && dest !== 'document') {
    // Image preload, fetch from another tab, etc — do not credit.
    return new Response(null, { status: 204 });
  }
  // ... validate token, set cookie, write referral_redemptions(landing) ...
}
```

Self-credit via `<img src="/r/my-token">` blocked: image fetch sends `Sec-Fetch-Dest: image`. Modern browsers (Chrome 80+, Firefox 90+, Safari 16+) all send the header. Older browsers without it fall through and we accept the credit — acceptable risk.

### 23.8 Token mint at open-check, not finalize (fixes R3-M3)

`recording_open_check_rpc` mints the referral token **at arm time** and returns plaintext token + short-URL hash to the client. End card draws this URL during recording. Finalize binds `recordings.share_token` to the already-minted `referral_tokens.token_hash` — the in-video URL is identical to the share-modal URL, no race.

If the user discards the recording (PREVIEW → DISCARD), we mark `referral_tokens.expires_at = now()` to revoke. Cheap; no leaked tokens.

### 23.9 `crossOrigin` ships as its own PR 24h before React work (fixes R3-M4)

**Day -1 (today after spikes pass):** open PR with single change — add `crossOrigin="anonymous"` (gated by `NEXT_PUBLIC_REACT_CAPTURE_ENABLED`) to the two production-facing `@mux/mux-video-react` mounts: `hook-panel.tsx` and `long-form-player.tsx`. The other production-facing video surfaces (`welcome-overlay.tsx`, `demo-loop.tsx`) use `@mux/mux-player-react` (different package, different prop forwarding) and are intentionally excluded — they are not duet-capture targets. Admin `MuxUploader` mounts are uploader widgets, not playback, also excluded.

**Soak-test sequence — REVISED for build-time inlining (R4-M1/M2/M5):**
1. **Merge with flag off (no-op safety net).** Bundle byte-equivalent to today.
2. **Flip `NEXT_PUBLIC_REACT_CAPTURE_ENABLED=1` in Vercel + redeploy production.** `NEXT_PUBLIC_*` is build-time-inlined in client components — Vercel env flip alone is NOT enough; a redeploy is required. (Differs from the FEED flag, which is server-component-consumed and runtime-flippable.)
3. **24h soak window starts at the post-flip redeploy timestamp.** Monitor on iOS Safari + Android Chrome:
   - Mux Data `videoStartupFailed` rate ≤ flag-off baseline + 0.1pp (numeric, falsifiable).
   - PostHog `hook_view_start` rate within ±5% of baseline.
   - Sentry: zero new error patterns scoped to `MuxVideo` or hls.js.
4. **If green at +24h: React feature work proceeds.** If red: revert via Vercel instant-rollback to the prior deployment OR redeploy with flag off; investigate before further work.

**Revert path:** Vercel instant-rollback to the prior deployment. Note: the original framing of "independently revertable from React feature work" was inaccurate (audit R3 M5) — the same `NEXT_PUBLIC_REACT_CAPTURE_ENABLED` flag gates BOTH the `crossOrigin` attribute AND the (future) ReactButton/duet UI mount. There is no flag-level separation between them. The reason this PR ships first is sequencing — when PR #1 lands, the React UI components don't exist yet, so flipping the flag exercises only the CORS-mode HLS fetch path against a known-empty UI surface. That isolation is temporal (CORS-mode soaked alone for 24h before duet UI lands), not flag-architectural.

**Calendar implication:** Day 0 = open PR + merge + flip + redeploy. Day 1 morning starts the 24h soak. Day 2 morning begins React feature work — **§23.11 calendar is honest about this** because Day 1 was already permission lib + schema migrations + composite-canvas/audio-mixer scaffolding (none of which depend on the soak result), and the soak runs in parallel.

### 23.10 Cut order — LIVE (under §27 Option A-prime)

Locked baseline = §27 Option A-prime (Android + desktop full feature; iOS PWA gets no capture, modal-only fallback). C2PA is already cut. The cut sequence below applies *only* if the Day-2 EOD gate fails (per §25.4) or May 4 polish slips.

```
[Baseline already in scope] Android + desktop full feature (hook + long-form + Ask).
[Baseline already in scope] iOS PWA: modal CTA only, no capture (defer to native iOS post-YC).

If Day-2 EOD gate (§25.4) fails — drop in this order:
1. Cut Ask-mode duet (recording during voice convo). Ship hook + long-form only.
2. Cut long-form-mode duet. Ship hook only.
3. Cut Android+desktop hook-duet entirely → drop to Floor.

Floor (Option B — polished referral-only, ~1.5 days):
- Ship a creator "Invite friends" button on every hook + every long-form + every Ask scene.
- HMAC server-signed referral token (Sec-Fetch-Dest gated, partial-unique on first_session).
- /r/[token] landing → cookie-set + creator-drawer redirect.
- Toast on first-session credit (Item 4 copy locked).
- No recording, no canvas, no MediaRecorder. End card is a static SVG.
```

Decision gate **end of Day 3 (May 2 EOD)** per §25.4. No "but it almost works" — fail any of the 4 hard criteria → drop one step. Better than a half-broken capture button (per `feedback_youtube_tiktok_polish_bar.md`).

### 23.11 Calendar — REVISED with Day 0

| Day | Date | Task |
|---|---|---|
| **0** | Apr 30 PM | 3 spikes (Mux CORS, iOS canvas→MediaRecorder, simli-bridge refactor). Decide A / A-prime / B. |
| **0** | Apr 30 PM | If Option A or A-prime: open `crossOrigin` PR (R3-M4). Schema migrations. Permission lib. |
| **1** | May 1 | Composite-canvas + audio-mixer + ReactButton in hook-panel. `getCurrentTracks()` accessor. Hook-mode end-to-end on desktop. |
| **2** | May 2 | Long-form mode wiring. iOS Safari mp4 probe. **EOD gate: hook-duet polished on Android+desktop?** If not → drop to Option B floor. |
| **3** | May 3 | Ask-mode wiring (`getCurrentTracks` consumed). Audio routing + Simli mute. State machine final. |
| **4** | May 4 | Preview/trim. Web Share. Referral mint at open-check (R3-M3). Landing page + `Sec-Fetch-Dest` check. |
| **5** | May 5 | Manual mobile parity. Quota enforcement (`recording_pending_arms`). Sentry/PostHog. NM3 crossfade + NM5 watermark+URL. |
| **6** | May 6 | Buffer / cut features behind flags / record demo / ship. |

Day-2 EOD is the explicit go/no-go on capture vs. referral-only.

---

## 24. Auditor Round 4 (Final) Findings — 2026-04-30

**Verdict: APPROVE-WITH-CONDITIONS.** All R3 criticals resolved or partially-resolved-with-spike-gate. 1 new critical (NEW-C1) + 3 new mediums (NEW-M1/M2/M3) + 4 blocking pre-Day-1 conditions + several quality fixes. Spike work can start today.

### R3 Disposition
- R3-C1 (iOS canvas→MR validity): **Partially** — spike #2 methodology too weak, see §25.1.
- R3-C2 (simli-bridge late subscriber): **Resolved** at the `getCurrentTracks()` API level; renegotiation gap surfaced as new medium.
- R3-C3 (multi-tab race): **Resolved** via `recording_pending_arms` child table.
- R3-C4 (voice-cap kill-switch): **Resolved** via AND-gate.
- R3-C5 (cut floor): **Resolved** at contract level; floor estimate aspirational, see §25.5.
- R3-M1/M2/M3/M4: all Resolved.
- R3-M6/M7: deferred-correctly.

### New Critical
- **NEW-C1.** Token-mint-at-open-check creates an unauthenticated mint surface. Bot tapping React 1000×/sec → 1000 abandoned tokens. Need rate-limit + per-day cap on mints.

### New Medium
- **NEW-M1.** Voice-cap denial UX gap — when ask_duet recording is denied for `voice_cap_hit`, the in-progress Simli session must continue normally; only the duet button disables. Plan must state this explicitly.
- **NEW-M2.** `setLocalPlayback(audible)` needs a Vitest + iOS edge-case validation (mid-WebRTC `audioEl.muted=true` sometimes drops the track per WebKit issue).
- **NEW-M3.** Option B floor: "Invite friends" button has no clip/creator binding without a recording. State explicitly that the token is bound to the creator viewed at click time (server-mints with `creator_id` from the surface the click happened on); else generic landing = weaker viral hook.

### Audit notes that became §25 fixes
- §3 Spike #2 methodology weak — need ffprobe + real-platform upload, not "QuickTime plays."
- §4 PWA→native escape hatch §23.1 hand-waves: native iOS = compositor rebuild, not leaf swap. Honest cost = ~1 week post-YC.
- §5 Option B "1 day" estimate aspirational; honest 8–10 hours = 1.5 days with debug budget.
- §6 LiveKit track renegotiation poisons `getCurrentTracks()` cache on ICE restart / WiFi↔LTE / simulcast change. Must subscribe to LiveKit `trackSubscribed` / `trackPublicationUpdated` and refresh cache.
- §7 Day-2 EOD gate "polished" undefined — replace with 4 hard pass/fail criteria.
- §8 `Sec-Fetch-Dest` mostly sound; partial-unique-index limits worst case to 1 fraud credit per fraudster. Acceptable.
- §9 Token expiry: add pg_cron sweep that revokes never-bound tokens after 24h.

---

## 25. R4 Conditions integrated into plan (Day 0 fixes)

### 25.1 Spike #2 methodology — UPGRADED (R4 condition 1)

| | Before | After (R4) |
|---|---|---|
| Recording duration | 5s | 10s |
| Source | color-fill canvas only | canvas + drawImage(local-mp4) + getUserMedia(audio) |
| Validation | "QuickTime plays clean" | `ffprobe -show_streams` asserts: 2 streams, video has IDR within first GOP, audio drift <100ms, blob ≥ 4MB |
| End-to-end | AirDrop → QuickTime | AirDrop → ffprobe + upload to private IG account → confirm playback |

Pass = both ffprobe + IG upload green. "Plays in QuickTime" alone is not pass.

### 25.2 PWA→native escape hatch — REWRITTEN (R4 condition 2)

**§23.1 corrected:** v1 PWA. v2 native iOS + Android shells **rebuild the compositor natively** — no JS bridge to AVAssetWriter, no MediaRecorder leaf swap. iOS native = `AVCaptureSession` + `AVPlayerItemVideoOutput` + Core Audio + `AVAssetWriter`, ~1 week of Swift. Android native = analogous Camera2 + MediaCodec + MediaMuxer, ~1 week of Kotlin. **Honest cost: ~2 engineer-weeks of native work post-YC** to close the iOS PWA capture gap. The web canvas + Web Audio code stays as the desktop + Android-PWA path; native iOS gets its own implementation. This is documented up front so May 7 is not a surprise.

### 25.3 NEW-C1 — Mint rate limit + day cap (R4 condition 3)

```sql
-- referral_tokens migration addition:
-- per-user per-day mint cap enforced in recording_open_check_rpc
-- (RPC checks count(*) from referral_tokens where user_id=$u and created_at >= today_start; reject if >= 50)

-- /api/recording/open-check rate limit:
-- 6 calls/min/user, matching voice ticket cadence (existing pattern in /api/sessions/open)
```

Bot harvest blocked. Cost surface bounded. ~15 min implementation.

### 25.4 Day-2 EOD gate — 4 hard pass criteria (R4 condition 4)

All 4 must be green at 23:00 PT on May 2. Else drop to Option B floor on May 3 AM.

1. **Latency:** React-tap → ARMED state ≤ 500ms p95 across 10 trials on Pixel 7 + desktop Chrome.
2. **Output integrity:** 5 consecutive 30s recordings each pass `ffprobe`: 2 streams, ≥ 1 IDR/second, audio drift <100ms, blob ≥ 4MB.
3. **No regressions:** D5 hook-feed audio path passes existing test matrix; PostHog `hook_view_start` rate within ±5% of baseline over 4h window.
4. **No console errors** during 5 consecutive arm/stop/swipe cycles.

If any fails: Option B floor. No "but it almost works."

### 25.5 LiveKit track renegotiation handler (Day-1 task, R4 §6)

`simli-bridge.ts` Day-1 patch:
- Subscribe to LiveKit `RoomEvent.TrackSubscribed` and `RoomEvent.TrackUnsubscribed` (the SDK events the bridge already abstracts behind LiveKit imports — no SDK type leak past bridge).
- On new track: refresh cached `currentVideoTrack` / `currentAudioTrack` + re-fire `onVideoTrack` / `onAudioTrack` to subscribers.
- Update JSDoc on `AvatarBridgeHandlers`: "Fires on initial track and on every renegotiation. Consumers MUST handle re-fire (e.g. recording controller swaps source ref + re-mixes audio node)."
- Recording controller `track.onended` listener still triggers STOP if the new track also ends.

Severity Medium per R4. Day-1 task — not deferrable, otherwise mid-recording ICE blip silently corrupts the output.

### 25.6 Option B floor — 1.5 days (R4 §5)

§23.10 floor revised: **1.5 days, not 1 day.** Honest task list:
- HMAC token primitive (reuse, ✓)
- `referral_tokens` migration + RLS + indexes (~30 min)
- `referral_redemptions` migration + partial unique index (~20 min)
- `/r/[token]/page.tsx` + `Sec-Fetch-Dest` check + cookie set (~1 h)
- `/api/sessions/open` first_session credit wire-in + dedup (~45 min)
- "Invite friends" button × 3 surfaces (responsive + dark/light + a11y) (~2 h)
- Per-creator binding for token at click time (NEW-M3) (~1 h)
- Copy-to-clipboard + ✓ feedback (iOS Safari `NotAllowedError` debug budgeted) (~1 h)
- PostHog events × 3 (~15 min)
- E2E + Vitest round-trip (~1.5 h)
- Manual mobile parity (~1 h)
- = ~9.5 h pure work + debug budget = **1.5 days**

Calendar §23.11 day-by-day stands; floor cut consumes Days 5–6 if triggered, no carryover into Day 4.

### 25.7 NEW-M1: voice-cap denial UX (Day-1 fix)

When `recording_open_check_rpc` returns `{allowed: false, reason: 'voice_cap_hit'}` for `kind='ask_duet'`:
- Active Simli session **continues normally** — no teardown.
- Only the React button on the Ask scene disables with tooltip "Daily voice cap reached — recording unavailable until reset."
- User keeps talking. Cap reset (midnight UTC) re-enables.

### 25.8 NEW-M2: setLocalPlayback test coverage

Vitest covers state-machine ARM→audible=false / STOP→audible=true. iOS edge case (`audioEl.muted=true` mid-WebRTC drops track) verified during spike #3 — if it reproduces, fall back to `audioEl.volume = 0` instead of `muted=true` (volume swap doesn't trigger track-drop in WebKit).

### 25.9 NEW-M3: Option B token binding to creator

Token mint on "Invite friends" tap binds `referral_tokens.creator_id` to the creator the surface is showing (hook-panel's `creator_id`, long-form's `creator_id`, ask-scene's `creator_id`). Landing at `/r/[token]` redirects to that creator's drawer, not generic feed. Same viral hook as the duet variant — the recipient comes for that creator.

### 25.10 Token expiry pg_cron sweep (R4 §9)

```sql
-- Daily sweep: revoke abandoned tokens
-- pg_cron job:
--   UPDATE referral_tokens SET expires_at = now()
--   WHERE expires_at > now()
--     AND created_at < now() - interval '24 hours'
--     AND token_hash NOT IN (SELECT share_token FROM recordings WHERE share_token IS NOT NULL)
--     AND id NOT IN (SELECT token_hash FROM referral_redemptions);
```

Bounds row growth on abandoned-tab tokens. ~5 min.

---

## 26. Final spike kickoff checklist (today, in this order)

```
[ ] 0a. Open crossOrigin="anonymous" PR (R3-M4 / §23.9). Merge + deploy + monitor 24h.
[ ] 0b. Spike 1 — Mux CORS pass-through. 30 min.
[ ] 0c. Spike 2 — iOS canvas→MediaRecorder validity (UPGRADED methodology per §25.1). 1.5 h.
[ ] 0d. Spike 3 — simli-bridge multi-subscriber refactor cost. 45 min.
[ ] 0e. Decision: A (full plan) / A-prime (Android+desktop+Ask only) / B (referral-only).
[ ] 0f. If A or A-prime: apply R4 conditions 3 + 4 to schema + RPC. ~30 min.
[ ] 0g. Day 1 starts — LiveKit renegotiation handler (§25.5) is the first commit on Day 1.
```

---

## 27. DECISION LOCKED — Option A-prime (2026-04-30)

**Vuk approved Option A-prime with full auto-execute trust.**

### A-prime semantics (final)
- **Android PWA + desktop PWA:** full feature — hook duet, long-form duet, Ask-mode duet. Capture, preview, share, referral.
- **iOS PWA:** **NO capture, period.** Not hook, not long-form, not Ask. iOS PWA users see "Coming to iOS — try desktop or copy invite link" CTA on every React button.
- **Native iOS app (post-YC):** rebuilds compositor natively (`AVCaptureSession` + `AVAssetWriter`), ~1 week of Swift. Closes the iOS gap.
- **Native Android app (post-YC):** Camera2 + MediaCodec rebuild, but PWA capture already works on Android Chrome — native is for app-store presence, not capability gap.

### Spike list — REVISED for A-prime
**Dropped (no longer needed):**
- ❌ Spike #2 (iOS canvas→MediaRecorder validity) — moot, iOS PWA gets no capture.
- ❌ Spike #A1 (iOS WebRTC→MediaRecorder validity) — moot, same reason.

**Active (today, autonomous):**
- ✅ Spike #1 — Mux CORS pass-through. Gates Android+desktop hook capture. Autonomous.
- ✅ Spike #3 — simli-bridge refactor (`getCurrentTracks()` + LiveKit renegotiation listener). Gates Ask-mode-during-recording UX. Autonomous.

**Decision tree post-spikes:**
- Spike #1 fail → Option B (referral-only). 1.5 days.
- Spike #1 pass + Spike #3 pass → A-prime as planned, full Day 1 starts tomorrow.
- Spike #1 pass + Spike #3 reveals refactor cost >2h → A-prime with Day-1 buffer reallocated.

### iOS PWA UX (locked)
When an iOS Safari PWA user taps the React button on any surface:
1. Detect via `userAgent` (iOS + Safari/PWA standalone mode).
2. Show modal: *"Recording is coming to iOS soon. Try OakLeague on desktop, or copy this invite link to share @{creator} with a friend."*
3. Inline copy-to-clipboard button + the `oakl.gg/r/<token>` URL. Token mints on tap (referral-only path).
4. Modal dismiss = back to feed. No state corruption.

This is the iOS PWA's referral-only fallback. **iOS PWA users still get the viral funnel via copy-link, just not the duet capture.**

---

## 28. Post-YC follow-ups (item 2 + collected deferrals)

Loaded into plan so the next "what's left to do" agent can find it.

### Engineering
- **C2PA invisible content credentials** — when social platforms (TT/IG/X) verify, add `c2pa-js` lazy-loaded on share. ~1 day.
- **Native iOS app shell** — `AVCaptureSession` + `AVPlayerItemVideoOutput` + Core Audio + `AVAssetWriter` rebuild of compositor. ~1 week Swift.
- **Native Android app shell** — Camera2 + MediaCodec + MediaMuxer rebuild + WebView wrapper. ~1 week Kotlin.
- **Server-side ffmpeg transcode** — webm → mp4 for Android share path. Behind `/api/recording/transcode`. ~2 days.
- **Server-side watermark bake-in** — re-encode after upload with permanent watermark + C2PA. Defeats end-card trim. ~3 days.
- **In-app "My Duets" feed** — uploads enabled, recordings visible to user, replay path. ~1 week.
- **Public duet feed** — discoverable duets per creator, social proof. ~2 weeks (moderation gate first).
- **Duet editor** — cuts, captions, music. ~3 weeks.
- **3-way duet** — user + avatar + reference clip. Composite gets a 3rd layer. ~3 days post-editor.
- **Long-form duets (>60s)** — current cap is 60s. ~2 days (memory + chunking).
- **Recording moderation flags** — `recordings.takedown_at`, admin review queue, creator-side "remove this duet" button. ~1 week.

### Product
- **Bystander consent / privacy** — selfie capture in public spaces; minor-detection on user-cam side. Legal + ML eval. Post-YC.
- **Creator T&Cs duet rights** — checkbox added in v1 (item 3); revisit copy with legal post-YC.
- **Referral perks v2** — replace symbolic toast with real perk (free voice minutes, premium tier upgrade). Pick perk based on v1 telemetry.
- **Cross-token referral fraud detection** — `device_fp` + `ip_prefix` (intentionally cut from v1 for GDPR). Re-add with proper legal basis + reviewer queue when fraud volume justifies.
- **Account-deletion-bypass on first-session credit** — currently a fresh `auth.uid()` re-credits the same referrer. Bind credit to email-hash or device-fp when fraud detection lands.
- **iOS Safari `getUserMedia` UX hardening** — current touch-block-on-prompt overlay is heuristic; revisit with iOS 19 telemetry.
- **VAD ducking** — `webrtc-vad` WASM (~150KB) for proper voice activity detection in audio mixer. Replaces v1 static gain mix.

### Cost / ops
- **Mux upload path** — when "My Duets" lands, recordings hit Mux ingest. ~$300/mo at 10K DAU.
- **Supabase storage for backups** — local-first today; cloud-backup post-YC.
- **Sentry recording-path scrub list expansion** — re-audit when capture surface grows.

---

## 29. Decision log — closed items + remaining gaps

### Closed (2026-04-30)
1. **Mux CORS spike** ✅ PASS — verified via mux-video-react source + curl on all 3 layers (master manifest, rendition manifest, segments). Architectural gate cleared.
2. **iOS PWA capture** ✅ DECIDED — A-prime locked. iOS PWA gets modal-only CTA, no capture. Native iOS app (post-YC, ~1 week Swift) closes the gap. See §27.
3. **C2PA cut** ✅ CONFIRMED — out of v1. Logged in §28 Post-YC follow-ups.
4. **Creator T&Cs (legal copy)** ✅ LANDED — `/legal/creator-terms` page (v2026-05-04) shipped via PR #2; consent checkbox links to it; version pinned in `CREATOR_TERMS_VERSION` constant; audit trail in `creator_applications.duet_consent_at` + `duet_consent_terms_version`.
5. **Referral payout v1 = symbolic** ✅ CONFIRMED — toast variant 1 locked: "@{referrer} gets credit — free voice minutes coming for every friend they bring on 🎙️". No real perk in v1.
6. **YC demo device** (audit R3 C4) ✅ LOCKED — **Demo runs on Vuk's Android phone (or desktop Chrome).** YC partner-on-iPhone path is *not* a duet demo path in v1; if a partner opens the link on iPhone Safari they see the modal-only fallback + the referral copy-link. The pitch deck + demo video must reflect this — Vuk drives the recording flow on Android live; iPhone showcases the consume-side (browse hooks, open Ask session) only.

### Remaining gaps (non-blocking for Day 1 start)
- **Spike #1 real-iPhone draw-to-canvas test** — source + curl confirmed CORS, but the iOS Safari `crossOrigin`-after-src-reload quirk that R3-M4 historically tripped on was not exercised on hardware. Surface as a test step during the 24h post-flag-flip soak (PR #1 / §23.9).
- **Spike #3 real LiveKit `TrackUnsubscribed` exercise** — assessment was paper-only. Real verification happens when Day-1 simli-bridge refactor lands; budget reserved.
- **Migration #008 local apply-and-call** — `supabase db reset && db push` to be run before commit of PR #2 (see §30).

