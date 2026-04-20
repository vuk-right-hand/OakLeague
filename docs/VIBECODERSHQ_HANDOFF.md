# Agent Handoff — Lessons from Building Veritas/VibeCodersHQ

> Distilled playbook of mistakes we made, the fix, and the why. Stack assumed: **Next.js (App Router) + Supabase (Postgres, Auth, Storage) + Vercel + Resend**.
> Monetization intentionally deferred in OakLeague v1 — no Stripe columns, no `stripe_*` fields.

---

## 0. Operating Philosophy

1. **Data before code.** Never write a server action or component until the exact table shape, RLS policy, and payload shape are defined. "Schema drift" is the #1 cause of production outages.
2. **Self-annealing repair loop.** On any failure: (a) read the stack trace, (b) patch the specific line, (c) append a 3-line entry to `.claude_learnings.md`. Read that file before every debugging session.
3. **Tests first for anything that touches money, auth, or webhooks.** Skip tests on basic UI — they rot faster than the component.
4. **Assume the frontend is hostile.** Every server action must re-derive the caller identity server-side and re-verify ownership of any ID it was handed.
5. **Don't add features the task doesn't need.** No speculative abstractions, no "just in case" fallbacks, no feature flags for backwards-compat with code that doesn't exist.
6. **Default to NO comments in code.** Only justified if it explains a non-obvious *why* (a hidden invariant, a workaround for a specific bug).

---

## 1. Project Structure (App Router)

- **Flat routes, no route groups.** `/dashboard`, `/login`, `/v/[slug]`. Route groups break proxy matcher patterns.
- **All server actions in `src/app/actions/*.ts`.** Do NOT co-locate with pages.
- **Dual Supabase clients, never mix:**
  - `supabaseClient.ts` — anon key, browser only. **localStorage only.**
  - `supabaseAdmin.ts` — service role, server only. **Bypasses RLS.** Every call re-verifies ownership.
  - `supabaseServer.ts` — `@supabase/ssr` cookie-bound client. **Canonical "who is logged in" on the server.**
- One `UserContext.tsx`. Resist multiple contexts.

---

## 2. Auth & Session — The Biggest Source of Bugs

### Canonical identity resolution (server)
```ts
// 1. Supabase auth session (SSR cookie client)
const { data: { user } } = await supabaseServer.auth.getUser();
if (user) return user.id;

// 2. Fallback cookie → DB lookup for anon/guest flows (if applicable)
const cookieVal = cookies().get('app_user')?.value;
if (cookieVal) { /* guest lookup */ }

return null;
```
Write this as `getCallerUserId()` **once**. Every server action calls it.

### After login / signup / role change
- **ALWAYS `window.location.href`, never `router.push()`.** Soft RSC navigation keeps the old `UserProvider` mounted with stale data. Full reload re-hydrates.
- After role/tier upgrade call `revalidatePath('/', 'layout')` to bust Next cache.

### Profile button / nav guards
Check **both** `isLoggedIn` AND `userProfile`. A stale cookie with no profile row passes `isLoggedIn` but crashes on first profile access.

### "Ghost users"
When signup fails mid-flow (`createUser` succeeds, profile insert fails):
- Can't re-signup (email taken)
- Can't log in (no profile)
- Detection: query `auth.users` for rows with no matching `profiles.id`
- **OAuth claim flow fix:** `createUser` errors with "already exists" → look up user_id → `updateUserById(userId, { password })` → login. Safe because OAuth already proved email ownership.
- **Email signup flow fix:** NEVER overwrite password blind — account hijack vector. Use magic link via `auth_pending_verifications` to verify ownership before any password set.

### Cookie security (copy exactly)
```ts
cookieStore.set('app_user', value, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: 60 * 60 * 24 * 7,
});
```
`secure: true` unconditional breaks localhost. `sameSite: 'strict'` breaks OAuth redirects. `sameSite: 'none'` requires `secure` and breaks most mobile browsers.

---

## 3. Row-Level Security — Common Misconceptions

