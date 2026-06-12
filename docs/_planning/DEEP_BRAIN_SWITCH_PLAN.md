# Deep Brain Switch — Implementation Plan (v2, post-audit)

**Status:** Pre-build. Drafted 2026-06-08, revised after round-1 hostile audit (5 Critical / 7 Medium). Owner: Vuk.
**Decision:** Option A — user-facing creator switch (not auto-on-onboarding). Memory `project_deep_brain_switch`.
**Branch:** new `feat/deep-brain-switch` off `main`.

---

## 0. Summary

Creator dashboard gets a **Deep Brain** card. Copy: *"Ingesting a book or 1000+ hrs? Turn on Deep Brain."* Enable → enqueue a v3 corpus build for ready samples → "Building your deep brain…" with progress + queue position → when `creator_v3_ready()` is true, auto-activate → flip `retrieval_version=3` (gated, atomic, advisory-locked, persona recompiled) → "Deep Brain ON." Reuses the live v3 worker, `creator_v3_ready`, `_creator_brain_compile_unsafe`, and the soft-cutover flip semantics. Only new code: creator-scoped RPCs (ownership via `auth.uid()`), a creator audit sink, routes, UI.

## 1. Reuse (do NOT rebuild)
Same as v1: v3 retrieval (live), `embed-worker.js` (Fly, processes `target_version=3` — verified `embed-worker.js:1772`), `creator_v3_ready` (granted authenticated), `_creator_brain_compile_unsafe`, the admin flip's →3 branch as parity source, `assertCreatorFromSession`, the `brain-status` poll pattern. Worker writes `cogs_log` for v3 builds (verified) and enforces a per-creator daily embedding USD cap (`creator_embedding_budget_accumulate_and_check`) — **that cap is our real COGS floor**, not a new kill-switch.

---

## 2. AUDIT RESOLUTIONS (round 1) — these are now requirements

