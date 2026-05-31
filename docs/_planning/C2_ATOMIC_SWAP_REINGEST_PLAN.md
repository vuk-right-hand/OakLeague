# C2/C3 Fix — Atomic-Swap Re-Ingest (Step-9 audit) — REV 3

> REV 3 supersedes REV 2 after the 2nd plan-audit. REV 2 closed C1/C2/C3 from
> REV 1 but introduced THREE new Criticals (chunk-UNIQUE collision, false
> cache-invalidation premise, unsafe HNSW fallback). REV 3 is written against
> the ACTUAL constraint DDL + the session-snapshot code, not from memory.
>
> **Root-cause discipline (why REV 1+2 failed):** both proposed constraint /
> invalidation fixes WITHOUT reading the real constraint / snapshot code. REV 3
> quotes the exact DDL it changes. Every reader + every UNIQUE + the cache
> snapshot are cited inline.

## The bug (verified)
Re-ingest of a creator already live on retrieval_version=3 deletes all of a
sample's sections up front (embed-worker.js:1071-1074) then rebuilds over
minutes-to-hours → empty/partial retrieval mid-rebuild. `creator_v3_ready`
gates only the initial 2→3 flip, not re-ingest of an already-flipped creator.

## Generation numbering (pinned — M-1)
- `section_generation` DEFAULT 1 on every table; `active_section_generation`
  DEFAULT 1 on sample_content. So **gen 1 = "everything that existed at
  migration time"** — both v2-legacy units (section_id NULL) AND any
  pre-existing v3 rows. Pre-existing data is already collision-free under the
  old `(sample_id, unit_index)` UNIQUE, so it satisfies the new
  `(sample_id, section_generation, unit_index)` UNIQUE at gen 1 unchanged
  (replay-safe; vuk_lehendas/scratch stay readable).
- **Every future v3 build targets `active_section_generation + 1`** → first
  re-ingest of an already-v3 sample writes gen 2. v3 builds are therefore
  ALWAYS gen ≥ 2 going forward; gen 1's only v3 rows are the pre-existing
  (offset-safe) ones. This is what kills the unit/chunk collision (new gen has
  its own generation key → fresh per-gen index space).
- v2-legacy rows (section_id NULL) stay at gen 1 forever and are NOT part of
  the v3 generation lifecycle — they're owned by `admin_purge_legacy_chunks`
  (the C1 soft-cutover purge), never by the v3 GC.

## EVERY reader of v3 sections/units/chunks (verified against code)
| # | Reader | File:line | Reads | REV 3 scoping |
|---|--------|-----------|-------|---------------|
| R1 | `creator_route_sections_v3` | mig 30 | sections by creator_id, HNSW | gen filter as POST-HNSW outer filter on the bounded top_s*3 candidate set (C-3) |
| R2 | flat-fallback | retrieve-knowledge.ts:1421-1430 | raw `.from(sections).select(id).eq(creator_id)` | replace with RPC `_creator_active_section_ids_v3` |
| R3 | `creator_v3_ready` (b)(c) | mig 40 | sections by sample_id | gen-filter each section subquery to active gen |
| R4 | count invariant (d) | mig 60 | count(sections by sample_id) | count active-gen sections; expected written AT swap (M-3) |
| R5 | cache-hit parent re-fetch | retrieve-knowledge.ts:864-886 | `narrative_units` by id, no gen filter | **gen-filter the fetch** (C-2 — NOT a corpus_version bump; corpusVersionAtSession is frozen at session-open, index.js:1016) |
| R6 | worker unit/chunk insert | embed-worker.js:1296-1342 | writes units/chunks | per-gen unit_index from 0; write section_generation on every row |
| R7 | `knowledge_topk_v3` | mig 31 | chunks via `section_id = ANY(active ids)` | UNCHANGED (reached only via R1/R2 active ids; section_id belongs to one gen) |

## Schema (migration ...002)
Add `section_generation int NOT NULL DEFAULT 1` to: `sample_content_sections`,
`sample_content_narrative_units`, `sample_content_chunks`.
Add `active_section_generation int NOT NULL DEFAULT 1` to `sample_content`.

UNIQUE swaps (the C-1 fix — quoting the REAL constraints):
- sections: `UNIQUE (sample_id, section_index)` →
  `UNIQUE (sample_id, section_generation, section_index)`.
- units: `UNIQUE (sample_id, unit_index)` (mig 20260514000002:41) →
  `UNIQUE (sample_id, section_generation, unit_index)`.
- chunks v3 partial (mig 20260528000012:106-108):
  `(sample_id, chunker_version, section_index, chunk_index) WHERE chunker_version=3`
  → `(sample_id, chunker_version, section_generation, section_index, chunk_index) WHERE chunker_version=3`.
  **This is the constraint REV 2 forgot — chunk uniqueness is keyed on
  section_index/chunk_index, NOT unit_index.**

