# V3 FLIP — EXECUTION PLAN (the "HOLY FUCK" gate)

**Written 2026-06-01 (late). Execute morning of 2026-06-02.**
Single source of truth for FLIPPING a creator to `retrieval_version=3` on prod.
The companion `V3_PROD_CUTOVER_GATE.md` covered Phases 1–2 (now done). This doc is
Phase 3: build a real v3 corpus → flip → live "is it him" test.

> **Standing rule reminder:** run the **auditor subagent** on this plan (and on the
> one code change below) BEFORE writing the migration / committing. Self-audit
> doesn't count. Don't start coding until the plan is audited.

---

## Where we actually are (verified 2026-06-01, reading live code + migrations)

**DONE and live on prod:**
- All 20 v3 migrations applied (schema + RPCs + soft cutover). Fly proxy redeployed
  with the `embed-worker.js` v3 generation path. `main` merged (`970ffef`).
- The 3 UX P0s (thinking-dots, error-pill, grounding hedge) shipped to main.
- min_sim calibrated — placeholders (`max_blend=0.20`, `vec_max=0.40`) validated safe;
  `V3_OFF_DOMAIN_HEDGE_ENABLED` safe to flip (default OFF until we want the hedge copy).
- The cross-tenant secdef leak is fixed (mig `20260601000001`).

**Built and live, verified by reading the code:**
- v3 worker path: `corpus_reprocess_mark_done_v3 → corpus_reprocess_finalize_v3`
  (embed-worker.js:808) — atomic, **bumps `creators.current_corpus_version`**
  per sample (mig …050:116), so the cache invalidates during the build.
  *(This closes the old `corpus_finalize_not_wired` worry — it was the v2/pre-step-9
  state; v3 finalize bumps the version.)*
- `creator_v3_ready(creator_id)` (mig …040): hard gate — TRUE iff every `ready`
  sample has (a) a `done` target_version=3 job, (b) sections with non-NULL
  summary+centroid embeddings, (c) ≥1 chunker_version=3 chunk per section.
- `admin_set_creator_retrieval_version` (mig …041 + …0001 soft cutover): flipping
  TO 3 **RAISES** `creator_v3_not_ready` unless the gate passes; **SOFT cutover** —
  v1/v2 chunks go dormant (not deleted), so **rollback 3→2 is instant + correct**.
- `admin_purge_legacy_chunks` + `legacy_purged_at` (mig …0001): the deferred,
  explicit legacy delete, post-soak. Once purged, rollback is refused (loud).
- Admin UI for purge/GC on `/admin/creators/[id]` (M5, committed `bdc1c17`).

---

## THE ONE GAP (the reason we can't flip today) — chicken-and-egg

To do the intended **build-then-flip** (build v3 corpus while the creator keeps
serving v2, then flip once `creator_v3_ready`), we must enqueue `target_version=3`
jobs for a creator who is **still at `retrieval_version=2`**. Today nothing can:

- `_admin_enqueue_corpus_reprocess_unsafe` (mig `20260518000001`, the only def)
  **hardcodes `target_version, 2`** (lines 117, 200) — it predates v3. The CLI
  (`scripts/corpus-reprocess.mjs`) and the `/api/admin/corpus-reprocess` button both
  call it, so both only enqueue v2 jobs.
- The on-edit trigger `enqueue_sample_embedding_job` (mig …051) routes by the
  creator's **current** `retrieval_version`: a v2 creator's sample edit enqueues
  `target_version=2`; it only enqueues 3 when the creator is **already** at 3.
- The eval harness (`diag-eval-v3.mjs`) sidesteps this by **birthing the creator at
  `retrieval_version=3`** then inserting samples (line 238) — fine for a throwaway
  creator with no live users, useless for an existing prod creator (flip-to-3 is
  gated; and even a raw `UPDATE …=3` would make him blank for the whole build).