| # | Finding | Resolution baked into the steps below |
|---|---------|----------------------------------------|
| **C1** | `admin_audit_log.admin_user_id` FKs to `admin_roles` — a creator's uid isn't there → the audit INSERT `23503`-violates and rolls back the WHOLE RPC. Feature dead on first click. | **New `creator_audit_log` table** (FK `auth.users(id)`, RLS service-role-only + GRANT footer) in the same migration. Creator RPCs audit there, never to `admin_audit_log`. pgTAP asserts a non-admin uid inserts fine. |
| **C2** | `creator_activate` omitted the `pg_advisory_xact_lock(hashtext('reprocess:'||id))` the real flip takes (mig 20260531000001:84-86) BEFORE `FOR UPDATE`. Without it, activate can run the readiness gate + flip interleaved with the worker's `finalize_v3` (same lock key) → read a half-built corpus → "he blanks every turn." | **Extract a shared `_set_retrieval_version_v3_unsafe(p_actor uuid, p_creator_id uuid)` core** (advisory lock → FOR UPDATE → same-version no-op → `creator_v3_ready` gate → UPDATE →`_creator_brain_compile_unsafe`). Both `admin_set_creator_retrieval_version`'s →3 path AND `creator_activate_deep_brain` call it. Parity is structural, not copy-paste. Refactoring the admin RPC → **update its pgTAP + run FULL suite in the same change** (blast-radius rule). |
| **C3** | `rate_limit_hit` RAISES `22023` on any window ≠ `'1 minute'` (mig 20260503000009). A `'24 hours'` enable cap would throw → 500 on every enable. (Same class of bug as the /request P0 found this session.) | **No enable rate-limit at all.** Enable is a ONE-WAY switch (Vuk, 2026-06-08): once on v3 the RPC refuses (C4), so double-clicks are no-ops and can't re-bill. Cost ceiling is the worker's existing per-creator embedding USD cap. (If a `rate_limit_hit` call is ever added elsewhere, only `'1 minute'` is legal; use `rate_limit_hit_day` for daily.) |
| **C4** | Plan's enqueue `ON CONFLICT ... DO UPDATE SET status='pending' WHERE status IN ('done','errored')` resets **done** jobs → a re-enable force-re-embeds the whole corpus = repeated Anthropic+Gemini spend. | Enable **only enqueues samples with NO `done` v3 job**; and **refuses entirely once `retrieval_version=3` OR `creator_v3_ready()` is already true**. Content edits already re-enqueue via the on-edit trigger — the button never forces a re-embed of unchanged samples. (Don't reset `done`; only resurrect `errored` with an explicit comment that a genuinely-broken sample re-bills its failed pipeline.) |
| **C5** | Single Fly worker, `LIMIT 1` per 5s tick, global FIFO by `created_at`. Two creators building at once → the second sees "Building…" with zero progress for the duration of the first's book = looks hung = launch-day shame. | Status endpoint computes **queue depth ahead of this creator** ("N jobs ahead of you"). BUILDING UI shows position + honest "large corpora take a while." **Stall state** (oldest pending older than threshold with no `processing` advancing) → "Deep Brain is backed up, try later" instead of a forever-spinner. Calibrate copy to real per-book wall-clock. |
| **M1** | Cross-tab auto-activate double-fire writes a duplicate audit row. | Idempotent `already:true` branch `RETURN`s **before** any audit write (mirror admin flip 20260531000001:96-98). |
| **M2** | "via supabaseAdmin().rpc(...) via JWT-bound supabaseServer()" is self-contradictory — service-role makes `auth.uid()` NULL → `not_a_creator` for everyone. | RPCs that read `auth.uid()` are called **only via `supabaseServer()` (JWT)** — exactly the pattern in `creator-retrieval-version/route.ts:66-89`. Never pass the route's `creatorId` as a param (would reintroduce IDOR). |
| **M3** | Status COUNT must filter `target_version=3` AND the **server-derived** creator_id; `corpus_reprocess_jobs` is RLS deny-all. | A creator-scoped SECDEF read RPC (or `supabaseAdmin()` with a hard `WHERE sample_content.creator_id = <derived>` AND `target_version=3`). creatorId always from `assertCreatorFromSession`, never a query param. |
| **M4** | Enabling/activating while `brain_status='errored'` (or unpublished) builds into a void / can make recompile raise a confusing 500. | Gate Enable on `brain_status <> 'errored'`; surface a "finish setup first" state. Verify `_creator_brain_compile_unsafe` RAISES (not swallows) so the activate stays atomic (R7). |
| **M5** | `creator_v3_ready(uuid)` is authenticated-callable with ANY id (existing IDOR-shaped boolean probe). | Call it only with the server-derived creatorId. Flag the existing surface; don't widen its return without an ownership check. |
| **M6** | No `revalidatePath('/creator')` after mutations → stale server-rendered card. | `revalidatePath('/creator')` after enable + activate. |
| **M7** | Adding `retrieval_version` to `get-creator.ts` select + `CreatorRow` is a typed-shape change with consumers. | Grep all `CreatorRow` consumers, update in same change, make the field **non-optional** so a miss is a compile error. Run full build. |
| **S1/S2/S5/S6** | reset `finished_at` on re-enqueue; discriminate `no_ready_samples` on the message token not bare `P0001`; add a JWT-only `not_a_creator` authz test (NOT role-switch — PG17 segfault); comment the errored-rebill. | Folded into steps. |

---

## 3. Build steps (TDD)

