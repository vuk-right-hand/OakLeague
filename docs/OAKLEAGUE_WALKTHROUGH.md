# OakLeague — Agent Onboarding Brief

Read this in full on session start. Then load the handoff docs (`docs/VIBECODERSHQ_HANDOFF.md`, `docs/VOICER_VOICE_GUIDE.md`) when their domains come up — auth/Supabase work pulls in VibeCoders, voice work pulls in Voicer. Do not pre-read everything before writing one line of code; that's wasteful. Trust the handoffs over your priors when they conflict.

---

## Part 1 — What We're Building

OakLeague is interactive video mentorship. End to end:

User opens app. First screen: 30-second full-screen welcome hook from the creator. *"This isn't TikTok, this isn't YouTube, this is a conversation with the people you'd pay $10K/mo to sit across from."* Then the feed loads.

Vertical 9:16, slow-paced, single-shot talking-head hooks. 60–90 seconds. One key idea per hook. Substance, not spectacle. Each "video" is a 5-hook carousel — five lessons on one topic from one creator. Swipe up = next video (new topic). Swipe right = next lesson in current topic.

User taps "Ask" anywhere during a hook. Screen rotates/expands to 16:9 horizontal, avatar is now live and conversational. The avatar — AI clone of the creator with their voice, face, pacing, and decision-tree logic — answers the user's question in real time.

**Tiered model routing** at session-open: `free` → Gemini 3.1 Flash Live (native audio dialog). `premium` / `boardroom` → Pro pipeline (STT via Flash Live transcription → Gemini Pro text reasoning → Cartesia TTS). Locked for the session's duration. v1 implements Flash routing end-to-end; Pro pipeline scaffolded and demo-flippable via admin tier override.

Free tier: 10 minutes/day of Answer Time (the conversational leg), reset at user local midnight. Feed scroll is unlimited and free-of-COGS. Camera off by default, opt-in only.

**v1 is seeded with Vuk as creator #1 through the real onboarding flow — not hardcoded.** The system encodes no special-case for any creator ID. Interactive ads (brand avatars / sponsored segments) are v2, but the `creator_type` enum is in place from day one so v2 lands as a data change, not a migration.

**COGS engineering is the moat.** MP4 hooks (cheap CDN bandwidth) for 90%+ of user time. WebRTC + avatar only when avatar is *speaking* — when user talks, we pause sending audio to Simli's lipsync compute (pipe stays warm, only paying for generated frames).

**Thesis:** Static one-way video is over. Interactive conversational video is the new category. OakLeague is the first consumer platform for it. *Our creator-side conversational primitive is structurally the next ad unit — same tech, brand instead of creator.* That's the YC narrative leverage.

**v1 scope (2026-05-06):** Invite-only creator onboarding + admin review console. One creator seeded (Vuk). One topic (TBD within 48h). 5–10 hooks. Working session with barge-in. Welcome hook. Landing page + waitlist. User onboarding (goals + obstacles). Feed (non-personalized v1). Tier enum + admin flip. COGS log + kill-switch + admin viewer. 60-second demo video.

**Out of v1:** Stripe billing. Brand/sponsored-segment creator types (enum exists, unused). Real-time feed personalization from goals/obstacles. Native apps. Multi-language. Custom video orders. Multi-tier routing hot-swap per turn.

---

## Part 2 — The Stack

**Frontend:** Next.js 15 App Router. TypeScript. Tailwind. shadcn/ui. RSC by default. PWA via manifest + service worker. npm.

**Backend:** Supabase. Postgres + Auth + Storage + Edge Functions. RLS on every table. Patterns from `docs/VIBECODERSHQ_HANDOFF.md` §2–§4. Day-one artifact: `src/lib/auth-guards.ts`.

**Realtime transport:** LiveKit Cloud as WebRTC pipe + global TURN. Not LiveKit Agents framework.

**Voice brain:** Direct WebSocket to Gemini Live. Default `gemini-3.1-flash-live-preview` (pinned via `VOICE_MODEL_PRIMARY` env). Fallback `gemini-2.5-flash-native-audio-preview-12-2025` (pinned via `VOICE_MODEL_SECONDARY`) — one env-swap recovery. Browser audio worklets per `docs/VOICER_VOICE_GUIDE.md` §4–§7.

