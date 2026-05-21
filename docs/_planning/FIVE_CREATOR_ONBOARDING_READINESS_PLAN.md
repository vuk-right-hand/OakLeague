# Five-Creator Onboarding Readiness — Implementation Plan

**Date:** 2026-05-21
**Branch context:** `rag-sota-phase-2-days-8-12`
**Goal:** Make it safe and possible to email 5 real creators (and let their
audiences in) without an engineer hand-running scripts. Covers the three areas
flagged for audit:

3. Creator onboarding end-to-end (invite → … → published)
4. Cold-start NEW-USER (audience) path
5. Trust / legal (consent, PII retention, moderation, terms)

Every claim below is grounded in code that was read, not in prior plans. File
paths + line context cited inline. **This is a findings + plan doc; no code is
changed yet.**

---

## PART A — WHAT ACTUALLY EXISTS TODAY (code-proven)

### Area 3 — Creator onboarding chain

The intended chain is:
`invite → claim → apply → admin approve → creator adds knowledge → corpus
re-process v2 → voice clone → face upload → retrieval flip → PUBLISH → appears
in feed`.

What is built and wired (✅ = proven present):

- ✅ **Invite mint** — `src/app/admin/invites/actions.ts` `mintCreatorInvite`:
  admin-gated (`assertAdminFromSession`), inserts `creator_invitations`, sends
  Resend email, returns copy-fallback URL. Single-use, ≤7-day expiry.
- ✅ **Claim** — `src/app/invite/[token]/claim/route.ts`: requires login, calls
  `bind_invite_claim` RPC, sets `invite_nonce` httpOnly cookie (1h), redirects
  to `/apply`.
- ✅ **Apply** — `src/app/apply/page.tsx` + `apply-form.tsx` →
  `submitCreatorApplication`. Captures display_name, handle, bio, 1–5 topics,
  proof URLs.
- ✅ **Admin review queue** — `src/app/admin/applications/[id]/review-actions.tsx`
  → `approveApplication` → `approve_creator_application` RPC
  (`supabase/migrations/20260511000003`). The RPC creates the `creators` row at
  `brain_status='training'` and **immediately compiles the persona**
  (`_creator_brain_compile_unsafe`). Reject path also present.
- ✅ **Creator self-serve knowledge** — `src/app/creator/brain/page.tsx` +
  `actions.ts`: creator adds topics + `sample_content` (up to 5 topics, 100
  rows). Every mutation recompiles persona via Next 15 `after()`.
- ✅ **Corpus re-process v2** — admin panel
  `src/app/admin/creators/[id]/corpus-reprocess-panel.tsx` →
  `POST /api/admin/corpus-reprocess` → `_admin_enqueue_corpus_reprocess_unsafe`
  (`20260518000001`) → `corpus_reprocess_jobs` queue → in-proxy worker
  `makeCorpusReprocessWorker` (`server/voice-proxy/index.js:2506-2528`,
  `embed-worker.js`). Live polling UI, force-reprocess, per-sample errors.
- ✅ **Voice clone** — admin `voice-clone-upload.tsx` →
  `POST /api/admin/voice-clone` → Cartesia → `creators.voice_id`. Rate-limited,
  WAV-validated, overwrite-guarded.
- ✅ **Face upload** — admin `face-upload.tsx` → Simli `simli_face_id`, with
  pending-resume + timeout-orphan recovery.
- ✅ **Retrieval-version flip** — admin button →
  `POST /api/admin/creator-retrieval-version` →
  `admin_set_creator_retrieval_version` (recompiles persona in-txn).
- ✅ **Session-open gate** — `src/app/api/sessions/open/route.ts:228-282`:
  blocks with 409 `brain_not_ready` only when `system_prompt IS NULL OR
  brain_status='errored'`. It deliberately does **not** require
  `published_at`/`'ready'`.

### Area 4 — Cold-start NEW USER (audience)

- ✅ **Auth** — `src/app/login/actions.ts`: `requestMagicLink`
  (`signInWithOtp`) + `startGoogleOAuth`, both redirect to
  `/auth/callback?next=`. No standalone `/signup` route — login page is the
  entry.
- ✅ **Onboarding** — `src/app/onboarding/` (page + form + actions) collects
  goals/obstacles.