**Step 1 — Migration `20260608000001_deep_brain.sql`:**
1. `CREATE TABLE creator_audit_log` (id, user_id uuid NOT NULL REFERENCES auth.users(id), action text, target_id uuid, before jsonb, after jsonb, created_at) — RLS on, zero policies, `GRANT ALL TO service_role` (C1).
2. `_set_retrieval_version_v3_unsafe(p_actor uuid, p_creator_id uuid)` — the shared →3 core (advisory lock → FOR UPDATE → same-version RETURN-before-audit → `creator_v3_ready` gate → UPDATE 3 → recompile → audit to the actor's appropriate log). (C2/M1)
3. Rewrite `admin_set_creator_retrieval_version`'s →3 path to call the core (passing admin uid; audits to admin_audit_log at the wrapper). **Update its pgTAP, run full suite.** (C2 blast-radius)
4. `creator_enable_deep_brain()` — derive own creator from `auth.uid()` (`not_authenticated`/`not_a_creator`), require `brain_status<>'errored'` + ≥1 ready sample (`no_ready_samples`), **refuse if already v3/ready**, enqueue only ready samples lacking a `done` v3 job (reset `finished_at`; resurrect only `errored`), audit to `creator_audit_log`. (C4/M4/S1)
5. `creator_activate_deep_brain()` — derive own creator, call `_set_retrieval_version_v3_unsafe(auth.uid(), own_id)`, audit to `creator_audit_log`. (C2)
6. SECDEF footers on all: `REVOKE ... FROM public, anon; GRANT EXECUTE ... TO authenticated;` — none take a creator_id param.

**Step 2 — pgTAP `creator_deep_brain_rpcs.test.sql`:** enable (enqueues only un-built ready samples; idempotent; refuses when already v3; `no_ready_samples`; errored-brain refused), activate (`creator_v3_not_ready` gate; flips when ready; idempotent; recompiles), `creator_audit_log` accepts non-admin uid (C1), JWT-only `not_a_creator` authz test (S5), grant shape via `has_function_privilege`, full-suite parity after the admin-RPC refactor.

**Step 3 — Routes** (`assertCreatorFromSession`, same-origin + JSON-CT on POST, RPCs via `supabaseServer()` JWT — M2):
- `POST /creator/api/deep-brain/enable` — RPC → `revalidatePath('/creator')`. No rate-limit (one-way switch; idempotent RPC + worker embedding cap are the guards — C3/C4). Map `no_ready_samples`/errored→422.
- `GET /creator/api/deep-brain/status` — `{retrieval_version, ready, counts(target_version=3, own creator), queue_ahead, oldest_pending_age}` (M3/C5). no-store.
- `POST /creator/api/deep-brain/activate` — RPC → `revalidatePath('/creator')`. `creator_v3_not_ready`→409.

**Step 4 — UI `DeepBrainPanel.tsx`** on `/creator`: OFF/BUILDING(progress + "N ahead" + stall→backed-up)/ACTIVATING(single auto-POST, double-fire guarded)/ON. Disabled "Add knowledge first" at 0 ready; "Finish setup first" when errored. Initial `retrieval_version` from `getCreatorForCaller` (add field — M7).

**Step 5 — Build + FULL pgTAP + auditor re-pass + commit (no push).** Re-audit-after-building is SOP here (Vuk, 2026-06-08) — non-negotiable because Step 1.3 refactors a live admin RPC that serving v3 creators depend on.

## 4. Out of scope
Tier/paywall gating; creator-facing downgrade/rollback/purge; auto-onboarding; creator v1-vs-v3 viewer (defer).

---

## 5. BUILD LOG + SOP re-audit resolutions (2026-06-08)

Built end-to-end. Full pgTAP green (1096 tests, incl. 17 new in `creator_deep_brain_rpcs.test.sql`); full `npm run build` green. SOP re-audit ran on the BUILT code (mandatory — refactored a live admin RPC).

**Re-audit verdict:** admin-RPC refactor is **behavior-preserving** (→1/2 path byte-equivalent vs 20260531000001; →3 path produces identical end-state + audit row; advisory key matches finalize/claim). **Zero criticals.** Resolutions applied:
- **M5 (fixed)** — `creator_enable_deep_brain` buildable/enqueue predicate aligned to `fetch_status='ready' AND raw_text IS NOT NULL` (was `raw_text` only), matching `creator_v3_ready`'s gate so a creator can't build yet never activate. Regression test 17 added.
- **M2 (fixed)** — partial index `corpus_reprocess_jobs (created_at) WHERE status='pending'` for `queue_ahead`.
- **M3 (fixed)** — auto-activate retries only on a FRESH `ready` read after a 409 (no stale-`ready` hot-loop contending the finalize advisory lock).
- **M6 (fixed)** — OFF state surfaces a prior failed build (`errored` jobs) + "Retry" instead of a silent OFF.
- **S1 + Activating state + STABLE marker (fixed)** — `brain_errored` token mapped in UI; distinct "Activating…" state; `creator_deep_brain_status` marked STABLE.

**Deferred (with rationale):**
- **M1 — build-COGS cap covers only embedding USD, not the Flash (narrative-chunk) + Anthropic (contextual-gen) spend.** Not changed now: enable is restricted to *admin-approved* creators (a creators row only exists post-approval), corpora are quota-bounded (`SAMPLE_ROW_QUOTA=100` × 256KB raw_text), and re-enable is idempotent (C4 — one build, no re-spend), so realistic spend is "one bounded build per approved creator." The proper fix (fold Flash+Anthropic into a unified per-creator daily build budget in `embed-worker.js`) is a **worker-track** change with its own COGS-accounting tests — owed follow-up, not a launch blocker.
- **M4 — enable is NOT gated on `published_at`.** By design: Deep Brain is a brain-setup step that happens BEFORE admin publish, so gating on published would break the intended flow. The admin-approval gate (above) bounds the spend surface.
