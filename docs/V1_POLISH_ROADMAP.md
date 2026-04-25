# v1 Polish Roadmap — rc1 → YC S26 Submission

**Window:** 2026-04-23 (rc1 tagged) → 2026-05-06 (YC S26 application due).
**Bar:** YouTube/TikTok consumer-app polish. Not "working demo." See [feedback_youtube_tiktok_polish_bar.md](../../../Users/Korisnik/.claude/projects/c--Antigravity-OakLeague/memory/feedback_youtube_tiktok_polish_bar.md).
**Status tracker:** update this file as items land; resist feature creep — polish, instrumentation, stress tests only.

---

## Tier 1 — Test debt cleanup ✅ DONE (verified 2026-04-25)

All six tests fixed and the new one created during the rc1 → D4 window. Suite at **105 files / 249 tests / Result: PASS**.

- [x] `quota_tier_flip_same_day.test.sql` — uses `gemini_3_1_flash_live_preview` (Pipeline α' single-model). `plan(2)`.
- [x] `admin_roles_revoked_denied.test.sql` — inserts `user_id` from `tests.create_auth_user`. `plan(2)`.
- [x] `admin_tier_flip_invariants.test.sql` — `plan(8)`.
- [x] `admin_force_close_session.test.sql` — `plan(6)`.
- [x] `admin_roles_service_role_delete_blocked.test.sql` — `plan(2)`.
- [x] NEW `admin_set_user_voice_caps.test.sql` — `plan(11)` covers admin guard (42501), missing user (P0002), all 3 range errors (22003 daily/weekly/monthly), happy path, audit log triple, NULL weekly/monthly disabling caps.
- [x] Re-run `supabase test db` — 249/249 green, 3-second wallclock.

---

## Between Tier 1 and Tier 2 — Feed algorithm instrumentation ✅ DONE (D1–D4, 2026-04-25)

Schema-level plumbing landed in algo plan migrations 0503-00 → 0503-16 + client wire-up. Scoring intelligence can lag; the event bus is in place.

- [x] Algorithm plan surfaced ([docs/ALGO_IMPLEMENTATION_PLAN.md](ALGO_IMPLEMENTATION_PLAN.md)) — schemas, event taxonomy, scoring sketch.
- [x] Event tables: `feed_events_raw` (single append-only stream, supersedes the per-event-type table sketch). `user_topic_affinity`, `user_creator_affinity`, `hook_global_stats` rollups.
- [x] Per-user taste vector: `user_topic_affinity` (topic × signed EMA), updated via `feed_events_rollup` trigger on every raw insert.
- [x] Per-video tagging: hooks carry `topic_tags[]`; creator_topics drives the cold-start S_cold component.
- [x] Naive scoring function v1: dual-scored exploit + explore via `compute_hook_score`; deterministic explore-slot interleaving (`feed_ranked_page` migration 0503-16).
- [x] RLS: all event tables locked to caller; service-role-only for rollup writes; SECURITY DEFINER ingest RPCs at the edges.
- [x] D4 client wire-up: `/api/feed`, `/api/feed/events`, anon cookie, batched event emitter (commit 2290c9a).
- [ ] **D5 — broader event emission** (dwell, swipe, full_video, creator carousel) — in progress.
- [ ] **D6 — admin algo inspector** (`admin_algo_inspect_rpcs` + `/admin/algo/<user_id>`) — pending, ALGO_IMPLEMENTATION_PLAN §7.
- [ ] **D7 — retention pg_cron** (90-day GC of `feed_events_raw` + orphan `anon_feed_sessions`) — pending.

---

## Tier 2 — Consumer-app polish audit

Every screen a user or admin touches gets walked end-to-end, on real devices, with real data.

### UX pass
- [ ] Hook feed: swipe feel, preload next clip, no black-frame flashes, orientation lock
- [ ] Video player: scrubber, chapter marks (if applicable), skip-intro UX, autoplay-next
- [ ] Mic tap → avatar transition: zero-latency perceived, clear "I'm listening" state, clear "connecting" state with <2s max
- [ ] Avatar connect: Simli warmup, barge-in feel, disconnect/reconnect grace
- [ ] Admin console: every table, every form, every modal, every confirm, every empty state
- [ ] Every error state: specific copy, not codes. "out_of_range" → "Daily cap must be between 1 and 86400 seconds."
- [ ] Every empty state: helpful, pointing user to next action
- [ ] Every loading state: skeleton or spinner, no naked white screens

### Mobile feel
- [ ] Pixel 7 Pro: WiFi + LTE, portrait + landscape, PWA installed + Chrome tab
- [ ] iPhone 11: WiFi + LTE, portrait + landscape, PWA installed + Safari tab
- [ ] Touch targets ≥44px everywhere
- [ ] No horizontal scroll anywhere
- [ ] Scroll momentum correct on iOS (no rubber-band jank)
- [ ] Keyboard doesn't shove content out of viewport on input focus

### Copy + icons
- [ ] Every user-facing string audited for tone (TikTok-confident, not enterprise-hedging)
- [ ] Icon alignment + sizing consistent across components
- [ ] Dark mode parity if we're shipping dark mode
- [ ] Empty-ish surfaces (no handle yet, no sessions yet) read like intentional onboarding, not bugs

### Animation + timing
- [ ] Page transitions feel intentional — either instant or choreographed
- [ ] Avatar connect spinner doesn't stutter
- [ ] Mic button press → visual feedback <16ms (single frame)
- [ ] No CLS (cumulative layout shift) on any screen that could be a first impression

---

## Tier 3 — YC-day-one stress tests

What happens when 50 people hit the app at once after a launch tweet.

- [ ] Rate-limit behavior under load: hit `/api/sessions/mint` 100x from one IP, confirm voice_ip_counters kicks in, confirm error copy is human
- [ ] Kill-switch behavior: force a user past 150% voice quota, confirm session ends gracefully, confirm latch preserved, confirm next-day reset works
- [ ] Cold PWA install → first mic-tap session in under 60 seconds, measured on real hardware
- [ ] Admin onboard-new-creator full flow: invite → signup → application → review → approve → brain-training → published → user discovers → mic tap → avatar answers. End-to-end, with real Cartesia voice clone, no shortcuts.
- [ ] Error budget: document exactly what happens when each external provider (Gemini, Cartesia, Simli, Mux, Supabase) goes down mid-session. Every failure mode maps to a specific user-facing message and a specific cleanup path.
- [ ] Observability: dry-run "it's 3am, prod is broken, I have 10 min to triage" — can Sentry + PostHog + Supabase logs answer *what* broke and *for whom*?
- [ ] Backup + restore dry run: can we lose today's data and recover from yesterday?

---

## Out of scope for v1 → YC submission

Resist touching these unless explicitly decided:

- Stripe billing (v2)
- Brand / sponsored_segment creator types (v2; enum exists, code path doesn't)
- Semantic vector RAG (v2; topic drawers are the v1 primitive)
- Tier-based voice pipeline swaps (forbidden by architecture — see CLAUDE.md)
- Mid-session avatar provider hot-swap (forbidden by architecture)
- Native iOS/Android apps (PWA only in v1)
- Premium avatar provider evaluation (post-YC)
