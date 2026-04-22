# OakLeague

Interactive video mentorship. Vertical 9:16 hooks → tap → conversational AI avatar of the creator answers in real time. PWA v1. YC S26 application due **2026-05-06**.

**Production from line one.** No hardcoded founder. No `is_founder` flags. No "v2 becomes real later." Schema, auth, RLS, creator onboarding, and admin console all built as if creator #50 signs up in week three. We seed v1 with Vuk as creator #1 *via the real invite → application → approval flow*, not via a hardcoded migration row.

**Stack:** Next.js 15 · TypeScript · Tailwind · shadcn/ui · Supabase (Postgres + Auth + Storage + RLS) · LiveKit Cloud (WebRTC transport + global TURN) · Gemini 3.1 Flash Live (audio-in brain, AUDIO mode with `outputAudioTranscription` — we read the transcript text and discard the audio, pinned preview) · Cartesia Sonic 3 (cloned voice TTS — the **only** voice path; zero bland AI voice anywhere) · Simli Trinity-1 (all tiers while we evaluate premium alternatives — Tavus scrapped after Spike B) · Mux · Vercel · Resend · Sentry · PostHog.

**Package manager:** npm.
**Git flow:** push to main → Vercel production deploy. PRs → Vercel preview/staging.
**Git push authorization:** when Vuk says "push to git" (or equivalent), Claude is pre-authorized to stage, commit, and push to `main` without further confirmation — including setting local `git config user.name` / `user.email` if unset. Destructive ops (force-push, reset --hard, branch delete) still require per-action confirmation.
**Admin seed:** `vukpjescic@gmail.com` (via migration seed of `admin_roles`).

---

## Prime Directive — Verify, Don't Guess

Before recommending any tool, version, API, or fix: web search official docs. No "typically" or "usually." If unverified, say so.
Before debugging: get full stack trace, env, versions, repro from user. Read `.claude_learnings.md` first.

## Core Architecture Principle — Provider-Agnostic

**The face is a commodity; the brain is the moat.** OakLeague does not build rendering infrastructure, voice models, or transport layers. We consume them behind clean interfaces and swap when the market moves.

Every external AI/media provider sits behind a thin, typed bridge interface:

- **Voice**: `VOICE_MODEL` env var + fallback. Today: **Gemini 3.1 Flash Live** (audio-in, AUDIO mode with `outputAudioTranscription` — we grab the streaming transcript text Google emits alongside the audio, throw the audio away, and feed the text into Cartesia). Fallback: 2.5 Flash Native Audio for STT + 2.5 Pro for brain, still into Cartesia. **Gemini's stock voice is never user-facing, on any tier.** Phase 0 verified: 3.1 Live refuses `responseModalities=[TEXT]` ("Internal error encountered." on open) but accepts `[AUDIO] + outputAudioTranscription:{}` and streams usable transcript chunks. See `docs/_planning/PHASE_0_MEASUREMENTS.md`.
- **Avatar**: `AvatarBridge` interface (`open | sendAudio | cancel | close` + error taxonomy). Today: Simli Trinity-1 for all tiers (Tavus scrapped after Spike B; premium avatar provider to be re-evaluated post-YC). Routing still happens at session-open from `sessions.tier_at_session` so a future premium swap doesn't require a refactor — **never** mid-session.
- **TTS** (when we add non-native-audio paths): same pattern.
- **Video hosting**: Mux behind a thin wrapper.

Rules this enforces:
1. **No provider SDK types leak past the bridge.** Consumers import only our interface.
2. **Every provider call writes `cogs_log`** with `service` enum + `environment` + pinned `QUOTED_AT` rate. Swap-ready accounting.
3. **Error taxonomy is ours, not theirs.** Map provider errors to our const-union codes (`connect_timeout | replica_not_ready | rtc_ice_failed | ...`) at the bridge boundary.
4. **Swap cost = one env var + one bridge file**, not a refactor. When Simli catches Tavus or a new $0.005/min entrant beats both, we change `AVATAR_PROVIDER_FREE=x` and ship. No business logic moves.
5. **Tier routing at session-open only.** WebRTC mid-session hot-swap is forbidden (ICE restart + audio gap + state reconciliation = unsolvable in our time budget).
6. **Partnership / committed-volume deals happen at the bridge layer**, not in product code. At 10K DAU we negotiate a rate with whoever's winning; the rest of the stack doesn't notice.

