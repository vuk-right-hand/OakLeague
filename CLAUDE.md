# OakLeague

Interactive video mentorship. Vertical 9:16 hooks → tap → conversational AI avatar of the creator answers in real time. PWA v1. YC S26 application due **2026-05-06**.

**Production from line one.** No hardcoded founder. No `is_founder` flags. No "v2 becomes real later." Schema, auth, RLS, creator onboarding, and admin console all built as if creator #50 signs up in week three. We seed v1 with Vuk as creator #1 *via the real invite → application → approval flow*, not via a hardcoded migration row.

**Stack:** Next.js 15 · TypeScript · Tailwind · shadcn/ui · Supabase (Postgres + Auth + Storage + RLS) · LiveKit Cloud (WebRTC transport + global TURN) · Gemini 3.1 Flash Live (native audio, pinned preview) · Cartesia Sonic 3 · Simli Trinity-1 *or* Tavus (Day 5 spike) · Mux · Vercel · Resend · Sentry · PostHog.

**Package manager:** npm.
**Git flow:** push to main → Vercel production deploy. PRs → Vercel preview/staging.
**Git push authorization:** when Vuk says "push to git" (or equivalent), Claude is pre-authorized to stage, commit, and push to `main` without further confirmation — including setting local `git config user.name` / `user.email` if unset. Destructive ops (force-push, reset --hard, branch delete) still require per-action confirmation.
**Admin seed:** `vukpjescic@gmail.com` (via migration seed of `admin_roles`).

---

## Prime Directive — Verify, Don't Guess

Before recommending any tool, version, API, or fix: web search official docs. No "typically" or "usually." If unverified, say so.
Before debugging: get full stack trace, env, versions, repro from user. Read `.claude_learnings.md` first.

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
- **`profiles.tier` enum: `free | premium | boardroom`.** Default `free`. Admin-only flip (no Stripe in v1). Session routing: free → Flash Live, premium/boardroom → Pro pipeline. `sessions.tier_at_session` snapshot — no mid-session swap.
- **Users set `goals[]` and `obstacles[]` during onboarding.** Used for feed personalization (v2) but collected from day one.
- **Creator knowledge = topic drawers.** Up to 5 topics per creator. Each `sample_content` row (`youtube | transcript | book_or_doc | mastermind_or_course | testimonial`) is `topic_tags[]`-tagged. Session pulls only the relevant drawer, not the whole corpus. Simpler than vector RAG, faster to ship.
- **Admin console in v1 (Days 13-14 polish window):** creator invitation generator, application review queue, creator brain-status visibility, manual tier flip, COGS log viewer with real-time cost per session.

### Voice
- **`VOICE_MODEL` env var, pinned version string.** Banned: `-latest`, bare `-preview` with no version. Default: `gemini-3.1-flash-live-preview`. Fallback one env-swap away: `gemini-live-2.5-flash-native-audio` (GA).
- **Pinned preview strings allowed ONLY with a Spike-A re-verification gate.** Day 4 spike MUST measure real-device PWA latency for both 3.1 and 2.5 on physical iOS Safari + Android Chrome. If 3.1 shows the 15-20s regression Voicer reported on 2026-04-18, flip to 2.5. Document timing data in `.claude_learnings.md`.
- **Voice brain in our code, not LiveKit Agents.** LiveKit Cloud = WebRTC pipe + global TURN. We open a direct WS to Gemini Live and own audio worklets, turn lifecycle, and barge-in.
- **Gemini 3.1 Live breaking changes (bake in from day one):** `thinkingBudget` → `thinkingLevel` (minimal/low/medium/high). Single server events now contain multiple parts simultaneously — parser must iterate. Use `send_realtime_input` for per-turn audio; `send_client_content` only seeds initial history. Tool calling is synchronous only. Proactive audio + affective dialog removed. 15-min audio-only session cap.
- **Avatar pipe stays warm.** Never tear down the WebRTC connection to Simli mid-session. Pause sending audio to lipsync when user speaks (cost meter pauses) — pipe stays open, frames resume instantly when TTS chunks arrive.
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
