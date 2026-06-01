# ✅ V3 PRE-FLIP GATE — UX P0s DONE + min_sim CALIBRATED (2026-06-01)

The v3 schema + proxy + admin UI are LIVE on prod (dormant). A whole-build UX+security
audit (2026-06-01) ran before the main merge. **Security C1/H1 (live cross-tenant corpus
leak) is FIXED + on prod (mig 20260601000001, commit b26c0a8, anon probe verified 42501).**
**The 3 UX P0s are now FIXED** (full plan→2× plan-audit→build→code-audit loop, 0 Critical/
Medium; vitest 1229✓, proxy node:test 444✓, build green) and **min_sim is CALIBRATED**
(aod sweep 2026-06-01). The ONLY remaining gate before a creator v3 flip (Phase 3) is the
**live human "is it him" voice test** on a flipped scratch creator — an in-person check, not
automatable here.

- **UX P0-1 — silent pre-answer gap → DONE.** Added a `thinking` PipeState (mic disabled
  during it) + three pulsing `ThinkingDots` + a ref-based turn-dead watchdog (35s → existing
  `reconnecting`). `session-reducer.ts` / `use-session-pipe.ts` / `session-client.tsx`.
- **UX P0-2 — raw error-code leak → DONE.** Pure `resolveAskErrorDisplay` (`ask-error-copy.ts`)
  maps known codes to human copy; generic fallback NEVER prints a raw code. `ask-error-pill.tsx`.
- **UX P0-3 — confident ungrounded answers → DONE.** Two-branch grounding: off-domain (soft
  in-voice hedge) vs retrieval-failure ("give me an example"), via a `t.retrieveFailed` flag +
  `groundingState` in `decoupled-orchestrator.js` → hedge clause appended LAST in `brain-bridge.js`.
  Off-domain copy gated by `V3_OFF_DOMAIN_HEDGE_ENABLED` (default OFF).
- **min_sim — CALIBRATED, no change needed.** The aod sweep (113 grid points) showed
  topk_min_sim/route_min_sim have NO recall effect across [0,0.3]; off-topic returns empty at
  floor 0 (routing does the rejection). The placeholder floors (`max_blend=0.20`, `vec_max=0.40`)
  are validated-safe; env-overridable via `V3_MIN_SIM_*` (`v3-min-sim.ts`). Because the floor
  doesn't drop on-domain hits, `V3_OFF_DOMAIN_HEDGE_ENABLED=1` is safe to flip at prod when wanted.

