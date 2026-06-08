# Creator Journey — Go-Live Plan + Hostile Audit

**Status:** Pre-build scope, audited. NOT yet implemented.
**Date:** 2026-06-04
**Owner:** Vuk
**Audience:** internal build + external auditor handoff.

This document maps the full creator customer-journey (link → request → invite →
apply → approve → self-service dashboard uploads → admin publish → share),
states what already exists vs. what must be built, captures the locked product
decisions, and embeds a **hostile adversarial audit** (framed as a competitor
hunting for a public-shaming launch failure) with code-grounded findings and a
go/no-go verdict per workstream.

---

## 1. Locked product decisions

| # | Decision | Resolution |
|---|----------|------------|
| Email | No domain owned yet | **Build fully env-driven** (`RESEND_API_KEY` / `RESEND_FROM_EMAIL` / `RESEND_REPLY_TO` / `NEXT_PUBLIC_SITE_URL`). No hardcoded domain. Flip on by setting envs once a domain is bought + verified. |
| Entry | "Become a creator" reframed | **"Request to become a creator"**: public form → `creator_requests` table → admin queue → approve auto-fires the existing invite email → unchanged `/invite → /apply`. Stays invite-gated. |
| Payment | $197 setup / $97-mo floated | **DEFERRED.** No Stripe, no billing schema this round. First creators billed manually. |
| Knowledge | COGS control | **YouTube URL + paste/.txt ONLY** at launch. No PDF/doc. |
| Voice (#15) | Creator submits 2–3 min | **In-browser recorder + file-upload fallback** → Cartesia clone. |
| Face (#16) | Creator submits image | Creator image upload → Simli. |
| Video (#17) | Creator uploads | Creator uploads hooks + long-form → Mux. **Admin still gates publish** (no auto-publish). |
| Share (#20) | Users + creators | Pulsating right-rail button on hooks / long-form / profiles; `navigator.share` + copy fallback; dynamic OG cards for `/v/[id]` and `/@handle`. |

---

## 2. Target journey (after this work)

```
Guest on /  ──tap centered nav "Request to become a creator"──▶  /request form
   └─▶ creator_requests row ──▶ admin /admin/requests queue ──▶ approve
          └─▶ auto-fires invite email ──▶ /invite/[token] ──▶ login ──▶ /apply
                 └─▶ application (current form) ──▶ "received" + ACK EMAIL
                        └─▶ admin review ──▶ approve (creates creator) / reject
                               ├─ reject ─▶ REJECTION EMAIL (with reason)
                               └─ approve ─▶ APPROVAL EMAIL ("here's your studio")
                                      └─▶ /creator dashboard now shows:
                                            1. Knowledge (YT + paste/.txt) + "Start ingest"
                                            2. Voice (record 2–3min OR upload) → Cartesia
                                            3. Face image upload → Simli
                                            4. Videos: hooks + long-form → Mux
                                      └─▶ admin reviews readiness ──▶ publish
                                            └─▶ "YOU'RE LIVE" EMAIL + share link
Share button (pulsating, right rail) on hooks / long-form / profiles — OG cards.
```

---

## 3. What already exists (✓ — no work)

Invite mint/claim ([admin/invites/actions.ts](../../src/app/admin/invites/actions.ts),
[invite/[token]/claim/route.ts](../../src/app/invite/[token]/claim/route.ts));
application form + validation + consent provenance
([apply/apply-form.tsx](../../src/app/apply/apply-form.tsx),
[apply/actions.ts](../../src/app/apply/actions.ts)); admin review queue +
approve/reject RPCs with persona auto-compile on approve
([admin/applications](../../src/app/admin/applications),
[20260511000003](../../supabase/migrations/20260511000003_approve_calls_brain_compile.sql));
publish-readiness gate ([admin/creators/[id]/page.tsx](../../src/app/admin/creators/[id]/page.tsx));
Mux webhook ([webhooks/mux](../../src/app/api/webhooks/mux/route.ts)); admin
voice/face/video tooling; `/@handle` profiles; bottom-nav state machine
([bottom-nav.tsx](../../src/components/bottom-nav.tsx)); typed consent rows for
`voice_clone` + `likeness` already emitted at apply
([consent.ts](../../src/lib/consent.ts)).

---

## 4. Workstreams (dependency-ordered) — ORIGINAL PLAN

> The audit in §5 revises several of these. Read §5 + §6 before building.

- **WS0 — Email foundation** `[NEW]` · S. `src/lib/email/` `sendEmail()` wrapper,
  env-driven, no-op when keys absent; extract inline invite HTML to shared
  templates. Blocks WS1, WS2.
- **WS1 — Request-to-become-a-creator** `[NEW]` · M. `creator_requests` table
  (RLS service-only + GRANTs); public `/request` form (no auth);
  `submit_creator_request` RPC (rate-limited); repoint nav guest path
  ([bottom-nav.tsx:35-36](../../src/components/bottom-nav.tsx#L35-L36)) to
  `/request`; admin `/admin/requests` queue + "Approve & invite" + "Decline".
- **WS2 — Lifecycle emails** `[NEW]` · S. Wire `sendEmail()` into apply ACK,
  approval, rejection (with stored reason), and "you're live" on publish.
  Applicant email fetched from `auth.users` in the action (not the RPC).
- **WS3 — Knowledge inputs + creator ingest** `[PARTIAL]` · M. Constrain
  [brain-ui.tsx](../../src/app/creator/brain/brain-ui.tsx) to youtube + paste/.txt
  (.txt read client-side); add creator "Start ingest" button = ownership-scoped
  wrapper over [corpus-reprocess](../../src/app/api/admin/corpus-reprocess/route.ts).
- **WS4 — Creator voice → Cartesia** `[NEW]` · M/L. Recorder + upload on
  `/creator/voice`; `/api/creator/voice-clone` over admin logic
  ([voice-clone](../../src/app/api/admin/voice-clone/route.ts)); writes
  `voice_clone_uploads` + `creators.voice_id`; requires active `voice_clone` consent.
- **WS5 — Creator face → Simli** `[NEW]` · M. Image upload cell;
  `/api/creator/face-upload` over admin logic
  ([face-upload](../../src/app/api/admin/face-upload/route.ts)); requires active
  `likeness` consent.
- **WS6 — Creator video → Mux** `[NEW]` · L. Dashboard content section, long-form
  + ≤5 hooks, creator-set title/caption/topic-tags; `/api/creator/mux-upload`
  signed-upload wrapper ([mux-upload](../../src/app/api/admin/mux-upload/route.ts));
  existing Mux webhook handles asset-ready; **no auto-publish** — admin PublishPanel
  stays the gate.
- **WS7 — Share everywhere** `[NEW]` · M. Pulsating right-rail Share button on
  feed/hooks, `/v/` long-form, `/@handle`; `navigator.share` + copy fallback;
  dynamic `opengraph-image` routes for `/v/[id]` and `/@handle`.

---

## 5. HOSTILE AUDIT (adversarial — "a competitor wants to publicly shame us")

Findings are code-grounded. Severity, scenario, location, fix. **Verification
notes added in `▶` lines where the plan owner re-checked the claim against code.**

### CRITICAL

**C1 — WS4 rejects ~100% of real browser recordings (WAV-only vs MediaRecorder).**
The voice-clone route hard-rejects anything not PCM WAV
([voice-clone/route.ts:151](../../src/app/api/admin/voice-clone/route.ts#L151),
`only PCM WAV is accepted in v1`). `MediaRecorder` cannot emit WAV on any shipping
browser — Chrome/Android → `audio/webm;codecs=opus`, iOS Safari → `audio/mp4`
(AAC). Every guided recording → `415`. File-upload fallback only helps the ~0% with
a `.wav` handy.
*Fix:* decide the transcode boundary before UI — (a) client-side WebAudio
`decodeAudioData` → re-encode to 16-bit PCM WAV in a worker, or (b) accept
webm/opus + mp4/aac server-side with a duration probe (route comment at
[lines 13-16](../../src/app/api/admin/voice-clone/route.ts#L13-L16) notes the probe
gap). Verify Cartesia's accepted formats against the real `/voices/clone` endpoint
(`RUN_REAL_API_TESTS`) before building.
**▶ VERIFIED REAL.** Line 151 confirmed.
**▶ RESOLVED (2026-06-04, see §8.C1):** Cartesia **accepts `.webm`** (verified — docs),
and instant-clone needs only ~3–10s so our ~60s recording is ample. So
MediaRecorder `webm/opus` → Cartesia directly; the fix is to **relax the route's
WAV-only gate to accept webm + add a webm duration probe** (or client-reported duration
cross-checked server-side), NOT a client-side WAV transcode. Risk downgraded from
"riskiest single item" to a contained route change.

**C2 — Resend with keys-present-but-domain-unverified silently breaks the funnel.**
The locked decision covers keys-absent (no-op). The real prod failure is keys
*present* + domain *unverified*: Resend only lets you send from
`onboarding@resend.dev` until a domain is verified, and that sandbox sender can
**only deliver to the Resend account owner's address.** Every applicant/invite
email succeeds for you (owner) and silently fails for creator #2. Invite-mint
already swallows the error
([invites/actions.ts:59-61](../../src/app/admin/invites/actions.ts#L59-L61), `catch {}`).
*Fix:* `sendEmail()` must be 3-state — (1) keys absent → `skipped`, surface
"email disabled, copy link" in admin UI; (2) keys present + send fails → log to
Sentry, return `failed`, show a red "not delivered" badge; (3) success. Boot-time
warn if `RESEND_FROM_EMAIL` is `*.resend.dev`. Admin "Approve & invite" always
shows the copy-fallback URL.

**C3 — Unauthenticated `/request` form = email-bomb / enumeration / token-mint abuse.**
Public no-auth form + "approve auto-fires invite" + nav guest button pointing at it.
(1) Spam/DB-fill: plan's "rate-limit per IP/email" via single-key `rate_limit_hit`
is bypassed by IP rotation / `user+N@`. Waitlist has Turnstile
([waitlist-actions.ts](../../src/app/waitlist/waitlist-actions.ts)); `/request` has
none planned. (2) Email-bomb: attacker submits N requests spoofing
`victim@gmail.com`; bulk-approve fires N invites — each minting a **valid creator
invite token** addressed to the victim. (3) Stored XSS: anonymous `socials`/`pitch`/
`audience` free-text rendered in admin queue + possibly outbound email.
*Fix:* Turnstile on `/request` (reuse `verifyTurnstile`); rate-limit on BOTH IP and
normalized email + a global hourly ceiling; **never treat the request's `email` as
proof** — dedupe against already-invited, no bulk one-click approve in v1; lock
`socials` to an http(s)-validated fixed-key object (mirror `ProofSchema`), cap
lengths, strip control chars; `creator_requests` = RLS enabled, **zero** policies,
`GRANT ALL ... TO service_role` only, public insert via SECURITY DEFINER RPC.

**C4 — `/api/creator/*` wrappers inherit admin-shaped rate limits + prod-only gates.**
The admin routes' rails are keyed to admins:
(1) COGS: `voice-clone`/`face-upload` rate-limit on `admin_user_id` (3 success / 20
attempts per 24h); `mux-upload` limits **20 mints/minute/admin**
([mux-upload/route.ts:86-91](../../src/app/api/admin/mux-upload/route.ts#L86-L91)).
Each completed Mux upload is billable; no global ceiling across creators; CLAUDE.md's
mandated 150%-quota kill-switch is consulted by none of these media routes.
(2) Prod-only gate: voice-clone returns `503 voice_clone_only_in_production`
([lines 96-104](../../src/app/api/admin/voice-clone/route.ts#L96-L104)); face-upload
requires `VERCEL_ENV='production'`. A creator on a preview/non-prod path gets an
admin-oriented 503.
*Fix:* don't call the admin routes — extract the shared core (probe → provider call
→ finalize RPC) to a lib; build creator routes with creator-shaped guards: ownership
via `getCreatorForCaller()` re-verified inside the finalize RPC, per-creator **and
global** daily caps backed by `cogs_log` with the 150% kill-switch, user-facing error
copy, deliberate env-gate decision. Audit tables' `admin_user_id` must carry honest
actor identity (`actor_user_id` + `actor_role`) or COGS-by-admin reports are poisoned.

**C5 — IDOR: client-supplied `creatorId`/`id` lets creator A mutate creator B.**
Admin media routes trust a client target id and authorize via the admin gate, not
ownership: voice-clone reads `creatorId` from the form
([route.ts:122](../../src/app/api/admin/voice-clone/route.ts#L122)); face-upload
same; mux-upload takes `{target,id}` from JSON and selects by `id` with no creator
scoping. A creator wrapper that forwards the client id → creator A clones a voice /
trains a face / mints a Mux upload onto creator B's row. Voice/face = likeness-fraud
T&S disaster. Correct pattern already exists in
[creator/voice/actions.ts:53-58](../../src/app/creator/voice/actions.ts#L53-L58)
(`getCreatorForCaller()` + `.eq('id',creatorId).eq('user_id',userId)`).
*Fix:* creator routes **derive** `creatorId` from `getCreatorForCaller()` and ignore
client-supplied creator ids (mismatch → 403). For mux-upload `{target,id}`, re-check
the row belongs to the caller's creator inside the same query/RPC under a lock.
**▶ VERIFIED REAL.** Line 122 confirmed reading from form body.

**C6 — Deepfake-of-a-real-person is the actual launch-killer (promoted from M2 by 2nd external audit).**
For an avatar company, the headline a competitor wants is: *"I uploaded Sam Altman's
voice and OakLeague made a public, shareable talking clone of him."* The consent gate
is verifiably theater against this:
[voice-clone/route.ts:233-242](../../src/app/api/admin/voice-clone/route.ts#L233-L242)
checks a `voice_clone` consent row exists **for the applicant's own user_id** — it
proves someone clicked a box, not that the uploaded clip depicts a consenting person.
Self-service uploads + a shareable OG card (WS7) turn this from a private admin mistake
into an indexed, screenshot-able public artifact. The original audit rated
publish-gating Medium (M4) and depicted-person "v2" (M2) — for this threat model that's
inverted.
*Fix (gating for WS4/WS5/WS7):* (a) admin MUST review the rendered media + likeness
before `published_at` is set, and every share/OG surface MUST be provably gated on
`published_at`; (b) treat depicted-person as an **unsolved hole** and do not ship
self-service voice/face to anonymous-origin creators without a manual identity step
(the invite-only request→approve flow is the partial mitigation — the approving admin
is the identity check, so the request reviewer MUST verify the person is who they claim
before inviting).
**▶ VERIFIED.** Consent gate at :233-242 confirmed checks row-existence for own
user_id, not depiction. Profile/`/v/` pages already publish-gate
([[handle]/page.tsx:85,108](../../src/app/[handle]/page.tsx#L108)) — but WS7's NEW OG
routes do not exist yet and must inherit the same gate.

### MEDIUM

**M1 — `.txt` ingest has no size limit → memory/COGS bomb.** `addSampleContent`
caps `raw_text` at 262144 chars
([brain/actions.ts:77](../../src/app/creator/brain/actions.ts#L77)) but there's no
pre-read byte cap and no text-MIME check; a renamed binary → mojibake → junk
embeddings spend. *Fix:* client byte cap before `readAsText`, reject non-`text/plain`,
live char-count vs limit, decide chunk-vs-reject for oversize (never silent truncate).

**M2 — No virus/content moderation on uploaded media.** Self-service audio/image/video
with zero moderation. Risks: impersonation (consent gate proves *consent recorded for
this user*, not *media depicts that user* — see
[voice-clone/route.ts:233-242](../../src/app/api/admin/voice-clone/route.ts#L233-L242)),
NSFW/illegal media to Simli/Mux later rendered in share cards, malware in upload
fallback. *Fix:* admin review queue must show the actual media before `published_at`;
document that creator media is never public pre-publish; flag likeness-of-depicted-
person as an unsolved v2 (brand/sponsored) hole.

**M3 — WS7 OG-image routes = unauthenticated SSRF/DoS surface.** Dynamic
`opengraph-image` for `/v/[id]` and `/@handle`: (a) if it fetches creator-supplied
URLs to composite, SSRF; (b) `ImageResponse` is CPU-heavy → cheap DoS / Vercel cost
amplifier. *Fix:* fetch images only from an allowlist of own Mux/Supabase hosts; set
`revalidate`/cache headers; static fallback for unknown/unpublished ids.

**M4 — Share/OG leaks unpublished creators/videos (enumeration).** If `/v/`, `/@`, or
their OG routes render for `published_at IS NULL`, guessing ids leaks draft
titles/thumbnails/existence. *Fix:* OG + public pages apply the same publish gate the
feed uses; unknown/unpublished → generic fallback.

**M5 — Consent re-check timing.** *Original concern: apply checkbox might not write the
`voice_clone`/`likeness` rows the media routes query → funnel dead-ends.*
**▶ CORRECTED — partially wrong.** [consent.ts:23-37](../../src/lib/consent.ts#L23-L37)
**does** emit typed `voice_clone` AND `likeness` rows at apply; the gate checks
existence (non-revoked). Funnel will NOT dead-end. Residual valid points: (a) version
bumps are not re-checked (already a known P1, see consent.ts comment + deferred-audit
backlog); (b) consent proves *recorded*, not *depicted-person* — folds into **M2**.

**M6 — Repointing nav to `/request` orphans the working `/waitlist`.** `/waitlist`
already has Turnstile + rate-limiting + `cap_hit` source and "carries the creator CTA"
per [bottom-nav.tsx:33-34](../../src/components/bottom-nav.tsx#L33-L34). Two overlapping
lead funnels, one hardened, one new. *Fix:* decide explicitly — `/request` replaces the
creator CTA on `/waitlist` (then update that CTA to deep-link `/request`, keep
`/waitlist` for consumer cap-hit) — don't leave two half-wired funnels; update the nav
comment.

**M7 — Admin actions throw raw on non-admin (500, not clean 403).**
[admin/content/actions.ts:77](../../src/app/admin/content/actions.ts#L77) calls
`assertAdminFromSession()` with no try/catch → uncaught throw. Newer actions handle it
([creators/[id]/actions.ts](../../src/app/admin/creators/[id]/actions.ts),
[applications/actions.ts:13](../../src/app/admin/applications/actions.ts#L13)). The
"you're live" publish-email hook (WS2) sits near these — don't copy the throwing
pattern. *Fix:* wrap every admin server action; standardize on `requireAdmin()`.

**M8 — No `revalidatePath` discipline specified for creator upload flows.** WS4-6 change
visible state (voice/face/video) but async (face poll, Mux webhook) means the dashboard
shows stale status. Brain actions get this right
([brain/actions.ts:103-106](../../src/app/creator/brain/actions.ts#L103-L106)). *Fix:*
`revalidatePath('/creator/...')` after each mutation; poll/optimistic UI for async;
readiness surface reflects in-flight uploads.

### SMALL

- `mintCreatorInvite` caps `expires_in_days` at 7; WS1 auto-approve must pass an
  explicit expiry, not a guessable/long default.
- [voice-clone/route.ts:56](../../src/app/api/admin/voice-clone/route.ts#L56) subject
  uses `&apos;` (HTML entity) in a plain-text subject → renders literally. Use a real
  apostrophe.
- [corpus-reprocess/route.ts:31](../../src/app/api/admin/corpus-reprocess/route.ts#L31)
  uses a loose UUID regex; the creator-scoped wrapper (WS3) should use the strict
  version-pinned regex like voice-clone/face-upload.
- [mux-upload/route.ts:130](../../src/app/api/admin/mux-upload/route.ts#L130) falls back
  to `http://localhost:3000` for `corsOrigin` if `NEXT_PUBLIC_SITE_URL` unset → opaque
  CORS break in prod. Fail loud if unset in prod.
- WS2 fetch applicant email via `admin.getUserById`/`getUserByEmail`, never
  `listUsers()` (CLAUDE.md ban; silent miss past ~1000 users).
- `creator_requests.status` needs a DB CHECK constraint, not just a TS enum.
- WS7 `navigator.share` is unavailable on desktop Chrome/Firefox + needs user-gesture +
  HTTPS; copy fallback is the default-visible desktop path, not an error state.
- `submit_creator_request` RPC must end with the secdef REVOKE-from-
  public/anon/authenticated + GRANT-to-service_role footer (2026-06-01 cross-tenant
  exfil incident was a missing footer on a public secdef RPC).

### Provider-reality sources (verified during audit)
- Cartesia: voice cloning API + pro clone playground (no published format allowlist →
  must test chosen container against the real endpoint).
- Resend: domain verification required; pre-verification sender `onboarding@resend.dev`
  can only deliver to the account owner.
- MDN `MediaRecorder.mimeType` + iOS Safari emits `audio/mp4` (no WAV path).

---

## 5b. SECOND EXTERNAL AUDIT — additions (verified 2026-06-04)

A second independent hostile pass. Below are findings NOT in §5, each with the plan
owner's `▶` verification verdict. (H1 was promoted into §5 as **C6**.)

### Hostile / public-shaming
- **H2 — Cold sending domain lands invites/approvals in spam ("you ghosted me" tweets).**
  C2 covers the `resend.dev` sandbox; it misses that a freshly-verified domain with no
  SPF/DKIM/DMARC warmup silently spam-foldered. Same public shape as a broken funnel.
  *Fix (WS0):* require DMARC before flipping email live; make the copy-link fallback
  **load-bearing** (not advisory) in the admin "Approve & invite" UI; add an
  admin-visible "resend invite" action + per-row delivery-status badge.
  **▶ VALID.** Product/deliverability concern; no code contradicts it.
- **H3 — Outbound email template injection from anonymous free-text.** C3 pinned stored
  XSS to the admin queue — but React auto-escapes there, so it's mostly inert. The live
  vector is WS2 emails: rejection emails carry a stored reason; request notifications
  would carry anon pitch/socials/audience. **HTML emails are string interpolation, not
  JSX — they do NOT auto-escape** (see
  [invites/actions.ts:67-77](../../src/app/admin/invites/actions.ts#L67-L77),
  `renderInviteEmail` interpolates `${url}` raw). Anon text → admin's inbox / forwarded
  screenshots.
  *Fix:* HTML-escape ALL user/anon text at the email-template boundary; lock `socials`
  to an http(s)-validated fixed-key object (extend C3 to the email path).
  **▶ VALID + verified.** Invite email is raw string interpolation; the existing audit
  under-weighted the email path vs the auto-escaping queue.

### UX
- **U1 — No "request submitted" state → the funnel visibly loops.** creator-status is a
  5-state machine ([creator-status/route.ts:47](../../src/app/api/me/creator-status/route.ts#L47))
  with no `requested`. A logged-in user who submits `/request` stays `not_invited` → the
  nav middle button keeps saying "Become a Creator," pointing back into the funnel they
  just finished. *Fix (WS1):* add a 6th `requested` state to creator-status + nav copy.
  **▶ VERIFIED REAL — with a caveat:** the `/request` form is **public/no-auth** (C3),
  so anonymous requesters have no user_id to key state on and stay `guest`. The 6th
  state only helps logged-in requesters; for anonymous ones, the form's own
  success/confirmation screen must carry the "we'll be in touch" closure.
- **U2 — Live funnel leak TODAY: creator-intent users land on the consumer waitlist.**
  The nav guest button currently → `/waitlist`
  ([bottom-nav.tsx:35-36](../../src/components/bottom-nav.tsx#L35-L36)), a consumer
  cap-hit list — so a would-be creator joins a consumer list and is never routed to a
  creator path. §2's diagram assumes the nav already points at `/request`; it does not.
  M6 rated this Medium — it's a **production funnel leak** and the single most important
  WS1 decision: does `/request` replace the waitlist creator CTA, and what happens to
  people already in `waitlist`?
  **▶ VERIFIED REAL.** Promote M6 to a WS1 gating decision.
- **U3 — Approval fires a 7-day token with no resend path → limbo.** Approval email →
  spam (H2) → token silently expires in 7 days → `creator_requests`/application row is
  consumed but the creator has no usable invite and no self-serve "resend"; admin must
  mint a fresh invite manually. *Fix (WS1/WS2):* explicit admin "resend invite" action
  (re-mint + re-send) surfaced in the queue.
  **▶ VALID.** Operational dead-end; pairs with H2.
- **U4 — Creator-facing errors are admin-shaped debug strings.** Beyond C4's generic
  prod-only 503: a creator overwriting their voice mid-session gets
  `creator_has_active_sessions`
  ([voice-clone/route.ts:374-383](../../src/app/api/admin/voice-clone/route.ts#L374-L383));
  any preview deploy gets `voice_clone_only_in_production`. These are debug codes, not
  user copy. *Fix:* creator routes map every error to user-facing copy (extends C4).
  **▶ VALID.**

### Security / build-reality
- **S1 — Voice clone is hard prod-only → creator #2 is your first live-fire test.**
  Because [voice-clone/route.ts:97-104](../../src/app/api/admin/voice-clone/route.ts#L97-L104)
  503s on any non-prod env, the creator voice flow CANNOT be exercised on a preview
  deploy. Combined with C1 (WAV) + real Cartesia spend, there is **zero end-to-end
  staging path** — creator #2 debugs the funnel in production with billable calls.
  *Fix:* this is a **named hard blocker**, not a C4 sub-bullet — an env-aware finalize
  RPC (write to the env-correct voice_id column) must ship before self-service voice.
  **▶ VERIFIED REAL.** Promote to a blocker for WS4.
- **S2 — The "global ceiling / kill-switch" assumes a primitive that's only half there.**
  *Auditor claim:* `rate_limit_hit` window is hardcoded '1 minute', so hourly + global
  are net-new. **▶ PARTIALLY WRONG:**
  [20260420000032:25-41](../../supabase/migrations/20260420000032_waitlist_ip_and_ratelimit.sql#L25-L41)
  takes `p_window interval` as a **parameter** with arbitrary-interval support — an
  hourly window is **config**, just pass `'1 hour'`. **▶ WHAT LANDS:** it is request-
  *count*, not *spend*. The CLAUDE.md-mandated **COGS 150% kill-switch is genuinely
  net-new** (must read `cogs_log` quota, not request counts), and a global un-keyed
  ceiling is a new key-usage pattern (pass a fixed key like `'global'`). Treat the
  kill-switch as build-work with its own audit; don't assume turn-key.
- **S3 — Ingest (WS3) has NO COGS kill-switch — C4 wrongly exempts it.** corpus-reprocess
  just enqueues an embedding job per ready sample; the route has no spend ceiling
  anywhere ([corpus-reprocess/route.ts](../../src/app/api/admin/corpus-reprocess/route.ts)
  — enqueue only). M1 caps `.txt` size, not spend or queue burst. Self-service
  "Start ingest" + paste-bomb + retry = embedding COGS with no kill-switch, plus a single
  Fly worker draining one queue for N creators (latency cliff). Embeddings are a paid call
  → CLAUDE.md mandates the 150% kill-switch. *Fix:* WS3 gets the kill-switch too;
  WS3 is **not** the "lowest-risk" free start it looked like.
  **▶ VERIFIED REAL.**
- **S4 — WS3 may wrap the WRONG operation entirely (architecture catch).**
  corpus-reprocess **explicitly bypasses the on-`sample_content` trigger gate** and
  defaults `target_version: 2`
  ([corpus-reprocess/route.ts:1-5,123-136](../../src/app/api/admin/corpus-reprocess/route.ts#L1-L5)).
  A brand-new creator's FIRST ingest is a different code path (the trigger). Wrapping
  corpus-reprocess for "Start ingest" may enqueue chunks at v2/v3 while the creator's
  `retrieval_version` is 1 → ingest "succeeds" but the brain reads nothing.
  *Fix (verify-first):* determine which operation actually first-ingests a new sample,
  and ensure the creator-facing trigger targets the creator's CURRENT `retrieval_version`,
  before building the wrapper.
  **▶ VERIFIED REAL.** Route header confirms trigger-bypass + default v2. **This is the
  reason WS3 is no longer the recommended safe start.**
- **S5 — mux IDOR fix (C5) is harder than voice/face.** mux's `{target,id}` targets a row
  in `hooks`/`welcome_hooks`/`videos`, not a creator id
  ([mux-upload/route.ts:103-113](../../src/app/api/admin/mux-upload/route.ts#L103-L113)) —
  so the fix must re-verify that specific row belongs to the caller's creator, inside the
  same locked query, for THREE tables. Plus: is `welcome_hook` a creator-exposed target at
  all? (product question). *Fix:* per-table ownership join under lock; decide whether
  creators may set their own welcome hook.
  **▶ VERIFIED REAL.** mux-upload selects by `id` alone, no creator join, no user_id even
  fetched — the worst IDOR of the three.

---

## 6. REVISED go/no-go + required fixes before build

| WS | Verdict | Must-fix before building |
|----|---------|--------------------------|
| WS0 Email | **NO-GO as scoped** | C2 — `sendEmail()` 3-state (skipped/failed/success), surface failure, no `catch{}` on funnel sends, boot-warn on `resend.dev` sender. **H2** — DMARC-before-live + load-bearing copy-link fallback + delivery-status badge. **H3** — HTML-escape all user/anon text at the email-template boundary. |
| WS1 Request | **NO-GO** | C3 — Turnstile, dual-key + global rate limit, no bulk approve, hardened JSONB, service-only RLS + grants, secdef footer, status CHECK constraint. **U2** (gating decision) — `/request` vs `/waitlist` double-funnel + migrate existing waitlist creators. **U1** — add 6th `requested` nav state (+ anon confirmation screen). **U3** — admin "resend invite" action. **C6** — request reviewer is the identity check; verify person before inviting. |
| WS2 Emails | **CONDITIONAL** | Blocked by C2/H2/H3; fix M7 throwing pattern; use `getUserById` not `listUsers`; rejection-reason + any anon text HTML-escaped. |
| WS3 Knowledge | **NO-GO (downgraded from "lowest risk")** | **S4** (verify-first, blocking) — confirm which op first-ingests a NEW sample; corpus-reprocess bypasses the trigger + defaults v2 → may produce chunks the brain never reads. **S3** — ingest needs the COGS 150% kill-switch (currently unguarded). M1 `.txt` byte cap + MIME; strict UUID + secdef footer. |
| WS4 Voice | **NO-GO (highest risk)** | **C1** transcode boundary (verify Cartesia formats first). **C5** derived id. **C4** creator-shaped limits + kill-switch + honest actor id. **S1** (hard blocker) — env-aware finalize RPC so it's testable pre-prod. **C6** — admin likeness review before publish; depicted-person hole acknowledged. **U4** — user-facing error copy. |
| WS5 Face | **NO-GO** | C5, C4, **S1** (same env-gate blocker applies to face), **C6** likeness-of-depicted-person review checkpoint (publish-gated), U4 copy. |
| WS6 Video | **NO-GO** | **C5/S5** per-table `{target,id}` ownership re-check across hooks/welcome_hooks/videos under lock (+ welcome_hook product decision). C4 global Mux ceiling + kill-switch. C6/M2 moderation before publish (admin gate preserved — good). |
| WS7 Share | **NO-GO** | M3 self-host image allowlist + edge cache. M4/**C6** publish-gate parity on NEW OG routes + fallback (don't leak/clone unpublished). Desktop copy-fallback default (navigator.share absent on desktop). |

### Net-new primitives the plan must NOT assume are turn-key
- **COGS 150% kill-switch** (C4/S3) — reads `cogs_log` quota, not request counts. Net-new
  across voice/face/mux/**ingest**. Needs its own audit.
- **Global (un-keyed) ceiling** (C3/C4) — a new key-usage of `rate_limit_hit` (`'global'`).
  Hourly window is already supported (`p_window` param — corrects 2nd-audit S2).
- **Env-aware voice/face finalize RPC** (S1) — hard blocker for self-service voice/face;
  without it there is no pre-prod test path.

**Bottom line:** existing admin primitives are well-built. The plan's trap is
"wrap the admin route + add an ownership check" — that inherits admin-shaped guards
(production-only, per-admin rate limits, no kill-switch, trust-the-client-id) wrong for
public/self-service callers. **Extract shared cores; build creator routes with
creator-shaped guards** (derived ids, per-creator + global COGS kill-switches,
user-facing errors).

Two audits agree on the headline. Three additions reorder the work:
1. **C6 (depicted-person/deepfake) is the real public-shaming surface** — publish-gating
   + manual likeness review is GATING for WS4/WS5/WS7, and the invite-only request
   reviewer is the load-bearing identity check.
2. **WS3 is no longer the safe start** — S4 (wrong-operation risk) + S3 (unguarded COGS)
   must be settled first.
3. **S1 (env-aware finalize) decides whether self-service voice/face is buildable+testable
   at all** — settle before WS4/WS5.

**Recommended sequencing:** short verify-first spike on **C6 policy + S1 + S4** (these
decide scope/viability) → fix-designs for the two known landmines (C1 transcode, C2/H2/H3
email) → then build, starting with WS0/WS1/WS2 (the request→invite→email spine) rather
than WS3.

---

## 7. Verify-first (open research before the relevant WS)

**Scope-deciding spikes (do these FIRST — they determine viability/sequencing):**
- 🔎 **C6 — depicted-person policy.** Decide: do we ship self-service voice/face at all
  pre-launch, or require a manual identity step at request-review? Confirm every share/OG
  surface gates on `published_at`. Gates WS4/WS5/WS7.
- 🔎 **S1 — env-aware finalize.** Can voice/face clone be exercised on a preview deploy?
  Today: no (hard prod-only 503). Decide the env-aware finalize RPC before WS4/WS5, or
  accept launching blind with billable prod-only tests.
- 🔎 **S4 — first-ingest path.** Which operation actually first-ingests a NEW creator's
  sample — the on-`sample_content` trigger, or corpus-reprocess? Does it target the
  creator's CURRENT `retrieval_version`? Settle before WS3.

**Provider research (before the relevant WS):**
- 🔎 Cartesia Sonic 3 clone input: accepted container/format, sample-rate, min/target
  length, instant-vs-pro — test against real endpoint (WS4, blocks C1 transcode decision).
- 🔎 Simli Trinity-1 face input: image vs short video, resolution, framing (WS5).
- 🔎 Mux direct-upload security + per-upload cost model for the global ceiling (WS6).
- 🔎 Resend: DMARC/SPF/DKIM warmup requirements before flipping email live (WS0, H2).

---

## 8. RESOLUTIONS (decisions taken 2026-06-04)

These supersede the open questions in §5b/§6/§7 for C6, C1, S1, S4.

### C1 — Voice format: accept webm, don't transcode
Cartesia accepts `.webm` and instant-clone needs only ~3–10s (verified — Cartesia docs;
our ~60s recording is ample and lands in the 60s+ quality sweet spot). **Decision:** feed
MediaRecorder `webm/opus` straight to Cartesia. Build work = relax
[voice-clone/route.ts:151](../../src/app/api/admin/voice-clone/route.ts#L151) WAV-only
gate to accept webm + add a webm duration probe (or client-reported duration validated
server-side). No client-side WAV encoder needed. iOS Safari emits `audio/mp4` (AAC) —
confirm Cartesia accepts m4a too, else transcode only that one container.

### C6 — Identity: live random-script recording, matched against public content
**Decision — the verification recording IS the clone source (one recording, both jobs):**
- **In-browser recording ONLY.** No file upload, no "upload a better one after" — that's
  confusing UX and re-opens the impersonation hole. One guided recorder.
- **Server-generated random script, 4 sentences (~60s total — do NOT go over)**, shown on
  screen, containing randomized tokens (name + date + a numeric code). A
  pre-recorded/held-up-to-the-mic clip of someone else cannot contain today's random code
  → defeats replay + mic-next-to-speaker. ~60s is ample: well above Fish's ~15s and
  Cartesia instant-clone's ~3–10s minimums, with headroom — no quality reason to record
  longer.
- **"Generate new script" button** — re-rolls a NEW *server-side* random script (UX: let
  them retry if they fumble). **Hard rule: the script is ALWAYS server-generated; the user
  can never type/choose their own text** (a chosen script = attacker matches it to
  pre-recorded audio).
- **4 core emotions** (Happy / Sad / Angry / Neutral) shown on the side — ideally one per
  sentence — prompting them to vary delivery → richer vocal range for the clone (Sonic
  preserves emotion/cadence). Delivery hints, not separate recordings. 4 sentences × 4
  emotions in ~60s is more than enough sample.
- **Identity check = admin A/Bs the recording against the creator's OWN public content**
  (the YouTube/podcast/socials they submitted on the application). That public channel is
  the ground-truth reference. The random script proves the live recorder is the account
  holder; the public-content match proves the account holder is who they claim. The
  invite-only request→approve reviewer is the human in this loop.
- **Residual hole (accepted for v1):** a real-time voice-deepfake reading the script could
  still pass. Mitigated by the public-content A/B + invite gate. Heavier ID/face-video KYC
  is v2.
- **Gating:** no creator goes live until admin has reviewed the rendered media + likeness
  and set `published_at`; every share/OG surface must gate on `published_at`.
🔎 Verify-first: confirm Cartesia clone quality from a ~60s *phone-mic* recording
(4 sentences, emotion-varied) is acceptable.

### S1 — Build the env-aware finalize RPC (testable pre-prod)
**Decision: build it.** The env-scoped columns already exist
([env-scoped-voice-id.ts](../../src/lib/voice/env-scoped-voice-id.ts),
[20260507000002_creators_voice_id_env_scoped.sql](../../supabase/migrations/20260507000002_creators_voice_id_env_scoped.sql)
— `voice_id` / `voice_id_preview` / `voice_id_dev`). The route 503s on non-prod only
because finalize doesn't yet write to the env-correct column. Write an env-aware finalize
RPC that writes the column matching the deploy env, then drop the prod-only 503. Result:
voice/face clone is exercisable on preview deploys → no more "creator #2 is the first
live-fire test." Small, schema is done. Same pattern applies to the face finalize (WS5).

### S4 — v3 is the default for new creators; ingest is button-gated
**Decision: new creators default to `retrieval_version = 3`.** The on-`sample_content`
trigger ALREADY routes v3 creators to v3 ingest
([20260528000051_enqueue_routes_v3.sql](../../supabase/migrations/20260528000051_enqueue_routes_v3.sql):
"v3 creators → corpus_reprocess_jobs target_version=3"), and v3 ingest is validated
(12/12 needles, 0 drops). Today new creators default to `retrieval_version = 1`
([20260514000001:23](../../supabase/migrations/20260514000001_creators_retrieval_version.sql#L23)).
Change = set `retrieval_version = 3` for new creators (flip column default OR set it in
`approve_creator_application`). Then adding a sample auto-routes to the v3 format the brain
reads — the S4 "ingest into a drawer the brain can't see" bug disappears.
- **Ingest trigger is automatic on sample-add** via the trigger — so a creator "Start
  ingest" button is technically redundant. **Decision: keep an explicit button anyway**
  for COGS control (creator chooses when to spend), and pair it with the S3 150%
  kill-switch. (Implementation note: either gate the trigger behind a "ready to ingest"
  flag, or have the button be the enqueue and suppress auto-enqueue on raw_text edits.)
- **Caveat:** new creators are now on the newest retrieval path from day one. Acceptable —
  v3 ingest is validated and v3 retrieval is already live on prod (see project memory:
  v3 prod cutover).
🔎 Verify-first: confirm v3 retrieval is solid end-to-end for a brand-new single-creator
corpus (not just the migrated existing creators).

### Voice forward-compat — buffer room for a provider swap (WS4)
**Decision:** build the voice flow so swapping TTS/clone providers later needs ZERO creator
re-records.
- **Persist the source recording** in Supabase Storage (consent-gated), keyed to the
  creator — NOT just metadata. Today
  [voice_clone_uploads](../../supabase/migrations/20260427000003_voice_clone_uploads.sql)
  keeps only sha256/duration/mime/bytes + `cartesia_voice_id`; the audio is discarded.
  Storing the raw ~60s recording means a future swap = re-run clone on stored audio, zero
  friction.
- **Provider-tagged voice_id from day one** — generalize to `(provider, external_voice_id)`
  so Cartesia / Fish / self-host coexist (partway there already: per-creator `tts_provider`
  + `hume_voice_id` columns + env-scoped `voice_id` columns exist).
- **Recording length** = ~60s, fixed (see §8.C6) — above every candidate's minimum with
  headroom; no need for more.

### Fish Audio — active TTS-swap candidate (parallel spike, OFF the critical path)
Verified 2026-06-04: real **clone API** (10–15s sample, no fine-tune — clears the bar Hume
failed), ~200ms streaming first-audio, **$15 / million UTF-8 _bytes_** (per-byte, not
per-char), **Apache-2.0 open weights, self-hostable** on a consumer GPU (self-host
break-even ~50M chars/mo). ~35% of Cartesia cost per Vuk. Stronger candidate than Hume
(which had no human-clone API). Swap is the designed path — TTS bridge already
provider-agnostic ([cartesia-bridge.js](../../server/voice-proxy/cartesia-bridge.js) +
[hume-bridge.js](../../server/voice-proxy/hume-bridge.js), `VOICE_TTS_PROVIDER`); adding
`fish-bridge.js` is the same move.

**Gates before flipping the prod default (NOT before spiking):**
- **Real A/B on actual creator voices**, not demo samples.
- **Consent + privacy-policy reconciliation (do this BEFORE sending any real creator audio
  to Fish).** Creators authorized "OakLeague to clone my voice"; adding Fish as a NEW
  subprocessor — OR self-hosting (cleaner: the audio never leaves us) — must be reconciled
  with the consent text + privacy policy / subprocessor disclosure. Self-host is the
  consent-simplest path.
- **COGS unit mismatch** — Fish bills per UTF-8 byte vs Cartesia per char → needs
  `FISH_USD_PER_BYTE` + `QUOTED_AT` + a byte-based `cogs_log` leg.
- **Streaming error taxonomy** mapped to our const-union close codes (CLAUDE.md rule 3).
- **License/ToS** permits commercial voice cloning.

**Process:** spike in a worktree behind `VOICE_TTS_PROVIDER=fish`; build `fish-bridge.js` +
clone integration; gate the default flip on the A/B. The buffer room above makes the
eventual swap frictionless. Sources: [fish-speech repo](https://github.com/fishaudio/fish-speech),
[voice clone](https://fish.audio/voice-clone/),
[pricing](https://fish.audio/blog/cheapest-text-to-speech-api-developers/),
[self-host](https://www.spheron.network/blog/deploy-open-source-tts-gpu-cloud-2026/).