- ✅ **Feed / video / session lifecycle** — present and in active dogfood use
  (feed RPCs, `/v/[id]`, `/s/[id]`, open/close/heartbeat, Simli accrual).

### Area 5 — Trust / legal

- ✅ **PII (partial)** — `voice_tickets` consumed/expired purge (7d,
  `20260511000005`); `feed_events_raw` 90d + `anon_feed_sessions` 30d via
  pg_cron (`20260504000007`); rate-limit cleanup cron.
- ✅ **Cascade delete** — FK `ON DELETE CASCADE` on `session_turns`,
  `sessions`, etc.; `cascade_auth_user_delete` test exists → deleting an auth
  user wipes their rows.
- ✅ **Camera off by default** (CLAUDE.md hard rule), enforced in session UI.
- ✅ **Prompt-injection neutralization (L0)** on `sample_content`
  (`/api/internal/preprocess`).

---

## PART B — GAPS (code-proven, the real work)

### 🔴 BLOCKER-1 — There is no "publish creator" path at all

**Proof:** A repo-wide search for any write of `creators.published_at` or
`creators.brain_status='ready'` found **zero** production code paths.
- `published_at =` writes exist only on `videos` (`admin/content/actions.ts`)
  and in algo test fixtures.
- `brain_status='ready'` is set only by `scripts/seed-rag-test-fixture.mjs`
  (a TEST fixture creator) — never in app code, never in a non-fixture script.
- `creators` table CHECK: `published_at IS NULL OR brain_status='ready'`
  (`20260420000011:30`). Feed RLS read policy requires
  `published_at IS NOT NULL AND creator_type='human'` (`:123-125`).

**Consequence:** An approved creator is stuck at `brain_status='training'`
forever. Their hooks can never enter the feed. Creator #1 (Vuk) is live only
because someone ran raw SQL by hand. **This is the single thing most directly
between us and "email 5 creators."**

### 🔴 BLOCKER-2 — No URL/YouTube transcript fetch; `fetch_status` is inert

**Proof:**
- `sample_content.fetch_status` defaults to `'pending'`
  (`20260420000013:13`). No code anywhere transitions it to `'ready'` except
  the test-fixture seed script. No YouTube/transcript fetcher exists (searched
  ytdl/innertube/transcript-api — none).