**Conclusion:** the build-then-flip path the schema was designed around (the
`finalize_v3` comment literally says "v2 chunks are the live read path during the
build-then-flip window") has **no enqueue entry point**. That is the single piece
of new code below; everything downstream of it is built and tested.

---

## STEP 1 (only code) — add a `p_target_version` enqueue param

**New migration** `20260602000001_admin_enqueue_corpus_reprocess_target_version.sql`.

> **AUDIT C1 — must DROP, not CREATE OR REPLACE.** Postgres function identity is the
> arg-type list, so `(uuid,uuid,boolean,smallint)` is a NEW function, not a replace of
> `(uuid,uuid,boolean)`. A bare `CREATE OR REPLACE` would leave the OLD 3-arg function
> on disk still hardcoding `target_version=2`, and 3-named-arg callers would resolve to
> it. So the migration MUST:
> 1. `DROP FUNCTION public.admin_enqueue_corpus_reprocess(uuid, boolean);` (wrapper first — it depends on the unsafe one)
> 2. `DROP FUNCTION public._admin_enqueue_corpus_reprocess_unsafe(uuid, uuid, boolean);`
> 3. `CREATE` the new 4-arg / 3-arg-defaulted versions.
> 4. Re-state the full GRANT/REVOKE footer on the NEW identities (DROP invalidated the old grants).
>
> After the DROP, exactly ONE function exists; a 3-named-arg call resolves to it via the
> DEFAULT — so existing v2 callers keep working AND v3 is reachable. (Verified: PostgREST
> resolves a named-arg call omitting a defaulted arg as long as the overload is unique,
> which it is post-DROP.)

- `_admin_enqueue_corpus_reprocess_unsafe(p_admin_user_id, p_creator_id, p_force,
  **p_target_version smallint DEFAULT 2**)`:
  - Validate `p_target_version IN (2, 3)` → else `RAISE 22023 target_version_invalid`.
  - **AUDIT C2 — parameterize ALL THREE hardcoded `2`s** (not two): the force=true
    INSERT (line 117), the force=false INSERT (line 200), AND the `skipped_already_queued`
    pre-snapshot join `j.target_version = 2` (line ~192). Missing line 192 makes the v3
    enqueue report counts off the v2 queue.
  - Audit-row `before` gains `target_version` so the log distinguishes v2 vs v3 enqueues.
- `admin_enqueue_corpus_reprocess(p_creator_id, p_force, **p_target_version DEFAULT 2**)`
  — public wrapper, DROP + recreate, forward the new arg.

**CLI** `scripts/corpus-reprocess.mjs`: add `--target-version <2|3>` (default 2) + `--v3`
alias → `--target-version 3`, pass through `enqueueOne` as the 4th RPC arg. **Reject
client-side** any value other than 2/3 (fail fast before the RPC). Fix the hardcoded
"enqueuing v2 re-process" log string (line ~226) to print the actual target version.

**Route** `/api/admin/corpus-reprocess/route.ts`: **NOT optional (audit M3)** — accept
an optional `targetVersion` (default 2), `assertAdminFromSession` unchanged, forward as
the 4th arg. The route must change in the SAME commit as the migration: after the DROP,
the route's existing 3-named-arg call resolves to the new defaulted function (so the v2
button keeps working), but we update it now so the run isn't split across commits.

**Tests (TDD):** pgTAP — v2 enqueue unchanged (default arg); `p_target_version=3` writes
`target_version=3` rows; `=4` raises `22003/22023`; `skipped_already_queued` for a v3
enqueue counts the v3 queue only (C2 regression guard); audit row carries the version.
Update `route.test.ts` + the enqueue pgTAP. Run the **full** `npm run db:test`
(schema-blast-radius), then `npm run build`. **Then auditor on the diff.**

---

## PRE-FLIGHT — run these BEFORE the COGS-bearing Step 2 (audit C4/M2/M4/M6)

All read-only / config checks. Any failure blocks the build.

1. **Mig …531000003 applied (audit M4).** The worker calls the 3-arg
   `corpus_reprocess_mark_done_v3(p_job_id, p_claimed_version, p_target_generation)`.
   If only the 2-arg stub exists, EVERY v3 finalize fails → jobs loop processing→reaped.
   Verify: `SELECT pg_get_function_arguments(oid) FROM pg_proc WHERE proname='corpus_reprocess_mark_done_v3'` shows 3 args.
2. **Embedding daily cap vs book cost (audit M6).** `CREATOR_EMBEDDING_DAILY_CAP_USD`
   defaults to **$10** and is enforced per-creator-per-day (embedding leg only); a book
   whose embedding leg approaches it gets jobs killed mid-build → gate stuck FALSE. Confirm
   the cap exceeds the book's embedding-leg estimate, or raise it on Fly for the build day.