1. **`using(true)` does NOT mean "service role only".** It means "every authenticated user can read". Service role bypasses RLS implicitly — don't add an open policy to "allow" it.
2. **Service-role-only tables get RLS enabled with ZERO policies.** That is the correct pattern.
3. **Never trust client-supplied IDs in server actions using `supabaseAdmin`:**
   ```ts
   const callerId = await getCallerUserId();
   if (!callerId) return { error: 'Unauthorized' };
   const { data: row } = await supabaseAdmin
     .from('widgets').select('user_id').eq('id', clientId).single();
   if (row.user_id !== callerId) return { error: 'Forbidden' };
   ```
4. **Admin RLS compares auth JWT email to `admin_roles` table** — never trust client-passed `email` or `isAdmin`. Build `assertAdminFromSession()` that does SSR cookie → `auth.users` → `admin_roles` lookup.
5. **Whitelist enum values in the server action**, not only via CHECK constraint. CHECK error returns cryptic Postgres error; pre-check returns clean `{ error: 'Invalid category' }`.

---

## 4. Supabase Admin API Footguns

- **`listUsers()` without filter defaults to page 1, 50 rows.** Past ~1000 users it silently misses. Use `getUserByEmail()` (O(1)).
- **Migration filename ≠ migration applied.** Always verify via `information_schema.columns`. We lost 20+ hours to this.
- After schema change: `NOTIFY pgrst, 'reload schema';` or PostgREST returns cryptic "column not found" errors.
- Migrations in `supabase/migrations/` are source of truth — `db-schema.sql` drifts.

---

## 5. Proxy / Middleware

Use `proxy.ts` (Next middleware) alongside page-level gates — they complement.

**Matcher excludes:** `.json, .html, .js, .xml, .ico, .txt, .webmanifest`, image extensions. Without this, `manifest.json` redirects to `/login` for guests, breaking PWA install and OAuth.

**Never match `/auth/*`.** Matching on PKCE flows eats the `?code=` param → infinite auth loop. Safety net: `StrayCodeRedirect` client component on `/` that catches stray `?code=` and forwards to `/auth/callback`.

**Rules (in order):**
1. Logged-in user on auth page → redirect to `/dashboard`. **Exception:** `/onboarding` without profile cookie = new OAuth user mid-flow.
2. Logged-out on protected page → `/login`. Explicit allowlist for public paths (`/v/*`, `/c/*`, `/api/*`, legal).

---

## 6. OAuth (Google + GitHub)

- **PKCE flow.** Client `signInWithOAuth()` → Supabase → provider → `/auth/callback`.
- **`flow` query param** (`onboarding | claim | login`) drives post-auth logic. Pre-persist state in a 10-min httpOnly cookie BEFORE redirecting — the cookie is the only state carrier through the provider hop.
- **`next` prop** must append to `redirectTo` and survive cross-domain hops.
- **Supabase dashboard Redirect URLs MUST include both `https://www.domain.com/auth/callback**` AND `https://domain.com/auth/callback**`.** Missing either → PKCE code sent to root → loop.
- **GitHub private email:** handle explicitly. Redirect with `?error=no_email&provider=github`.
- **Expired pending cookies:** `?error=session_expired` — don't silent-fall-through.
- Pages using `useSearchParams()` MUST be `<Suspense>`-wrapped or Next throws at build.

---

## 7. Server Actions — Required Pattern

```ts
'use server';

export async function updateWidget(id: string, patch: Partial<Widget>) {
  // 1. Who is calling?
  const callerId = await getCallerUserId();
  if (!callerId) return { error: 'Unauthorized' };

  // 2. Do they own this row?
  const { data: row } = await supabaseAdmin
    .from('widgets').select('user_id').eq('id', id).single();
  if (!row || row.user_id !== callerId) return { error: 'Forbidden' };

  // 3. Whitelist mutable fields — never spread.
  const safe = { name: patch.name, color: patch.color };

  // 4. Mutate.
  const { error } = await supabaseAdmin.from('widgets').update(safe).eq('id', id);
  if (error) return { error: error.message };

  // 5. Revalidate.
  revalidatePath('/widgets', 'page');
  return { ok: true };
}
```
Every action follows this shape. Deviation = bug.