This is the YC pitch in one sentence: we're an operator-network + cloned-voice + RAG-brain company, not an infrastructure company. The rendering war is someone else's problem; we plug in whoever wins at each layer.

## Reference Material (Load When Relevant)

- `docs/OAKLEAGUE_WALKTHROUGH.md` — product, data model, flows, gotchas, day-by-day plan. Read on session start.
- `docs/VIBECODERSHQ_HANDOFF.md` — load when touching auth, Supabase, RLS, server actions, PWA, deploy.
- `docs/VOICER_VOICE_GUIDE.md` — load when touching voice code, audio worklets, WS lifecycle, barge-in.

These are reference docs, not pre-reading homework. Grep them when their domain comes up. Trust them over priors when they conflict.

## Planning Loop (Every Non-Trivial Feature)

1. Draft strike-through checklist: schema, files, tests, edge cases, order
2. Auditor subagent (`.claude/agents/auditor.md`) via Task tool — returns Critical (3-5), Medium (5-7), Small. Apply revisions.
3. Re-audit revised plan
4. Third audit only if critical gaps remain. Max 3 rounds.
5. Web-verify every stack claim
6. Approval gate, wait:
```
[1] Approve & auto-execute
[2] Approve & confirm each step
[3] Keep planning
[4] Changes: ___
```

## Implementation — TDD

Per step: write test → run (fails right) → implement → run (passes) → strike → next.
Test data integrity, webhooks, RLS, voice session lifecycle, barge-in, COGS guardrails.
Skip tests for basic UI and standard routing.
Real-API gated test (`RUN_REAL_API_TESTS=1`) for the voice provider — single canned WAV → real Gemini → assert response. Catches silent model deprecation.

---

## Hard Rules — These Override Everything

### Auth & RLS
- Day-one `src/lib/auth-guards.ts` exporting `getCallerUserId()` and `assertAdminFromSession()`. Every server action calls them. Never inline.
- RLS on every table. Service-role-only tables = RLS enabled, **zero** policies.
- Server actions: getCaller → ownership check → field whitelist → mutate → revalidate. Whitelist, never spread `patch`.
- `window.location.href` after login/signup/role/tier change. Never `router.push()`.
- Cookies: `httpOnly: true, secure: prod, sameSite: 'lax'`. No variations.
- Ghost user fix is context-dependent: OAuth claim flow may overwrite (provider proved email ownership). Email signup flow MUST send magic link to verify ownership before any password set. See walkthrough Part 6.