Indexes:
- sections `(creator_id, section_generation)` (creator_id LEADING — route + R2
  filter by creator_id; serves R2/flat, NOT the HNSW route — S-5).
- sections `(sample_id, section_generation)` (finalize/GC by sample).

Replay-safety: every existing row → gen 1; the new UNIQUEs equal the old keys
at gen 1 (existing data already satisfied them). Unique-swap on populated tables
succeeds because no two existing rows share the new key. Re-GRANT NOT needed
(column adds on existing tables inherit grants; no new CREATE TABLE — S-1).

## RPC edits (migration ...003)

### R6/C-1 — `_insert_chunk_v3_unsafe` (mig 13/14) — REWIRE
Add `p_section_generation int` arg; write it into the chunk row. The worker
passes `targetGen`. **REV 2 omitted this RPC entirely** — every v3 chunk is
inserted through it, so without the arg the chunk's section_generation defaults
to 1 and collides. (Also re-grant EXECUTE as before.)

### R1/C-3 — `creator_route_sections_v3` (mig 30) — POST-HNSW outer gen filter
The partial HNSW index requires the inner CTE WHERE to TEXTUALLY include
`summary_embedding IS NOT NULL` + the `ORDER BY embedding <=> vec LIMIT k`
pushdown (mig 30 audit M3). The gen filter MUST NOT enter that inner WHERE
(a correlated semi-join there can defeat the index scan — the REV 2 risk).
Instead:
- Keep `summary_top` / `centroid_top` CTEs EXACTLY as today (HNSW + IS NOT NULL
  + LIMIT top_s*3) — index scan preserved, candidate set bounded to ≤ top_s*3.
- Add an OUTER filter step AFTER the union/merge: join the bounded candidate
  rows to `sample_content sc ON sc.id = cand.sample_id` and keep only
  `cand.section_generation = sc.active_section_generation`. Since this runs on
  ≤ (top_s*3)*2 rows (tiny), the join cost is negligible and the HNSW path is
  untouched. (Requires `section_generation` + `sample_id` in the CTE SELECT.)
- pgTAP EXPLAIN-assert: "Index Scan using ..._hnsw_idx" STILL present on both
  CTEs (M2). NO `is_active_generation boolean` — that fallback is dropped (C-3:
  it needs a book-sized UPDATE inside the finalize 5s-lock txn + is a 2nd source
  of truth).

### R2 — NEW `_creator_active_section_ids_v3(p_creator_id, p_limit)`
Returns active-gen section ids for the flat-fallback:
`SELECT s.id FROM sample_content_sections s JOIN sample_content sc ON sc.id =
s.sample_id WHERE s.creator_id = p_creator_id AND s.section_generation =
sc.active_section_generation AND s.summary_embedding IS NOT NULL ORDER BY
s.section_index LIMIT p_limit`. Replaces the raw client SELECT at
retrieve-knowledge.ts:1421-1430. pgTAP: R1 and R2 return the SAME id set for the
same creator/gen state (they must agree on which gen is live).

### R3/R4 — `creator_v3_ready` (mig 40 + 60) — gen-scope + count timing
- Clauses (b)(c): each `sample_content_sections s WHERE s.sample_id = sc.id`
  subquery gains `AND s.section_generation = sc.active_section_generation`. The
  mid-build NEW gen (NULL embeddings) becomes invisible → gate reflects the
  ACTIVE gen → stays TRUE during re-ingest (C3 closed).
- Clause (c) child-chunk `NOT EXISTS ... c.section_id = s.id AND
  chunker_version=3` is gen-safe via the section_id FK (s is already
  active-gen) — NO separate chunk-gen predicate (M-4; adding one would break it).
- Clause (d) count: `count(active-gen sections) = v3_expected_section_count -
  v3_skipped_empty_count`. **The expected/skipped counts are written AT SWAP by
  finalize (M-3), not mid-build** — so during build, active=old-gen and expected
  still reflects old-gen → matches → stays ready; at swap both flip together.

### Finalize — `corpus_reprocess_finalize_v3` (mig 50) — swap + counts + bump, NO GC
New signature: `(p_job_id, p_claimed_version, p_target_generation,
p_expected_section_count, p_skipped_empty_count)`. Under the existing per-creator
advisory lock, one txn:
1. `UPDATE sample_content SET active_section_generation = p_target_generation,
   v3_expected_section_count = p_expected_section_count,
   v3_skipped_empty_count = p_skipped_empty_count WHERE id = sample`.