3. **Fly memory (audit C4).** Proxy runs at `vm.memory_mb = 256` and shares the box with
   the live voice proxy + face workers. Book-scale ingest can OOM → silent reap-loop that
   `$8` won't catch (each crash bills truthfully, zero progress). Consider `fly scale memory`
   up for the build, or watch for OOM in `fly logs` and abort the loop manually.
4. **Worker single-flight wall-clock (audit C4).** Reprocess worker claims ONE job per
   ~5s tick, up to 540s per book sample — serial. Budget wall-clock, not just COGS.

## GATE-FALSE RUNBOOK — `creator_v3_ready` won't go TRUE (audit C3/M5 — likely first failure)

A section can have real text but produce **zero surviving child chunks** (Flash collapses
its units). The worker still marks the job `done` (`embed-worker.js:1558-1606`), but that
section then has a NULL centroid AND no v3 chunk → the gate's clause (b)/(c) fail
**permanently**, with only a Sentry breadcrumb. `--force` re-ingest may reproduce it if
Flash is deterministic. Treat this as a FIRST-CLASS branch, not an afterthought:

1. **Diagnose** — find the offending section(s):
   ```sql
   SELECT s.id, s.sample_id, s.section_index, s.centroid_embedding IS NULL AS null_centroid,
          NOT EXISTS (SELECT 1 FROM sample_content_chunks c
                        WHERE c.section_id = s.id AND c.chunker_version = 3) AS no_v3_chunk
     FROM sample_content_sections s
     JOIN sample_content sc ON sc.id = s.sample_id
    WHERE sc.creator_id = '<creator-id>'
      AND (s.centroid_embedding IS NULL
           OR NOT EXISTS (SELECT 1 FROM sample_content_chunks c
                            WHERE c.section_id = s.id AND c.chunker_version = 3));
   ```
   Check clauses **(b) NULL embedding / (c) no chunk** — NOT clause (d) section-count
   (per audit Small, a zero-children section is counted as *processed*, so (d) passes).
2. **Recover** — re-run `--force` once (transient Flash failure clears). If it reproduces:
   the section legitimately has no retrievable content → DELETE the orphan section row so
   (b)/(c) pass — **but first check the `v3_section_count_invariant` (mig …060)** doesn't
   trip on the delete; if it does, the recovery is to NULL nothing and instead accept the
   sample as not-v3-able (do not flip that creator) and escalate. Document which path was taken.
3. **Also pre-check predicate-population match (audit M2):** the enqueue selects by
   `raw_text IS NOT NULL`; the gate demands every `fetch_status='ready'` sample. If a real
   creator has a `ready` sample with NULL raw_text (or vice-versa), the gate hangs with no
   cause. Confirm the two sets are identical for the creator before building:
   ```sql
   SELECT count(*) FILTER (WHERE fetch_status='ready' AND raw_text IS NULL)  AS ready_no_text,
          count(*) FILTER (WHERE fetch_status<>'ready' AND raw_text IS NOT NULL) AS text_not_ready
     FROM sample_content WHERE creator_id = '<creator-id>';
   ```
   Both must be 0.

## CONTENT FREEZE during the build window (audit M1)

While the creator is at v2 and the v3 build runs, ANY edit to `sample_content.raw_text`
fires the on-edit trigger → enqueues a **target_version=2** job (trigger routes by current
version), which rebuilds v2 chunks AND bumps `current_corpus_version` (cache thrash). It
won't corrupt the v3 corpus (separate composite key + finalize), but it splits state and
churns cache. **Freeze creator content edits from `--force` until the flip.** (If an edit
slips in, just re-run `--force --target-version 3` after to re-stage that sample.)

---

## STEP 2 — build a v3 corpus on a SCRATCH creator first (prove the pipe on prod)

Do NOT start with your real creator. Use a fresh throwaway on prod (mirrors the
eval harness, zero blast radius):

1. Create a scratch creator on prod (real invite→apply→approve flow, or a minimal
   seed) with a **known book-scale corpus** (the same `eval-v3/book` we calibrated
   on, so we know the needle answers).
