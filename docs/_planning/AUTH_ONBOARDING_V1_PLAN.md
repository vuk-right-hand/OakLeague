# AUTH_ONBOARDING_V1_PLAN

Creator-onboarding trust chain + user auth/onboarding + admin console v1.
Scope covers everything between "empty repo with schema live in Supabase" and
"first real creator approved, first real user onboarded."

Companion to [SCHEMA_V1_PLAN.md](./SCHEMA_V1_PLAN.md). Schema is live (21
migrations deployed). This plan adds the security migrations the schema plan
deferred, the Next.js surface, and the admin console.

Plan has been through 3 audit rounds. All Critical findings closed in this
document. Remaining opens are explicit at the bottom.

---

## 0. Foundation already in place

- [src/lib/auth-guards.ts](../../src/lib/auth-guards.ts) — `getCallerUserId`, `assertAdminFromSession`, `assertCreatorFromSession`
- [src/lib/invite-tokens.ts](../../src/lib/invite-tokens.ts) — HMAC mint + rotation candidate hashes
- [src/lib/supabase/](../../src/lib/supabase/) — `client.ts`, `server.ts`, `admin.ts`
- [src/app/layout.tsx](../../src/app/layout.tsx) — PWA metadata, viewport, theme color
- [proxy.ts](../../proxy.ts) — stub (needs function rename + body)
- 21 migrations covering profiles (goals/obstacles/timezone/tier/handle), admin_roles, auth_pending_verifications, creator_invitations, creator_applications, creators, creator_topics, sample_content, videos, hooks, sessions, session_turns, daily_quotas, cogs_log

Foundation is correct. Everything below builds on it.

---

## 1. Locked decisions (from audit rounds 1-3)

| Decision | Choice | Why |
|---|---|---|
| Passwordless v1 | Yes — magic link + Google OAuth only | Eliminates ghost-user password overwrite class |
| Claim enum values | Two: `email_signup_claim`, `creator_invite_claim` | `oauth_claim` has no writer in v1 — add when flow exists |
| Admin handle-edit carveout | None (reject + DM applicant) | v1 has ≤10 creators; manual handles it |
| Waitlist rate-limit | IP bucket + Cloudflare Turnstile | Redis overkill pre-launch |
| Waitlist auto-welcome email | No | Deliverability + spam-victim attack vector |
| Admin seed | Bootstrap RPC after first login, not at migration time | auth.users doesn't exist at migration time |
| Admin identity | `user_id` FK, not `email` PK | Stale-email hijack + Unicode confusables |
| Email mirror on `auth.users` UPDATE | Mirror on confirmation, not on request | `supabase.auth.updateUser({email})` only requests — doesn't update `auth.users.email` until user clicks confirm link (R4-M5). No v1 email-change UI; no mirror helper shipped |
| TTL cleanup scheduler | Vercel Cron (daily) → Next route → RPC | Config-in-git, works on Hobby plan's daily limit |
| `gemini_pro_audio_v2` enum value | Delete (unused, speculative) | "No v2-later placeholders" cuts both ways |
| Proxy file | `proxy.ts` (Next 16 rename) | Confirmed against Next 16 docs |
| Day-by-day packaging | Dropped | Executed top-to-bottom in one sitting |

---

## 2. Migration queue

Executed in strict order. Each is a separate file. `0022` first — it's a
correctness bug fix for already-deployed code.

