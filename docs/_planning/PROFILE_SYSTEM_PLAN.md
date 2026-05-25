# Profile System Plan — TikTok/YouTube-style identity, handshakes, watch history, unified shell

**Status:** DRAFT — pending auditor pass + approval gate.
**Owner:** profile/identity workstream.
**Date:** 2026-05-25.
**One-liner:** Give every account a real public profile (same place for users and creators), a follow graph branded **"handshakes,"** a private watch history, and a persistent bottom-nav app shell whose middle button is the **"Become a Creator / Unlock"** entry point into the (already-built) application flow.

---

## 0. Decisions locked (from Vuk, 2026-05-25)

1. **"Handshake" = one-way follow, branded.** No friend-request / approval. Following someone = "you gave them a handshake." Your follower count is shown as **"Handshakes."** Psychology: honoring the relationship, not a cold "follower." Data model is a plain directed follow edge; only the *label* changes.
2. **Profiles are public to the open web.** `oakleague.com/@handle` loads with no login. Column-limited exposure only: handle, display_name, avatar, bio, handshake counts, and (for creators) their published video grid + "Ask" CTA. **Never** exposed: email, goals/obstacles, tier, timezone, watch history, session content.
3. **Production from line one** (CLAUDE.md): RLS on every table, no hardcoded IDs, deletion/export-aware, moderation-aware. Built as if account #50 signs up next week.
4. **Two product invariants this plan MUST NOT break (Round 2 audit):**
   - **Anonymous swipe-first is sacred.** The feed (`/`) renders for anon (`feed_ranked_anon_page`) and authed-with-no-profile users alike — there is NO onboarding wall today and we are NOT adding one. Identity (handle/avatar) is captured **lazily**, never as a gate between signup and the feed.
   - **Creators are invite-only.** `/apply` is hard-gated by an `invite_nonce` cookie (`apply/page.tsx`, `apply/actions.ts` → `needs_invite`). The middle "Become a Creator" button must NOT route non-invited users to `/apply` (they'd hit "invite session expired"). Non-invited → waitlist/interest capture; only invited users reach the application.

---

## 1. What already exists (reuse — do NOT rebuild)

| Capability | Where | Note |
|---|---|---|
| Identity columns | `profiles`: `display_name`, `handle` (citext, 3–30, `^[a-z0-9_]+$`), `avatar_url`, `goals[]`, `obstacles[]`, `tier`, `onboarded_at`, email mirror | `handle` is **nullable** today |
| Shared handle namespace | `handles_registry(handle, owner_kind ∈ {profile,creator}, owner_id)` + `reserved_handles` | Users & creators already share one namespace — squatting + reserved-name guard already enforced by `profiles_handle_sync_*` / `creators_handle_sync` triggers |
| Creator identity | `creators`: own `display_name`, `handle`, `bio`, `avatar_url`, `published_at`, `brain_status` | A published creator's public face reads from **`creators`**, not `profiles` |
| "Become a creator" backend | `creator_applications` (+ `submit_creator_application` RPC w/ consent, P0-3) — collects `display_name`, `handle`, `bio`, `topics`, `proof` (jsonb: `youtube_url`, `website`, …) | Backend DONE. We only add the entry point + capture socials/courses in `proof` |
| Apply UI | `src/app/apply/*` (consent checkboxes wired) | Reuse; middle button routes here |
| Content | `videos` (RLS public-read when `published_at` set + creator published — P0-1/P1-5), `sessions`, feed at `src/app/(feed)/*` | Video grid source |
| Auth/guards | `src/lib/auth-guards.ts` (`getCallerUserId`, `assertAdminFromSession`), `supabaseServer()` (JWT) vs `supabaseAdmin()` (service) | Every new server action uses these |

## 2. What's net-new (the missing piece)

- `follows` graph + handshake counts + follow/unfollow RPCs.
- `watch_history` (private) + view-write hook.
- `profiles.bio` (users have no bio column).
- **Public read path** for profiles (today `profiles` is own-read only) — a column-limited resolver, not a broad SELECT policy.
- Avatar upload (no storage bucket exists yet).
- Identity capture at signup (onboarding only asks goals/obstacles today — no name/handle/avatar).
- Public profile page `/@[handle]` (none exists today for users *or* creators).
- Persistent bottom-nav **app shell** (none exists today).

---

## 3. Architecture decisions

### 3.1 Handle resolution — one URL space, two backing tables
`/@[handle]` → resolve via `handles_registry` (through `resolve_public_profile`, §3.2):
- `owner_kind='creator'` **and** that creator `published_at IS NOT NULL` → **creator profile** (face = `creators` row: name/bio/avatar + published video grid + "Ask {name}" CTA + handshakes).
- otherwise → **user profile** (face = `profiles` row: name/bio/avatar + handshakes; own watch-history tab visible only to self).
- unpublished creator viewed by public → falls back to the user-profile shape (no video grid, no Ask) so an in-review creator doesn't leak a half-built creator page. Owner/admin still sees a "pending" banner.

> A creator IS a user (`creators.user_id → profiles.id`). The handshake graph keys on **`profiles.id`** always, so following a creator = following their profile. Counts are unified; the creator page just renders the creator-branded face.

### 3.2 Public read — view + RPC, never a broad policy
Adding `CREATE POLICY profiles_public_read ... USING (true)` would leak `email`/`goals`/`tier`. Instead:

- **`public_profiles` view** (`security_invoker = false`, owner = postgres — must bypass `profiles` own-read RLS to serve anon) exposing ONLY: `handle`, `display_name`, `avatar_url`, `bio`, `is_creator`, `creator_id`, `handshake_count` (followers), `handshakes_given_count` (following), `created_at`. `GRANT SELECT TO anon, authenticated`. Underlying `profiles`/`creators` RLS stays restrictive.
  - **C1/C4 (audit):** this *inverts* the codebase's audited posture — every other public view (`hooks_public`, `welcome_hooks_public`) is `security_invoker = true` because migration `20260420000030` (R4-C1) chose RLS-as-gate. A definer view makes the **column allowlist the sole gatekeeper**, and `profiles` provably grows columns (`email` added post-ship in `20260420000027`). So: (a) the migration MUST carry an inline comment documenting the deliberate divergence + reason (own-read RLS can't serve anon), or the next reader "fixes" it back to invoker and breaks public profiles; (b) a **pgTAP guard asserts the EXACT column set** of `public_profiles` against `information_schema.columns` — adding any column outside the allowlist fails the build (drift = PII leak); (c) confirm the grants migration does not later `REVOKE SELECT ... FROM anon` (the way `20260420000030` did to `creator_applications`).
  - **M4 (audit):** do NOT expose `profile_id` (= `auth.users.id`) — the auth UUID must never reach anon. Client keys on `handle` + `creator_id` only. The handshake button resolves the target's profile id server-side from the handle inside the RPC.