**Per-session model selection:** When session opens, we choose Flash Live (free) or Pro pipeline (premium/boardroom) based on user tier. Session is locked to that choice for its full duration. `sessions.tier_at_session` snapshots for audit.

**TTS:** Cartesia Sonic 3. Voice cloned from creator audio (Cartesia needs 3-60s of clean audio).

**Avatar:** Simli Trinity-1 (pending Day 5 spike vs Tavus). WebRTC pipe stays warm continuously; we pause sending audio to lipsync when user speaks.

**Video CDN:** Mux for hook MP4s.

**Hosting:** Vercel. Edge runtime where possible. **Two envs from day one** — staging on every PR, production on main.

**Observability:** Sentry, PostHog, custom `cogs_log` table + admin viewer page.

**Email:** Resend, transactional only (creator invites, admin notifications, magic links).

**Languages:** TypeScript everywhere user-facing. Python only for offline creator brain-training pipeline (if needed beyond Gemini prompt caching — likely not v1).

No Stripe. No Deepgram.

---

## Part 3 — Three Architecture Decisions That Need Their Reasoning

**LiveKit transport, not LiveKit Agents.** LiveKit Cloud is the WebRTC pipe + global TURN. We do not use their Agents framework. Reason: voice turn management, barge-in, audio worklet plumbing, provider WebSocket — Voicer's hard-won lesson is that every layer of abstraction added is two days of debugging when something breaks. LiveKit Agents is a fine product for teams who never need to look inside; we will need to look inside repeatedly during YC crunch. Single-WS architecture per Voicer §3 is debuggable. Voice brain in our code, audio over LiveKit's pipe.

**Avatar pipe stays open continuously.** WebRTC handshake is 500ms-2.5s. You cannot tear down and re-establish mid-conversation — the avatar would freeze on every turn. Correct architecture: keep the WebRTC connection to Simli alive for the entire session. When user starts speaking, pause sending audio frames to Simli's lipsync compute (their server stops generating new video frames, our cost meter stops). When TTS chunks resume, push audio to lipsync, frames flow back instantly. Same cost savings (Simli charges per generated second), zero re-negotiation. The on-device "nodding MP4 loop" plays in the avatar's video region while Simli is paused — purely local, zero network.

**Semantic router runs at session-open, not per-turn.** Native multimodal Gemini Live requires opening a persistent WebSocket to a specific model before the user speaks. You cannot listen to user audio on Flash WS, decide it's a complex question, and hot-swap mid-sentence — the latency cost destroys the conversation. Correct architecture: routing happens at session-open by user tier. `free` → Flash Live WS. `premium` / `boardroom` → Pro pipeline. Session is locked to that routing. Gross margins absorb running Pro for an entire 90-min Boardroom block. v2 optimization: run a cheap text classifier on the *transcript* of each turn; if the next turn looks consulting-grade, pre-warm a second WS that swaps in on next user tap. Not v1.

---

## Part 4 — Data Model (v1)

Confirmed via Data-First gate before any application logic. Schema is production-grade from the first migration — no v2-placeholder columns, no hardcoded creator IDs.

### Identity & tiers

`profiles` — extends `auth.users`. `id` (FK auth.users), `display_name`, `handle`, `avatar_url`, `timezone`, `tier` enum (`free` | `premium` | `boardroom`, default `free`), `goals text[]`, `obstacles text[]`, `onboarded_at`, timestamps. RLS: own row read/update.

`admin_roles` — `email text PRIMARY KEY`, `role` enum (`superadmin`), seeded with Vuk's email on first migration. RLS: zero policies (service-role only). Admin checks derive from SSR cookie → `auth.users.email` → `admin_roles` lookup.

### Creator onboarding (invite-only)

`creator_invitations` — `id` (uuid PK), `email`, `invite_token` (unguessable, signed, unique), `invited_by` (FK profiles.id), `expires_at`, `used_at`, `notes`, timestamps. RLS: zero policies.

