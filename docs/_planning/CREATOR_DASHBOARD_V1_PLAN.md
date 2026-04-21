# Creator Dashboard v1 — Implementation Plan

**Audits:** 3 rounds · 14 criticals resolved · 0 criticals remaining
**Scope:** `/creator` dashboard + `/creator/brain` knowledge drawers
**Out of scope:** brain-training job, voice/avatar config, publish toggle, Stripe, PostHog analytics for creator actions (defer to feed-phase telemetry)

---

## Schema — One New Migration Required

Almost all schema exists in 0011–0013. One new migration closes the orphan-tag race (NM3):

### `supabase/migrations/20260420000039_creator_topics_delete_orphan_guard.sql`
- [ ] `BEFORE DELETE` trigger on `creator_topics`: if any `sample_content` row for the same `creator_id` has the topic's slug in `topic_tags`, raise `check_violation` (23514) with a specific message (e.g. `topic_referenced_by_sample_content`)
- [ ] Closes the race where a concurrent `addSampleContent` (tab B) slips in between the app's pre-check and `DELETE` (tab A). App-level pre-check still runs first for a friendly error path; trigger is the correctness wall.
- [ ] Trigger owned by `security definer`, search_path pinned, revoke from public (same pattern as `creator_topics_prevent_orphan_slugs`)

### Bake into layer (from actual migrations, verified)

- `creators.user_id` — FK to `profiles.id`. `creators.id` is the FK target for `creator_topics.creator_id` and `sample_content.creator_id` (NOT `user_id`). `assertCreatorFromSession()` returns both — use the right one.
- Topics live in `creator_topics` (slug, title, description, sort_order). No `topics[]` column on `creators`.
- `creators.handle` is `citext`; `creator_topics.slug` is `text`. Always lowercase slugs client-side.
- **`brain_status` enum has 5 values**: `pending | queued | training | ready | errored` (migration 0001).
- `sample_content.fetch_status` reuses `brain_status` enum — distinct display labels from creator-level badge (see NM6 below).
- `sample_content` RLS policy `"sample_content own all"` already exists — do NOT re-add.
- Admin reads `sample_content` via service role only — no admin read policy; enforce as rule.
- DB trigger `verify_sample_topic_slugs` on `INSERT OR UPDATE OF topic_tags, creator_id` — catch ERRCODE `23514`.
- DB trigger `creator_topics_enforce_max_five` on INSERT — catch ERRCODE `23514`.
- DB trigger `creator_topics_prevent_orphan_slugs` blocks slug **RENAME** (`UPDATE OF slug`). The new 0039 trigger blocks **DELETE**.
- `creator_topics.slug` CHECK: `char_length(slug) BETWEEN 2 AND 40` AND regex `^[a-z0-9_-]+$`. **No reserved-slug list on topics** — only `creators.handle` has that (migration 0011). `addTopic` must NOT branch on "reserved" in error messages.
- `sample_content.title` ≤ 200 chars, `raw_text` ≤ 262144 (256KB).
- **v1 app-level cap: ≤ 100 `sample_content` rows per creator** (no DB migration for this; enforce in `addSampleContent`).
- `creators.published_at` CHECK ambush (documented, not a dashboard bug): `CHECK (published_at IS NULL OR brain_status = 'ready')` evaluates on every UPDATE. A `ready → errored` transition on a published creator silently fails unless the job nulls `published_at` in the same UPDATE. Add as TODO for brain-training job owner in `.claude_learnings.md`.

---

## Files

```
supabase/migrations/
  20260420000039_creator_topics_delete_orphan_guard.sql   NEW — DELETE trigger

src/app/creator/
  layout.tsx                     auth guard
  page.tsx                       main dashboard
  brain/
    page.tsx                     knowledge drawers
    actions.ts                   'use server' — topic + sample_content CRUD
  api/brain-status/
    route.ts                     GET: returns { brain_status } for SWR polling

src/lib/creator/
  get-creator.ts                 cached creator fetch (RSC-only)
  validate-url.ts                SSRF-hardened URL check (canonicalizing)
  types.ts                       hand-authored BrainStatus, CreatorRow

src/components/creator/
  BrainStatusBadge.tsx           'use client' — 5-state, SWR, narrowed type
  SampleFetchBadge.tsx           'use client' — fetch_status, different labels
```

---

## Shared Helpers