- For the creator face, the view COALESCEs creator name/bio/avatar over profile's **only when `published_at IS NOT NULL`**; the `is_creator` predicate must match `creators` RLS exactly (`published_at IS NOT NULL` — `creator_type` is CHECK-pinned to `human`, so no extra clause, but keep them in sync).
- **M2 (audit) — headline count is RECEIVED, not given.** The profile header shows `handshake_count` (received) labeled **"Handshakes"** as the social-proof number. `handshakes_given_count` is secondary, labeled **"Handshakes given"** — never the headline (it's self-inflatable by following 500 accounts). Lock this so the UI build doesn't surface the gameable one.
- **M7 (audit) — unpublish demotes the profile shape; takedown MUST bust cache.** When a creator unpublishes/is taken down (P1-5), `is_creator` flips false → the page reverts to the user face (no grid, no Ask); handshake edges persist (keyed on `profiles.id`, correct). A short CDN TTL is NOT sufficient for a takedown (compliance surface) — unpublish must **actively invalidate the `resolve_public_profile` cache** for that handle, or the creator face keeps serving to anon past the takedown.
- **Split the read into two RPCs (M5 — CDN-cache safety):**
  - **`resolve_public_profile(p_handle citext)`** RPC (STABLE, SECURITY DEFINER, `SET search_path = public, pg_temp`) → returns the one `public_profiles` row. **No per-viewer field.** Safe to short-TTL CDN-cache for logged-out. `GRANT EXECUTE TO anon, authenticated` (C2 — logged-out must call it).
  - **`viewer_handshake_state(p_target_handle citext)`** RPC (authenticated only, `GRANT EXECUTE TO authenticated`) → returns `viewer_has_handshaked boolean` for `auth.uid()`. Client-fetched, never cached. This keeps the per-viewer flag out of any cacheable response — the page must never set `Cache-Control: public` on a body containing live counts.
- **`handle_available(p_handle citext)`** RPC: `GRANT EXECUTE TO authenticated, anon`. Returns a single boolean/`unavailable` reason — must NOT disclose taken-by-creator-vs-reserved-vs-user (no enumeration of who owns what).
- **Grant matrix is load-bearing (C2):** every new RPC follows the codebase pattern `REVOKE EXECUTE ... FROM public` then explicit `GRANT EXECUTE TO <roles>`. Missing `GRANT TO anon` on `resolve_public_profile`/`handle_available` = silent 403 on every logged-out profile view.

### 3.3 Handshake graph
```sql
CREATE TABLE public.handshakes (              -- "follows", branded
  follower_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  followee_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)          -- no self-handshake
);
CREATE INDEX handshakes_followee_idx ON public.handshakes (followee_id, created_at DESC);
CREATE INDEX handshakes_follower_idx ON public.handshakes (follower_id, created_at DESC);
```
- **Counts:** denormalized `profiles.handshake_count` (followers) + `profiles.handshakes_given_count`, maintained by an `AFTER INSERT/DELETE` trigger on `handshakes` (single-row UPDATE; `GREATEST(0, …)` floor). Avoids `count(*)` on every profile load. Revisit to a periodic reconcile job only if write contention shows up (it won't at v1 scale).
  - **M1 (audit) — cascade-delete safety:** the trigger UPDATEs ONLY the *counterparty* row (`WHERE id = NEW.followee_id` on insert / `WHERE id = OLD.followee_id` and `= OLD.follower_id` on delete) — it must **never** touch the row being deleted, or a profile-delete cascade may try to UPDATE a mid-delete row. pgTAP must delete a profile that has edges in BOTH directions and assert only the surviving counterparties' counts move.
- **RLS:** `ENABLE ROW LEVEL SECURITY`.
  - SELECT: public (handshake lists are public on TikTok) — `USING (true)` **plus an explicit `GRANT SELECT TO anon, authenticated`** (the codebase default-grant posture in `20260420000021` is restrictive — policy alone 403s without the grant).
  - INSERT/DELETE: **only via RPC** (no direct client write). RPCs `handshake(p_target uuid)` / `unhandshake(p_target uuid)` are SECURITY DEFINER (`SET search_path`), `GRANT EXECUTE TO authenticated` (REVOKE FROM public first), assert `auth.uid() = follower_id`, block self, block targets that don't exist, idempotent (`ON CONFLICT DO NOTHING` / delete-if-exists, so counts never double-move), and **rate-limited internally** (see 5.5 — call `rate_limit_hit` INSIDE the RPC so hitting it directly via PostgREST can't bypass the limit).
- **Lists:** `list_handshakers(p_profile, p_cursor, p_limit)` / `list_handshaked(...)` → join `handshakes` to `public_profiles`, keyset-paginated.
  - **C3.2 (audit):** filter `handle IS NOT NULL` — a not-yet-onboarded account (no public identity) must NOT surface in a public list with name/avatar. Decide explicitly: such accounts are non-listable.
  - **Small (audit):** keyset cursor is the composite `(created_at, follower_id)` (or `(created_at, followee_id)`), not `created_at` alone — `created_at` isn't unique. Add the matching composite index.

### 3.4 Watch history (private)
```sql
CREATE TABLE public.watch_history (
  user_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  video_id       uuid NOT NULL REFERENCES public.videos(id)   ON DELETE CASCADE,
  first_viewed_at timestamptz NOT NULL DEFAULT now(),
  last_viewed_at  timestamptz NOT NULL DEFAULT now(),
  view_count      int NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX watch_history_recent_idx ON public.watch_history (user_id, last_viewed_at DESC);
```
- **RLS:** own-read/own-nothing-else. SELECT `USING (user_id = auth.uid())`. No client INSERT/UPDATE/DELETE policy — writes via `record_watch(p_video_id)` RPC (upsert, bumps `last_viewed_at`/`view_count`). DELETE via `clear_watch_history()` RPC (own only) for the "Clear" button.
- **`record_watch` hardening (C3.1 + M6 — audit):** SECURITY DEFINER, asserts `auth.uid()` = caller, and **verifies the video is published AND its creator is published** (`videos.published_at IS NOT NULL AND creators.published_at IS NOT NULL`) at write time — matching the `20260523000006` takedown precedent. Without this, a user writes history rows for unpublished/taken-down creators and the self-view tab leaks them. Apply a light `rate_limit_hit` cap on distinct videos/min to stop scripted inflation (the upsert already collapses repeat views of one video).
- **Read path re-gates takedowns (C3.1):** the watch-history read (RPC or view) JOINs `creators.published_at IS NOT NULL` so a since-unpublished creator's videos drop out of history — `videos` RLS alone gates on `videos.published_at` only (`20260420000014`) and will NOT hide a taken-down creator's still-`published_at` video.
- **Privacy:** never in `public_profiles`. Own-tab only.
- **Retention:** ties into **P1-2** — `watch_history` rows older than N days minimized by the same scheduled job. Noted as a cross-cut, not built here.
- **Write trigger point (M3 — audit: correct the signal source).** Hook `record_watch` into the **`full_video_quartile`** emission in `src/app/v/[id]/long-form-player.tsx` (~L108–114, first quartile) — NOT `feed-impression-context.tsx`, which tracks *hook-clip* impressions and would record history on mere feed impressions (exactly the "meaningless history" failure). First long-form quartile = a real watch.

### 3.5 Avatar upload
- New storage bucket `avatars`.
- **M3 (audit) — do NOT put `auth.users.id` in a public path.** Path keys on an **opaque per-profile public id** (a random `profiles.public_id uuid DEFAULT gen_random_uuid()`, never the auth UUID): `avatars/{public_id}/{uuid}.webp`. The auth UUID in a public CDN URL becomes a stable cross-surface join key for scrapers. (This `public_id` is also the opaque handle the client uses where an id is unavoidable, keeping `auth.users.id` off every public surface — ties to M4.)
- Storage RLS: authenticated user may write/read/delete only under their own folder. Public read served via the URL written into `avatar_url`. Default: public-read bucket (avatars are public on the profile anyway) — simpler, CDN-cacheable.
- Upload route `POST /api/me/avatar`: same-origin, auth, content-type allowlist (`image/png|jpeg|webp` — **no SVG**, XSS vector), size cap (≤ 2 MB), server-side re-encode/resize to ≤ 512px webp. **Strip EXIF/GPS, ICC color profile, and embedded thumbnails; reject/flatten animated formats to a single frame.** Assert all of this in vitest, don't assume the encoder does it. Write `avatar_url`. **Moderation hook (P1-4):** avatar is user-supplied imagery → flagged as a report target.

### 3.6 App shell + bottom nav
- New client `BottomNav` rendered in the authenticated app layout (the `(feed)` group + profile/activity routes). 5 slots, TikTok geometry:
  `Home (feed)` · `Discover` · **`[middle]`** · `Activity` · `You (profile)`.
- **Middle button state machine (C1 — audit: invite-only is load-bearing)** (server-resolved per request, no flash). Five states, not three:
  - **not invited** (no `invite_nonce` cookie, not a creator, no application) → **"Become a Creator"** → opens a **waitlist / interest-capture sheet** ("Creators are invite-only — join the list"). MUST NOT route to `/apply` (that page renders "invite session expired" with no path forward — confirmed in `apply/page.tsx`). This is ~100% of users at launch.
  - **invited, not yet applied** (`invite_nonce` present) → **"Complete your application"** → `/apply` (the only state that may route there).
  - **active application** (`submitted`/`under_review`) → **"In review"** pill → `/apply/submitted`.
  - **is a creator (published or in-review post-approval)** → **"Studio"** → `/creator`.
  - **logged-out** (public profile visitor): see S2 — minimal header CTA, NOT the full authed 5-slot shell.
- The status query is one indexed lookup each: `creators.user_id` (UNIQUE) + the `creator_applications` one-active partial index + cookie read. No extra round-trips per render.

### 3.7 "You" / profile editing
- `/@[myhandle]` self-view shows an **Edit profile** affordance → sheet to edit `display_name`, `bio`, `avatar`, and **claim/change handle** (availability check via `handle_available(p_handle)` RPC hitting `handles_registry` + reserved guard). Reuses existing handle triggers — a handle change re-mirrors the registry automatically.
- **NULL-handle users defined end-to-end (C3 — audit: every existing account has `handle IS NULL`).** This is the #1 "works on my seeded account, 404s for every real user" risk.
  - The **"You" nav slot** routes to a **claim-handle sheet** when `handle IS NULL` — NOT to `/@[null]` (which would 404/crash). Add an integration assertion that "You" resolves for a handle-less account.
  - A NULL-handle user **can** give handshakes (the RPC keys on `profiles.id`), but **does not appear in any public list** (§3.3 filters `handle IS NOT NULL`) and **has no public profile URL** until they claim a handle.
  - Document this state in U3 + U4; it is the primary flow, not an edge case.
- **M2 (audit) — creator brand vs user profile must not collide.** A published creator's public face COALESCEs `creators` name/bio/avatar over `profiles` (§3.2). So if a creator edits their name in the "You" sheet and it writes `profiles.display_name`, the public page (COALESCE-wins on `creators`) shows no change → silent no-op confusion. Product rule: **creators edit brand identity ONLY in `/creator` (studio); the "You" sheet, for `is_creator` accounts, whitelists only non-brand fields** (and shows a "Manage your public creator profile in Studio" link). The `saveProfile` server action MUST refuse to write `creators`-backed fields and must never mutate the `creators` row. pgTAP/vitest: a creator's profile-edit cannot change `creators`.
- **Handle/identity change uses `window.location.href`, never `router.push`** (CLAUDE.md hard rule) — applies to the mid-flow handle claim too, not just onboarding completion.
- **M5 (audit) — handle change = link rot + impersonation surface.** The profile link is the share unit; changing `oldhandle`→`newhandle` frees `oldhandle`, so every shared link/screenshot/CDN entry for `/@oldhandle` 404s — or worse, later resolves to a *different* person who claims it. Mitigations: (a) keep a `handle_history(old_handle, profile_id, vacated_at)` map so `/@oldhandle` 301-redirects to the current handle for a window; (b) cooldown before a vacated handle is re-claimable; (c) rate-limit handle changes; (d) on change, **bust the CDN cache** for `/@oldhandle` (stale content otherwise serves until TTL). Document the tradeoff.

---

## 4. Implementation units (TDD, ordered)

> Each unit: schema → pgTAP → server action/RPC + vitest → UI. Build order respects deps. Auditor runs on the **plan** first (this doc), then on the built unit per CLAUDE.md cadence.

### U1 — Schema foundations (migrations + pgTAP)
- `…_profiles_bio_and_handshake_counts.sql`: add `profiles.bio`, `handshake_count`, `handshakes_given_count`.
- `…_handshakes.sql`: table + indexes + count trigger + RLS + `handshake`/`unhandshake`/`list_handshakers`/`list_handshaked` RPCs.
- `…_watch_history.sql`: table + RLS + `record_watch`/`clear_watch_history` RPCs.
- `…_public_profiles_view_and_resolve.sql`: `public_profiles` view + `resolve_public_profile` + `viewer_handshake_state` + `handle_available` RPCs + grants (S7 — one consistent name: `resolve_public_profile`, never `resolve_handle`).
- pgTAP: `handshakes.test.sql` (self-block, idempotent, count trigger up/down, **profile-delete with edges in BOTH directions moves only counterparties — M1**, floor-at-0), `watch_history.test.sql` (own-read only, upsert bumps count, clear, **unpublished-creator video excluded from read — C3**), `public_profiles.test.sql` (**EXACT column allowlist via `information_schema.columns` — fails on any extra column, C1**; no email/goals/tier/`profile_id` exposed; unpublished creator renders as user; counts correct).
- **C2 (audit) — pgTAP PG17.6 segfault trap.** The new RPCs are SECURITY DEFINER with `REVOKE EXECUTE FROM public`. Negative-authz tests (e.g. "anon can't write `handshakes`", "non-owner can't `record_watch`") MUST assert via `has_function_privilege(...)` or jwt-only (set only `request.jwt.claims`, stay on a role that HAS execute) — **never** `set_config('role','authenticated')` + CALL a REVOKE'd definer fn (segfaults the backend, masks every alphabetically-later test as "recovery mode"). Follow `creator_brain_compile_unsafe_blocked_from_roles.test.sql`. Also: `resolve_public_profile`/`handle_available` tests must run with NULL `auth.uid()` (logged-out) and assert they still return (grant-to-anon verified).
- **Blast-radius:** new columns are nullable/defaulted → no NOT NULL drift. Run **full** `npm run db:test` (CLAUDE.md discipline), not just new files.

### U2 — Avatar upload
- Storage bucket migration + storage RLS policies + `POST /api/me/avatar` (+ vitest: origin/auth/content-type/size/re-encode/own-prefix). EXIF strip asserted.

### U3 — Identity capture (LAZY — never walls the feed) — C2 (audit)
- **The feed stays reachable with no handle/avatar.** Today `/` has no onboarding gate (only a `NEXT_PUBLIC_FEED_ENABLED` flag → `/waitlist`); we do NOT add an identity wall. Forcing name+handle+avatar before the feed would kill the anonymous swipe-first funnel the whole product runs on, and gates shareability behind a commitment with no payoff yet.
- `saveOnboarding` may *optionally* capture display_name/handle/avatar, but completion never blocks `/`. Goals/obstacles stay optional as today.
- **Handle/avatar are claimed lazily**, at the first moment they're needed:
  - first time you give a handshake (you become linkable),
  - first time you tap "You" / try to view your own profile,
  - an explicit "complete your profile" nudge.
- `handle_available` checked server-side before write (race-safe: the registry unique index is the real guard; the RPC is a UX pre-check). `window.location.href` after any handle/identity change (CLAUDE.md).

### U4 — Public profile page `/@[handle]`
- `src/app/@[handle]/page.tsx` (server) → `resolve_public_profile` (cacheable, no viewer field); 404 on miss. Logged-in viewer's handshake state fetched separately via `viewer_handshake_state` (client, uncached) — never bake per-viewer state into a cacheable response (M5).
- Shared `ProfileView` with `creator` vs `user` branch (3.1). Creator branch: published video grid (reuse video card) + **"Ask {name}" CTA**.
  - **M1 (audit) — "Ask" does NOT open a session from the profile.** A voice session is COGS-logged, tier-gated, and opens on **mic-tap with video context + `tier_at_session` snapshot** (CLAUDE.md: "session opens on mic tap only"). A contextless profile page can't set that up, and a logged-out visitor must not open a paid session. "Ask {name}" routes to the creator's **content** (their feed/video) where the established mic-tap flow opens the session. Logged-out → signup with `?next`. Define which video/context it lands on.
  - **S4 (audit):** `display_name` is nullable → COALESCE to handle in "Ask {name}" so it never renders "Ask ".
- **Handshake button** — optimistic; auth-gates to login. **M6 (audit) — persist intent across the auth hop:** logged-out tap → `/login?next=/@handle&action=handshake`; consume `action=handshake` once on return and auto-execute, so the follow isn't silently dropped (this is exactly where the growth loop leaks). Optimistic client path must not `router.push`.
- **Self-view states (M4 — audit: define all three explicitly):**
  - non-creator self → user face + Edit-profile sheet (display_name/bio/avatar/handle).
  - in-review creator self → user face + "pending" banner + "manage in Studio once approved"; no creator grid yet.
  - published creator self → creator face **with the "Ask" CTA suppressed** (no "ask yourself"), and **"Edit in Studio"** (NOT the user edit sheet — Round-1 M2: brand edits live in `/creator`). Test: "Ask {name}" never renders on your own profile.
- Watch-history tab (own only) + Handshakes / Handshakes-given lists.
- **Empty states (S1):** zero-handshake profile, creator with zero published videos (empty grid), empty watch-history, and the feed empty state under the new shell — each needs copy or the page reads as broken at launch.
- **Routing collision check (M7 — audit):** `reserved_handles` (`20260420000003` + `20260420000024`) currently has `login/signup/waitlist/c/invite/apply/auth/onboarding/logout/callback/settings` but is **missing live segments `s` (session), `v` (video), `rate`, `upgrade`** (and lists a dead `r` entry). Ship a `reserved_handles` top-up migration covering `s, v, rate, upgrade` — and **audit the full `src/app` tree at build time, not from memory**. Using the literal `@` prefix on the route lowers shadowing risk, but the reserved list must still be complete since handles also appear bare in copy/links.

### U5 — App shell + bottom nav + "Become a Creator" entry
- `BottomNav` + middle-button **5-state** machine (3.6, C1), server-resolved `creatorStatus` (invite cookie? creator? application status?) passed into the layout. Non-invited → waitlist sheet, NOT `/apply`.
- **S2 (audit) — logged-out visitor on a shared `/@handle`** renders a minimal header CTA ("Sign up / Log in"), NOT the full authed 5-slot shell (Home/Discover/Activity would be dead taps bouncing to login).
- For the **invited** path: ensure `apply-form` `proof` captures **socials + courses** (`instagram`, `tiktok`, `x`, `courses[]`). **S5 (audit): the `proof` Zod schema (`ProofSchema` in `apply/actions.ts`) is a whitelist that silently strips unknown keys** — the new fields MUST be added to the schema, not just the form, or they vanish on submit.
- Activity tab v1 = recent handshakers. **S3 (audit):** near-zero handshakes day one → pair with an empty-state nudge or it reads as broken. Notifications system is a later cut.
- **S6 (audit):** every new `rate_limit_hit` scope string (`handshake`, watch-write, handle-change) must be unique and documented alongside existing scopes in `20260420000032` so two features don't collide on a window key.

### U6 — Cross-cut wiring (handoff to P1 workstreams)
Status after the U1–U5 build:
- **P1-3 deletion/export** — DB rows are already safe: `handshakes` (both FKs `ON DELETE CASCADE`) and `watch_history` (`ON DELETE CASCADE`) drop with the profile, and the count trigger fires per-row on cascade so counterparties' counts decrement correctly (**proven** by `handshakes.test.sql` #11). **OWED by P1-3:** (a) delete the avatar storage object(s) under `avatars/{public_id}/` (storage isn't FK-cascaded); (b) include `public_profiles`-shaped data + `watch_history` + handshake edges in the export bundle.
- **P1-4 moderation** — profile, `avatar_url`, and `bio` are user-supplied and become report targets; the avatar route already flags imagery for review. **OWED by P1-4:** add `profile`/`avatar`/`bio` to the report-target enum + admin queue.
- **P1-2 retention** — `watch_history(last_viewed_at)` is indexed for a time-windowed minimization sweep. **OWED by P1-2:** add `watch_history` rows older than N days to the scheduled minimization job.
- **Takedown (P1-5)** — `record_watch` + `list_watch_history` already re-gate on `creators.published_at` (proven by `watch_history.test.sql` #7), and the profile page demotes a since-unpublished creator to the user face. **OWED:** active CDN-cache bust of `/@handle` on unpublish (the page is `force-dynamic`, so no CDN entry today; revisit if it's ever made cacheable).

---

## 5. Edge cases / risks (pre-load for the auditor)

1. **Count drift on cascade delete.** When a profile is deleted, `handshakes` rows cascade-delete — the AFTER DELETE trigger must run per-row to decrement the *other* party's count. Postgres fires row triggers on cascade deletes, so OK, but pgTAP must prove it (delete a profile, assert the people they handshaked lost a follower).
2. **Self-handshake / handshake nonexistent / double-handshake.** CHECK + RPC existence check + `ON CONFLICT DO NOTHING` (idempotent, count not double-incremented).
3. **PII leak via view.** `public_profiles` must NOT carry email/goals/obstacles/tier/timezone/watch history. pgTAP asserts the exact column set.
4. **Unpublished creator leak.** In-review creator's `/@handle` must render the user shape (no video grid, no Ask), matching P0-1/P1-5 takedown semantics — never expose a half-built creator face.
5. **Mass-follow abuse / handshake spam.** Rate-limit the `handshake` RPC **internally** via the real primitive **`rate_limit_hit(p_scope, p_key, p_window, p_limit)`** (migration `20260420000032` — DB-computed window, survives serverless clock fragmentation). NOT `src/app/api/rate` (that's the Spike-B rater-score endpoint, irrelevant). Two scopes: a per-caller cap (`scope='handshake'`, `key=auth.uid()`, e.g. ≤ 60/min, ≤ 500/day) AND a per-target cap to stop targeted harassment of one profile. Calling it inside the RPC (not the route) means hitting the RPC directly via PostgREST can't bypass the limit.
6. **Handle squatting & route shadowing.** Reserved-handles must include all top-level route segments; registry unique index prevents dup; reserved guard already in triggers.
7. **Avatar abuse.** Size/type cap, server re-encode, EXIF/GPS strip, moderation report target. No SVG (XSS). 
8. **Watch-history meaningfulness.** Write on quartile, not impression; private; clearable; retention-bounded.
9. **Logged-out caching vs logged-in viewer flag.** Profile page must not cache the per-viewer `viewer_has_handshaked` into a public CDN entry. Split: static public shell + client-fetched viewer state, or `dynamic` for authed.
10. **Count denormalization correctness under concurrency.** Trigger does `UPDATE … SET handshake_count = handshake_count ± 1`; row-level lock serializes. `GREATEST(0,…)` floor guards against any double-fire.
11. **Creator vs profile identity divergence.** Name/avatar/bio shown for a creator come from `creators`; editing your *user* profile must not silently overwrite your *creator* brand (and vice versa). Edit sheet writes to the right table based on creator status.
12. **`window.location.href` after handle/identity change** (CLAUDE.md hard rule) — never `router.push()`.

---

## 6. Out of scope (v1)
- DMs / messaging, notifications service (Activity tab is a simple list).
- Blocking/muting (ties to P1-4 moderation — note, don't build).
- Private/friend-request profiles (explicitly dropped by Vuk).
- Profile cover images, pinned content, profile themes.
- Liked/saved public collections (watch history private only for now).

## 7. Open questions for approval
- Profile URL form: **`/@[handle]`** (TikTok vanity, needs careful route reservation) vs **`/u/[handle]`** (collision-proof). Recommend `/@[handle]` with a hardened reserved list.
- Avatar bucket: public-read vs signed-URL. Recommend public-read (avatars are public anyway) — simpler, CDN-cacheable. Path keyed on opaque `public_id`, never the auth UUID (M3).
- "Unlock" vs "Become a Creator" copy on the middle button (cosmetic; pick at build).

---

## 8. Audit Round 1 — resolution log (auditor subagent, 2026-05-25)

| # | Finding | Resolution in plan |
|---|---|---|
| **C1** | Definer view = column allowlist is sole PII gate; contradicts R4-C1 | §3.2: keep definer (own-read RLS forces it) + inline divergence comment + **pgTAP exact-column-allowlist guard** that breaks build on drift |
| **C2** | SECURITY DEFINER + `auth.uid()` grant matrix unstated; pgTAP segfault trap | §3.2 grant matrix made explicit (`anon` on public reads); §4 mandates `has_function_privilege`/jwt-only for negative-authz tests |
| **C3** | Watch-history + handshake lists leak unpublished-creator / handle-NULL identity | §3.4 `record_watch` + read re-gate on `creators.published_at`; §3.3 lists filter `handle IS NOT NULL` |
| **C4** | Cited wrong rate-limit primitive (`/api/rate` = rater route) | §5.5 → real `rate_limit_hit` (`20260420000032`), called inside the RPC, per-caller + per-target scopes |
| **M1** | Count trigger may touch mid-delete row on cascade | §3.3 trigger UPDATEs counterparty only; pgTAP both-direction delete test |
| **M2** | Creator brand vs user-profile edit clobber | §3.7 explicit rule: creators edit brand in `/creator`; "You" sheet refuses `creators`-backed fields |
| **M3** | Avatar path leaks `auth.users.id` | §3.5 path keys on opaque `profiles.public_id`, not auth UUID; no SVG |
| **M4** | View exposes `profile_id` (auth UUID) to anon | §3.2 `profile_id` dropped; client keys on `handle`/`creator_id` |
| **M5** | CDN-cached logged-out page pins counts / per-viewer flag | §3.2 split into `resolve_public_profile` (cacheable) + `viewer_handshake_state` (authed, uncached) |
| **M6** | `record_watch` unverified client write | §3.4 SECURITY DEFINER + published gate + rate-limit |
| **M7** | `reserved_handles` missing `s/v/rate/upgrade` | §4 U4 top-up migration + build-time `src/app` tree audit |
| Smalls | grants, keyset composite cursor, ICC/animated strip, hot-row note, `handle_available` non-enumeration, `window.location.href` on handle change, `is_creator` predicate parity | Folded into §3.2/§3.3/§3.5/§3.7/§4 inline |

All Critical + Medium + Small findings applied (per standing rule: fix all, don't defer).

## 9. Audit Round 2 — resolution log (auditor subagent, 2026-05-25 — flow/logic/UX focus)

Round 2 hunted product-flow, not columns. Verified against live code before applying.

| # | Finding | Resolution |
|---|---|---|
| **C1** | Middle button → `/apply` dead-ends ~100% of users (invite-gated) | §0.4 + §3.6: **5-state machine**; non-invited → waitlist sheet, only `invite_nonce`-holders reach `/apply` |
| **C2** | Forcing identity at onboarding walls the anonymous swipe-first funnel | §0.4 + U3: feed never gated; **handle/avatar captured lazily** at first need |
| **C3** | Every existing user has `handle IS NULL` → "You" tab 404s for whole base | §3.7: NULL-handle defined end-to-end; "You" → claim-handle sheet; can handshake, not listed, no URL until claimed; integration assert |
| **M1** | "Ask {name}" on profile bypasses the mic-tap/video-context session contract | §3.1/U4: "Ask" routes to creator **content**, not a session; logged-out → signup |
| **M2** | Two counts, no defined headline → gameable vanity metric | §3.2: headline = **received** (`handshake_count`); given is secondary |
| **M3** | `record_watch` wired to hook-impression context, not long-form quartile | §3.4: hook into `full_video_quartile` in `long-form-player.tsx` |
| **M4** | Creator's own profile self-view undefined; "Ask yourself" nonsense | U4: three self-view states defined; suppress self-Ask; brand edits → Studio |
| **M5** | Handle change → link rot + impersonation of vacated handle | §3.7: `handle_history` redirect map + cooldown + rate-limit + CDN bust |
| **M6** | Logged-out handshake intent dropped across the login hop | U4: `?action=handshake` persisted + auto-executed on return |
| **M7** | Unpublish silently demotes profile; CDN keeps serving creator face post-takedown | §3.2: demote defined; **takedown actively busts** `resolve_public_profile` cache |
| **S1–S7** | Empty states; logged-out nav; empty Activity; `display_name` COALESCE; `ProofSchema` whitelist; rate-limit scope uniqueness; RPC name consistency | Folded into U3/U4/U5/§3.2 inline |

Verified against live code: `/apply` invite gate (`apply/page.tsx`, `apply/actions.ts:62`), no onboarding wall on `/` (`page.tsx` — only `NEXT_PUBLIC_FEED_ENABLED` flag), long-form signal (`long-form-player.tsx:108-114`), `handle` nullable (`20260420000005`).

Two audit rounds complete (security + flow). Plan ready for approval.

## 10. Audit Round 3 — post-build DELTA pass (auditor subagent, 2026-05-25)

Ran on the BUILT code after the post-build fixes, focused on the fix-deltas + never-audited new files. All applied:

| # | Finding | Resolution |
|---|---|---|
| **C-D1** | Approved-but-unpublished creator 404s on their OWN profile (handle promoted + NULLed, view requires published) — fires for creator #1 | `[handle]/page.tsx`: resolve viewer identity BEFORE the not-found; owner of an unpublished creator sees a "training / go to Studio" self-state, not 404 |
| **C-D2** | Creator reaching claim mode dead-ends on raw `edit_in_studio` | onboarding claim branch `redirect('/creator')` for any creator; claim form maps `edit_in_studio` → Studio redirect |
| **M-D2** | `replaceState` stripped `?action` before the handshake resolved → failed follow lost silently | strip URL only on `res.ok`; show retry message on failure |
| **M-D3** | Neutral middle nav button was a live dead-tap to `/` while loading | render a non-navigating `aria-disabled` span until status resolves |
| **M-D5** | watch beacon used `keepalive` mid-watch (wasted budget) | dropped keepalive |
| **M-D1** | `watch_history` is self-attested (record_watch gates published, not proof-of-watch) | documented in the route: not a trusted ranking signal without feed_events corroboration |
| **M-D4 / smalls** | substring error-map (acceptable, matches apply pattern); deps comment; same-origin intent comment | comments added |

Verified the post-build fixes (C1 GET-mutation gone, M1/M3/M4/M5/M2) introduced no regressions. **Three full audit rounds + delta. 49 tests green, all files typecheck.**

## Security audit of the migrations (auditor subagent, 2026-05-25 — migration `20260525000010`)

Pure security pass over migrations `20260525000001`–`09` at Vuk's request, before prod. The comments/likes/watch-history layer came back clean; the holes were all in the profile layer. **Two ship-blockers**, both fixed and re-audited CLOSED:

| # | Finding | Fix (migration `…000010`) |
|---|---|---|
| **C1** 🔴 | `profiles` UPDATE policy is column-blind + Supabase default-grants table-wide UPDATE → a user could PATCH their own row to forge `handshake_count`, self-flip `tier` to `boardroom` (free voice minutes/COGS — *pre-existing* on the branch), or re-roll `public_id`. | `REVOKE UPDATE ON profiles FROM authenticated, anon` → `GRANT UPDATE(display_name, bio, handle, goals, obstacles, timezone, onboarded_at)`. Allowlist = exactly the two user-context write sites; counters/tier/public_id/avatar/tos excluded (service-role or trigger/RPC-written). |
| **C1-bio** 🔴 | bio is public-to-web → scam-link billboard (Vuk's original concern). | `BEFORE INSERT/UPDATE OF bio` trigger reusing `_comment_contains_link`, **creators exempt**. DB-level so a direct PATCH can't bypass. |
| **C2** 🔴 | `_profile_id_for_handle` resolved unpublished-creator handles → `handshake()` succeeded on an in-review creator the public page 404s = existence oracle leaking the creator pipeline. | creators arm now `published_at IS NOT NULL`; unpublished → `target_not_found` like a free handle. |
| **M4** 🟡 | every admin (incl. `reviewer`) — and even *revoked* admins — could moderate platform-wide. | `_can_moderate_comment`/`_is_video_moderator` admin branch → `role='superadmin' AND revoked_at IS NULL`. (Decision: superadmin-only; reviewers may still triage the reports queue.) |
| **M3** 🟡 | `list_comment_replies` derived moderator scope from an ungated parent. | published-gated `v_video` resolution. |
| **M2** 🟡 | `report_comment` had no per-target cap → false-report flooding. | added `comment_report_target` 50/min cap. |
| **M5** 🟡 | `handle_available` was anon + unthrottled → handle-namespace enumeration. | authenticated-only + 30/min per-caller; anon revoked. |
| **M1/M7** 🟡 | `admin_list_comment_reports` returned raw `reporter_id` uuid + reports never resolved. | projects `reporter_handle`; added `resolved_at/resolved_by` + `admin_resolve_comment_report`; queue defaults to unresolved. |
| M6 | per-video 120/min comment cap is a shared bucket (theoretical DoS). | accepted for v1 (per-caller 10/min already limits individuals). |

Root cause worth remembering: **this codebase gates `profiles` writes by RLS row-ownership but never by column** — any new trust-bearing `profiles` column is client-writable by default and needs a column grant or guard in the same migration.

**Re-audit verdict: all 8 findings CLOSED, no new Critical/Medium introduced. 18 new pgTAP assertions + the full 232-file suite green; tsc clean.**