- The reprocess enqueue gate is `raw_text IS NOT NULL`
  (`20260518000001:108-110,201-203`), **not** `fetch_status='ready'` (the panel
  comment claims "ready" — it's wrong/misleading).

**Consequence:** A `youtube` sample with only a `source_url` and no pasted
`raw_text` is silently never processed. The apply + brain UIs invite a YouTube
URL, implying it gets ingested — it does not. Creators must paste raw transcript
text or nothing trains. Silent UX trap.

### 🟡 GAP-3 — Corpus worker is env-gated and can silently no-op in prod

**Proof:** `server/voice-proxy/index.js:2511-2528` — the reprocess worker only
starts if `GEMINI_API_KEY && INTERNAL_API_BASE_URL && INTERNAL_API_SECRET` (and
secret ≥32 chars). Otherwise it logs `corpus reprocess worker disabled` and the
admin's "Re-process v2" enqueues jobs that sit `pending` forever with no error
surfaced in the UI.

**Consequence:** Onboarding can stall invisibly depending on Fly env config.
Must verify these secrets are set in the deployed proxy, and the UI should warn
when jobs sit pending with no worker heartbeat.

### 🟡 GAP-4 — No onboarding orchestration / readiness surface for admin

The admin creator-detail page (`admin/creators/[id]/page.tsx`) is explicitly
"read-only brain-status + action panels, no re-trigger" by design. There is no
"what's left to publish this creator" checklist, no enforced order, and (per
BLOCKER-1) no Publish button. An admin must remember the exact sequence and
manually judge readiness. Easy to ship a half-trained creator (e.g. retrieval
flipped to v2 before any v2 chunks exist — a documented foot-gun in
`PROD_DEPLOY_GATE.md:103-114`).

### 🔴 GAP-5 (Area 5) — No consent capture for voice/likeness clone

**Proof:** `apply-form.tsx` has no acknowledgment/consent checkbox.
`voice-clone-upload.tsx` has no consent attestation and there is no consent
record table. Cloning is admin-initiated on the creator's behalf with nothing
recording that the creator authorized use of their voice + face.

**Consequence:** Fine for self-dogfood (Vuk). For 5 external creators, cloning a
person's voice/likeness with no recorded consent is a real legal exposure.

### 🔴 GAP-6 (Area 5) — No Terms of Service / Privacy Policy

**Proof:** No `/terms`, `/privacy`, or `/legal` routes exist. No acceptance is
recorded at signup or apply.

### 🟡 GAP-7 (Area 5) — Conversation transcripts retained indefinitely

**Proof:** `session_turns.transcript` stores ≤8192 chars of real conversation
content per turn (`20260420000018:13`). Among the 13 retention-related
migrations, **none** purge `session_turns` or `sessions`. It cascades on
profile delete (GDPR erase works) but there is no time-based minimization.

### 🟡 GAP-8 (Area 5) — No self-serve account deletion / data export

Cascade delete works at the DB level, but there is no user-facing "delete my
account" / "export my data" path and no documented admin tool for an erasure
request.

### 🟡 GAP-9 (Area 5) — No content moderation / abuse reporting

L0 neutralizes prompt-injection in the corpus — that is security, not abuse
moderation. There is no moderation of user questions, no moderation of creator
answers, and no report/flag path for audiences.

### Area 4 — verification owed (not proven broken)

- Ghost-user / email-ownership branch in `/auth/callback` for a brand-new email
  (CLAUDE.md hard rule) — verify OAuth-claim vs email-signup handling.
- Onboarding gating: confirm a user who skips/abandons onboarding still reaches
  a working feed (no redirect loop), and that `goals/obstacles` are optional to
  browse.
- First-session device reality: mic-permission prompt + iOS Safari autoplay —
  manual device test, not in code.
- Feed with a single published creator — confirm it renders sanely (already
  true in dogfood, but re-confirm with a 2nd published creator once BLOCKER-1
  lands).

---

## PART C — IMPLEMENTATION PLAN (prioritized, TDD)

Ordering follows CLAUDE.md: schema → server → UI → tests, smallest blast radius
first. Each unit gets the auditor before commit (per standing rule).

### P0 — Unblocks "email 5 creators" (must land before any creator email)

#### Unit P0-1 — Creator publish/unpublish RPC + admin button + readiness gate
- [ ] **Schema/RPC** `supabase/migrations/<ts>_admin_set_creator_published.sql`.
      Use the **`_admin_enqueue_corpus_reprocess_unsafe` pattern, NOT the
      retrieval-version JWT pattern** (auditor C2): service-role-callable,
      signature `_admin_set_creator_published_unsafe(p_admin_user_id uuid,
      p_creator_id uuid, p_publish bool)`, verify `p_admin_user_id` against
      `admin_roles` (revoked_at IS NULL) before writing, and pass it as
      `admin_audit_log.admin_user_id` (that column is `NOT NULL REFERENCES
      admin_roles(user_id)` — `auth.uid()` is NULL under service-role and the
      FK insert would fail). Provide a public `_assert_caller_is_admin()`
      wrapper too for SQL-editor use.
      - Publish path is a **single UPDATE** setting
        `brain_status='ready', published_at=now()` (atomic — two writes violate
        the CHECK; see `SCHEMA_V1_PLAN.md:585`).
      - **Unpublish path (auditor C3):** `published_at=NULL` ALONE does NOT stop
        sessions — session-open ignores `published_at` (`route.ts:245-246`), so
        an unpublished-but-ready creator is still fully serviceable by anyone
        with the UUID/deep link. Decide + implement ONE: (a) add
        `published_at IS NOT NULL` to the non-admin session-open gate (cleaner;
        a deliberate behavior change with its own test), or (b) unpublish moves
        `brain_status` to a non-serving value. Default to (a).
      - **Readiness preconditions** enforced IN the RPC (RAISE per-code):
        `voice_id IS NOT NULL`, `simli_face_id IS NOT NULL`, `system_prompt IS
        NOT NULL`, ≥1 `sample_content` row with `raw_text IS NOT NULL`. For the
        retrieval gate (auditor C1): only when `brain_mode='vector'` AND
        `retrieval_version=2`, require
        `EXISTS (SELECT 1 FROM sample_content_chunks WHERE creator_id=p_creator_id
        AND chunker_version=2 AND embedding IS NOT NULL)` — a populated narrative
        unit with un-embedded children still retrieves nothing, so checking the
        parent unit is the wrong guard.
- [ ] **Route** `POST /api/admin/creator-publish`: same-origin + JSON +
      `assertAdminFromSession`, call the `_unsafe` RPC via `supabaseAdmin`
      passing `admin.userId` (mirror `/api/admin/corpus-reprocess/route.ts`, NOT
      the retrieval-version route). Map each precondition code to a 4xx. On
      success, **revalidate the public feed cache as well as the admin page**
      (auditor S6) — otherwise hooks won't appear until feed TTL expires,
      breaking P0-5's acceptance.
- [ ] **UI** Publish/Unpublish button + readiness checklist on
      `admin/creators/[id]/page.tsx` showing each precondition green/red, the
      `embedding IS NOT NULL` v2-chunk count (auditor S4), and `published_at`.
- [ ] **Tests** `supabase/tests/admin_set_creator_published.test.sql`: blocks
      when each precondition missing; v2 gate passes only on embedded child
      chunks; atomic publish satisfies CHECK; non-admin rejected; audit row
      written with the real admin id; **unpublish actually blocks session-open**
      (auditor S5/C3).

#### Unit P0-2 — Corpus worker prod-config verification + UI stall warning
- [ ] Verify on the deployed Fly proxy that **all three** boot-gate vars are set
      (auditor C4): `GEMINI_API_KEY`, `INTERNAL_API_BASE_URL`, and
      `INTERNAL_API_SECRET` with **length ≥ 32** (a shorter secret logs an error
      and disables the worker without crashing boot — proxy looks "healthy").
      Document in `PROD_DEPLOY_GATE.md`. (Config check, not code.)
- [ ] **UI** corpus-reprocess panel: when pending rows exist but no
      `corpus_reprocess_jobs.claimed_at` has advanced in > N seconds, show
      "worker may be offline" instead of an indefinite spinner. Keying off
      `claimed_at` (not which env var is missing) detects the disabled-worker
      case regardless of cause.
- [ ] **Test** unit test for the stall-detection helper.

#### Unit P0-3 — Voice/likeness consent capture + record
- [ ] **Schema** `creator_consents` table. **Key on `user_id` (and/or
      `application_id`), NOT `creator_id`** (auditor M2): the `creators` row
      doesn't exist until approval, so consent collected at apply time has no
      `creator_id` to FK. Relink/derive at approval. Columns: consent_type
      `voice_clone|likeness|content_license|tos`, version text, accepted_at, ip,
      user_agent, source (e.g. `apply_form|pre_consent_backfill`). RLS: applicant
      reads/inserts own (or written inside the RPC — see next bullet); admin
      reads. **This table stores PII (ip, user_agent) — add it to the P1-2
      retention plan** (auditor S3).
- [ ] **Write path (auditor M1):** `submitCreatorApplication` calls the
      `submit_creator_application` RPC via the JWT client — it does NOT do a
      direct table insert, so a service-role-only `creator_consents` cannot be
      written from the action. Either (a) add consent params to the
      `submit_creator_application` RPC and insert there, or (b) give
      `creator_consents` an own-insert RLS policy for the authenticated
      applicant. Verify the RPC's current params before implementing.
- [ ] **UI** consent checkboxes on `apply-form.tsx` (ToS + voice/likeness) —
      required to submit. Block `POST /api/admin/voice-clone` and `face-upload`
      server-side when no `voice_clone`/`likeness` consent exists for the
      creator's user.
- [ ] **Backfill (auditor M3):** a migration seeding `creator_consents` rows for
      EXISTING creators (Vuk/creator #1) with `source='pre_consent_backfill'`,
      or an explicit admin-attestation bypass — otherwise the new gate hard-fails
      re-clone/re-upload for the live creator the day it ships.
- [ ] **Tests** application insert requires consent rows; voice-clone route 4xx
      without consent; backfilled creator can still re-clone.

#### Unit P0-4 — Terms of Service + Privacy Policy pages + acceptance
- [ ] Static `/terms` + `/privacy` routes (content can be a v1 draft, but real).
- [ ] Record ToS/privacy acceptance. Audience write lives in `auth/callback`
      but **must be idempotent + version-aware** (auditor M4): that route runs
      on EVERY magic-link/OAuth callback, not just first signup, so write only
      `WHERE tos_accepted_at IS NULL OR tos_version < current` — otherwise every
      re-login overwrites the original acceptance timestamp and destroys the
      legal record of when they first accepted. Creators accept via P0-3.
- [ ] Footer links site-wide.

#### Unit P0-5 — Dry-run creator #2 end-to-end on staging (no engineer)
- [ ] Runbook in this doc's appendix: invite → claim → apply (with consent) →
      approve → creator pastes transcript text → admin reprocess → **WAIT until
      the corpus panel shows every sample `done` AND ≥1 v2 chunk embedded**
      (auditor M6 — flipping retrieval before the async worker finishes embeds
      reproduces the empty-retrieval foot-gun) → flip retrieval → clone voice →
      upload face → **Publish button** → confirm hooks appear in feed → open a
      session → hear the cloned voice + on-persona answer. Done entirely through
      the admin/creator UIs, scripts forbidden. Acceptance gate for "5 onboard."

### P1 — Needed soon after first creators, not strictly blocking the email

#### Unit P1-1 — URL/YouTube ingestion OR honest UI (+ fix admin readiness signal)
- [ ] **Option A (preferred):** add a fetch step — on `sample_content` insert
      with `source_url` and null `raw_text`, enqueue a fetch job; a worker pulls
      the transcript (provider TBD — web-verify a supported YouTube transcript
      API), writes `raw_text`, sets `fetch_status='ready'`. Then it flows into
      the existing reprocess path.
- [ ] **Option B (cheap stopgap):** make the UI honest — require pasted
      `raw_text` for every source type, label the URL field "reference only —
      paste the transcript below," and hide/disable submit until text present.
- [ ] **Fix the admin readiness display (auditor M5):** `admin/creators/[id]/
      page.tsx:218,223` computes "ready" counts from `fetch_status==='ready'`,
      which nothing ever sets in real creators — so the admin's own readiness UI
      shows 0 ready forever while enqueue/publish key off `raw_text IS NOT NULL`.
      Switch the display to `raw_text IS NOT NULL`. (If Option A lands,
      `fetch_status` becomes meaningful and this can stay as a secondary signal.)
- [ ] **Tests** per chosen option.

#### Unit P1-2 — `session_turns` PII minimization (NOT row delete)
- [ ] **Auditor M7:** `session_turns` carries the per-turn COGS trail
      (`cost_breakdown`, `llm_input_tokens`, `tts_characters`, `avatar_seconds`
      — `20260420000018:15-20`), not just `transcript`. A blanket row-delete
      destroys cost history. Instead **NULL out `transcript` past the window**
      (the PII) while retaining the cost columns — or aggregate cost to a
      separate retained table before any delete. pg_cron, batched +
      advisory-locked, logging to `retention_run_log`, mirroring `20260504000007`.
- [ ] Include `creator_consents` PII (ip, user_agent) in the same retention
      sweep (auditor S3).
- [ ] **Test** transcript nulled past window; cost columns survive; logs row;
      idempotent.

#### Unit P1-3 — Account deletion + data export (GDPR/CCPA)
- [ ] User-facing "Delete my account" (triggers auth-user delete → cascade) with
      confirm; "Export my data" (JSON of profile + sessions + turns). Admin
      erasure tool for emailed requests.
- [ ] **Tests** delete cascades; export contains expected tables only.

#### Unit P1-5 — Full content takedown: cascade unpublish to videos RLS
- [ ] **From P0-1 implementation audit (M2 residual).** P0-1 closed the two
      FEED entry-point surfaces (`welcome_hooks_public` view + `hooks`
      public-read RLS now both require `creators.published_at IS NOT NULL` —
      migration `20260523000006`). But `videos` own public-read RLS still gates
      on `videos.published_at` independent of the creator, so a deep link
      straight to a published video of an unpublished creator can still render
      the video shell (no hook, no session). Extend `videos` public-read RLS
      with a `creators.published_at` EXISTS clause for a true full takedown.
      Deferred from P0-1 because it's a broader RLS change with its own test
      surface; the P0-1 unpublish promise ("removes from feed + blocks
      sessions") is accurate today, "removes ALL content" is not yet.

#### Unit P1-4 — Minimal content moderation + report path
- [ ] Audience "report" button on a creator/session; rows land in an admin
      review table. Optional: lightweight moderation pass on user questions
      (web-verify provider). Scope deliberately small for v1.

### P2 / Verification — Area 4 cold-start

- [ ] Manual cold-start run on a fresh email + fresh device (iOS Safari +
      Android Chrome): signup → onboarding → feed → hook → mic tap → session.
      Use the `/verify` or `/run` skill. Capture the ghost-user branch behavior.
- [ ] Confirm onboarding is skippable and feed never redirect-loops.

---

## PART D — RISKS / OPEN QUESTIONS

- **Retrieval-version vs publish ordering**: P0-1's "v2 needs ≥1 parent chunk"
  precondition must match the real v2 schema check used elsewhere — verify the
  exact table/column before writing the guard (`PROD_DEPLOY_GATE.md:103-114`).
- **Consent versioning**: ToS text will change; consent rows must be
  version-pinned so re-acceptance can be required later.
- **session_turns window**: 90d is a proposal; Vuk to confirm legal/retention
  stance before we delete real conversation data.
- **Moderation scope**: full moderation is a v2 surface; P1-4 is intentionally a
  report-path MVP, not automated takedown.
- **Decoupled-brain / prod deploy** remains separately gated by
  `PROD_DEPLOY_GATE.md` (P1-10 + 1c). This plan does not change that gate; a
  published creator still needs the proxy deployed to actually serve sessions.
- **Don't "fix" approve to set `'ready'` (auditor S1):** `session-open
  route.ts:230-235` documents that the strict `brain_status='ready'` gate was
  deliberately removed. P0-1 introduces the only legitimate `'ready'` setter
  (the publish RPC). A future reader must not re-add `'ready'` inside
  `approve_creator_application` — that would re-introduce the strict gate.
- **Stale panel comment (auditor S2):** `corpus-reprocess-panel.tsx` says it
  enqueues "every ready sample" — the real gate is `raw_text IS NOT NULL`. Fix
  the comment alongside P1-1 so it isn't cited as truth later.

---

## AUDIT TRAIL

Auditor subagent run 2026-05-21 against the first draft. Findings accuracy of
PART A/B confirmed (every "✅/🔴 proven" claim spot-checked against the cited
files held up). Defects were in the PART C *implementation proposals* and have
been folded in: **C1** (v2 precondition → embedded child chunk + brain_mode
gate), **C2** (publish RPC uses the service-role `_unsafe` + `p_admin_user_id`
pattern, not the JWT pattern, because `admin_audit_log.admin_user_id` is a
NOT-NULL FK), **C3** (unpublish must actually stop session-open), **C4**
(verify all three worker env vars + secret length ≥32), **M1** (consent written
via the RPC, not a direct insert), **M2** (consent keyed on user_id, not the
not-yet-existing creator_id), **M3** (backfill consent for existing creators),
**M4** (idempotent version-aware ToS write), **M5** (admin readiness display
uses raw_text), **M6** (runbook waits for embed completion before retrieval
flip), **M7** (NULL transcript, retain COGS columns), **S1–S6** (noted above /
in-unit).

**Auditor's three "could not verify" items — RESOLVED 2026-05-21:**
- **M1/M2** — `submit_creator_application` (`20260420000036`) is SECURITY
  DEFINER, identity from `auth.uid()` (`v_uid`), creates `creator_applications`
  keyed on `user_id`; no `creator_id` exists yet. ✅ Plan is correct: write
  `creator_consents` inside this RPC keyed on `v_uid` + returned `v_app_id`.
  Build note: adding params is a DROP+CREATE migration (signature change) +
  grant re-emit + update the caller in `apply/actions.ts`.
- **M3** — `voice-clone/route.ts:61-69` gates on `assertAdminFromSession` first,
  uses `supabaseAdmin`. ✅ Consent check slots in right after the admin gate.
  Backfill confirmed necessary (creator #1 already has `voice_id`).
- **Area-4 ghost-user** — `auth/callback/route.ts` uses `exchangeCodeForSession`
  + an `email_signup_claim` nonce (`auth_pending_verifications`); magic-link/OTP
  proves email ownership. ✅ Auth code is sound; what's owed is device/UX
  testing (iOS mic, autoplay, redirect-loop), not a code fix.

**Status: cleared to begin building. No third audit needed** — residual risk is
implementation correctness, caught by the per-unit TDD + auditor cycle.

---

## APPENDIX — Creator #2 dry-run runbook (P0-5)

The literal click-path to onboard a new creator end-to-end **with zero script
access**. This is the acceptance gate for "email 5 creators": if every step
below works through the admin/creator UIs alone, onboarding is no longer
engineer-gated. Run it on staging against a throwaway creator before emailing
anyone. **No `scripts/*.mjs`, no SQL editor.**

### A. Invite (admin)
1. Go to `/admin/invites/new`. Enter the creator's email + expiry (≤7 days).
   Generate. The invite is emailed (Resend) and the copy-link is shown as a
   fallback. Send the link.

### B. Apply (creator)
2. Creator opens the invite link → logs in (magic link / Google) → lands on
   `/apply`.
3. Creator fills display name, handle, bio, 1–5 topics, proof URLs, AND checks
   **both** consent boxes (Terms/Privacy + voice/likeness authorization).
   Submit is disabled until both are checked. Submit → `/apply/submitted`.
   - ✅ Verify: a `creator_consents` row exists for `tos`, `voice_clone`,
     `likeness` (visible later in the admin Consent panel).

### C. Approve (admin)
4. Go to `/admin/applications` → open the application → **Approve**. This
   creates the creator (`brain_status='training'`), compiles the persona, and
   promotes the handle. (Reject path also available.)

### D. Knowledge (creator)
5. Creator opens `/creator/brain` → adds topics → for each, adds sample content.
   **IMPORTANT (current limitation, P1-1):** paste the actual transcript/text
   into the body — a bare YouTube URL with no text is NOT ingested. Persona
   recompiles automatically after each change.

### E. Clone + train (admin, on `/admin/creators/[id]`)
6. **Consent panel** — confirm `voice_clone` + `likeness` are green (from the
   apply checkboxes). If missing (e.g. a pre-consent creator), click **Attest
   *type* on behalf** only if the creator consented out-of-band (logged).
7. **Voice clone** — upload a PCM WAV (3–120 s). Blocked with `consent_missing`
   if no `voice_clone` consent. On success `voice_id` is set.
8. **Face upload** — upload the avatar image. Blocked if no `likeness` consent.
   On success `simli_face_id` is set.
9. **(Vector v2 creators only — skip for drawer/v1)** Corpus re-process panel →
   **Re-process v2** → **WAIT** until every sample shows `done` AND the
   Publication checklist's "Embedded v2 chunks" is green. If a "worker may be
   offline" warning appears, fix the proxy env (see PROD_DEPLOY_GATE P0-2)
   before continuing. Then flip retrieval_version → 2.

### F. Publish (admin)
10. **Publication panel** — every readiness check must be green: Cloned voice,
    Avatar face, Persona compiled, Brain not errored, Knowledge, and (if v2)
    Embedded v2 chunks. Click **Publish**. `published_at` is set; the creator
    enters the feed.

### G. Verify the user-facing result
11. As a normal user (or incognito), open the feed (`/`) → the new creator's
    hooks appear. Tap a hook → long-form video → tap the mic → a session opens.
12. ✅ Confirm: you hear the creator's **cloned voice** (not a stock voice) and
    the answer is **on-persona** (their content/tone), not a generic AI hedge.

### H. Takedown sanity (optional but recommended)
13. **Unpublish** (Publication panel) → confirm the creator's hooks disappear
    from the feed AND a new session-open returns 409 `creator_not_published`
    (rollover too).
14. **Revoke** voice_clone (Consent panel) → confirm it is a full takedown:
    the creator is **auto-unpublished** (gone from the feed, sessions 409),
    a re-clone is blocked with `consent_missing`, and re-publishing is blocked
    with `voice_consent_missing` until consent is recorded again. (Holistic
    audit C1: revoke = takedown, not just a feed-hide.)

**Acceptance:** steps A–G complete with no scripts and no SQL. If any step
requires an engineer, that's the gap to close before emailing creators.