### `src/lib/creator/types.ts` (hand-authored — Supabase types are `any`)
```ts
export type BrainStatus = 'pending' | 'queued' | 'training' | 'ready' | 'errored';
export type CreatorRow = { id: string; user_id: string; handle: string; display_name: string; bio: string | null; avatar_url: string | null; brain_status: BrainStatus; published_at: string | null; };
```
- Cast at the DB-read boundary in `get-creator.ts`; every downstream component consumes the narrowed types.
- `assertNever(x: never): never` utility for exhaustive switches. Compile check is real because the **input** to the switch is narrowed, even though Supabase's raw response is `any`.

### `src/lib/creator/get-creator.ts` — RSC-only, `React.cache()`-wrapped
- [ ] `export const getCreatorForCaller = cache(async (): Promise<{ userId, creatorId, creator: CreatorRow }> => { … })`
- [ ] **Scope note (NC1):** `React.cache()` dedupes only within a single RSC render tree (layout + page of the same request). Server actions are separate invocations with their own request context — they re-query by design. Plan assumes 1 query for layout+page render, and 1 additional query per action invocation. Do not over-promise.

### `src/lib/creator/validate-url.ts` — canonicalizing SSRF guard
- [ ] `export function assertSafePublicHttpsUrl(raw: string): URL` — throws `ValidationError` with specific codes
- [ ] Parse: `new URL(raw)` → else `invalid_url`
- [ ] `protocol !== 'https:'` → `insecure_scheme`
- [ ] **Hostname canonicalization (NC3):**
  1. Strip trailing dot: `hostname = hostname.replace(/\.$/, '')`
  2. Reject non-ASCII: `if (/[^\x00-\x7f]/.test(hostname)) throw` — caller may punycode first if they want international URLs (v2)
  3. Lowercase: `hostname = hostname.toLowerCase()`
- [ ] **IPv4 detection beyond dotted-quad:** attempt to coerce hostname to an IPv4 integer via:
  - Dotted-quad (4 parts): `node:net.isIPv4()`
  - Decimal (1 part): parseInt base 10, range 0..(2^32-1)
  - Octal (parts starting with `0`): parseInt base 8
  - Hex (`0x…`): parseInt base 16
  - Any of the above → convert to canonical dotted-quad → run CIDR check
- [ ] **CIDR blocks (IPv4):** reject if canonical IP falls in `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4`
- [ ] **IPv6:** `node:net.isIPv6()` → expand to 128-bit BigInt → reject loopback (`::1`), link-local (`fe80::/10`), ULA (`fc00::/7`), IPv4-mapped (`::ffff:x.x.x.x` → recurse through IPv4 check), unspecified (`::`), multicast (`ff00::/8`)
- [ ] **Name-based blocklist** (exact match on canonical hostname): `localhost`, `metadata.google.internal`, `metadata.goog`. Also reject any hostname ending in `.local`, `.internal`, `.localhost`, `.home.arpa`.
- [ ] **Fetcher TODO (documented, not v1):** hostnames can change between submit and fetch. The brain-training job must re-run this check AND pin DNS resolution at fetch time, or use a well-behaved outbound proxy. File: `TODO-SSRF.md`.

---

## Implementation Checklist

### Migration 0039 — `creator_topics_delete_orphan_guard`
- [ ] Function + BEFORE DELETE trigger, raises `check_violation` with message `topic_referenced_by_sample_content`
- [ ] Test: concurrent addSampleContent + deleteTopic — deleteTopic fails after sample_content commits
- [ ] Test: no sample_content for slug → deleteTopic succeeds

### Layout — `src/app/creator/layout.tsx`
- [ ] Call `getCreatorForCaller()`
- [ ] try/catch:
  ```ts
  try { await getCreatorForCaller(); }
  catch (e) {
    if (e instanceof AuthGuardError) {
      if (e.status === 401) redirect('/login');
      if (e.status === 403) redirect('/');
    }
    throw e;  // re-throw anything else
  }
  ```
- [ ] Uses `redirect()` from `next/navigation`, never `router.push()`
- [ ] **Rationale note:** creator layout uses `redirect()` (login prompt for unauth users); admin layout uses `notFound()` (hides existence). Document inline.

### Component — `BrainStatusBadge`
- [ ] `'use client'` directive at top
- [ ] Consumes `BrainStatus` (narrowed hand-authored type), not `any`
- [ ] All 5 states handled with exhaustive switch + `assertNever` default
  - `pending` → grey pill "Setting up"
  - `queued` → grey pill "Training queued"
  - `training` → amber pill "Training your brain…" + SWR polling
  - `ready` → green pill "Ready"
  - `errored` → red pill "Training failed — contact support"