UX P1s (track, not gate): P1-1 barge tail ~250ms (simli-bridge.ts:507 — mute local sink on
cancel); P1-2 7s silence cutoff too aggressive (use-session-pipe.ts:1153 → ~10-12s); P1-4
rollover fires mid-turn (gate timer on turn-idle, use-session-pipe.ts:1006); P1-5 withDeadline
doesn't cancel inner query (abortSignal). Security (track, not block): M2 60s HMAC replay
window (no nonce store); M3 ingest /api/internal/* routes use plain-bearer not HMAC; M5 GC
preview 1000-row count cap (cosmetic). Full reports: UX auditor + security auditor, 2026-06-01.

---

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

## DEFERRED — RAG v3 Step 6b+6c audit round-5 (auditor 2026-05-28, applied inline + flagged)

Auditor surfaced 4 Critical + 7 Medium + 7 Small on the v3 application-layer wiring.
C1/C2/C3 applied inline (the dropped-v3-parents bug at resolveInjectionAtTurnComplete,
cache poisoning under flat-fallback or topic_tags, flat-fallback budget/cap).
M1/M2/M3/M4/M5/M6/M7 applied. Smalls S2/S4/S6/S7 deferred below; C4 deferred.

### C4 · AbortController doesn't propagate from proxy through HTTP to the orchestrator
- **What:** Barge-in (proxy `ac.abort()`) cancels the HTTP fetch from proxy → Vercel
  but not the orchestrator running on Vercel. `retrieveKnowledgeV3` runs to completion
  server-side, incrementing budget + writing cogs_log for paid legs the user never
  heard. A barge-happy session burns 2-3× budget. CLAUDE.md COGS kill-switch at 150%
  trips silently after three such sessions.
- **Why deferred:** auditor explicit: "defer until rest of v3 ships, but MUST land
  before flipping any second creator to v3." First creator (Vuk-dogfood) is acceptable
  acceptance loss; second creator is not.
- **TRIGGER — do it before:** flipping a SECOND creator to retrieval_version=3. Fix
  shape: thread `req.signal` (or derived AbortController) through `RetrieveKnowledgeV3Args`
  and into every `withDeadline` call site via `.abortSignal()` on supabase-js builders
  + the rewrite/embed/rerank bridges. Same fix wanted for v2.

### Cache-key extension to include topic_tags + rank_mode (related to C2 partial fix)
- **What:** C2 was applied as a CONSERVATIVE gate (don't upsert when flatFallbackFired
  OR topicTags set). The proper fix is to extend semantic_query_cache's key from
  `(creator, corpus_version, query_vec)` to include topic_tags_hash + rank_mode so
  ALL v3 turns can cache safely. Today: v3 turns with topic_tags get full RAG cost
  every time (no cache benefit).
- **Why deferred:** schema change touching the cache table, RPC migration for the
  lookup/upsert functions, and the harness needs to pin topic_tags presence per
  creator. Substantial.
- **TRIGGER — do it when:** harness §7 measures v3-with-topic-tags p50 latency
  cost vs the v3-without-topic-tags baseline and the gap matters. Or when the
  first creator's v3 cache-hit rate is materially worse than their v2 rate.

### S2 · `lambda` Zod max=10 vs plan §3b "0..1 blend weight"
- **What:** `route.ts` Zod schema accepts `lambda: z.number().min(0).max(10)`. Plan
  §3b describes lambda as a small `~0.05` blend weight, but the topk_v3 migration
  comment (round-5 M2 fix) explicitly widened the clamp to [0, 10] so the §7 harness
  can sweep the high end. Schema upper bound and plan-text disagree at first glance.
- **Why deferred:** intentional widening per harness sweep request. Add an explicit
  "harness override" note in the schema's z.number() to make the intent visible.
- **TRIGGER — do it when:** §7 harness lands and freezes the prod lambda value.

### S4 · `pathTokenToVersion` helper (proxy v=3 reverse-map duplication)
- **What:** `kickoffRetrieval` in proxy index.js manually decodes the chokepoint
  token back to an integer: `version: pathToken === 'v3' ? 3 : 2`. Only one site
  today; a future v4 path would need to remember this decode site.
- **Why deferred:** one site = no duplication. Promote when a SECOND site needs it.
- **TRIGGER — do it when:** any second site needs token→integer mapping.

### S6 · `RetrieveLeg.candidatesFromScope` should default to 0 not undefined
- **What:** type is `number | undefined`. Dashboards that `SUM(candidates_from_scope)`
  need `COALESCE(..., 0)` to handle v1/v2 rows that don't set it. Default to 0 in
  the type so the orchestrator can't accidentally leave it undefined.
- **Why deferred:** v1/v2 paths never set RetrieveLeg.candidatesFromScope at all,
  so changing the type narrowing requires updating both orchestrators. Low impact.
- **TRIGGER — do it when:** any dashboard query trips on the COALESCE missing.

### S7 · Integration test: proxy NULL retrieval_version_at_session must fail loud
- **What:** M3 fixed the loader to throw on NULL via `resolveRetrievalPath`. There's
  no test that inserts a `sessions` row with NULL snapshot and asserts the proxy
  closes the WS loud (vs silent v1 degrade).
- **Why deferred:** requires an integration test fixture that goes through the WS
  open path with a corrupted session snapshot — not easy in vitest given the proxy
  has no test surface yet. node:test on `loadSessionForTicket` directly is more
  feasible.
- **TRIGGER — do it when:** writing the next proxy node:test suite (e.g., when
  the v3 dispatch site gets its own integration test).

---

## v3 ingest bulletproofing — round-2 audit follow-ups (2026-05-29)

Deferred items from the round-2 audit of the "no silent word-loss" ingest change
(section-coverage.ts + route never-null + worker rescue/backstop + creator_v3_ready
count invariant). Core findings applied in the same change; these are the
explicitly-deferred ones.

- **NARRATIVE_CHUNK_MODEL pin (round-2 C1) — DECISION OWED TO VUK.** The v3 section
  chunker defaults to the bare alias `gemini-2.5-flash` (narrative-chunk.ts:37),
  which (a) is mutable/unversioned and (b) is slated for **deprecation ~June 2026**
  per Google's forum (verified 2026-05-29). The coverage-gate determinism rationale
  leans on temp-0 output stability, which a silent backend swap undercuts. NOT
  blind-pinned in the bulletproofing commit because choosing the replacement string
  needs its own verification pass (which dated GA tag is current + not deprecating)
  AND the 0.85/0.90 coverage floors should be re-derived against whatever model is
  pinned. **TRIGGER:** before the v3 prod cutover (Step 9) — pin NARRATIVE_CHUNK_MODEL
  to a verified dated string on Fly+Vercel, re-run the AoD ingest, confirm the
  observed per-section coverage min stays well above the floors.

- **Coverage gate flip-flop persistence (round-2 M1) — ACCEPTED, not implemented.**
  Even at temp 0, a borderline section can flip Flash-units↔verbatim across
  re-claims, bumping current_corpus_version + re-embedding. Bounded (one section per
  flip) and largely moot because the additive build already DELETEs+rebuilds the
  whole sample on every re-claim regardless. If flip churn ever shows up in cost
  telemetry, persist the decision: store fallback_reason + a section-text hash on
  sample_content_sections and skip Flash on clean re-claim when the hash is unchanged.

- **flash_failed COGS under-count (round-2 Small) — ACCEPTED.** route.ts buildFallback
  reports usage {0,0,0} on the flash_failed path, discarding the two failed Flash
  attempts' input-token spend (narrativeChunkSection returns null without surfacing
  usage). Small undercount; fix would require threading failed-attempt usage out of
  narrativeChunkSection.

---

## Creator-facing ingest-failure UX (raised by Vuk 2026-05-30)

The v3 bulletproofing makes ingest failure **fail-closed + operator-loud** (errored
job row + Sentry + creator_v3_ready=false blocks the flip, so a half-book never
reaches a viewer). But the CREATOR who uploaded is NOT auto-notified "chapter XYZ
errored, resubmit it":
- creator brain-status API (`/creator/api/brain-status`) reads `sample_content.fetch_status`
  (upload status), NOT the corpus_reprocess_jobs status → a v3-job error is invisible there.
- embed-worker.js never calls the `creator_brain_mark_errored` helper (0 brain refs) →
  `brain_status` doesn't flip on a v3 ingest failure.
- brain page `errored` copy is generic ("our team will take a look"), not per-chapter,
  no self-serve resubmit.
**To close (a dedicated unit):** (1) worker calls creator_brain_mark_errored on terminal
v3 failure; (2) brain-status route surfaces per-sample reprocess-job status; (3) brain
page shows which chapter failed + a re-enqueue/resubmit action; (4) tests.
**Acceptable for v1** (invite-only, hands-on admin re-enqueues) — TRIGGER: when creator
count grows past hands-on, or before self-serve creator onboarding GA.

---

## v3 ingest: re-upgrade a verbatim-fallback section to AI-chunking (Vuk 2026-05-30)

Decision-gated on the sweep. IF AI-chunking is even marginally better than verbatim
(quality/latency/UX), then a section that fell to verbatim because Flash transiently
failed must NOT be permanently stuck on the inferior path. Desired lifecycle:
  ai-chunking attempt → fails → verbatim (words safe, creator can go live) →
  LATER re-attempt ai-chunking → if it succeeds, UPGRADE that section in place → done.
So verbatim is a temporary safety net, not a permanent downgrade.

Why it's not in the current commit: today a verbatim section only gets re-attempted
if the WHOLE sample is re-enqueued (which re-runs every section). We want a
per-section, idempotent re-attempt that only re-does the verbatim-flagged sections.

Design sketch (revisit AFTER the sweep confirms the gap is worth it):
- Persist on sample_content_sections: a `fallback_reason` (already emitted by the
  route) + a section-text hash, so a re-claim can tell verbatim-fallback sections
  from healthy ones.
- A low-priority re-attempt pass (cron or admin button) that, for sections flagged
  verbatim, re-runs ONLY narrative-chunk-section; on success swaps that section's
  units/chunks/centroid atomically + clears the flag; on fail leaves verbatim intact.
- Bounded retries + backoff so a permanently-pathological section doesn't loop.
- This pairs with the already-logged "flip-flop persistence" item (store the decision
  so temp-0 borderline sections don't oscillate).
TRIGGER: after the sweep, IF we keep AI-chunking as the primary path (not verbatim-only).

---

## v3 config FROZEN + decisions (Vuk + sweep, 2026-05-30)

**DECIDED — keep AI-chunker as the single primary path; NO verbatim-only mode.**
Reasoning (Vuk): AI-chunker COGS on a small creator is negligible (cents/book, one-
time), so verbatim-only would not save meaningful money; it WOULD add a second code
path, a "small vs big" threshold nobody can define ("who's gonna count the words?"),
and more places to fail. Keep infra lean = one path. Verbatim stays ONLY as the
never-lose-a-word fallback inside the AI path (already shipped, commit 942283d).
The scale argument reinforces this: at company-brain scale (YC use case — 10M+ words,
5yr Slack/email/drive × employees → 5k-50k sections) ROUTING is the bottleneck, and
routing quality depends on the AI-written section SUMMARY embeddings. Verbatim has no
real summary (faked from first sentences) → at huge section counts the query routes to
the wrong handful and the right answer never becomes a candidate. Verbatim ≈ AI at
~100-500k words; AI wins DECISIVELY at 10M+. So AI-chunker is what makes company-brain
scale possible. "Best content wins" (Vuk): the moat is content quality in the chunks,
not ranking cleverness — sweep showed rank_mode/topk_min/λ barely move recall@1.

**FROZEN config (retrieve-knowledge.ts DEFAULT_V3_*):** S=6, rank_mode=max_blend,
λ=0.10, topk_min per-mode defaults. From §8 sweep (AoD full book, 12 needles):
S=4 → routing 58% / r@1 39%; S=6 → 81% / 47%; S=8 → 83% / 47% (6→8 is noise, S=6
wins r@2 56% vs 53%). NOTE recall@1 ~47% is the STRICT substring-proxy metric and
badly understates real answer quality (yesterday's answers read excellent; many
"misses" returned correct in-voice answers). No config cleared the design's 95%
routing floor — but the floor is proxy-strict, not a real-quality verdict.

**TODO — adaptive S (Step 9 refinement, route RPC already comments "ship conservative
S adaptive").** A fixed S=6 is a v1 simplification. S is a ceiling (`LIMIT top_s`), so
it's safe for tiny creators, but a 3-section solo creator and a 5000-section company
brain should not share one S. Make S scale with the creator's section count (e.g.
clamp(ceil(sqrt(sections)) or a small fraction, [3,10])). TRIGGER: company-brain /
large-corpus onboarding, or when a creator's section count >> book scale.

---

## RAG v3 — model-pin validation + config freeze (2026-05-31)

**Validation of record (replaces the throwaway `scripts/tmp-model-probe.mjs`, deleted post-commit).** `gemini-3.1-flash-lite` pinned for `NARRATIVE_CHUNK_MODEL` + `QUERY_REWRITE_MODEL` (was `gemini-2.5-flash`, retires 2026-10-16). Proven 2026-05-31:
- Direct `generateContent` call → Google echoed `modelVersion: "gemini-3.1-flash-lite"` (ground truth, not inference).
- Live `/api/internal/narrative-chunk-section` with a real AoD section → HTTP 200, `fallback:false`, attempt 1, coverage lengthRatio 0.9935 / trigram 0.907 (binds `responseSchema` + `thinkingLevel:MINIMAL`, clears the coverage gate through prod code).
- `tsc --noEmit` exit 0; full voice vitest 527 passed / 4 skipped.
- COGS pinned to 3.1-flash-lite $0.25/$1.50 per 1M across ALL surfaces: `embed-worker.js FLASH_USD_PER_M_*`, `query-rewrite.ts QUERY_REWRITE_USD_*`, `rag-telemetry.test.ts` fixtures, and `diag-eval-v3.mjs` mirrors. Config freeze: `DEFAULT_V3_TOP_S=6`, `max_blend`, λ=0.10.

**Deferred audit findings (2026-05-31 auditor round on the model-pin changeset):**
- **M5 — real-API gated regression for narrative-chunk-section. ✅ DONE 2026-05-31.** Added `src/lib/voice/narrative-chunk.real-api.test.ts` (gated on `RUN_REAL_API_TESTS=1` + `GEMINI_API_KEY`; skips clean otherwise). Calls real `narrativeChunkSection` on a real AoD section → asserts non-null + non-empty units/title/summary + usage>0, then runs the prod `sectionCoverage`/`coveragePasses` gate. Real run PASSED: model=gemini-3.1-flash-lite, attempt 1, 4 units, lengthRatio 0.9935 / trigram 0.9334. ~$0.0005/run. Catches silent model deprecation / responseSchema-semantics drift. (Done now, not deferred to Step 9.)
- **M3 — deploy-ordering trap (runbook, not code). ✅ RESOLVED 2026-05-31.** `NARRATIVE_CHUNK_MODEL` + `FLASH_USD_PER_M_*` are read on Fly; `QUERY_REWRITE_MODEL` + `QUERY_REWRITE_USD_*` on Vercel. A stale prod env override would silently run 3.1-lite at 2.5 prices or mislabel COGS rows. VERIFIED both environments are CLEAN: Fly `oakleague-voice-proxy` secrets list has none of the 6 (`flyctl secrets list`, names/digests only); Vercel `oak-league` Production env has none of the 4 (`vercel env ls production`). So the pinned code defaults are the single source of truth on both sides — when this branch ships, 3.1-flash-lite runs at $0.25/$1.50 with correct COGS labels. No env change needed. Re-check only if someone adds one of these vars later.

---

## RAG v3 — Step 9 final CODE audit (2026-05-31, applied inline + flagged)

CODE audit of the built Step-9 changeset (C1 soft-cutover + C2/C3 generation machinery + C4 rerank cap + model-pin). **0 Critical** (all 8 high-value attack surfaces verified holding). Mediums/Smalls below: most fixed in the same changeset; two deferred with rationale.

**Fixed inline (same commit):**
- **M2 — purge-then-rollback was a silent one-way door. FIXED.** `admin_purge_legacy_chunks` now stamps `creators.legacy_purged_at`; `admin_set_creator_retrieval_version` refuses a 3→2/3→1 rollback (`check_violation 'rollback_refused_legacy_purged'`) once it's set — fail-loud instead of serving an empty corpus. Pinned by gate-test case 13. (mig …0001)
- **M3 — flat-fallback 50-section cap could silently under-recall a large-corpus creator. FIXED.** `retrieve-knowledge.ts` now emits a `console.warn` breadcrumb + `telemetry.route.flatFallbackCapped` when `allSections.length >= FLAT_FALLBACK_MAX_SECTIONS`, so "creator forgot the back half of book 2" surfaces before a user reports it. (Cap itself unchanged — raising it requires re-deriving the topk fan-out budget; the breadcrumb is the trigger.)
- **M4 — `creator_v3_ready` clause (c) didn't gen-scope the chunk check. FIXED (defense-in-depth).** Added `AND c.section_generation = s.section_generation` to the child-chunk EXISTS. Redundant under today's single-writer invariant (`_insert_chunk_v3_unsafe` derives chunk gen from its section) but the gate no longer DEPENDS on that invariant holding forever. (mig …0003)
- **S1 — finalize test's 1→1 swap didn't prove the pointer moves. FIXED.** `corpus_reprocess_finalize_v3.test.sql` case 2 now asserts `active_section_generation = p_target_generation` + comments that the real 1→2 MOVE is covered by `v3_section_generations.test.sql` case 8.
- **S2 — gen test's "GC at active=2 deletes nothing" sub-claim was computed but unasserted. FIXED.** Added case 11 (`is(g1,1)` + `stale_sections_deleted=0`); renumbered (plan 12→13).
- **S3/S5 — stale comments. FIXED.** `embed-worker.js` MAX_UNITS_PER_SECTION stride rationale (now per-gen, not collision-load-bearing) + the "finalize_v3 will land / status flip only" stub comment (finalize swap has landed).
- **S4 — `MAX_CANDIDATES=30` was a hand-synced literal (manual-sync trap). FIXED.** Exported from `rerank.ts`; `retrieve-knowledge.ts` boot-asserts it equals `DEFAULT_V3_TOP_S × DEFAULT_V3_N_PARENT_PER_SECTION`, so a fan-out bump that forgets the cap fails LOUD at module load. (Caveat documented: if a caller overrides `args.topS` above the default, the cap must be re-derived; prod freezes topS=6.)

**Deferred (logged, with rationale):**
- **M1 — concurrent/zombie re-ingest can clobber a live claim + burn `attempts`. DEFERRED.** A worker that lost its claim mid-build (reaper requeued, second worker claimed) can hit a `(sample_id, section_generation, section_index)` 23505 against the new owner, and its `bumpFailure`/`markJobErrored` update the job row by `id` unconditionally — clobbering the live claim. **Why deferred, not fixed now:** the window is closed by construction in the normal case — `REPROCESS_CLAIM_TIMEOUT_MS=540_000` (worker self-deadline, checked before every section AND every unit) sits a full 60s UNDER the 600s reaper requeue TTL, so worker A self-abandons before the reaper can hand the job to worker B. The residual is a single sub-operation overrunning by >60s without hitting a `timeLeft()` checkpoint — self-healing (active generation is NEVER touched; finalize's `enqueue_version` guard abandons the stale worker; `attempts` caps at 5). **The proper fix** (an `enqueue_version`-guarded `.eq()` on the `bumpFailure`/`markJobErrored` updates, threaded via an optional `claimedVersion` param) touches a SHARED v2+v3 helper across ~30 call sites — not something to land hastily in the same commit as the C1/C2/C3 machinery. **TRIGGER:** when the reaper TTL is ever lowered toward the worker self-deadline (closing the 60s margin), OR when prod telemetry shows v3 jobs falsely `errored` with 23505 in `last_error`. Fix = thread `claimedVersion` → guard both helper updates with `.eq('enqueue_version', claimedVersion)` (a stale worker then no-ops instead of clobbering).
- **M5 — `admin_purge_legacy_chunks` + `admin_gc_stale_section_generations` are not wired to any API route / admin-console action. DEFERRED to the admin-console build (CLAUDE.md Days 13-14 window).** Today they're invokable only via raw SQL by an admin. **Runbook until the UI lands (soft-cutover lifecycle, per creator):** (1) re-ingest builds gen N+1 alongside live gen N; (2) `admin_set_creator_retrieval_version(creator, 3)` flips to v3 (soft — v1/v2 stay dormant for rollback); (3) **soak** on v3; if broken, `admin_set_creator_retrieval_version(creator, 2)` rolls back instantly (legacy corpus intact); (4) once confident, `admin_purge_legacy_chunks(creator)` deletes the dormant v1/v2 (stamps `legacy_purged_at` — rollback now refused, see M2); (5) `admin_gc_stale_section_generations(creator)` reclaims v3 generations below active-1 (keeps active + prior). **TRIGGER:** the Days 13-14 admin-console build — add confirm-dialog + audit-preview routes for steps 4 and 5 (both are destructive + currently UI-less).