`creator_applications` — `id`, `profile_id` (FK profiles.id, set after signup), `invitation_id` (FK), `name`, `handle`, `bio`, `topics text[]` (≤5), `proof jsonb` (`{website_url, primary_social, why_me, calendly_url?}`), `status` enum (`submitted` | `under_review` | `approved` | `rejected`), `admin_notes`, `submitted_at`, `reviewed_at`, `reviewed_by`, timestamps. RLS: applicant reads own (via profile_id), service-role writes.

`creators` — `id`, `profile_id` (FK profiles.id, UNIQUE), `creator_type` enum (`human` | `brand` | `sponsored_segment`, default `human`), `bio`, `topics text[]`, `brain_status` enum (`pending` | `training` | `ready` | `errored`), `system_prompt_cache_id`, `voice_id`, `simli_face_id`, `published_at`, timestamps. RLS: read-public when `published_at IS NOT NULL AND creator_type = 'human'`; brand/sponsored follow separate read logic in v2.

`sample_content` — "topic drawers" for brain training. `id`, `creator_id` (FK), `source_type` enum (`youtube` | `transcript` | `book_or_doc` | `mastermind_or_course` | `testimonial`), `source_url`, `raw_text`, `topic_tags text[]` (must intersect `creators.topics`), `fetch_status` enum (`pending` | `fetched` | `errored`), `fetched_at`, timestamps. RLS: creator reads/writes own; admin reads all.

### Feed content

`welcome_hooks` — `id`, `mux_playback_id`, `duration_seconds`, `transcript`, `active bool`, timestamps. Single active row at a time. First-open event, not feed content. Ask-button disabled during welcome. RLS: read-public when active.

`videos` — topic container. `id`, `creator_id`, `title`, `description`, `thumbnail_url`, `lesson_count`, `published_at`, timestamps. RLS: read-public when published.

`hooks` — the vertical MP4s users swipe. `id`, `video_id`, `lesson_number` (1-5), `mux_playback_id`, `duration_seconds`, `transcript`, `opening_prompt`, `question_seeds jsonb`, `published_at`, timestamps. RLS: read-public when parent video published.

### Sessions & cost

`sessions` — `id`, `user_id`, `creator_id`, `hook_id`, `livekit_room_id`, `model_used text` (free-form — pinned string from `VOICE_MODEL`), `tier_at_session` enum (snapshot), `started_at`, `ended_at`, `active_seconds`, `total_cost_usd numeric`, `state` enum (`active` | `ended` | `errored`). RLS: own only.

`session_turns` — `id`, `session_id`, `turn_number`, `user_audio_duration_ms`, `transcript`, `llm_input_tokens`, `llm_output_tokens`, `llm_cache_hit bool`, `tts_characters`, `avatar_seconds`, `cost_breakdown jsonb`, `created_at`. RLS: own via parent session.

`daily_quotas` — `user_id`, `date`, `answer_seconds_used` (default 0), `answer_seconds_limit` (tier-derived: free=600, premium=3600, boardroom=14400 soft cap), `streak_days`. Reset job runs hourly across timezones. RLS: own only.

`cogs_log` — append-only. `id`, `created_at`, `user_id`, `session_id`, `provider`, `operation`, `units numeric`, `unit_label text`, `cost_usd numeric`. RLS: zero policies. Kill-switch: when a session's cumulative `cost_usd` crosses 150% of that user's tier quota, the session's `state` goes to `errored` and a new session create is blocked for the day.

### Waitlist & auth recovery

`waitlist` — `email`, `source`, `created_at`, `position`. RLS: insert-public, read service-only.

`auth_pending_verifications` — `email`, `verification_token`, `expires_at`. For email-signup ghost-user recovery per Part 6. RLS: zero policies.

### Notes
- Migrations live in `supabase/migrations/`. Verify columns via `information_schema.columns` after every migration before declaring done.
- Every enum is CHECK-constrained at the DB level *and* typed in TS. Don't trust TS to enforce DB invariants.
- FK CASCADE choices: `profiles` delete cascades to `creators`, `creator_applications`, `sample_content`, `sessions`, `daily_quotas`. `cogs_log` is append-only and user_id is nullable on delete (preserve historical cost records).

