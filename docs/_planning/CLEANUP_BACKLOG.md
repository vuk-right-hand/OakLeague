# CLEANUP_BACKLOG — orphaned debt on `rag-sota-phase-2-days-8-12`

Captured 2026-05-21. These are **pre-existing items left by prior work**, not
owned by either currently-active workstream (decoupled-brain/failover, RAG
embed). No agent currently owns them — this doc is the checklist so they don't
slip. Each was located + root-caused already; this is triage-and-execute, NOT a
"go read all the code" discovery task.

Companion memory: `project_preexisting_red_pgtap_tests.md` (same items, terse).

---

## ✅ RESOLVED — full pgTAP suite greened (2026-05-22)

The entire `supabase test db` suite is now **225/225 files, 812 tests, deterministically
green** (verified 3× back-to-back). 8 originally-red files were ground out with
evidence that each green = prod-correct (not papered over):

- **7 were genuine TEST bugs** (verdict reached by reading the prod RPC/schema, not
  by bending the test): `creators_retrieval_version` (3a/3b read creators back AS the
  admin under RLS → blind NULL; moved read after `reset_role`; plan 7→8);
  `voice_session_state` (stale `2001`→`4001`, cap deliberately bumped 2000→4000 by
  `20260521000010`); `face_clone_orphan_cleanup` (missing service_role jwt → guard
  raised, 0 tests; + added a self-sufficient ACL assertion); `semantic_query_cache`
  (upsert requires 32-byte sha256, test used 16-byte md5 — proved live: 16B→NULL,
  32B→uuid); `corpus_reprocess_jobs` t10 (reap fencing bumped enqueue_version 1→2;
  pinned in setup); `claim_corpus_reprocess_job` (FLAKY — `created_at DEFAULT now()`
  is frozen at txn-start, `pg_sleep` can't advance it → identical timestamps →
  claim's `created_at,id` FIFO tiebroke on the RANDOM uuid; set explicit distinct
  created_at); `admin_set_retrieval_version_cleans_v2_zombies` (audit-row tie under
  frozen now(); filtered by post-state); `creator_brain_compile_reads` (plan 5→6).
- **1 was a REAL product bug** → see R-1 below.

Auditor (subagent) reviewed the batch + migration: 0 Critical, all Medium/Small
applied. The two RPCs I'd flagged as "possibly real" (`semantic_query_cache_upsert`,
`corpus_reprocess_mark_done`) were proven CORRECT — the tests were the wrong side.

### R-1 · `session_rollover` regression — REAL prod bug, FIXED (migration `20260522000104`)
- **What:** migration `20260521000009` (intent: only add `corpus_version_at_session`)
  silently INVERTED the old-session guard (`ended_at IS NOT NULL → P0006` became
  `ended_at IS NULL → old_session_still_open P0001`), DROPPED the `UPDATE sessions
  SET ended_at` close + session_pauses resolution, and (consequently) charged ZERO
  seconds to quota (elapsed computed from a never-set `ended_at`). `20260522000100`
  carried it forward.
- **Impact:** the client fires rollover at the 15-min Gemini cap with OVERLAP (old
  session still OPEN) and the route never pre-closes → every real rollover hit
  `old_session_still_open` → **paid-tier conversations cut off at 15 min**, and the
  COGS kill-switch was blinded for the rollover charge.
- **Fix:** `20260522000104_session_rollover_restore_close_old_session.sql` restores
  the proven original close-the-open-old-session body + KEEPS the corpus/retrieval
  version snapshot. Regression now pinned by `session_open_hook_creator_mismatch_rejected`
  tests 5 (old row closed) + 6 (snapshot survives).

### C-7 · RAG retrieval-version test suite — second failure layer — ✅ DONE 2026-05-22
All three sub-failures resolved (signature was actually `(uuid, smallint)` — tests
fixed to cast; the `tests.set_role` references were replaced with jwt-set / 
`has_function_privilege`; `corpus_reprocess_mark_done` RPC verified correct, test
t10 was the wrong side). Suite green.

**Still open:** ~~C-5~~ ✅ DONE 2026-05-22 (threaded the truncation signal into the
decoupled early-trigger: skip retrieval + forceBrief + `truncated_turns` metric;
auditor-cleared, 376/376 voice-proxy tests green).