- [ ] SWR polls **`/api/creator/brain-status`** (never the anon client directly — keeps cookie-auth consistent)
- [ ] Polling active only when status ∈ {`pending`, `queued`, `training`}; refresh 10s → exponential backoff to 60s max; hard stop at 10 min → "Refresh to check"
- [ ] SWR `revalidateOnFocus: false`, explicit cleanup on unmount

### Component — `SampleFetchBadge` (distinct from BrainStatusBadge)
- [ ] `'use client'` directive
- [ ] Consumes `BrainStatus` type but **different labels** to disambiguate (NM6):
  - `pending` → "Pending"
  - `queued` → "Fetch queued"
  - `training` → "Pending" (defensive — not set on sample_content in v1)
  - `ready` → "Fetched"
  - `errored` → "Error" (red)

### Route Handler — `src/app/creator/api/brain-status/route.ts`
- [ ] `GET` handler
- [ ] `await getCreatorForCaller()` → returns `{ brain_status: creator.brain_status }` as JSON
- [ ] 401 on auth failure, 403 on non-creator
- [ ] `export const dynamic = 'force-dynamic'` (no caching)
- [ ] Sets `Cache-Control: no-store`

### Page — `/creator`
- [ ] Header: `display_name` + `@handle`, `avatar_url` (placeholder initials from display_name if null)
- [ ] `<BrainStatusBadge initialStatus={creator.brain_status} />` — client poll takes over
- [ ] Topics chips from `creator_topics ORDER BY sort_order, created_at` (stable tiebreak — M4)
- [ ] Profile preview: `bio` truncated at 300 chars + "Read more" toggle — read-only v1
- [ ] "Manage knowledge →" → `/creator/brain`
- [ ] Publish chip: "Live" (green) only if `published_at IS NOT NULL`, else "Not published" (grey)

### Page — `/creator/brain`
- [ ] **Empty state A** (zero `creator_topics`): "Add your first topic to get started" + create form prominent, no accordions rendered
- [ ] **Per-accordion empty state** (topic exists, zero matching sources): "No sources yet for {title} — add one below"
- [ ] **Add topic form** — client validation:
  - `slug = slug.toLowerCase().trim().replace(/\.$/, '')`
  - Regex: `/^[a-z0-9_-]+$/`
  - Length: `2..40` chars
- [ ] **Delete topic button**: server action returns `{ error }` on block; render inline, never raw DB
- [ ] Accordions: one per topic, ordered by `(sort_order, created_at)`
- [ ] **A11y:** accordion uses shadcn/ui Accordion (proper `aria-expanded`, keyboard nav, focus ring). Not custom-rolled.
- [ ] Inside each accordion: list sources via `.overlaps('topic_tags', [slug])` — **JS array form** `['slug']`, NOT PG literal `'{slug}'`
- [ ] Per row: source_type chip, title or truncated URL rendered as `<a href={url} target="_blank" rel="noopener noreferrer ugc">` (NM7), `<SampleFetchBadge status={row.fetch_status} />`, delete button
- [ ] **Add source form** per accordion:
  - `source_type` ∈ `youtube | transcript | book_or_doc | mastermind_or_course | testimonial` (from `sample_source_type` enum)
  - `title` ≤ 200 chars (both client + server validation)
  - `source_url` — validated via `assertSafePublicHttpsUrl`
  - `raw_text` ≤ 262144 chars (both client + server)
  - `topic_tags` — auto-includes current slug, allows adding registered slugs via multi-select

### Server Actions — `src/app/creator/brain/actions.ts`
- [ ] First line: `'use server';`
- [ ] Every action starts: `const { creatorId } = await getCreatorForCaller();` — on throw, returns structured `{ error: 'sign_in_required' }` (no silent RLS failure)

#### `addTopic({ slug, title, description? })`
- [ ] Whitelist: `slug`, `title`, `description`
- [ ] Server-side re-validate slug (regex + length 2..40 — M7) + title (≤ 100) + description (≤ 500 or null)
- [ ] `sort_order`: `SELECT COALESCE(MAX(sort_order), 0) + 1 FROM creator_topics WHERE creator_id = ?`
  - **Race note (NM1):** concurrent inserts can land at same sort_order. No UNIQUE constraint. Query orders by `(sort_order, created_at)` so ties resolve deterministically. Accepted.