2. `UPDATE creators SET current_corpus_version = current_corpus_version + 1`
   (general cache freshness for NEW sessions — NOT the correctness mechanism
   for R5; that's the gen-filtered fetch).
3. Existing chunker_version=1 delete unchanged.
4. **NO CASCADE delete of the old generation** (keeps it for rollback — C3).
5. Mark job done.
A reader sees gen N (pre-commit) or gen N+1 (post-commit), never a mix.

### R5/C-2 — `fetchParentNarrativesByIds` (retrieve-knowledge.ts:864-886) — gen-filter
It already `.select('id, text, title, sample_content!inner(source_type)')`. Add
the active-gen predicate so a stale-gen id deterministically fetches 0 rows
regardless of cache/session timing: filter `section_generation =
sample_content.active_section_generation`. (PostgREST: select
`sample_content!inner(source_type, active_section_generation)` then filter, OR
move this fetch to a small RPC `_fetch_active_parents_v3(creator_id, ids)` that
does the join server-side — preferred, keeps the gen rule in SQL not TS.)
Telemetry note (S-4): `cacheStaleCorpus` may tick during re-ingest as stale-gen
ids fetch 0 — expected, not a regression.

### GC — NEW `admin_gc_stale_section_generations(p_creator_id)` (deferred sweep)
Under `reprocess:||id` advisory lock (same order as finalize/flip/purge):
take lock → read `active_section_generation` per sample INSIDE the lock (M-2) →
DELETE sections (CASCADE units/chunks) WHERE `section_id IS NOT NULL`-gen rows
with `section_generation < active - 1` (keeps active + immediately-prior for
rollback). **Never touches section_id-NULL v2 rows** (those are
admin_purge_legacy_chunks's job — M-2). Never runs inside finalize (M5 — a
book-sized CASCADE must not compete with the 5s finalize lock). Bumps
current_corpus_version. Idempotent.

## Worker (embed-worker.js)
- Read `active_section_generation` for the sample up front; `targetGen = +1`.
- REMOVE the upfront `DELETE FROM sample_content_sections WHERE sample_id`
  (1071-1074).
- REMOVE `v3UnitBase` MAX-lookup (1086-1100), the int4 overflow guard (1107),
  and the Round-6 M1 coupling comment (1314-1322) — all DEAD under per-gen
  unit_index (S-3). unit_index = a per-generation counter from 0.
- Tag every section/unit/chunk insert with `section_generation = targetGen`;
  pass `targetGen` to `_insert_chunk_v3_unsafe`.
- Centroid UPDATE MUST target `WHERE id = sectionId` (the captured
  sectionRow.id at :1289), NEVER `(sample_id, section_index)` — two gens share
  section_index (M-5). Verify in build.
- finalize call passes `targetGen`, built section count, skipped-empty count.
- Worker/vitest: re-ingest while gen N active → gen N readable throughout →
  finalize swaps → gen N+1 active + corpus_version bumped → gen <N GC-eligible.

## pgTAP (migration ...003 tests)
- R1: route returns ONLY active-gen sections (build gen2 alongside gen1; route
  sees gen1 until swap, gen2 after) + **EXPLAIN Index Scan on both HNSW CTEs**.
- R2: `_creator_active_section_ids_v3` excludes inactive gen; matches R1's set.
- R3: `creator_v3_ready` stays TRUE mid-re-ingest (gen2 NULL-embeddings invisible).
- R4: count invariant counts only active gen; expected written at swap → ready
  before AND after, not-ready never spuriously flips during build.
- C-1: two generations of CHUNKS coexist with NO 23505 (the constraint REV 2
  missed) + two gens of units coexist.
- Finalize: swap atomic (gen N fully readable until commit); corpus_version bumped.
- R5: stale-gen parent id fetches 0 rows (gen-filtered), active-gen fetches the row.
- GC: keeps active + prior, deletes older; skips section_id-NULL v2 rows; re-reads
  active inside lock; does NOT run in finalize.
- M-1: first v3 build targets gen 2 (not gen 1); v2 gen-1 units don't collide.
- Replay: existing rows = gen1 active; unique-swaps succeed on populated tables.

## Reconciliation with 20260531000001 (soft cutover / purge)
- `admin_purge_legacy_chunks`: deletes chunker_version IN (1,2) (v1/v2 legacy,
  section_id NULL units). Guarded on retrieval_version=3.
- `admin_gc_stale_section_generations`: deletes stale v3 GENERATIONS
  (chunker_version=3, section_id NOT NULL, section_generation < active-1).
- Disjoint targets, shared advisory lock + order, neither in finalize. Both bump
  current_corpus_version.

## Risk / blast radius
- Live read path: R1 (route, post-HNSW outer filter — HNSW preserved), R2
  (flat→RPC), R5 (parent fetch gen-filtered), gate R3/R4. R7 + topk + soft-cutover
  + purge + cache shape UNCHANGED.
- Single riskiest detail: R1's HNSW index scan must survive the outer gen filter
  — pgTAP EXPLAIN-asserts it; the outer filter runs on ≤ top_s*3*2 rows so the
  risk is low, but VERIFY empirically in build before commit.
- Backward-compat: DEFAULT 1 everywhere → zero behavior change until a re-ingest
  bumps a sample to gen 2.

## NOT in scope (deferred)
- M1-from-impl-audit cache thrash (perf, not correctness); adaptive-S; min_sim
  §7 freeze; spike-a v3 (M6-from-impl-audit).


## REV 3 — 3rd-audit applied (2026-05-31, verdict: buildable, 0 Criticals)
Must-fix-before-build, ranked. Fold into the migrations/worker below.

- **M-1 finalize signature chain.** `corpus_reprocess_finalize_v3` gains args, but the worker calls the 2-arg `corpus_reprocess_mark_done_v3` wrapper (embed-worker.js:1606), which delegates to finalize (mig 50:148-162). CHOSEN approach: KEEP the worker writing v3_expected/skipped counts in its pre-finalize UPDATE (embed-worker.js:1578-1590) BUT move that UPDATE to fire only when it also sets active_section_generation — i.e. fold the count-write INTO the swap. Simplest end-to-end: finalize takes (p_job_id, p_claimed_version, p_target_generation); it reads the worker-written counts off sample_content (already there) and does pointer-swap + count are one row so they flip atomically. Update mark_done_v3 wrapper to take + forward p_target_generation (3 args). Update worker call site :1606 to pass targetGen. Grep + update every pgTAP calling either fn.
- **M-2 clause (d) gen-filter + timing.** Add `AND s.section_generation = sc.active_section_generation` to clause (d) count subquery (mig 60). Worker must write v3_expected_section_count for the NEW gen ONLY in the swap txn (so during build, active=old gen, expected=old gen value, matches; at swap both flip). Reconcile with the worker pre-finalize write: the write must target the same UPDATE that flips the pointer.
- **M-3 starvation — gen filter INSIDE the CTE as correlated SCALAR (not outer, not semi-join).** In creator_route_sections_v3 summary_top + centroid_top WHERE add `AND s.section_generation = (SELECT sc.active_section_generation FROM sample_content sc WHERE sc.id = s.sample_id)`. A correlated scalar equality on a PK lookup does NOT defeat the partial HNSW index scan (same class as the existing creator_id filter); EXISTS/IN WOULD. pgTAP EXPLAIN-assert Index Scan WITH TWO GENERATIONS present. Fallback if it regresses: outer filter + bump CTE LIMIT to top_s*6 so active gen cannot be starved. Same correlated-scalar pattern for _creator_active_section_ids_v3 (R2).
- **M-4 GC floor.** `< active-1` is CORRECT (keeps active + prior; deletes older v3 gens; section_id-NULL v2 rows excluded). pgTAP MUST assert retained set for active=1 (no-op), active=2 (keep {1,2}), active=3 (keep {2,3}, delete gen-1 v3). Off-by-one-prone; pin it.
- **M-5 chunk RPC derives gen.** _insert_chunk_v3_unsafe already SELECTs the section row (mig 14:75-77) — add v_section_generation to that SELECT INTO and write THAT into the chunk. NO new arg (trusting an arg reopens the parameter-trust hole mig 13/14 closed). Worker passes nothing extra.
- **M-6 v2 worker delete scope.** embed-worker.js:1983-1986 (v2 path) `DELETE narrative_units WHERE sample_id` has NO section_id filter — wipes live v3 units if a v2 reprocess hits a sample with v3 rows. Scope to `AND section_id IS NULL` (v2-shape only), mirroring admin_purge_legacy_chunks:207-208.
- **S-1** delete the now-misleading Round-6 M1 unit-collision comment (embed-worker.js:1314-1322).
- **S-3** explicit REVOKE ALL + GRANT EXECUTE TO service_role on every NEW rpc (_creator_active_section_ids_v3, admin_gc_stale_section_generations, any _fetch_active_parents_v3).
- **S-4** doc the in-flight-session cache window (frozen corpusVersionAtSession → stale-gen ids fetch 0 → full retrieve each cached turn until rollover); accept or proactively clear that creator semantic_query_cache at swap.
- **S-5** route requires BOTH embeddings NOT NULL (mig 30:94,107) so a mid-build gen section is invisible until centroid lands too — build the M-3 EXPLAIN test against that true predicate set.