| # | File | Purpose | Audit ref |
|---|---|---|---|
| 0022 | `0022_fix_creators_handle_sync.sql` | `CREATE OR REPLACE` trigger: `v_promoted int := 0` instead of `boolean` receiving `ROW_COUNT` | R3-C1 |
| 0023 | `0023_verification_purpose_claims.sql` | `ALTER TYPE verification_purpose ADD VALUE` for `email_signup_claim` then `creator_invite_claim`. **Single-statement file** (no other DDL — new enum values aren't safe to use in the same txn) | R2-C1, R3-M6 |
| 0024 | `0024_reserved_handles_top_up.sql` | Add: `c, invite, apply, auth, onboarding, logout, callback, admin, api, public, assets, icons, images, static, health, robots, sitemap, favicon, manifest, team, teams, billing, dashboard, claim, search, explore, notifications, messages` | R2-Small, R3-Small |
| 0025 | `0025_admin_roles_user_id.sql` | **Renumbered from 0026 (R5-C3 — must run before the founder RPC references the new shape).** Strict step order (R4-C2): (1) `ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT` (nullable first), (2) backfill via citext email JOIN `auth.users`, (3) `DELETE FROM admin_roles WHERE user_id IS NULL` (clears orphan 0006 seed), (4) `ALTER COLUMN user_id SET NOT NULL`, (5) `DROP CONSTRAINT admin_roles_pkey`, (6) `ADD PRIMARY KEY (user_id)`. `email` kept nullable, display-only. Rewrite [auth-guards.ts](../../src/lib/auth-guards.ts) `assertAdminFromSession` to lookup by `user_id` | R1-C3, R2-C-α, R4-C2, R5-C3 |
| 0026 | `0026_founder_promotion_rpc.sql` | **Renumbered from 0024 (R5-C3 — must run after admin_roles.user_id exists).** `system_flags(key text PK, value jsonb, set_at timestamptz)` table. `promote_founder_if_first()` SECURITY DEFINER, body (R5-C1 idempotent, R5-C2 race-safe):<br>1. Resolve caller via `auth.uid()` → load email, provider, `email_confirmed_at` from `auth.users`.<br>2. Assert hardcoded founder email match, provider='google', `email_confirmed_at IS NOT NULL`. Reject otherwise.<br>3. `INSERT INTO system_flags(key,value,set_at) VALUES ('founder_bootstrapped', jsonb_build_object('user_id',auth.uid()), now()) ON CONFLICT (key) DO NOTHING RETURNING value` — this is the latch and it happens FIRST (R5-C2). If no row returned, check whether the existing latch's user_id matches caller. Match → treat as idempotent success (R5-C1). Mismatch → RAISE 'founder_already_set'.<br>4. `INSERT INTO admin_roles(user_id, email, role) VALUES (auth.uid(), v_email, 'superadmin') ON CONFLICT (user_id) DO NOTHING` (R5-C1 retry-safe).<br>5. RETURN 'promoted' \| 'already_promoted'. Never raises on re-run by the legitimate founder — only on provider/email mismatch or a different user trying to claim.<br>**Emergency runbook** (R5-C1): if bootstrap route returns 500 after partial success (e.g. network dropped between latch and admin_roles insert), re-POST the bootstrap endpoint; step 3 returns latch-exists-for-me → step 4 upserts → resolves. If the latch was somehow written for the wrong user_id, operator SQL: `DELETE FROM system_flags WHERE key='founder_bootstrapped'` (service-role only), then re-run. Document in README alongside the curl. | R3-M7, R4-C3, R5-C1, R5-C2, R5-C3 |
| 0027 | `0027_profiles_email_mirror.sql` | Add `profiles.email citext` nullable. Amend `handle_new_user()` to copy `NEW.email` on signup. Backfill existing rows. **No trigger on auth.users** (hosted Supabase blocks it). **No eager mirror on email-change** either (R4-M5) — `auth.updateUser({email})` request doesn't update `auth.users.email` until user confirms, so mirror at confirmation time (not request time) when v2 adds the UI | R2-M7, R3-C2, R3-C-γ, R4-M5 |
| 0028 | `0028_creator_applications_handle_uniqueness.sql` | `CREATE UNIQUE INDEX creator_applications_handle_pending_idx ON creator_applications(handle) WHERE status IN ('submitted','under_review')` | R2-C5 |
| 0029 | `0029_pending_verifications_metadata_unique.sql` | Add `metadata jsonb NOT NULL DEFAULT '{}'`. Add CHECK `purpose <> 'creator_invite_claim' OR metadata ? 'invitation_id'` (R4-M1 — without this, NULLs bypass partial-unique). Partial UNIQUE index `auth_pending_verifications_invite_claim_uidx` on `(email, purpose, (metadata->>'invitation_id'))` WHERE `purpose='creator_invite_claim' AND consumed_at IS NULL`. **R5-M1 correction:** `ON CONFLICT ON CONSTRAINT` does NOT work against partial unique indexes (no `pg_constraint` entry — only a `pg_class` index). Use inference form in bind RPC: `ON CONFLICT (email, purpose, (metadata->>'invitation_id')) WHERE purpose='creator_invite_claim' AND consumed_at IS NULL DO UPDATE ...` — the planner matches the partial index by predicate equivalence. Index name is retained for humans, not for ON CONFLICT | R3-C3, R3-C4, R4-M1, R5-M1 |
| 0030 | `0030_creator_applications_internal_notes_grants.sql` | Add `internal_notes text`. **No view** (R4-C1 — `security_invoker` + REVOKE on base = permission denied, invoker privileges propagate through view). Use column-level GRANT: `REVOKE SELECT ON creator_applications FROM authenticated; GRANT SELECT (id, user_id, invitation_id, status, display_name, handle, bio, topics, proof, rejection_reason, submitted_at, reviewed_at) ON creator_applications TO authenticated;` — omits `internal_notes`. Existing RLS `USING (user_id = auth.uid())` stays | R2-Small, R3-M4, R3-M-α, R4-C1 |
| 0031 | `0031_creator_topics_max_five_lock.sql` | Rewrite `creator_topics_enforce_max_five`: take `pg_advisory_xact_lock(hashtext('creator_topics:' || NEW.creator_id::text))` before the count | R2-M-η |
| 0032 | `0032_waitlist_ip_and_ratelimit.sql` | `ALTER TABLE waitlist ADD COLUMN created_ip inet`. New `rate_limit_log(scope text, key text, window_start timestamptz, count int, PRIMARY KEY(scope,key,window_start))`. **R5-M6:** ship `rate_limit_hit(p_scope text, p_key text, p_window interval, p_limit int) RETURNS boolean` SECURITY DEFINER — computes `v_window_start := date_trunc('hour', now())` (or `now() - (extract(epoch from now())::bigint % extract(epoch from p_window)::bigint) * interval '1 second'` for sub-hour windows) **inside the RPC**, then upserts `count=count+1 RETURNING count <= p_limit`. Callers never compute window_start client-side — different serverless instances have different wall-clocks and would fragment the bucket | R2-v1-miss, R5-M6 |
| 0033 | `0033_applications_invitation_id_restrict.sql` | Change `creator_applications.invitation_id` FK from `ON DELETE SET NULL` to `ON DELETE RESTRICT` | R3-Small |
| 0034 | `0034_voice_model_drop_pro_audio_v2.sql` | Recreate `voice_model` enum without `gemini_pro_audio_v2`. Safe because no column uses that value yet. Columns on the enum get `USING col::text::voice_model` | R3-Small |
| 0035 | `0035_bind_invite_claim_rpc.sql` | `bind_invite_claim(p_token text) RETURNS text` — validates invitation by hash. Inference-form upsert (R5-M1): `INSERT … ON CONFLICT (email, purpose, (metadata->>'invitation_id')) WHERE purpose='creator_invite_claim' AND consumed_at IS NULL DO UPDATE SET expires_at = CASE WHEN auth_pending_verifications.expires_at < now() THEN excluded.expires_at ELSE auth_pending_verifications.expires_at END, verification_token = CASE WHEN auth_pending_verifications.expires_at < now() THEN excluded.verification_token ELSE auth_pending_verifications.verification_token END RETURNING verification_token`. **R5-M4:** only reset expires_at + nonce when prior row is already expired — otherwise re-visits would keep extending the 60-min window indefinitely, defeating expiry. Re-visits to an unexpired claim return the existing nonce | R3-C3, R3-C5, R5-M1, R5-M4 |
| 0036 | `0036_submit_application_rpc.sql` | `submit_creator_application(...)` — no `user_id` param (uses `auth.uid()`), consumes nonce by token+email+purpose, reads `invitation_id` from `metadata` (with defensive `IF NULL RAISE 'invite_claim_missing_invitation_id'`), consumes specific invitation by id with **status re-validation** (R4-M2). **R5-M2 error dispatch:** wrap the INSERT in `EXCEPTION WHEN unique_violation THEN GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME` then `CASE v_constraint WHEN 'creator_applications_handle_pending_idx' THEN RAISE 'handle_taken'; WHEN 'handles_registry_pkey' THEN RAISE 'handle_taken'; WHEN 'creator_applications_one_active_per_user_idx' THEN RAISE 'duplicate_application'; ELSE RAISE; END CASE` — never collapse every unique_violation to `handle_taken` (was lying to users about duplicate submissions) | R2-C4, R3-C5, R3-M2, R4-M2, R4-M7, R5-M2 |
| 0037 | `0037_approve_reject_application_rpcs.sql` | `approve_creator_application(p_id)` + `reject_creator_application(p_id, p_reason, p_internal_notes)` — both use `auth.uid()`, assert admin via `admin_roles.user_id`, approve path clears profile handle then sets new handle then inserts creator with `brain_status='training'` | v1 |
| 0038 | `0038_cleanup_expired_verifications_rpc.sql` | `cleanup_expired_verifications()` — **R5-S10:** use `pg_try_advisory_xact_lock(hashtext('cleanup_pending_verifications'))`, NOT `pg_try_advisory_lock`. Session-scoped advisory locks leak across PgBouncer transaction-pooler connections and can be inherited by unrelated requests; txn-scoped locks are released at COMMIT and are pool-safe. `IF NOT pg_try_advisory_xact_lock(...) THEN RETURN 0; END IF;` then `DELETE FROM auth_pending_verifications WHERE expires_at < now() - interval '7 days'` | R2-M-β, R4-M6, R5-S10 |

---

## 3. Proxy

**[proxy.ts](../../proxy.ts)** — rename export `middleware` → `proxy` (R3-C-β).
Body:
- SSR-session refresh via `createServerClient` from `@supabase/ssr`
- Protected paths: `/onboarding`, `/apply`, `/admin/*`, `/invite/*/claim`
- Unauthed on protected path → `redirect('/login?next=<original>')`
- Matcher unchanged (already correct: excludes `_next`, `manifest.webmanifest`, `auth/`, `api/`, static assets)
- Cookie flags via `@supabase/ssr` defaults; `secure` in prod, `sameSite:'lax'`, `httpOnly:true`

---

## 4. Auth

### `/login`
[src/app/login/page.tsx](../../src/app/login/page.tsx) — reads `?next=` + `?error=`.
Client form: email input → magic link, Google OAuth button.

Actions in [src/app/login/actions.ts](../../src/app/login/actions.ts):
- `requestMagicLink({email, next})` — zod → `supabase.auth.signInWithOtp({email, options:{emailRedirectTo: ${SITE}/auth/callback?next=${next}}})` → redirect `?sent=1`
- `startGoogleOAuth({next})` — `signInWithOAuth({provider:'google', options:{redirectTo: ${SITE}/auth/callback?next=${next}}})` → return URL, client `window.location.href=`

### `/auth/callback`
[src/app/auth/callback/route.ts](../../src/app/auth/callback/route.ts):
1. If `?error=` or no `?code=` → redirect `/login?error=...` (R2-M9)
2. `exchangeCodeForSession(code)` — wrapped in try/catch → fail → `/login?error=exchange_failed`
3. If `?claim=<token>` param present:
   - `UPDATE auth_pending_verifications SET consumed_at=now() WHERE verification_token=$claim AND email=$userEmail AND purpose='email_signup_claim' AND consumed_at IS NULL AND expires_at > now()`
   - Zero rows → ignore (don't block login)
4. Read `profiles.onboarded_at`. If NULL and `next` doesn't start with `/apply` → redirect `/onboarding?next=<next>`
5. Else redirect `next` (validated same-origin relative)

### Logout
[src/app/auth/actions.ts](../../src/app/auth/actions.ts) `logout()` → `signOut()` → `redirect('/login')`. Client follows with `window.location.href='/login'` for full reload per CLAUDE.md.

### Post-first-login bootstrap
[src/app/api/admin/bootstrap/route.ts](../../src/app/api/admin/bootstrap/route.ts) — POST, `Authorization: Bearer ${ADMIN_SECRET}`, calls `promote_founder_if_first()`.

**Layered defense against takeover (R4-C3):**
- `ADMIN_SECRET` gate alone is insufficient — attacker who registers `vukpjescic@gmail.com` before Vuk does + leaked secret = platform takeover
- Hardcoded founder email **inside the RPC body**, not a parameter
- RPC requires `raw_app_meta_data->>'provider' = 'google' AND email_confirmed_at IS NOT NULL` (Google's OAuth proves email ownership; Supabase magic-link alone doesn't prove attacker didn't intercept)
- One-shot latch: `system_flags.founder_bootstrapped` written in same txn. Subsequent calls RAISE

Document in README: "after first Vuk Google-OAuth login, `curl -X POST -H 'Authorization: Bearer $ADMIN_SECRET' $SITE/api/admin/bootstrap`". One-shot. If it fails, investigate — never retry blindly.

---

## 5. User onboarding

[src/app/onboarding/page.tsx](../../src/app/onboarding/page.tsx):
- `getCallerUserId` or redirect
- Read profile → if `onboarded_at` set → redirect `/`
- Render form

Form: goals (chip input, 1-5 items, ≤200ch each), obstacles (same, 0-5), hidden `timezone` via `Intl.DateTimeFormat().resolvedOptions().timeZone`.

[src/app/onboarding/actions.ts](../../src/app/onboarding/actions.ts):
- Zod validates shape
- Whitelist keys: `{goals, obstacles, timezone, onboarded_at: now()}` — never spread input
- RLS enforces `id=auth.uid()` on the UPDATE
- `revalidatePath('/')`
- Return `{ok:true, next}` — client `window.location.href = next` (validated relative path, default `/`)

---

## 6. Admin invite generator

### Layout
[src/app/admin/layout.tsx](../../src/app/admin/layout.tsx) — wraps `await assertAdminFromSession()` in `cache()` (React cache). Failure → `notFound()` from `next/navigation` (R2-M10) so the route existence doesn't leak.

### Invite form
[src/app/admin/invites/new/page.tsx](../../src/app/admin/invites/new/page.tsx) — form: `email`, `notes`, `expires_in_days` (1-7, default 7).

[src/app/admin/invites/actions.ts](../../src/app/admin/invites/actions.ts):
```
mintCreatorInvite(input):
  admin = await assertAdminFromSession()
  parsed = Schema.parse(input)
  {token, hash} = mintInviteToken()
  row = insert creator_invitations(email, token_hash=hash, invited_by=admin.userId, notes, expires_at)
  await resend.emails.send({from, to: parsed.email, subject, html: renderInviteEmail({url: `${SITE}/invite/${token}`, expires_at})})
  return {id: row.id, url}   // shown once for copy-fallback; NEVER logged
```

Token never stored plaintext. Email contains it once.

---

## 7. Invite landing + claim (C2/C-δ/M-γ resolved)

### `/invite/<token>` (public, read-only)
[src/app/invite/[token]/page.tsx](../../src/app/invite/[token]/page.tsx):
- Hash token via `candidateHashes(token)` (rotation-safe)
- Lookup `creator_invitations WHERE token_hash IN (...) AND used_at IS NULL AND expires_at > now()`
- Invalid/expired/used → render error
- Valid → `redirect('/login?next=/invite/<token>/claim')`
- **No DB write here. No cookie set.** Redemption happens post-auth.

### `/invite/<token>/claim` (protected)
[src/app/invite/[token]/claim/page.tsx](../../src/app/invite/[token]/claim/page.tsx):
- Auth enforced by proxy
- Server calls RPC `bind_invite_claim(p_token)`:
  ```
  auth.uid() inside; lookup user.email from auth.users
  lookup creator_invitations by hash, WHERE email = user.email AND not-used AND not-expired
    0 rows → RAISE 'invite_unavailable' (forwarded email attack blocked)
  INSERT auth_pending_verifications(email, purpose='creator_invite_claim',
    verification_token=gen_random_uuid()::text, expires_at=now()+interval '60 minutes',
    metadata=jsonb_build_object('invitation_id', invitation.id))
  ON CONFLICT (email, purpose, (metadata->>'invitation_id')) WHERE ...
    DO UPDATE SET expires_at=excluded.expires_at, verification_token=excluded.verification_token
  RETURNING verification_token
  ```
- Set httpOnly cookie `invite_nonce=<returned>` (60min, path=/, secure, sameSite=lax)
- `redirect('/apply')`

**M-γ fallback:** if user arrives at `/apply` with no cookie, show "your invite session expired — click the email link again." Cookie rebuilt on re-visit to `/claim` (idempotent — same pending row, just refreshed nonce).

---

## 8. Creator apply

[src/app/apply/page.tsx](../../src/app/apply/page.tsx) — protected, reads cookie, renders form.

Zod schema:
```
Topic = { slug: /^[a-z0-9_-]{2,40}$/, title: 1-80ch, description: 0-500ch }
Proof = { youtube_url?: url, twitter_url?: url, website?: url, other_links?: url[≤10] }
Apply = { display_name: 1-80, handle: /^[a-z0-9_]{3,30}$/, bio: 0-2000, topics: Topic[1-5] (unique slugs), proof: Proof }
```

[src/app/apply/actions.ts](../../src/app/apply/actions.ts):
```
submitCreatorApplication(input):
  userId = await getCallerUserId() or throw 401
  nonce = cookies().get('invite_nonce')?.value or throw 'needs_invite'
  parsed = Schema.parse(input)
  try {
    appId = await rpc('submit_creator_application', {p_claim_nonce: nonce, ...parsed})
  } catch (e) {
    code = parseStructuredError(e)  // dispatched by RPC via GET STACKED DIAGNOSTICS
                                    // CONSTRAINT_NAME (R5-M2): handle_taken,
                                    // duplicate_application, invite_claim_invalid,
                                    // invite_unavailable, invite_claim_missing_invitation_id
    return {ok:false, error: code}
  }
  cookies().delete('invite_nonce')
  revalidatePath('/admin/applications')
  redirect('/apply/submitted')
```

RPC body (0036) handles all atomicity. Server action is a thin wrapper + error mapper.

---

## 9. Admin application queue

[src/app/admin/applications/page.tsx](../../src/app/admin/applications/page.tsx):
- `assertAdminFromSession` via cached layout
- Service-role client queries `creator_applications` joined with `profiles(email, display_name)`
- List `status IN ('submitted','under_review')` ordered by `submitted_at ASC`
- Link to detail page per row

[src/app/admin/applications/[id]/page.tsx](../../src/app/admin/applications/[id]/page.tsx):
- Full detail view (topics, proof links, bio, handle)
- Approve / Reject buttons

[src/app/admin/applications/actions.ts](../../src/app/admin/applications/actions.ts):
- `approveApplication(id)` → `rpc('approve_creator_application', {p_id:id})` — catches FK `23503` (application referenced by existing creator) → structured error `application_already_approved` (R4-M4)
- `rejectApplication(id, reason, internal_notes)` → `rpc('reject_creator_application', ...)` — same 23503 catch pattern

Approval RPC body (0037):
```
assert admin_roles.user_id = auth.uid() and revoked_at IS NULL
UPDATE creator_applications SET status='approved', reviewed_at=now(), reviewed_by=auth.uid()
  WHERE id=p_id AND status IN ('submitted','under_review') RETURNING user_id, handle, display_name
  → IF NOT FOUND RAISE 'not_pending'
UPDATE profiles SET handle=NULL WHERE id=v_user_id AND handle IS DISTINCT FROM v_new_handle
UPDATE profiles SET handle=v_new_handle, display_name=coalesce(display_name, v_new_display_name) WHERE id=v_user_id
INSERT INTO creators(user_id, application_id, creator_type, brain_status) VALUES (v_user_id, p_id, 'human', 'training')
-- brain training job stub; actual training = Day 6+
```

---

## 10. Sentry + PostHog

- [sentry.client.config.ts](../../sentry.client.config.ts), [sentry.server.config.ts](../../sentry.server.config.ts), [instrumentation.ts](../../instrumentation.ts) — standard `@sentry/nextjs` v9 setup, `tracesSampleRate:0.1`, `replaysSessionSampleRate:0`
- `beforeSend` scrubs cookies (`invite_nonce`, `sb-*-auth-token`) and rewrites URL paths containing `/invite/` to `/invite/[redacted]`; same for transaction names
- `beforeBreadcrumb` sanitizes fetch crumbs to `/invite/` URLs
- [src/lib/posthog-server.ts](../../src/lib/posthog-server.ts) + [src/lib/posthog-client.tsx](../../src/lib/posthog-client.tsx); wrap `<body>` with `<PostHogProvider>`
- Identify in `/auth/callback` post-exchange: `posthog.identify(user.id, {email: user.email})`

---

## 11. Waitlist hardening

- [src/app/page.tsx](../../src/app/page.tsx) — landing with waitlist form, Cloudflare Turnstile widget
- Server action reads IP from `headers().get('x-forwarded-for')?.split(',')[0] ?? 'dev-local'` (R3-M5)
- Verifies Turnstile token server-side before insert
- IP bucket via `rate_limit_hit('waitlist', ip, interval '1 hour', 10)` RPC (R5-M6 — window computed DB-side)
- Inserts into `waitlist(email, created_ip)` — no auto-send email (R3 decision)

---

## 12. Scheduled cleanup (Vercel Cron)

[vercel.json](../../vercel.json):
```json
{"crons": [{"path": "/api/cron/cleanup-verifications", "schedule": "0 3 * * *"}]}
```
Daily at 03:00 UTC. Hobby-plan compatible (daily max).

[src/app/api/cron/cleanup-verifications/route.ts](../../src/app/api/cron/cleanup-verifications/route.ts):
- **R5-M5 guard:** at module top, `const secret = process.env.CRON_SECRET; if (!secret || secret.length < 32) throw new Error('CRON_SECRET missing or too short')` — unset or empty env would otherwise match the `Bearer ` header `==` check and turn into a trivial auth bypass. Fail closed at import time, not request time
- Request handler: constant-time compare against `Authorization: Bearer ${CRON_SECRET}` (Vercel auto-sends)
- `supabaseAdmin().rpc('cleanup_expired_verifications')`
- Return 200 with deleted count for observability

Env addition: `CRON_SECRET` (set in Vercel dashboard + `.env.example`).

---

## 13. Deps

### Add to package.json
- `@sentry/nextjs ^9`
- `posthog-js ^1.205`, `posthog-node ^4`
- `react-hook-form ^7.54`, `@hookform/resolvers ^3.10`
- `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`
- `@radix-ui/react-label`, `@radix-ui/react-slot`, `@radix-ui/react-toast`
- `vitest` + `@vitest/ui` (dev)

### shadcn/ui
`npx shadcn@latest init` → add `button input label textarea form toast card`.
Confirm Tailwind v4 compat.

### `.env.example` additions
- `NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com`
- `CRON_SECRET=` (Vercel auto-populates; documented here — R4-Small: this is Vercel's convention, not `PIPELINE_SECRET`)
- `NEXT_PUBLIC_TURNSTILE_SITE_KEY=` / `TURNSTILE_SECRET_KEY=`

### Remove
- `NEXT_PUBLIC_AUDIO_PREWARM` (dead config, R2-Small)
- `PIPELINE_SECRET` (unused; superseded by `CRON_SECRET` for the one scheduled job we have in v1 — R4-Small)

### next.config.ts
Move `typedRoutes` from `experimental` to top-level (stabilized in Next 16, R2-Small).

### Static assets
- [public/manifest.webmanifest](../../public/manifest.webmanifest) — name, short_name, start_url, display=standalone, theme_color=#0a0a0a
- [public/icons/icon-192.png](../../public/icons/icon-192.png), `icon-512.png` (placeholder solid-color OK)

---

## 14. Tests

SQL (via `supabase test db`):
- **0022:** `creators_handle_sync_after` INSERT path with existing profile handle correctly promotes (was failing due to boolean bug)
- **0025:** admin_roles rewrite — `assertAdminFromSession` by user_id succeeds; stale email does not
- **0028:** two pending applications with handle=`vuk` — second raises `handle_taken`
- **0029/0035:** two parallel `bind_invite_claim` calls → one row, both get same nonce (ON CONFLICT path)
- **0030:** applicant can SELECT via `creator_applications_applicant_view` but not base table
- **0031:** two concurrent topic #5 inserts → only one succeeds (advisory lock)
- **0036:** call with forged user_id fails signature (no param exists); missing `invitation_id` in metadata raises `invite_claim_missing_invitation_id`; cross-table handle collision raises `handle_taken`
- **0037:** approve → creator row + brain_status=`training` + handle promoted; double-approve idempotent (second raises `not_pending`)
- RLS: anonymous zero rows on `creator_invitations`; authenticated user cannot read other users' applications

TS (via `vitest`):
- `invite-tokens.test.ts`: mint→hash roundtrip, rotation (NEXT secret valid), `constantTimeEqual` fails fast on length mismatch
- `onboarding-action.test.ts`: rejects non-whitelisted keys
- `callback-ghost-claim.test.ts`: claim param for different email than session → no consumption
- `proxy.test.ts`: manifest.webmanifest bypasses auth; `/onboarding` redirects unauthed

**Real-API test (gated by `RUN_REAL_API_TESTS=1`):** deferred to voice work (Day 4+).

---

## 15. Execution order

```
Phase A — Security migrations (in numeric order 0022 → 0038)
Phase B — proxy.ts body + rename
Phase C — Deps + shadcn init + static assets
Phase D — Sentry + PostHog wiring (catch all subsequent errors)
Phase E — /login + /auth/callback + logout
Phase F — /onboarding
Phase G — /admin/layout + /admin/invites/new
Phase H — /api/admin/bootstrap + first-login founder promotion
Phase I — /invite/[token] + /invite/[token]/claim
Phase J — /apply
Phase K — /admin/applications (list + detail + approve/reject)
Phase L — / (landing + waitlist + Turnstile + rate-limit)
Phase M — vercel.json + cleanup cron route
Phase N — Pre-deploy red-team (VibeCoders §17) + first real creator dogfood (Vuk invites self)
```

---

## 16. Deferred (voice-era, not blocking onboarding)

- M-ζ sessions kill-switch race condition (R2)
- M-δ clock-drift (R2)
- `session_turns_guard` CASE without ELSE (R3-Small)
- Real-API voice test harness (Day 4 Spike A)

---

## 17. Closed items (reference — do not re-audit)

### Audit round 1 — 5 Critical / 10 Medium
All closed in §2 migrations and §4-§9 flows. Key closures:
- C1 (purpose+token filter on ghost-claim) → §4 callback step 3
- C2 (forwarded-invite redemption) → §7 `/claim` RPC email match
- C3 (admin_roles user_id) → 0025 (renumbered R5-C3)
- C4 (no user_id param in RPC) → 0036
- C5 (handle collision race) → 0028 + 0036 cross-table check

### Audit round 2 — 5 Critical / 8 Medium
- C-α (admin_roles unfixed) → 0025 (renumbered R5-C3)
- C-β (proxy.ts function rename) → §3
- C-γ (profiles.email mirror) → 0027 + §4 application-level
- C-δ (invitation_id through nonce, not re-match) → 0029 metadata + 0036
- C-ε (separate variables + single-statement enum file) → 0023 + 0035 + 0036

### Audit round 3 — 5 Critical / 7 Medium
- R3-C1 (boolean ROW_COUNT bug) → 0022
- R3-C2 (auth.users trigger on hosted Supabase) → 0027 application-level
- R3-C3 (idempotent claim binding) → 0029 partial UNIQUE + 0035 ON CONFLICT
- R3-C4 (metadata column missing) → 0029
- R3-C5 (NULL invitation_id silent mask) → 0036 defensive raise
- R3-M4 (security_invoker view) → 0030
- R3-M5 (x-forwarded-for) → §11
- R3-M7 (admin seed bootstrap) → 0026 (renumbered R5-C3)

---

## 18. Learnings to log when execution starts

Append to [.claude_learnings.md](../../.claude_learnings.md) on first migration:

```
## <date> — security_invoker view + REVOKE on base = permission denied
Root cause: WITH (security_invoker = on) causes the invoker's privileges
to propagate through the view to the base table. If the base table has
REVOKE SELECT FROM authenticated, the view read fails with "permission
denied for table X" even though RLS would allow the row.
Fix: use column-level GRANTs on the base table instead. Let RLS handle
row filtering; let column grants handle column filtering.
Lesson: views are a row-shaping tool, not a privilege-shaping tool.
```

---

## 19. Closed audit findings — round 4

- R4-C1 (security_invoker view backfire) → 0030 rewritten with column grants
- R4-C2 (migration step order for admin_roles) → 0025 explicit 6-step sequence (renumbered R5-C3)
- R4-C3 (founder bootstrap takeover) → 0026 layered defense (provider check, hardcoded email, one-shot latch) (renumbered R5-C3)
- R4-M1 (CHECK for invitation_id presence) → 0029
- R4-M2 (submit RPC re-validates invitation status) → 0036
- R4-M3 (ON CONFLICT ON CONSTRAINT named index) → 0029 + 0035
- R4-M4 (RESTRICT FK raw error) → §9 server-action 23503 catch
- R4-M5 (email mirror atomicity) → §4 mirror on confirmation, not request
- R4-M6 (cron overlap guard) → 0038 advisory lock
- R4-M7 (handle race TOCTOU) → 0036 EXCEPTION WHEN unique_violation
- R4-Small (CRON_SECRET naming) → §13 .env.example
- R4-Small (named partial unique index) → 0029 `auth_pending_verifications_invite_claim_uidx`
- R4-Small (security_invoker gotcha logged) → §18

## 20. Closed audit findings — round 5

- R5-C1 (bootstrap failure = zero-admin lockout) → 0026 RPC idempotent: latch-exists-for-me returns 'already_promoted'; admin_roles uses `ON CONFLICT (user_id) DO NOTHING`; emergency runbook documented
- R5-C2 (founder bootstrap SELECT-then-INSERT TOCTOU) → 0026 flips order: `system_flags` latch INSERT ... ON CONFLICT DO NOTHING RETURNING happens FIRST; admin_roles insert happens after latch outcome known
- R5-C3 (0024 ran before admin_roles restructure) → renumbered: 0024=reserved_handles_top_up, 0025=admin_roles_user_id, 0026=founder_promotion_rpc. RPC now references post-restructure shape
- R5-M1 (`ON CONFLICT ON CONSTRAINT` on partial unique index fails) → 0029/0035 switched to inference form `ON CONFLICT (cols) WHERE <predicate>`
- R5-M2 (unique_violation collapsed to handle_taken) → 0036 uses `GET STACKED DIAGNOSTICS CONSTRAINT_NAME` to dispatch by constraint
- R5-M4 (claim re-visit extends expiry indefinitely) → 0035 CASE expression: only reset expires_at+nonce when prior row already expired
- R5-M5 (empty CRON_SECRET = auth bypass) → §12 module-top guard: fail closed if missing or `< 32` chars
- R5-M6 (rate_limit window_start client-side) → 0032 ships `rate_limit_hit()` RPC computing window inside DB
- R5-S10 (`pg_try_advisory_lock` leaks in PgBouncer txn pooler) → 0038 uses `pg_try_advisory_xact_lock`

## 21. Open — none

All R1-R5 audit findings closed. Plan is ready for short final audit, then execution starting migration 0022.
