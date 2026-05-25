# Comments & Likes Plan — video engagement layer

**Status:** DRAFT — pending auditor + approval gate.
**Date:** 2026-05-25.
**Depends on:** the profile-system build (handshakes/watch_history patterns are the template). Migrations land after `20260525000006`.
**One-liner:** Add **likes** (one action → public count + algo signal + a private "Liked" list) and **comments** (videos only, one level of replies, creator-moderated) to long-form videos.

---

## 0. Decisions locked (Vuk, 2026-05-25)

1. **Comments on videos only** (never profiles — avoids personal harassment).
2. **Likes = ONE action.** Tapping Like: (a) increments a public count, (b) feeds the algorithm, (c) the set of videos you liked is YOUR private "Liked" list (logged-out/others can't see *what* you liked, only the aggregate count). No separate bookmark.
3. **Likes are video-level** (same unit as comments, watch_history, Ask). One count per video.
4. **Comments = one level of replies** (YouTube-style: top-level + a single reply tier). No deeper nesting.
5. **No comment-likes** in v1.
6. **Ask from a liked video:** the private Liked list links each row into the existing mic-tap Ask flow (`/v/[id]`).

### Recommendations accepted as defaults (flagged for the auditor to pressure-test)
- **Moderation floor (P1-4 doesn't exist yet):** author deletes own; the **video's creator** can delete / hide / pin comments on their video; **anyone authenticated can report**; admin removes via existing admin surface. Length cap + rate limit + optional word-blocklist now; real abuse-classification waits for P1-4. **No edit** in v1 (delete + repost).
- **Algo (CONFIRMED Vuk):** expose `videos.like_count` only; do **NOT** rewrite `feed_ranked_page`. (Audit M1: the scorer is *hook*-keyed and `like_count` is *video*-level — this is a documented signal in the wrong grain for drop-in use; the feed workstream owns any video→hook fan-out. We just emit the column honestly, no integration.)
- **UI (CONFIRMED Vuk):** **Like only** (no separate save), plus a **"Liked" tab** for the user. **Tapping a liked video opens the EXACT same video experience as if it were found in the feed** — the normal `/v/[id]` long-form view with the lesson **carousel** and the **Ask** option, not a stripped-down page. The Liked tab is just another entry point into the canonical video view. Comments + Like button live on `/v/[id]`; counts on the video page.
- **Notifications:** like/comment notifications are deferred; Activity tab stays handshake-focused in v1 (creators see comments on the video page).

---

## 1. Reuse (do not rebuild) — established patterns from the profile build
- Denormalized counter maintained by an `AFTER INSERT/DELETE` trigger with `GREATEST(0,…)` floor + cascade-safe counterparty-only updates (see `handshakes_maintain_counts`).
- SECURITY DEFINER RPCs, `SET search_path`, `REVOKE ALL … FROM public, anon, authenticated` then explicit `GRANT` (Supabase grants funcs to anon/authenticated by default — revoking only `public` is NOT enough; learned in U1).
- `rate_limit_hit(scope, key, '00:01:00', limit)` — **1-minute windows ONLY** (the RPC hard-rejects other intervals). Call it INSIDE the write RPC so PostgREST-direct calls can't bypass.
- **Takedown re-gate:** every read/write re-checks `creators.published_at IS NOT NULL` (videos RLS gates on `videos.published_at` only — a taken-down creator's still-`published_at` video would otherwise leak). Pattern from `record_watch` / `list_watch_history`.
- pgTAP negative-authz via `has_function_privilege` (never `set_config('role')` + CALL a REVOKE'd SECDEF fn → PG17.6 segfault).
- No GET-mutation: writes go through server actions (CSRF-protected) / authed routes, never an RSC render path.

## 2. Net-new

### 2.1 Likes — migration `…_video_likes.sql`
```sql
CREATE TABLE public.video_likes (
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  video_id   uuid NOT NULL REFERENCES public.videos(id)   ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX video_likes_recent_idx ON public.video_likes (user_id, created_at DESC, video_id); -- "Liked" tab composite keyset (audit M7)
ALTER TABLE public.videos ADD COLUMN like_count int NOT NULL DEFAULT 0 CHECK (like_count >= 0);
```
- **Privacy:** `video_likes` SELECT RLS = **own-read only** (`user_id = auth.uid()`) — *who* liked a video is private (TikTok hides this); the public sees only `videos.like_count`. No public read of the likes table.
- **Count trigger** `videos_like_count_maintain()` AFTER INSERT/DELETE on `video_likes` → `UPDATE videos SET like_count = like_count ± 1 WHERE id = NEW/OLD.video_id` (floor at 0). Cascade-safe (only touches the video row; video delete cascades likes but the video's gone — no-op).
- **RPCs** (SECDEF, `SET search_path`, REVOKE-all-then-grant authenticated):
  - `like_video(p_video_id uuid)` — auth; published video + published creator gate; `rate_limit_hit('video_like', uid, '1m', 60)`; `INSERT … ON CONFLICT DO NOTHING` (idempotent → count never double-moves).
  - `unlike_video(p_video_id uuid)` — auth; delete-if-exists (idempotent).
  - `viewer_liked_state(p_video_id uuid) → boolean` — auth only; **JOIN-gated on `creators.published_at IS NOT NULL` (audit C4)** so a taken-down creator's video never reports "you liked this" while the page is dark.
  - `list_liked_videos(p_cursor_ts timestamptz, p_cursor_id uuid, p_limit int)` — own; JOIN videos + creators **re-gated on `creators.published_at IS NOT NULL`** + `videos.published_at`; **composite keyset cursor `(liked_at, video_id)` — `created_at` alone isn't unique (audit M7, same fix as handshakes)**, index `video_likes (user_id, created_at DESC, video_id)`. Returns `video_id, title, thumbnail_url, creator_handle (COALESCE creators.handle, profiles.handle — promoted-handle safe), liked_at`. Granted authenticated. Each row routes to the canonical `/v/[id]` (same feed experience: carousel + Ask).
- **Algo hook:** `videos.like_count` is the exposed signal. Documented for the feed workstream; NOT consumed by `feed_ranked_page` in this plan.
- **pgTAP** `video_likes.test.sql`: anon no-EXECUTE on like_video; like increments count; idempotent re-like; unlike decrements; floor at 0; unpublished-creator video rejected; `list_liked_videos` excludes a since-unpublished creator (takedown); own-read isolation (another user can't read my likes); `viewer_liked_state` flips.

### 2.2 Comments — migration `…_video_comments.sql`
```sql
CREATE TABLE public.video_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id   uuid NOT NULL REFERENCES public.videos(id)            ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id)          ON DELETE CASCADE,
  parent_id  uuid          REFERENCES public.video_comments(id)    ON DELETE CASCADE,
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  pinned_at  timestamptz,           -- creator pin (top-level only)
  hidden_at  timestamptz,           -- creator hid it
  hidden_by  uuid REFERENCES public.profiles(id),
  deleted_at timestamptz,           -- soft delete (author/creator/admin)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX video_comments_feed_idx ON public.video_comments (video_id, created_at DESC, id); -- composite keyset (audit M7)
CREATE INDEX video_comments_thread_idx ON public.video_comments (parent_id, created_at) WHERE parent_id IS NOT NULL;
ALTER TABLE public.videos ADD COLUMN comment_count int NOT NULL DEFAULT 0 CHECK (comment_count >= 0);
```
- **Depth guard (one level) — reads the LIVE parent row, trusts nothing from the RPC args (audit C2):** BEFORE INSERT trigger — if `NEW.parent_id` is set, SELECT the parent row and require it to satisfy **all** of: `parent_id IS NULL` (no reply-to-reply), `video_id = NEW.video_id` (derive the parent's own video_id and compare — do NOT trust the client-supplied `p_video_id`), **`deleted_at IS NULL AND hidden_at IS NULL`** (cannot reply under a hidden/deleted comment — closes the moderation-evasion path where a thread is kept alive under a comment the creator killed). Raise `bad_parent` otherwise. The BEFORE INSERT trigger + the parent's row lock serialize, so the check is race-safe within the transaction.
- **Soft delete:** `deleted_at`/`hidden_at` keep the row (thread integrity + audit) but the read path filters them. A deleted parent with live replies renders as "[deleted]" so replies don't orphan.
- **RLS:**
  - SELECT (public read): `deleted_at IS NULL AND hidden_at IS NULL` **AND** the video's creator is published (takedown re-gate via EXISTS on creators.published_at) **AND** `videos.published_at IS NOT NULL`. Granted anon, authenticated. (A view or the RPC encapsulates the join.)
  - INSERT/UPDATE/DELETE: **none** — all writes via RPC.
- **Count trigger** `videos_comment_count_maintain()` — **MUST act on a derived visibility BOOLEAN's transition, never on individual column flips (audit C1).** Define `is_visible := (deleted_at IS NULL AND hidden_at IS NULL)`.
  - INSERT: `+1` (new rows are visible).
  - UPDATE: `was := OLD.is_visible`, `now := NEW.is_visible`; `+1` if `(NOT was AND now)` (unhide/undelete), `-1` if `(was AND NOT now)` (hide or delete), else no-op. This collapses **hide→delete to a single −1**, makes **unhide a correct +1 (only if not also deleted)**, and makes **repeated soft-deletes idempotent**.
  - DELETE: `-1` **only if `OLD` was visible** — a cascade-deleted row that was already soft-deleted/hidden must be a **no-op** (it was already counted out).
  - The `CHECK (comment_count >= 0)` floor is a tripwire, NOT a correctness mechanism — a CHECK violation in testing is a drift bug to fix, not a guard doing its job.
  - **pgTAP must cover every transition:** insert→hide→delete (net −1 from visible, not −2), hide→unhide (net 0), delete-then-delete (net −1, idempotent), cascade-delete of an already-soft-deleted row (net 0), reply insert/delete. "post→delete and hide" alone is insufficient — the drift lives in the compound transitions.
  - **Idempotency at the RPC layer too:** `delete_own_comment` / `creator_moderate_comment` no-op (early return) when the target is already in the requested state, so the AFTER UPDATE doesn't even fire twice.
- **RPCs** (SECDEF, grant matrix):
  - `post_comment(p_video_id, p_body, p_parent_id uuid DEFAULT NULL) → uuid` — auth; published gate; **two rate caps (audit M6):** per-caller `rate_limit_hit('comment_post', uid, '1m', 10)` AND per-video `rate_limit_hit('comment_video', video_id, '1m', ~120)` to blunt brigading of one creator's video; length check; depth guard; optional blocklist scrub; returns new id. Granted authenticated.
  - `delete_own_comment(p_comment_id)` — author only; soft delete. Granted authenticated.
  - `moderate_comment(p_comment_id, p_action text)` — `p_action ∈ {delete,hide,unhide,pin,unpin}`. Authorized for **the video's creator OR an admin (audit C3)**: caller passes if `EXISTS(admin_roles WHERE user_id = auth.uid())` **OR** owns the video's creator via the **two-hop join** `video_comments → videos.creator_id → creators.id → creators.user_id = auth.uid()` (NOTE: `videos.creator_id` references `creators.id`, not `user_id` — do not short-circuit). Pin only on top-level. Idempotent (no-op if already in state). Granted authenticated (body asserts authz).
  - `report_comment(p_comment_id, p_reason text)` — auth; `rate_limit_hit('comment_report', uid, '1m', 20)`; **no-ops with a generic `not_reportable` (same response shape as not-found) when the target is already deleted/hidden or its creator is unpublished** — so it isn't an existence oracle for invisible comments (audit M3). DB `CHECK (char_length(reason) <= 500)`. Inserts into `comment_reports`. Granted authenticated.
  - **Admin reports read:** a minimal `admin_list_comment_reports(...)` (admin-gated, SECDEF) so the existing admin surface can action the queue — the reports table is not write-only-into-the-void (audit C3).
  - `list_video_comments(p_video_id, p_cursor_ts, p_cursor_id, p_limit)` — public; **pins fetched as a separate small query (0–few), then the NON-pinned stream keyset-paginated on composite `(created_at, id)` — pins cannot fold into a keyset ORDER BY (audit M2)**. Author shown via the COALESCE(creators.handle, profiles.handle) public projection — never email/id; NULL-handle author → fallback name, not linkable. Soft-deleted parents with live replies return an `is_deleted` sentinel + NULL body (never the real text — audit Small). Sibling `list_comment_replies(p_parent_id, p_cursor_ts, p_cursor_id, …)` for the reply tier. Re-gated on `creators.published_at`. Granted anon, authenticated.
- **`comment_reports`** table (id, comment_id FK CASCADE, reporter_id FK profiles, reason text ≤500, created_at; partial unique (comment_id, reporter_id) to dedupe). RLS: service-role/admin read only (zero client policies); writes via `report_comment` RPC. Feeds the P1-4 admin queue.
- **pgTAP** `video_comments.test.sql`: anon no-EXECUTE on post_comment; post increments comment_count; reply depth guard (reply-to-reply rejected; cross-video parent rejected); author can soft-delete own + count decrements; non-author cannot delete; creator can hide/pin on own video; non-creator cannot moderate; unpublished-creator video post rejected; takedown hides comments from `list_video_comments`; report dedupes; reported row not readable by client (reports RLS).

## 3. UI units
- **V1 (video page `/v/[id]`):** Like button (optimistic, `viewer_liked_state` seed, login-gate with `?action=like` consumed client-side — same M6/C1 pattern as handshake, NO GET-mutation) + like_count; comment count; comments panel (list + compose + one-level replies; creator sees delete/hide/pin; everyone sees report; logged-out can read, compose CTA → login).
- **V2 (profile self-view):** private "Liked" tab (own only, `list_liked_videos`) beside Watch history; each row → `/v/[id]` (Ask entry). Empty state.
- Reuse the handshake-button intent-across-login pattern (client `useEffect` fires the CSRF-protected server action once, strips `?action`). Server actions: `likeAction`/`unlikeAction`, `postCommentAction`/`deleteCommentAction`/`moderateCommentAction`/`reportCommentAction`.

## 4. Units / order (TDD)
- **L1** likes schema + RPCs + pgTAP → **L2** like UI + Liked tab.
- **C1** comments schema + RPCs + reports + pgTAP → **C2** comments UI + moderation controls.
- **X** algo-signal doc hook.
- Full `npm run db:test` after each schema unit (not just new files — schema blast-radius discipline).

## 5. Edge cases / risks (pre-load for the auditor)
1. **Like/comment on unpublished or taken-down creator** — every write + read re-gates on `creators.published_at` (videos RLS alone is insufficient).
2. **Self-attested likes** — like_video gates published, not proof-of-watch; like_count is a real social signal but a determined user can like everything once (rate-limited, idempotent so no inflation of a single video). Acceptable; documented like watch_history.
3. **Comment depth** — reply-to-reply and cross-video parent must be rejected (trigger), or the one-level invariant breaks.
4. **Soft-delete count drift** — the comment_count trigger must handle insert / soft-delete / hide / hard-cascade-delete without double-counting; pgTAP covers each transition.
5. **Orphan replies** — a deleted parent with live replies renders "[deleted]" (don't cascade-delete replies on a soft delete; only hard cascade on row delete).
6. **PII via comment author** — `list_video_comments` exposes only the public-handle projection (name/avatar/handle), never email/id; a NULL-handle author shows as a fallback name, never linkable.
7. **Moderation authz** — `creator_moderate_comment` must verify the caller owns the *video's* creator, not just any creator; pin only top-level.
8. **Rate limits** — post 10/min, report 20/min, like 60/min (1-min windows only).
9. **Login-hop `?action=like`** — client-fires once, no GET-mutation (the exact C1 trap from the profile build).
10. **Report abuse / dedupe** — partial unique (comment_id, reporter_id); reports table client-unreadable.
11. **Algo coupling** — like_count exposed but `feed_ranked_page` untouched; flag if the feed workstream expects a different shape.
12. **Counts on a video whose creator later unpublishes** — counts persist on the row but the video/comments stop rendering publicly (takedown re-gate); no count reset needed.

## 6. Out of scope (v1)
Comment edit; comment-likes; deep threading; @mentions/notifications; like/comment activity feed; emoji reactions; GIFs; profanity ML (→ P1-4).

## 7. Audit Round 1 — resolution log (auditor subagent, 2026-05-25)

| # | Finding | Resolution |
|---|---|---|
| **C1** | `comment_count` trigger double-decrements (hide→delete), misses unhide, non-idempotent | §2.2: trigger acts on a derived **`is_visible` boolean transition**, DELETE decrements only if OLD was visible; RPCs no-op when already in state; pgTAP covers all compound transitions |
| **C2** | Depth guard trusts RPC args + lets you reply under hidden/deleted parent (moderation evasion) | §2.2: BEFORE INSERT reads the **live parent**, derives its `video_id`, rejects non-NULL parent_id + hidden/deleted parent |
| **C3** | "Admin removes" was vapor — only the video's creator could moderate | §2.2: `moderate_comment` adds an **admin branch** (`admin_roles`) + `admin_list_comment_reports` so the queue is actionable |
| **C4** | `viewer_liked_state` not takedown-re-gated | §2.1: JOIN-gated on `creators.published_at` like `list_liked_videos` |
| **M1** | `like_count` (video grain) unusable by the hook-keyed scorer | §0: documented as a video-grain signal; feed workstream owns any fan-out; we don't pretend it's drop-in (matches Vuk's "don't rewrite feed_ranked_page") |
| **M2** | pins can't fold into a keyset ORDER BY | §2.2: pins fetched separately, non-pinned stream keyset-paginated |
| **M3** | `report_comment` is an existence oracle for invisible comments | §2.2: no-op/`not_reportable` (same shape as not-found) on already-invisible/taken-down targets |
| **M4** | Count triggers' user-delete cascade direction undocumented | trigger comments must state: user-delete decrements the surviving video; video-delete is a no-op; soft-deleted cascade is a no-op (ties C1) |
| **M5** | comment body could ride the login hop in a URL (leak + GET-mutation) | §3: comment bodies **never** in a URL — stash client-side (sessionStorage), re-POST via the CSRF-protected action after auth; only the payload-free `?action=like` replays |
| **M6** | brigading: no per-video comment cap; scopes undocumented | §2.2: per-video `comment_video` cap added; all new scopes (`video_like`,`comment_post`,`comment_report`,`comment_video`) registered in `20260420000032` |
| **M7** | non-unique `created_at` keyset (the bug the profile build already fixed) | §2.1/§2.2: composite cursors `(created_at, id/video_id)` + matching composite indexes |
| **Smalls** | `video_likes` needs explicit `GRANT SELECT TO authenticated`; `REVOKE ALL FROM public,anon,authenticated` per RPC; `comment_reports` REVOKE-all + RLS-zero-policies; DB CHECK on `reason`; two-hop creator ownership join (`videos.creator_id → creators.id`); `[deleted]` sentinel never leaks body; `list_liked_videos` COALESCE handle | Folded into §2.1/§2.2 inline |

All Critical + Medium + Small applied (fix all, don't defer). Plan ready for approval.

## 8. Audit Round 2 — post-BUILD code pass (auditor subagent, 2026-05-25)

The SQL was confirmed to faithfully implement the plan-audit fixes (visibility-transition count trigger, live-parent depth guard, takedown re-gating, REVOKE-all grants, no GET-mutation). Findings were in the net-new app layer; all applied:

| # | Finding | Resolution |
|---|---|---|
| **C1** | "Delete" rendered on every comment; on others' it silently no-ops but the optimistic UI removed it (lie) | list RPCs now return `is_own`; Delete gated on `c.is_own` (the client otherwise can't tell whose comment it is) |
| **C2** | optimistic comment fabricated `author_name:'You'`, never reconciled; header count not bumped | pass viewer handle/name/avatar from page → optimistic rows; `count` is state, ±1 on post/own-delete |
| **C3** | `?action=like` re-fired for an already-liked video (count drift) | `autoLike` gated server-side on `&& !liked` (mirrors the handshake fix) |
| **M2** | "Load more" stayed a dead button after a short page | track `hasMore` from `res.comments.length >= 30` |
| **M3** | reply posted → parent `reply_count` label stale | bump `replyCount` locally on reply |
| **M4** | Report showed "reported" even on rate-limit/failure | check `res.ok`; surface failure |
| **M6** | like `replaceState` stripped `?from` (hook attribution) | strip only `action`, preserve the rest of the query |
| **M7** | unvalidated `cursor_ts` string → 400 dead "Load more" | `z.string().datetime()` |
| Smalls | null `post_comment` id guard; `<div>` direct child of `<ul>` → `<li>`; replies one-level verified in UI | applied |
| M1/M5 | no `revalidatePath` (page is force-dynamic — client reconciliation is correct, not revalidate); duplicate moderator-authz helpers | conscious no-op / noted (low risk, different signatures) |

**Two plan audits + post-build code audit. 30 pgTAP (12 likes + 18 comments) + the profile suite all green; full typecheck clean.**

## 9. Follow-up — anti-scam link block in comments (migration `20260525000009`, 2026-05-25)

Founder decision: scam links in comments are a trust/liability risk (click lands on our domain) → **hard-reject** links, **exempt** the video's creator + admins (they may link their own course).

**Design.** Server-side wall in `post_comment` (the single write chokepoint for top-level + replies). New `_comment_contains_link(text)` SECDEF-internal helper (REVOKE ALL): (1) URI scheme, (2) `www.`, (3) bare `domain.tld` over a curated, precision-first TLD set with a **space-tight** dot, (4) known shorteners/chat-invites. A normalizer strips zero-width chars, dot-like glyphs, and worded/embedded `dot` obfuscation **before** rule 3 — but never collapses whitespace around an ordinary `.`, so a sentence break is never a domain. `post_comment` raises `link_not_allowed` unless `_is_video_moderator` (checked only when a link is detected). Client maps it to "For your safety, links aren't allowed in comments." on both the top-level and reply compose paths.

**Auditor subagent pass — all real findings applied:**

| # | Finding | Resolution |
|---|---|---|
| **C2** | curated TLD set omitted high-volume scam TLDs (`.online/.site/.store/.shop/.live/.top/.click/.vip/.club/.cc/.to/.ws/.space/.fun`) — one-line bypass each | added to the rule-3 alternation (near-zero precision cost — these rarely appear `word.word` space-tight) |
| **C3** | obfuscations slipped: `scamdotcom` (no-space), `scam·com` (middle-dot glyph) | added a tight `([a-z0-9])dot([a-z0-9])` normalize (distinguished from the legit word "dotcom" by the alnum *prefix*) + glyph-dot normalize (· • ‧) |
| **C1** | emails as contact vector | bare emails on curated TLDs are already caught (the `@` is a boundary char); verified by test 21 |
| **M1** | `IMMUTABLE` marker dishonest (`lower()` is collation-dependent; never indexed) | downgraded to `STABLE` |
| **M7** | bypasses untested → green-but-leaky suite | added tests 18–24: `.online`, `scamdotcom`, middle-dot, email, **regression guard for "dotcom bubble"**, `node.js` negative, and the `scam . com` documented known-miss |
| Smalls | `youtu.be` shortener; header overclaimed coverage | added `youtu\.be`; header now states ACCEPTED RESIDUAL RISK explicitly |

**Accepted residual risk (deliberate, precision-first — moderation/report is the backstop):** a *spaced* literal dot "scam . com" is byte-for-byte indistinguishable from a sentence break ("...ever. Org meeting"), so blocking it would false-positive real comments — **not** blocked, asserted as a known-miss in test 24. Also out of scope for v1: bare IPv4 with no scheme, homoglyph/cyrillic-lookalike domains. The client renders comment bodies as non-clickable React text (no autolinker/`dangerouslySetInnerHTML`), so a bypassed link is plain selectable text, not a live link.

**30 new pgTAP assertions green; `video_comments` (18) + `video_likes` (12) regression suites still green; tsc clean on touched files.**