- [ ] Insert via `supabaseServer()` with explicit `creator_id: creatorId`
- [ ] Catch `23514` → `{ error: 'topic_limit_reached' }` if message contains "5 topics", else `{ error: 'invalid_topic' }`
  - **Removed (NC4):** no `reserved`-slug branch; no such check exists on `creator_topics`
- [ ] Catch `23505` → `{ error: 'slug_taken' }`
- [ ] `revalidatePath('/creator/brain')` + `revalidatePath('/creator')`

#### `deleteTopic({ topicId })`
- [ ] Fetch slug first (C3 round 2):
  ```ts
  const { data: topic } = await supabaseServer()
    .from('creator_topics')
    .select('slug')
    .eq('id', topicId).eq('creator_id', creatorId)
    .maybeSingle();
  if (!topic) return { error: 'not_found' };
  ```
- [ ] App-level orphan pre-check (friendly error path):
  ```ts
  const { data: refs } = await supabaseServer()
    .from('sample_content')
    .select('id').eq('creator_id', creatorId)
    .overlaps('topic_tags', [topic.slug])
    .limit(1);
  if (refs && refs.length > 0) return { error: 'topic_has_sources' };
  ```
- [ ] Delete scoped by `id` AND `creator_id`
- [ ] **Race closure:** if concurrent insert slips in, migration 0039 trigger raises `23514` with `topic_referenced_by_sample_content` → map to `{ error: 'topic_has_sources' }`
- [ ] `revalidatePath('/creator/brain')` + `revalidatePath('/creator')`

