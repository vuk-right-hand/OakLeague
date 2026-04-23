# v1 Polish Roadmap — rc1 → YC S26 Submission

**Window:** 2026-04-23 (rc1 tagged) → 2026-05-06 (YC S26 application due).
**Bar:** YouTube/TikTok consumer-app polish. Not "working demo." See [feedback_youtube_tiktok_polish_bar.md](../../../Users/Korisnik/.claude/projects/c--Antigravity-OakLeague/memory/feedback_youtube_tiktok_polish_bar.md).
**Status tracker:** update this file as items land; resist feature creep — polish, instrumentation, stress tests only.

---

## Tier 1 — Test debt cleanup (in progress)

- [ ] `quota_tier_flip_same_day.test.sql` — swap dropped `gemini_pro_audio_v2` enum for a live voice_model value
- [ ] `admin_roles_revoked_denied.test.sql` — add `user_id` to admin_roles insert (NOT NULL since 0025)
- [ ] `admin_tier_flip_invariants.test.sql` — fixture role/JWT so RLS allows `sessions` insert
- [ ] `admin_force_close_session.test.sql` — align tests 4-6 with current RPC (prefixed reason, idempotent noop audit row)
- [ ] `admin_roles_service_role_delete_blocked.test.sql` — reconcile test 2 with current delete-trigger behavior
- [ ] NEW `admin_set_user_voice_caps.test.sql` — coverage for the rc1 RPC: admin guard, 3 range errors w/ SQLSTATE+message, audit log triple, FOR UPDATE lock
- [ ] Re-run `supabase test db` — must be 40/40 green before Tier 2 starts

---

## Between Tier 1 and Tier 2 — Feed algorithm instrumentation

Schema-level plumbing that **must** be in v1 because behavioral data can't be retrofitted. Scoring intelligence can lag; the event bus cannot.

- [ ] Pop vibecodershq, surface the algorithm plan (schemas, event taxonomy, scoring sketch) — align before writing code
- [ ] Event tables: `feed_impressions`, `feed_swipes`, `video_watch_events` (quartiles + completion), `hook_engagement_events`
- [ ] Per-user taste vector table: topic tags × weights, updated via trigger on watch/swipe events
- [ ] Per-video tagging: topic_tags[] already exist on sample_content; ensure videos inherit via creator_topics join
- [ ] Admin console: read-only feed-algo diagnostics (per-user top-5 topics, exploit/explore split, swipe-after-Ns histogram)
- [ ] Naive scoring function v1: recent-first with 20% random exploration — shipped, instrumented, measurable
- [ ] RLS: every event table write-locked to the caller's own user_id; service-role-only for aggregation rollups

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