---

## 8. API Routes — Secret-Gated Admin/Debug

Every `/api/debug*`, `/api/fix-*`, `/api/internal*`, `/api/pipeline/*` route:
```ts
const secret = req.headers.get('x-admin-secret');
if (secret !== process.env.ADMIN_SECRET) {
  return new Response('Forbidden', { status: 403 });
}
```
A public debug endpoint with service role is a data exfiltration gift. We shipped one. Don't.

For cron/automation: dedicated `PIPELINE_SECRET` — separate from `ADMIN_SECRET` so leaking one doesn't compromise both.

---

## 9. Performance

- **Server Components by default.** Client components only for interactivity.
- **N+1 queries kill you.** Batch via `Promise.all`.
- **Select only the columns you render.** Pulling `embedding vector(3072)` into a feed list OOMs Vercel functions.
- **Keyset pagination over OFFSET.** OFFSET double-counts when rows are inserted mid-scroll.
- **Partial indexes are free wins.** `CREATE INDEX ... WHERE status='active'` — dramatically smaller.
- **Push sorting into SQL RPCs, not the client.** `STABLE SECURITY INVOKER` function reading `auth.uid()` is safer than a server action passing user_id (impersonation surface).
- **Server-side `excludeIds` on paginated RPCs.** Client dedupe silently skips rows on `loadMore`.

---

## 10. Pipeline / Background Jobs

- **n8n (or similar) = scheduler only.** Logic lives in API routes where you can test and log.
- **Job table + status column = observability layer.** Record every transition: `queued → fetching → processing → completed | failed`.
- **`try/catch/finally` — NOT just try/catch.** If catch returns 500 without updating the job row, the job is orphaned in an intermediate state forever. `finally` is non-negotiable.
- **Self-healing unstick query:**
  ```sql
  DELETE FROM pipeline_jobs
   WHERE status IN ('analyzing','generating_embedding','fetching_transcript')
     AND processing_time_ms IS NULL
     AND created_at < now() - interval '5 minutes';
  ```
- **Gemini structured output:** always set `responseMimeType: "application/json"` + `responseSchema`. String parsing LLM output is unreliable.
- **Round-robin:** `ORDER BY last_fetched_at ASC NULLS FIRST` — fair scheduling without a queue.
- **Dedupe at multiple layers:** check main table AND job table before enqueueing.

---

## 11. UX / Frontend Lessons

- **Labor-illusion interstitials** ("Building your feed…") on first visit feel faster than instant renders in onboarding.
- **Loading skeletons are mandatory** for RSC pages that block on fetch. Add a `loading.tsx` matching the target shape.
- **Optimistic UI for likes/follows/mutations.** Server action is source of truth, UI updates on click, revert on error.
- **Modal dismissal must be 4-way:** backdrop click + ESC + swipe-down + close button. All four. Users form personal habits — missing one feels trapped.
- **Form errors near the field**, toast for global state. Never top-of-page banner for field errors.

---

## 12. PWA / A2HS

- Icons MUST be `any` and `maskable` as **separate manifest entries**. Combining breaks `beforeinstallprompt`.
- Screenshots at 1080x2340 with `form_factor: "narrow"`.
- iOS ignores manifest screenshots — use `apple-mobile-web-app-capable`, `apple-mobile-web-app-title`, `apple-touch-icon`.
- **Proxy matcher excludes `.json`** or manifest redirects to `/login` for guests.
- Bump SW cache version on every icon/manifest change.

---

## 13. Email (Resend)

- **Log every send** to `email_notifications_log` with `email_type, recipient, metadata, sent_at`. SMTP logs expire; you WILL need "did X get their email?"
- **Dedupe milestone emails** with a `*_sent` table and UNIQUE constraint on `(resource_id, milestone)`. Rely on DB constraint, not app logic.
- **Unsubscribe one-click, no login.** Sign the unsub token server-side.