---

## Part 5 — The Four Critical Flows

**Flow A — Feed scroll.** User opens app → SSR serves first hook + cached upcoming list → Mux URL streams MP4 → plays. Swipe up preloads next. No WebRTC, no avatar, no paid APIs touched. Cost per 10 min of scroll: fractions of a cent in bandwidth.

**Flow B — Tap-to-session.** User taps "Ask" → API route checks `daily_quotas`. If exceeded: modal "Resets at midnight, join waitlist for more." If OK: read `profiles.tier`, select model path (free → Flash Live; premium/boardroom → Pro pipeline), create `sessions` row with `model_used` and `tier_at_session` snapshots, generate LiveKit access token, return to client. Client connects to LiveKit room. **In parallel:** client opens WebSocket to Gemini Live (model from session row) with creator's pre-built system prompt + relevant topic drawer. Avatar WebRTC pipe to Simli established. Screen rotates to horizontal. Hook MP4 pauses. Avatar fades in, opening line: "I see you're on lesson 2 about X — what do you want to dig into?"

**Flow C — Conversational turn.** User taps mic. Mic worklet captures PCM16 @ 16kHz (with FIR decimation if Android), streams over WS to Gemini via `send_realtime_input`. Gemini's native audio model interprets meaning + transcription simultaneously. Generates response. Response streams to Cartesia. Cartesia streams audio chunks back. Each chunk: written to TTS worklet ring buffer + handed to Simli for lipsync. Avatar speaks. **During user speech:** we stop sending audio to Simli's lipsync (cost meter pauses), local nodding MP4 plays in the avatar region, WebRTC connection to Simli stays open. When TTS chunks resume, audio flows to Simli, frames flow back instantly. Every API call writes to `cogs_log`.

**Flow D — Session end & resume.** User navigates away or session hits quota mid-turn. Client sends end signal. Server finalizes `sessions` row. Quota decremented. If cost >150% of quota: flag, alert, kill-switch. LiveKit room destroyed. **iOS Safari backgrounding:** WebRTC dies, but session state persists server-side per turn. User taps back into the same hook within 5 minutes → "welcome back, we were discussing X" pre-roll while we re-establish.

---

## Part 6 — Non-Obvious Gotchas (Each Saves a Day)