### Creator & User Model
- **Creator onboarding is invite-only in v1.** Admin generates invite link → creator signs up via token → fills application → admin reviews in queue → approves → brain-training job runs → published.
- **`creators.creator_type` enum: `human | brand | sponsored_segment`.** v1 uses `human` only. Interactive ads (brand / sponsored_segment) are v2 — same primitive, same table, different type. Added now to avoid a v2 migration.
- **`profiles.tier` enum: `free | premium | boardroom`.** Default `free`. Admin-only flip (no Stripe in v1). Session routing snapshot into `sessions.tier_at_session` — no mid-session swap.
    - **Voice pipeline is the same for every tier** (Pipeline α' — 3.1 Flash Live AUDIO + outputAudioTranscription → text → Cartesia cloned voice). Tier gates **minutes per day** only. v1 caps: free = 5 min/day + 15 min/week (weekly cap flattens binge users → natural upgrade moment), paid tiers raise caps but never swap pipelines. Caps enforced by `voice_usage_daily` / `voice_usage_weekly` tables + `voice_usage_ticket_check` RPC at session-open. No Gemini stock voice on any tier, no tier-based model swap.
    - **Avatar provider**: Simli Trinity-1 for every tier today. Premium avatar provider re-evaluated post-YC (Tavus scrapped). `sessions.tier_at_session` still snapshotted so a future swap is a bridge-file change, not a product refactor.
- **Users set `goals[]` and `obstacles[]` during onboarding.** Used for feed personalization (v2) but collected from day one.
- **Creator knowledge = topic drawers.** Up to 5 topics per creator. Each `sample_content` row (`youtube | transcript | book_or_doc | mastermind_or_course | testimonial`) is `topic_tags[]`-tagged. Session pulls only the relevant drawer, not the whole corpus. Simpler than vector RAG, faster to ship.
- **Admin console in v1 (Days 13-14 polish window):** creator invitation generator, application review queue, creator brain-status visibility, manual tier flip, COGS log viewer with real-time cost per session.

### Voice
- **`VOICE_MODEL` env var, pinned version string.** Banned: `-latest`, bare `-preview` with no version. Default: `gemini-3.1-flash-live-preview` run in AUDIO mode with `outputAudioTranscription:{}` enabled — we read the streaming transcript text and discard the audio bytes. Fallback one env-swap away: `gemini-2.5-flash-native-audio-preview-12-2025`.
- **Spike-A gate CLEARED 2026-04-21.** 3.1 pin holds. Measured across desktop Chrome, Pixel 7 Pro (WiFi + LTE), iPhone 11 (WiFi + LTE): 3.1 p50 ≈ 2.5–3.4s, ~2× faster than 2.5 across the matrix. Voicer's 15–20s regression did not reproduce on any surface. **3.1 is the user-audio-input winner by a wide margin — 2.5 is not a candidate for audio input, ever, on any tier.** Full data: `.claude_learnings.md`, `docs/VOICER_VOICE_GUIDE.md §2`. Re-run gate only if Google ships a new preview string or Voicer files a fresh reproducible regression.
- **Pipeline α' is the architecture.** One pipeline for every tier: user audio → 3.1 Flash Live (AUDIO mode + `outputAudioTranscription:{}`) → we read `serverContent.outputTranscription.text` chunks and **discard** the audio bytes Google generated → Cartesia Sonic 3 cloned voice (creator's own voice) → user. Tier (`free | premium | boardroom`) gates **minutes per day only** (free = 5/day + 15/week; admin-editable `voice_daily_cap_seconds` / `voice_weekly_cap_seconds` / `voice_monthly_cap_seconds` on `profiles`). No tier-based model swap, no tier-based TTS swap, no Gemini-native-audio path ever reaches user ears. **α (TEXT-out) was ruled out by Phase 0 runtime check — 3.1 Live preview rejects `responseModalities=[TEXT]`.**
- **Voice brain in our code, not LiveKit Agents.** LiveKit Cloud = WebRTC pipe + global TURN. We open a direct WS to Gemini Live and own audio worklets, turn lifecycle, and barge-in.
- **Gemini 3.1 Live breaking changes (bake in from day one):** `thinkingBudget` → `thinkingLevel` (minimal/low/medium/high). Single server events now contain multiple parts simultaneously — parser must iterate. Use `send_realtime_input` for per-turn audio; `send_client_content` only seeds initial history. Tool calling is synchronous only. Proactive audio + affective dialog removed. 15-min audio-only session cap.
- **Avatar pipe stays warm.** Never tear down the WebRTC connection to the avatar provider mid-session (Simli or Tavus — applies to both). Pause sending audio to lipsync when user speaks (cost meter pauses) — pipe stays open, frames resume instantly when TTS chunks arrive.
- **Semantic router runs at session-open, not per-turn.** Tier is locked for the session's duration. We do not hot-swap WS mid-conversation.
- **Camera off by default.** Opt-in only. Visible indicator when on.

### Content & COGS
- **Every paid API call writes to `cogs_log`** with kill-switch at 150% of user quota.
- **Don't use Deepgram.** STT is Gemini native multimodal.
- **Don't pre-model Stripe columns.** Billing is v2. `tier` is the only monetization surface in v1 schema.
- **Don't silently catch exceptions in voice connect.** Build error taxonomy first (Voicer §8).

---

## Debugging

Read `.claude_learnings.md` first. After every fix, append:
```
## YYYY-MM-DD — <short title>
Root cause: <one line>
Fix: <one line, file path>
Lesson: <one line>
```

## Pre-Deploy Red Team Check

Run before every merge to main. Full checklist in `docs/VIBECODERSHQ_HANDOFF.md` §17.