---

## 14. Tech Stack Versions (known-good as of 2026-04)

```
next 16.1.6
react 19
@supabase/ssr 0.8
@supabase/supabase-js 2.95
@google/generative-ai 0.24
tailwind 4
framer-motion 11
resend 6.9
zod, cva, radix-ui, lucide-react
```
No Stripe in OakLeague v1.

---

## 15. OakLeague-Specific Additions

Beyond the VibeCoders patterns, OakLeague requires:

**Invite-only creator onboarding:**
- `creator_invitations.invite_token` must be cryptographically random (256-bit), signed, single-use (`used_at` gate), and time-limited (`expires_at`).
- Token grants *ability to apply*, never *to be a creator*.
- Admin console for invite generation + review queue.

**Tier-based routing (no Stripe):**
- `profiles.tier` enum flipped by admin only.
- `sessions.tier_at_session` snapshots at open.
- Tier change triggers `revalidatePath('/', 'layout')` + full reload.

**COGS guardrails:**
- Every paid API call inserts into `cogs_log`.
- Kill-switch fires at 150% of daily quota.
- Admin COGS viewer page in v1.

**Voice model pin:**
- `VOICE_MODEL` env var, no `-latest`.
- Real-API gated test per deploy.

---

## 17. Red Team Checklist (run before every deploy)

- [ ] No `supabaseAdmin` call without `getCallerUserId()` + ownership check.
- [ ] No `/api/debug*` or `/api/fix-*` route without `x-admin-secret` gate.
- [ ] No RLS policy with `using(true)` unless the table is genuinely public-read.
- [ ] No `listUsers()` — replaced with `getUserByEmail()`.
- [ ] No client-passed `email` / `user_id` / `is_admin` / `tier` trusted anywhere.
- [ ] No demo/fallback path rendering real user data for unauthorized callers — use `redirect()`.
- [ ] Every cookie: `httpOnly: true, secure: prod, sameSite: 'lax'`.
- [ ] Every migration column verified via `information_schema.columns`.
- [ ] Every long-running job handler wrapped in `try/catch/finally` marking failed state.
- [ ] Every admin/destructive action revalidates `'/'` layout.
- [ ] No hardcoded creator IDs, `is_founder` booleans, or special-cased user emails in application logic.
- [ ] `creators.creator_type` enum present — v2 brand/sponsored path doesn't need migration.
- [ ] `profiles.tier` enum present, admin-only flip.
- [ ] Every paid API call writes to `cogs_log`.
- [ ] Kill-switch tested: synthetic session that exceeds quota → `state='errored'` + block new session.
- [ ] Invite tokens: unguessable, signed, single-use, time-limited.
- [ ] `VOICE_MODEL` pinned, real-API test passes.

---

## 18. `.claude_learnings.md` — Live It

Append after every non-trivial fix:
```
## YYYY-MM-DD — <short title>
Root cause: <one line>
Fix: <one line, file path>
Lesson: <one line>
```

Read before every debugging session. By month 3, grepping this file for a symptom is faster than re-reading the code.

---

## 19. What NOT to Build

- **Don't pre-model Stripe columns.** Zero `stripe_*` columns in v1 schema.
- **Don't build two scorers for the same thing** unless use cases truly differ.
- **Don't backfill legacy rows silently.** New column → NULL for old rows → old rows invisible until admin reclassifies.
- **Don't mix session detection paths.** Cookie client is canonical on server, localStorage client on browser. They disagree; pick cookie.
- **Don't hardcode creator #1.** Every creator, including Vuk, goes through the real invite → apply → approve flow.

---

## 20. The Two Things to Do Day One

1. **Write `getCallerUserId()`, `assertAdminFromSession()`, and the ownership-check pattern as `src/lib/auth-guards.ts` on day one.** Every security bug was a place where one of these was inlined and slightly wrong.
2. **Treat migrations as code-review artifacts.** Make migration-applied verification a deploy gate.

---

*End of handoff.*