#### `addSampleContent({ source_type, title?, source_url?, raw_text?, topic_tags })`
- [ ] Whitelist exactly those fields
- [ ] Validate `source_type` ∈ enum values
- [ ] `title` ≤ 200 chars (small #3)
- [ ] If `source_url` → `assertSafePublicHttpsUrl(source_url)` — canonicalizing check (NC3)
- [ ] `raw_text.length <= 262144`
- [ ] `topic_tags.length >= 1` (JS — `cardinality` is PG-only; small #2)
- [ ] Row quota: `count(*)` where `creator_id = ?`; if `>= 100` → `{ error: 'source_quota_reached' }`
  - **Race note (NM2):** count + insert not atomic. Two concurrent writes at 99 can produce 101. Accepted for v1; document.
- [ ] Insert via `supabaseServer()` with explicit `creator_id: creatorId`
- [ ] Catch `23514` → `{ error: 'invalid_topic_tags' }` if message contains "unregistered slugs", else `{ error: 'invalid_source' }`
- [ ] `revalidatePath('/creator/brain')` + `revalidatePath('/creator')` (defensive — `/creator` may add source counts later; small #5)

#### `deleteSampleContent({ id })`
- [ ] `.delete().eq('id', id).eq('creator_id', creatorId).select('id')` — `.select()` chained so `data` is populated (C4 round 2)
- [ ] `if (!data || data.length === 0) return { error: 'not_found' };`
- [ ] `revalidatePath('/creator/brain')` + `revalidatePath('/creator')`

---

## Tests

### Migration / DB
- [ ] Migration 0039 trigger: DELETE fails with `23514` / `topic_referenced_by_sample_content` when sample_content references slug
- [ ] Migration 0039 trigger: DELETE succeeds when no references
- [ ] Concurrent addSampleContent + deleteTopic race: trigger fires, no orphan tags

### RLS
- [ ] `creator_topics` RLS: creator A cannot SELECT or INSERT on creator B
- [ ] `sample_content` RLS: creator A cannot SELECT or mutate creator B
- [ ] `deleteSampleContent` wrong-owner → `{ error: 'not_found' }` (no crash — C4 round 2)

### Server Actions
- [ ] `addTopic` 6th insert → `topic_limit_reached`
- [ ] `addTopic` duplicate slug → `slug_taken`
- [ ] `addTopic` no `reserved` branch exists — unreachable branch removed (NC4)
- [ ] `addTopic` sort_order = max+1 (sequential); collision acknowledged for concurrent (NM1)
- [ ] `deleteTopic` fetches slug first; referenced slug → `topic_has_sources`, no DELETE
- [ ] `addSampleContent` with unregistered slug → `invalid_topic_tags`
- [ ] `addSampleContent` at row 101 → `source_quota_reached`
- [ ] Stale-session action call → `sign_in_required`, not opaque DB error

### URL validator (SSRF — NC3)
- [ ] `http://example.com` → `insecure_scheme`
- [ ] `https://169.254.169.254/` → blocked (IPv4 link-local)
- [ ] `https://2130706433/` → blocked (decimal-encoded 127.0.0.1)
- [ ] `https://0177.0.0.1/` → blocked (octal 127.0.0.1)
- [ ] `https://0x7f000001/` → blocked (hex 127.0.0.1)
- [ ] `https://127.1/` → blocked (short-form 127.0.0.1)
- [ ] `https://localhost/` → blocked
- [ ] `https://localhost./` → blocked (trailing dot stripped)
- [ ] `https://[::1]/` → blocked (IPv6 loopback)
- [ ] `https://[::ffff:7f00:1]/` → blocked (IPv4-mapped IPv6)
- [ ] `https://[fe80::1]/` → blocked (link-local)
- [ ] `https://metadata.google.internal/` → blocked
- [ ] `https://foo.internal/` → blocked (tld match)
- [ ] `https://exämple.com/` → blocked (non-ASCII, v1)
- [ ] `https://example.com/path` → passes

### UI
- [ ] BrainStatusBadge renders 5 states; adding a 6th enum value triggers TS error via `assertNever`
- [ ] SampleFetchBadge uses distinct labels from BrainStatusBadge (no "Training queued" for a source row)
- [ ] `/creator/api/brain-status` returns JSON, cookie-authed, no-store
- [ ] External source URLs render with `rel="noopener noreferrer ugc" target="_blank"` (NM7)
- [ ] Accordion a11y: arrow keys navigate, `aria-expanded` toggles, focus visible

---

## Audit Notes (historical)

### Round 1 — Criticals (resolved)
- **C1:** Actual schema uses `creators.user_id` + `creator_topics` table, not `profile_id` / `topics[]`
- **C2:** `sample_content own all` RLS already exists in 0013
- **C3:** `supabaseAdmin()` for guard only; `supabaseServer()` for mutations
- **C4:** DB trigger enforces topic_tags; app catches `23514`
- **C5:** Topic CRUD + empty-state guard added

### Round 2 — Criticals (resolved)
- **C1 R2:** `brain_status` enum has 5 values incl. `queued` — all UI handles
- **C2 R2:** `addTopic` passes explicit `creator_id: creatorId` in insert (RLS WITH CHECK)
- **C3 R2:** `deleteTopic` fetches `slug` before orphan check
- **C4 R2:** `.delete()` chains `.select('id')` so `data` populated
- **C5 R2:** Initial SSRF helper added (hardened further in R3)

### Round 3 — Criticals (resolved this revision)
- **NC1:** `React.cache()` scope explicitly documented — RSC-tree only; actions re-query by design
- **NC2:** Hand-authored `BrainStatus` type + cast at DB boundary — `assertNever` compile check now real (Supabase returns `any`)
- **NC3:** SSRF validator canonicalizes IPv4 (decimal/octal/hex/short-form), strips trailing dots, rejects non-ASCII, expands IPv6 to BigInt for CIDR check. `node:net.isIP` used, not regex-only.
- **NC4:** Removed dead `reserved`-slug branch from `addTopic` error mapping — no such trigger on `creator_topics`

### Round 3 — Mediums addressed
- **NM1:** sort_order race documented as accepted (deterministic tiebreak via `created_at`)
- **NM2:** 100-row quota race documented as accepted
- **NM3:** New migration 0039 — BEFORE DELETE trigger on `creator_topics` closes orphan race (correctness wall)
- **NM4:** SWR polls `/api/creator/brain-status` route handler (cookie-auth consistent)
- **NM5:** `published_at` CHECK ambush documented as TODO for brain-training job owner
- **NM6:** `SampleFetchBadge` has distinct labels ("Fetch queued") from `BrainStatusBadge` ("Training queued")
- **NM7:** External URLs render with `rel="noopener noreferrer ugc" target="_blank"`

### Round 3 — Smalls folded in
- `'use client'` directive on both badge components
- JS uses `.length`, not PG `cardinality`
- `title` 200-char cap listed in server-side validation
- `node:net.isIP()` committed as library choice
- `/creator` revalidate on source mutations documented as defensive (future count UI)
- Accordion a11y spec'd via shadcn/ui primitives
- PostHog analytics for creator actions: **out of scope** (deferred to feed-phase telemetry)
- Header bumped to "3 rounds · 14 criticals resolved"
- `redirect()` (creator) vs `notFound()` (admin) rationale documented inline in layout