**Ghost user recovery is context-dependent.** The VibeCoders pattern (overwrite password on "already exists") is safe ONLY for OAuth claim flows where the OAuth provider has already proven email ownership. For email signup mid-fail, blindly overwriting passwords is an account hijack vector. Correct pattern for email signup:
1. `createUser` returns "already exists"
2. Check if existing user has a profile row
3. If yes → real account → redirect to login (or send password reset)
4. If no → true ghost (auth row exists, profile doesn't) → insert into `auth_pending_verifications` with token, send magic link
5. On link click → verify token → complete profile → log in

**Gemini 3.1 Live breaking changes from 2.5** (Voicer's original doc was written for 2.5):
- `thinkingBudget` → `thinkingLevel` (`minimal` / `low` / `medium` / `high`)
- Single server events contain multiple parts simultaneously — parser must iterate all `parts[]`, not assume one
- Use `send_realtime_input` for per-turn live audio; `send_client_content` now only seeds initial history
- Tool calling is synchronous only — no async / non-blocking function support
- Proactive audio + affective dialog removed
- 15-min hard cap on audio-only sessions (2-min on audio+video)

**iOS Safari kills WebRTC on background.** Session state lives server-side per turn. On reconnect, replay last N turns as context, mask reconnect with contextual avatar greeting.

**iOS audio unlock is one-shot.** `audioCtx.resume()` must run inside the connect-button click handler. Otherwise TTS is silent in production 90% of the time on iOS. (Voicer §5.3)

**Camera permission is one-shot on iOS.** Custom pre-prompt modal explaining why. Only "Enable" tap triggers system dialog.

**Android Chrome ignores `sampleRate: 16000` hint.** Read `audioCtx.sampleRate` after construction, decimate in worklet with FIR low-pass. (Voicer §4.1, §4.2)

**Pre-warm AudioContext + worklets + WebSocket at connect, NOT mic.** `getUserMedia` only inside the voice-tap handler. (Voicer §4.3)

**`active = true` BEFORE any await in session start.** Voicer lost the first 3-5 seconds of every connect to this. (Voicer §4.6)

**LiveKit cold starts on Build plan: 10-20s.** Move to Scale plan post-YC. For dev, ping to keep warm.

**Gemini prompt caching has TTL.** Cache expires → next session COGS jumps 10×. Monitor cache hit rate. Auto-refresh before expiry. Log every call's cache hit/miss.

**Migration filename ≠ migration applied.** Verify columns via `information_schema.columns` before trusting. (VibeCoders §4)

**`window.location.href`, never `router.push()`** after login/signup/role/tier change. (VibeCoders §2)

**Proxy matcher excludes `.json`, `.webmanifest`, etc.** Otherwise PWA manifest redirects to `/login` for guests. (VibeCoders §5, §13)

**Don't pre-model Stripe columns.** (VibeCoders §19)

**Voice provider model strings retire silently.** `VOICE_MODEL` env var, pinned. Real-API gated test catches deprecation. (Voicer §2, §10)

**`worklet.port.onmessage` closure captures stale WS ref.** Rebind every `startListening`. (Voicer §4.5)

**Don't silently catch exceptions in voice connect.** Error taxonomy (Voicer §8) before happy path.

**Invite tokens must be unguessable, signed, single-use, and time-limited.** An invite token that also acts as a creator-auth bypass is a critical vulnerability. Token grants ability to *apply*, not to *be a creator*.

---

## Part 7 — The Two Pending Spikes (Days 4-5)

Each timeboxed to one day with measurement criteria written before testing starts.

**Spike A — Gemini 3.1 Flash Live vs 2.5 on real-device PWA.** Context: Voicer reported on 2026-04-18 a 15-20s end-to-end latency regression on 3.1 in PWA on real phones. Google's blog claims 3.1 is faster. We've committed to 3.1 as default *contingent on this spike*. Criteria: end-to-end latency from user-stops-talking to avatar-starts-speaking on Pixel 7 Pro (4G) + iPhone 15 (Safari PWA). Cold-start latency for second turn. 10-minute conversation stability. Hypothesis: 3.1 wins on quality, 2.5 wins on latency until Google ships a 3.1 fix. If 3.1 regression confirms, flip `VOICE_MODEL` env → `gemini-live-2.5-flash-native-audio`, zero code change. Document timing data in `.claude_learnings.md`.

**Spike B — Simli Trinity-1 vs Tavus.** Criteria: visual fidelity in side-by-side test on same audio input. Latency from audio chunk arrival to lip-sync render. Cost per minute at projected 600K active min/month. Hypothesis: Simli wins on cost decisively, Tavus wins on visual fidelity. Vuk approves side-by-side before commit.

If results are inconclusive, default to hypothesized winner and document open question in `.claude_learnings.md`.

---

## Part 8 — The 22-Day Build Plan

**Days 1-3 (Apr 20-22) — Foundation.** Next.js scaffold. Supabase project (two envs — staging + prod). Schema migrations per Part 4, Data-First gate + auditor pass. RLS policies on every table. `lib/auth-guards.ts` first. Auth flows (email + Google OAuth) per VibeCoders §6. Email signup with proper ghost-user recovery (Part 6). **Invite-only creator onboarding:** admin-only invite generator, signup via token, `/apply` form, application queue, admin approval flow, brain-training job stub. User onboarding (goals + obstacles). Proxy/middleware with correct matcher exclusions. Vercel staging + prod. Sentry + PostHog. **Deliverable:** sign up, log in, hit protected route on staging. Admin can invite, applicant can apply, admin can approve.

**Days 4-5 (Apr 23-24) — Spike days.** Spike A and B per Part 7. **Deliverable:** voice model locked (3.1 or 2.5), avatar provider locked, measurements in `.claude_learnings.md`.

**Days 6-7 (Apr 25-26) — Feed.** Mux account. Upload tooling. `videos` + `hooks` populated with founder content (recorded in parallel days 2-5). Vertical feed with gesture handling. Welcome hook on first open. **Deliverable:** stranger can scroll on physical phone.

**Day 5 inherited from Spike A audit (2026-04-21):** (1) redesign or delete `public/worklets/mic-processor.js` — the current carry-logic drops sample 0 and the file is unused by the spike harness; (2) iOS TTS playback via MediaSource/SourceBuffer Opus/webm (Spike A accepted Web Audio AEC regression); (3) implement Priming Window primitive — must use canned audio or seeded text, NOT silent PCM (empirically invalidated Phase 0). Full hand-off: `docs/SPIKE_A_V2_PLAN.md` § Deferred items.

**Days 8-12 (Apr 27 - May 1) — Voice pipeline.** Build in Voicer §13 order strictly:
1. Hello-world WS to Gemini 3.1 Live, canned text, response received
2. Mic worklet → 16kHz PCM → WS → live transcript (via `send_realtime_input`)
3. Transcript → Gemini → TTS audio via TTS worklet ring buffer
4. Pre-warm split (connect cheap, tap cheap)
5. Multi-turn without WS reconnect
6. Barge-in (TTS flush + response cancel)
7. Error taxonomy
8. Ephemeral token refresh

Per-session model selection by user tier. Cartesia voice cloned. Daily quota enforcement. `cogs_log` writes on every call. **Deliverable:** tap "Ask" → conversation → quota decrements → barge-in works.

**Day 8 inherited from Spike A audit (2026-04-21):** (1) heartbeat write amplification — aggregate per-session in memory, flush every N seconds instead of one `session_turns` row per turn; (2) add `daily_quotas.day_utc` GENERATED column + composite `(user_id, day_utc)` index; (3) tighten ghost-session reaper from spike's ~150s to <30s; (4) migrate COGS pricing from seconds-times-`$PRICE_USD_PER_SEC` folklore to real `usageMetadata` tokens once Gemini Live surfaces them reliably. Full hand-off: `docs/SPIKE_A_V2_PLAN.md` § Deferred items.

**Days 13-14 (May 2-3) — Avatar + admin + polish.** Simli (or Tavus) layer with pipe-stays-warm logic. Local nodding MP4 pre-rendered. Lip-sync timing tuned. Camera permission pre-prompt. Hook → session transition. Resume-session for iOS backgrounding. **Admin console:** creator application queue, creator brain-status visibility, manual tier flip (free / premium / boardroom), **COGS log viewer** (real-time per-session cost, kill-switch visibility). Landing page with thesis + waitlist + demo video embed. Loading skeletons. Modal dismissal patterns. **Deliverable:** stranger uses end-to-end without guidance on physical iOS Safari + Android Chrome. Admin can demo tier-flip live (Vuk's own account → premium → Pro pipeline visible).

**Days 15-16 (May 4-5) — Demo + application.** Record 60-second YC demo. Record 1-minute founder video. Write YC application. Test on 5 real users. Fix worst issue. Submit by May 6.

**Days 17-22 (May 6-12) — Buffer.** Bug-fix only, no new features. Mobile verification matrix. Token refresh stress test. Stuck-job self-heal verified. COGS kill-switch verified. Red Team Checklist run.

---

## Part 9 — How To Work Here

1. CLAUDE.md is the operating contract. Read on every turn.
2. This walkthrough is the project map. Read on session start.
3. Handoffs are reference material. Load when their domain comes up.
4. Before non-trivial features: planning loop with auditor subagent. Approval gate. Wait.
5. Before paid API integration: cost log + kill-switch.
6. Before production: RLS verified, Red Team Checklist run.
7. After every fix: append to `.claude_learnings.md`.
8. If founder instruction conflicts with these docs: ask which wins.

When in doubt, optimize for: (1) YC demo quality, (2) COGS sanity at scale, (3) shipping by 2026-05-06. In that order.