2. `node scripts/corpus-reprocess.mjs --handle <scratch> --target-version 3 --force`
   → enqueues v3 jobs. Creator stays at v2 the whole time (serves nothing; no users).
3. Watch the worker drain: `node scripts/poll-reprocess.mjs` (or the admin
   brain-status UI). Book scale = **COGS + minutes** (ingest ran ~$1.02 locally;
   budget ~$2, hard-stop $8 — watch `cogs_log`).
4. **Gate check:** `SELECT creator_v3_ready('<scratch-id>')`.
   - **TRUE** → proceed to step 5.
   - **FALSE (first-class branch, audit M5)** → run the GATE-FALSE RUNBOOK above.
     Do NOT flip. Re-check until TRUE or the section is provably un-ingestable.
5. Flip: `SELECT admin_set_creator_retrieval_version('<scratch-id>', 3)`.
6. **Live "is it him / does it recall the back half of the book" voice test** against
   the scratch creator. This is the real validation: routed hierarchical retrieval at
   book scale, in-persona, no fabrication on off-domain Qs.
7. Rollback drill: flip back to 2, confirm v2 still answers (proves soft cutover).
   Do NOT purge the scratch creator (keep rollback available).

---

## STEP 3 — flip your real creator (`vuk_lehendas`, 74e897d8)

Only after Step 2 is clean. **Run the PRE-FLIGHT predicate-population check (M2) on
THIS creator first** — a real creator with many samples is where the `ready` vs
`raw_text` mismatch actually bites. **Content freeze (M1) applies for the whole build.**

1. `node scripts/corpus-reprocess.mjs --handle vuk --target-version 3 --force`.
   **He keeps serving v2 the entire build** (soft cutover + still at v2) — zero
   downtime, no blanking. This is the whole point of build-then-flip.
2. Drain worker → `creator_v3_ready('74e897d8…') = TRUE` (GATE-FALSE RUNBOOK if not).
3. Flip to 3 → **live "EXACTLY him" test** (the headline moment).
4. Soak. If anything reads wrong → flip back to 2 instantly (v2 chunks still dormant
   on disk). Only after you're happy: `admin_purge_legacy_chunks` (UI button) to
   reclaim disk — **after which rollback is refused** (`legacy_purged_at` set).

---

## STEP 4 — optional polish, gated on the live test
- Flip `V3_OFF_DOMAIN_HEDGE_ENABLED=1` (Fly) once you've heard the off-domain
  behavior and want the soft hedge instead of the "give me an example" fallback.
- Then widen to general creators.

---

## Order of work
1. ✅ **Auditor on this plan** (done 2026-06-02) — all findings folded in: C1 (DROP not
   REPLACE), C2 (3 hardcoded `2`s incl. line-192 join), C3/M5 (gate-FALSE runbook),
   C4/M2/M4/M6 (pre-flight), M1 (content freeze), M3 (route not optional), smalls. The
   dispatch/finalize/rollback architecture validated clean — worker branches by JOB
   `target_version` (not creator version), both finalizes have mirror gates, reaper
   preserves `target_version`, soft cutover + rollback correct.
2. Build Step 1 (TDD: DROP+CREATE migration + CLI + route, full `db:test`, `npm run build`).
3. **Auditor on the Step-1 diff.** Commit. (Push only on Vuk's say-so.)
4. PRE-FLIGHT checks → Step 2 scratch build + flip + live test (COGS-bearing, manual).
5. Step 3 your creator. Step 4 polish.

## Risks / watch-items
- **COGS:** book-scale v3 ingest is the priciest single op in the app. Watch
  `cogs_log`; the worker has a partial-flush cadence so a mid-run crash still bills
  truthfully. Hard-stop the run at ~$8.
- **Worker liveness:** confirm the Fly proxy worker is actually claiming v3 jobs
  (boot log + `corpus_reprocess_jobs.status` moving pending→processing→done). A
  silent worker = jobs sit pending = gate never goes TRUE.
- **Don't raw-`UPDATE retrieval_version=3`** to shortcut — it bypasses the gate and
  makes the creator blank until v3 is built. Always go through the RPC after the gate.
- **`scripts/session-cogs-breakdown.mjs`** stays untracked (your WIP) — never stage it.