## 2026-05-22 — prod migration apply + creator #1 flag
- **All 8 pending migrations applied to prod** (`supabase db push --include-all`):
  `20260522000104` (session_rollover regression fix), `20260523000004` (12-arg
  COGS leg — fixes the kill-switch-blinding PGRST202 that surfaced in local
  testing-against-prod), `20260523000005` (variable-depth persona) + the
  onboarding/consent/ToS set `000006-000010`. COGS fn verified callable;
  vuk_lehendas recompiled.
- **⚠️ FLAG (tracked in PROD_DEPLOY_GATE):** creator #1 `vuk_lehendas` is live on
  the un-gated decoupled+vector path against a v1 corpus (the "lumberjack" recall
  gap). Decision: leave live, follow up with v2 reprocess / vector-bug clearance /
  drawer-flip before real users hit the feed.

---

## How to use this
Do NOT spawn a generalist agent to "handle all one by one" — the items differ
wildly in size/risk. Trivial ones are minutes with context that already exists;
the PG crash is a real investigation. Slice by risk (below), evidence-first on
the hard ones. Escalate a *single narrow* item to a focused agent only if it
balloons.

---

## TRIVIAL — fix is known, minutes each

### C-2 · `creator_applications.topics` NOT-NULL drift (pgTAP) — ✅ DONE 2026-05-22
- **Symptom:** `null value in column "topics" of relation "creator_applications" violates not-null constraint`.
- **Cause (corrected):** NOT a "drift" — `topics jsonb NOT NULL` (+ `proof jsonb NOT NULL`) has been in the BASE table since `20260420000010`. The 15 affected INSERTs across 7 tests omit BOTH columns (topics just errors first).
- **Fix applied:** added `topics, proof` with valid `'[]'::jsonb, '{}'::jsonb` to all 15 INSERTs (kept the schema's intent — apps must supply topics/proof, like the real submit RPC does; did NOT relax the constraint). Verified isolated against local DB.
- **⚠️ Unmasked a SEPARATE failure layer → see C-7.** Fixing the INSERT let 4 of these tests run further and hit a different, pre-existing red. 4 now fully green: `enqueue_routes_by_retrieval_version`, `creator_embedding_budget_cap_bump`, `creator_brain_compile_reads_retrieval_version` (+ `creator_knowledge_topk_grants` from C-3).

### C-3 · `creator_knowledge_topk_grants` — `role "public" does not exist` — ✅ DONE 2026-05-22
- **Cause:** test cast `'public'::regrole`; PUBLIC is a pseudo-role, not in `pg_roles`.
- **Fix applied:** use the text `'public'` (has_function_privilege accepts it as the PUBLIC pseudo-role — verified on local DB). Test green (3 ok).

### C-6 · maxOutputTokens discarded-output cap — ✅ NOT OURS / owned by the other agent
- The other agent landed this (the cost cap) TOGETHER with the silent-Cartesia race fix in `decoupled-orchestrator.js` (the `resolveSpoken` early-resolve the cap exposed). Confirmed working live ("Vucko speaks", cartesia chars > 0). Their commit, their auditor pass. **Do not touch.**

---

## INVESTIGATION — evidence-first, do NOT guess from reading

### C-1 · `face_clone_finalize_locked_lifecycle.test.sql` CRASHED Postgres — ✅ DONE 2026-05-22
- **Root cause (captured via PG server log = signal 11 SEGV + `RAISE WARNING` bisect):** step 1 used `tests.set_authenticated()` (which does `set_config('role','authenticated')`) then CALLED the SECURITY DEFINER `face_clone_finalize_locked` — a fn that REVOKEs EXECUTE from `authenticated`. On **PostgreSQL 17.6** the grant-check for a no-EXECUTE secdef fn under a `set_config`-switched role **segfaults the backend** (uncatchable) instead of raising permission-denied. The crash → recovery mode → masked every test after `face_clone*`.
- **NOT a prod lock bug** (the original "scary" hypothesis — disproven): prod never has `authenticated` reach finalize (REVOKED + not PostgREST-exposed); nothing in prod does `set_config('role',..)`+privileged-call. Test-only.
- **Fix applied:** step 1 now sets ONLY the jwt (`{role:authenticated}`) WITHOUT switching the DB role → the call enters the body and hits the internal `service_role only` guard cleanly (the test's actual intent). Steps 2-7 get a `service_role` jwt (old `reset_role` set claims `''`, unparseable by finalize). All 7 pass, DB survives. See memory `project_pg17_secdef_role_segfault`.
- **Follow-up (not done here):** the crash no longer cascades, so the back half of the suite is no longer masked. Confirm the WHOLE suite via a full `supabase test db` at the next coordinated reset (resets wipe local data the other agent uses — coordinate).

### C-4 · `/api/admin/corpus-reprocess` → 500 (persistent) — RAG workstream
- **Route is sound** (`src/app/api/admin/corpus-reprocess/route.ts`) — 500 is `enqueue_failed`/`list_failed` bubbling from the RAG RPC (`_admin_enqueue_corpus_reprocess_unsafe` / `admin_list_corpus_reprocess_jobs`).
- **Cause:** RAG RPC erroring on local data state (stale-local-DB class).
- **Related (RAG agent diagnosis, 2026-05-22):** the "lumberjack/monk/hunter story → 'I don't know it'" symptom is the SAME area — sessions run `retrieval_version=2` against `corpus_version=1` (the v2 chunks exist — 89 with parents — but aren't the served version). The reprocess 500 is likely what's blocking the v2 corpus flip + the v2 parent-unit fetch. **Owner: RAG workstream.** The brain correctly declined to fabricate (right failure mode) — gap is retrieval/corpus-version, not the voice path.

### C-5 · decoupled early-trigger returns before `truncationSuspected`
- **Symptom:** a >15s question can be answered from a TRUNCATED transcript with no signal — silent quality loss.
- **Where:** decoupled early-trigger path (voice proxy). Pre-existing, not the failover work.
- **Fix:** thread the truncation signal through the early-trigger return, or defer the trigger until truncation state is known.

### C-7 · RAG retrieval-version test suite — second failure layer (UNMASKED by C-2) ⚠️ NOT OURS
- **Discovered 2026-05-22** once C-2 let these tests run past the INSERT. Distinct root cause from the topics issue; RAG-workstream / test-infra, not the voice/decoupled work.
- **Three sub-failures:**
  1. `admin_set_creator_retrieval_version` **signature drift** — function EXISTS in the DB, but `creators_retrieval_version` + `admin_set_retrieval_version_cleans_v2_zombies` call it as `(uuid, integer)` and that signature doesn't resolve (likely `(uuid, smallint)` or extra args). Either the tests' call or a later migration's signature drifted.
  2. `claim_corpus_reprocess_job` calls `tests.set_role(...)` — a test helper that **exists in NO migration** (`tests` schema has no `set_role`). Test-infra gap.
  3. `corpus_reprocess_jobs` fails at test 10 (`corpus_reprocess_mark_done` matching-version → uuid + status=done) — logic/behavior, needs the RPC examined.
- **Owner:** RAG workstream. Evidence captured here so it isn't rediscovered.

---

## OURS — already understood, trivial, coordinate only

### O-1 · `cogs_insert_brain_leg` PGRST202 (local only) — ✅ DONE 2026-05-22
- Migration `20260523000004` is now applied to the local DB (a recent reset picked it up); the 12-arg `p_service cogs_service` signature is present (verified via `pg_proc`). Deep-answer COGS legs write again locally. Not a prod bug. Resolved.

---

## Benign — do NOT chase (confirmed expected)
- Haiku failover DISABLED locally (`ANTHROPIC_*` secrets unset) = deliberate fail-closed. Expected without Anthropic secrets.
- `[latency]`/`[decoupled]` DIAG logs removed = intentional cleanup. (If still debugging playout, may want them back temporarily — costs observability.)
- `SimliClient FAILED TO SEND FINAL MESSAGE` at teardown predates this work — likely red herring; only chase if it correlates with the no-audio symptom.

---

## DEFERRED — profile/comments/apply system (auditor 2026-05-26, Vuk OK'd skip)

Surfaced by the pre-push auditor on the profile-system merge to main (`6b27bae`).
M1 (URL scheme lock) + M2 (`/v/` nav overlap) were FIXED before push. These two
were consciously deferred with Vuk's sign-off — neither is urgent. Pick them up
when the trigger fires, not before.

### M5 · DB-side shape guard on `submit_creator_application(p_proof)` — defense-in-depth
- **What:** the creator-application `proof` blob (links + courses) is stored verbatim
  as JSONB by the RPC with NO server-side shape check. The ONLY guard is the Zod
  `ProofSchema` in the `'use server'` action (`src/app/apply/actions.ts`), which is
  solid — and as of `6b27bae` also locks URL schemes to http(s) (M1). M5 = add a
  redundant `IF jsonb_typeof(p_proof) IS DISTINCT FROM 'object' THEN RAISE` (and
  optionally reject unexpected top-level keys) INSIDE the RPC so the DB doesn't
  depend solely on one TS call site.
- **Why deferred:** exactly one caller today, already validated. The fix means a
  `CREATE OR REPLACE` of a function the voice/RAG workstream owns (defined in
  `20260523000008_submit_application_with_consent.sql`), pushed to prod — small but
  real risk of breaking live applications if the body is transcribed wrong.
- **TRIGGER — do it when:** a SECOND caller of `submit_creator_application` is added
  (a script, a different route, a re-used RPC), OR you're already editing that RPC
  for another reason (fold it in then). Effort: ~1 migration, low.

### M3 · Re-consent on terms/version bump — un-built P1 + policy decision
- **What:** creators record WHICH version of ToS / voice-likeness consent they
  accepted (`CONSENT_VERSIONS` in `src/lib/consent.ts`). If those terms are ever
  REVISED (version bumped), existing creators are NOT re-prompted to re-agree — they
  stay consented to the stale version. The clone/face gate checks consent EXISTENCE,
  not VERSION (noted in `consent.ts:4-8`).
- **Why deferred:** not a quick code fix — it's a feature (detect version mismatch →
  force a re-consent flow) PLUS a legal/policy call on how term revisions are handled.
  Only matters the day you actually revise the terms; today there's ~1 creator (Vuk).
- **TRIGGER — do it when:** you are about to change ToS or voice-likeness terms (bump
  a `CONSENT_VERSIONS` value). Build the re-consent prompt + decide the policy BEFORE
  the bump ships, so no creator operates on stale consent.

---

## DEFERRED — RAG v3 Step 3 audit round-4 (auditor 2026-05-28, applied inline + flagged)

Surfaced by the post-Step-3 auditor on the v3 lockstep migration set. Criticals: 0.
M1 (DROP CONSTRAINT IF EXISTS), M3 (HNSW partial-index forward note), M4 (NULL-
section_index dedup test), S1/S4/S6 (comment hygiene) FIXED before commit. The
two below are consciously deferred — broader scope than Step 3, no immediate hurt.

### M2 · Slug-rename race on `verify_*_topic_slugs` triggers — 3-table coordinated fix
- **What:** `verify_section_topic_slugs` (migration 20260528000010), `verify_narrative_unit_topic_slugs`
  (20260514000002), and `verify_sample_topic_slugs` (20260420000013) all do an EXISTS
  on `creator_topics` with NO `FOR SHARE` lock. Concurrent worker INSERT of a section
  + admin rename of the slug it references can interleave at READ-COMMITTED such that
  the verify EXISTS sees the OLD slug, the orphan-rename guard on the admin side
  doesn't see the in-flight worker INSERT yet — both commit, leaving an orphan tag.
- **Why deferred:** v3 inherits the v2 bug rather than introduces it. Fixing requires
  a coordinated 3-trigger migration that touches the live v2 path (sample_content +
  narrative_units), and a wrong edit blocks v2 ingest. Lower priority than v3 forward
  motion.
- **TRIGGER — do it when:** an operator first hits the orphan-tag retrieval-recall
  hole in dashboard logs, OR you're already touching one of the verify triggers for
  another reason (fold all three then). Effort: 1 migration adding `FOR SHARE` to
  each EXISTS body.

### M5 · `creator_v3_ready` pgTAP must reject NULL embeddings (when step 6 builds it)
- **What:** plan §6 pins `creator_v3_ready` as a 3-condition check (done job +
  sections + chunks). The Step-3 schema makes `sections.summary_embedding` and
  `sections.centroid_embedding` NULLable during the worker-in-flight window. If
  step-6's implementation forgets to assert `summary_embedding IS NOT NULL AND
  centroid_embedding IS NOT NULL` on every section row, a creator can pass
  `creator_v3_ready` with half-populated section embeddings → admin flips →
  routing RPC scores against partial-NULL → blanks/lag.
- **Why deferred:** the function doesn't exist yet. This is a forward-note for
  step 6's pgTAP, not a Step-3 deliverable.
- **TRIGGER — do it when:** step 6 writes `creator_v3_ready`. The pgTAP MUST
  EXISTS-check a section with NULL embedding and assert the function returns
  false; flip the embedding to non-NULL and assert true. Without this test, the
  silent-NULL-embedding regression has no tripwire.

## DEFERRED — RAG v3 Step 5 audit round-5 (auditor 2026-05-28, applied inline + flagged)

Surfaced by the post-Step-5 auditor on the route_sections_v3 + topk_v3 migrations + tests.
Criticals C1/C2/C3/C4 ALL applied inline; mediums M1/M2/M4/M5/M6/M7 ALL applied; small
S2/S6/S7/S8/S10 applied. Four Smalls deferred — low-impact tidiness, no production hurt.

### S1 · `RAISE NOTICE` when topk_v3 clamps `p_k_child` / `p_n_parent_per_section`
- **What:** mig 20260528000031 silently clamps `p_k_child > 100` → 100 and
  `p_n_parent_per_section > 20` → 20. If the §7 harness passes 200 expecting
  200, harness math gets wrong values with no log trail. Add `RAISE NOTICE
  USING DETAIL='clamped from X to Y'` so the harness telemetry can detect.
- **Why deferred:** the harness operator can grep COMMENT for the limits + the
  clamps are documented. UI callers never pass > the limit. Risk is harness-only.
- **TRIGGER — do it when:** §7 harness is built and during its first dry-run
  someone reports "I asked for 200 candidates and got 100." Same migration can
  fold in `p_top_s` on the route RPC.

### S3 · Promote `pg_temp.unit_vec(int) → halfvec(768)` to a shared test helper
- **What:** `pg_temp.unit_vec` (and the related `two_hot`) is now duplicated
  across `creator_route_sections_v3.test.sql` + `creator_knowledge_topk_v3.test.sql`.
  The next v3 read-path test (eval harness) will copy it a third time. Promote
  to `tests.unit_vec_768(int)` + `tests.two_hot_768(int, int)` in a tests-only
  helper migration.
- **Why deferred:** two copies isn't a real problem. Three copies is. Defer
  until the third test lands.
- **TRIGGER — do it when:** step 7-9 introduces a third v3 retrieval pgTAP that
  needs the same vector helpers.

### S4 + S6 · Topic-tag string + variable-name hygiene in topk_v3 test
- **What:** `'topic-a'` appears ~25 times across the topk_v3 test as a literal
  (extract into `v_topic := 'topic-a'` local). Variable `v_unit_many` was
  pre-rename used for a sec2 unit in test 6 (now `v_unit_sec2`); a few
  comments may still refer to the old name.
- **Why deferred:** pure tidiness, no functional impact.
- **TRIGGER — do it when:** the next edit to topk_v3 test touches >50 lines.

### S9 · `halfvec` vs `halfvec(768)` in COMMENT ON FUNCTION signatures
- **What:** all RPCs use bare `halfvec` in `COMMENT ON FUNCTION …(uuid, halfvec, …)`
  even though the actual param type is `halfvec(768)`. PG accepts both for
  resolution but inconsistent. Decide a convention + pin it across all v3 RPCs.
- **Why deferred:** zero-impact cosmetic; PG resolves both forms identically.
- **TRIGGER — do it when:** any v3 RPC signature changes (fold the convention
  pin into the same migration).
