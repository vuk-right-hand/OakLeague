# RAG v3 Eval Harness — Design (Step 8 of RAG_SCALING_V3_PLAN.md §8)

**Status:** design, post-auditor-round-1. Build follows **§9 (Revisions)** as the source of
truth where it supersedes earlier sections. **Author:** Claude (for Vuk). **Date:** 2026-05-29.
**Branch:** `rag-v3-scaling`.

> ⚠️ Sections 0–8 are the original design. The auditor (round 1) found 5 Critical + 7 Medium
> validity holes — all confirmed against source and ALL APPLIED in **§9**. Where §9 conflicts
> with §0–§8, §9 wins. The most important inline correction: there is **no "internal routing
> floor"** — `_creator_route_sections_v3` has a single `p_min_sim` gate (migration
> `…30:150`) that prod currently hardcodes to `0.0` (`retrieve-knowledge.ts:1300`). Treat every
> "internal floor" mention in §0/§3/§4 as wrong; see §9 C1.

> The plan (§7) already specifies *what* to measure. This doc specifies *how* — the
> methodology choices that determine whether the frozen constants are trustworthy.
> Those constants (`λ`, `S`/top-S, `p_min_sim`, inject min-rerank-score) are **hard-blocked
> from the prod flip** until this harness produces them, so a methodology bug here ships a
> miscalibrated prod. That is why this gets an auditor pass before a line of harness code.

---

## 0. What gates on this harness's output

Frozen-into-code constants this harness must produce, with evidence:
- **`λ` (max_blend lambda)** — the MAX(rrf)+λ·ln(1+n_children) blend weight in `_creator_knowledge_topk_v3`.
- **`S` (top-S sections)** — `p_top_s` for `_creator_route_sections_v3` (current default 4).
- **`p_min_sim`** — scoped-pass / routing similarity floor (current defaults: max/max_blend/best_child=0.20, vec_max=0.40; route uses 0.0 + internal floor).
- **inject min-rerank-score** — the Stage-4 silence gate (below this, inject nothing rather than a weak passage). **Currently unspecified — there is no defensible default; it MUST come from observed rerank-score distributions on real content.**
- **winning `p_rank_mode`** — one of `max | max_blend | vec_max | best_child`.
- **inject-K** — top-1 vs top-2 passages injected.

Plan §7 gate (verbatim intent): v3 ships only when (2) holds at book-scale, (6) shows no
regression, **and (7) the recognition moment is intact** (no blanking, tells the story,
speaks not recites). Metric (7) is the tiebreaker when (1)–(6) are close.

---

## 1. Autonomous vs. needs-Vuk (cost + human boundary)

| Part | Who | API $ |
|---|---|---|
| Harness code, synthetic fixtures, needle spec, rubric CSV export | Claude, now | $0 |
| Validate machinery on AoD corpus re-ingested at v3 + synthetic scale docs | Claude, now | ~$1–2 |
| Metrics 1–6 on **Vuk's book** (book-scale endpoint) | Claude, after book provided | ~$1–3 ingest + pennies/query |
| Metric 7 "exactly him" rubric (N≥30 Q, ≥2 raters) | **Vuk + wife/friend** | ~$1–3 live voice |

Total projected ≤ **$10** (Vuk's ceiling; ping before exceeding). The book-scale ingest +
the rubric run are blocked on Vuk handing over the book file and recruiting the 2nd rater.

---

## 2. Corpus design

### 2.1 Distractor realism (validity-critical)
A recall experiment is only valid if the distractor corpus has **realistic embeddings** —
pure lorem-ipsum filler collapses into a degenerate region of embedding space and makes any
needle trivially separable (recall looks artificially perfect). **Decision: distractors are
REAL prose**, drawn from:
- The existing AoD transcript corpus (`scripts/aod_test_corpus/`, ~91k words, already proven
  ingestable) — the "transcript" fixture + the small-scale no-regression base (metric 6).
- **Vuk's book** — the real-book fixture (metrics 1–3 book-scale + metric 7 content). Chosen
  over a Gutenberg text per Vuk: no copyright surface, raters who know him, he can grade
  *sourcing* (right chapter, not a plausible blend).
- **Synthetic "large docs"** for the scale curve (§7 wants ≥3) — see 2.2.

### 2.2 Synthetic large docs (scale-curve fillers, authored by Claude)
Purpose: the 1→6-docs→book scale curve (metric 2) needs intermediate, controllable scale.
These are NOT lorem ipsum. Each synthetic doc is **coherent topical prose** (~4–8k words) on
a distinct domain far from the needle topics (so they act as honest semantic distractors),
authored by Claude, no copyright. Needles are planted into the BOOK and AoD (real content),
NOT the synthetic docs — synthetic docs are pure distractor mass to grow the corpus and
force routing to discriminate. (Open Q for auditor: should ≥1 needle live in a synthetic doc
to test cross-doc routing? Leaning no — keeps needle ground-truth in content Vuk can verify.)

### 2.3 Scale tiers (metric 2 — "right unit reaches the reranker" as corpus grows)
- **Tier 1 (1 doc):** book only (or AoD only). Baseline — routing should be near-trivial.
- **Tier 6 (6 docs):** book + 5 synthetic docs. Mid-scale.
- **Tier book (book-scale):** book split chapter-as-sample (§6 decision: one `sample_content`
  per chapter) + synthetic docs → the dozens-of-sections regime where v2 SUM-RRF buries needles.
- Each tier ingested into a **separate scratch creator** (clean section counts; no cross-tier
  contamination). Tiers reuse the same ingested book chapters where possible to bound cost
  (ingest book once, attach synthetic docs per tier) — see 5.3 cost note.

### 2.4 Needle spec (`scripts/eval-v3/needles.json`)
Each needle:
```
{
  "id": "lumberjack",
  "planted_in": "book",                 // which corpus doc
  "depth": "ch1 | mid | last",          // §7: chapter 1 / mid / last chapter
  "ground_truth": {                     // how we score a hit (see 3.1)
    "match": "substring | unit_title_regex",
    "value": "...verbatim passage or title regex..."
  },
  "questions": ["variant 1", "variant 2", ...]   // ≥3 hand-written question phrasings
}
```
≥10 facts + the lumberjack story (§7), at varying depths, ≥3 question variants each.
**The needle text is NEVER shown to the embedder as the query** (the query is the *question*
about the needle, not the needle itself) — guards against the #1 recall-experiment cheat
(query≈document leakage). Auditor: confirm this is enforced.

---

## 3. The 7 metrics — operational definitions

All read-only. All run AFTER ingest, against the live v3 RPCs + Voyage, exactly as
`retrieveKnowledgeV3` calls them (RPC names/params mirrored verbatim — see §4).

1. **Recall@k** — for each needle question, does the needle's ground-truth unit appear in the
   **top-k injected** (k = inject-K, i.e. 1 and 2)? Reported as recall@1, recall@2, recall@5
   (5 = pre-inject rerank window). Hit = ground-truth match (3.1) on a returned parent unit.

2. **"Right unit reaches the reranker" across scale, per rank mode** — does the ground-truth
   unit appear in the candidate set fed to Voyage (the topk_v3 output, pre-rerank)? Measured at
   Tiers 1/6/book, **for each of the 4 `p_rank_mode` values**, to (a) pick the winner and (b)
   show v2 degrades while v3 holds. **Baseline = v2 WITH the #3a BM25 fix** (measure on top of
   it, never pre-#3a — §3b). v2 path uses `creator_knowledge_topk_v2`; v3 uses route→topk_v3.

3. **Routing precision — THE book-scale gate, HARD FLOOR.** For each needle question, is the
   needle's section in `_creator_route_sections_v3`'s top-S? Pass bar: **≥95% of planted
   needles' sections in routed top-S at book scale.** Below floor → v3 does NOT ship (flat
   fallback can't save it — it re-runs the global ranker that buried the needle). Reported as a
   function of S (sweep S ∈ {2,3,4,6,8}) to pick the smallest S clearing 95%.

4. **Latency p50/p95** — anchored to `retrieveCeilingMs=3500` (NOT 4000 — the live decoupled
   path is tighter; `decoupled-orchestrator.js:142`). Measured leg = **route RPC + topk_v3 +
   Voyage rerank** (§7's explicit scope), the candidate-count-sensitive part. Each query run
   N≥5× (warm; discard 1st cold) → p50/p95. Voyage candidate count = S × n_parent_per_section.

5. **COGS** — ingest $/book read straight from `cogs_log` rows the real worker wrote (service =
   gemini/anthropic), within the §3 modeled cap; per-turn $ = embed + Voyage rerank from a
   sampled query. No estimation — read the authoritative rows.

6. **No small-scale regression** — side-by-side v2 vs v3 on the **AoD 13k corpus**: same
   question set, compare recall@k + the top injected unit. v3 must not lose on small scale
   (where v2 already works). Requires AoD ingested at BOTH v2 and v3 (two scratch creators).

7. **"Exactly him" rubric** — harness EXPORTS a CSV: N≥30 held-out questions × {winning
   rank_mode} × {inject top-1, top-2}, with blank score columns for ≥2 raters on Likert 1–5:
   story-correctness, sounds-like-him, blanked (binary), confidently-wrong (binary). Run via
   live voice (Vuk + rater). Pass: ≥80% "right story", **ZERO blanks on known content, ZERO
   confidently-wrong**; Vuk adjudicates disagreements. Harness does NOT compute this — it
   produces the question sheet + the scoring template + (later) a tally script.

### 3.1 Hit definition (ground-truth match)
A returned parent unit "is the needle" iff its `parent_text` contains the needle's verbatim
substring (case/space-normalized) OR its `parent_title` matches the needle's title regex.
Chosen over embedding-similarity-to-needle (circular) or manual labeling (doesn't scale to
sweeps). Auditor: is substring-in-parent_text robust to the chunker splitting the needle
across two units? Mitigation: plant needles as a **single self-contained paragraph** so the
narrative-chunker keeps them in one unit; verify post-ingest that each needle resolves to
exactly one unit (a pre-flight assertion in the harness — fail loud if a needle is split or
absent, rather than silently scoring recall=0).

---

## 4. Ingest fidelity — drive the REAL worker, not a reimplementation

The frozen constants must reflect what ships. So the harness ingests by driving the actual
`makeCorpusReprocessWorker` (`server/voice-proxy/embed-worker.js`) — NOT a reimplemented
inline pipeline (the AoD spike reimplemented v2 inline; acceptable for a go/no-go signal,
NOT for freezing prod constants).

Flow:
1. `npm run dev` (Next) running separately → `/api/internal/contextual-gen` reachable at
   `http://localhost:3000` (worker dev-exception allows http-localhost; bearer = INTERNAL_API_SECRET).
2. Scratch creator at `retrieval_version=3`, `brain_status='ready'` (idempotent by handle,
   like the AoD script).
3. Insert `sample_content` rows (chapter-as-sample) with `topic_tags` → the
   `enqueue_sample_embedding_job` trigger auto-enqueues `target_version=3` jobs.
4. Construct the worker with `{ supabase: localServiceRole, geminiApiKey, internalApiBaseUrl:
   'http://localhost:3000', internalApiSecret, flyMachineId:'eval' }` and loop `worker.tick()`
   until no jobs remain (poll `corpus_reprocess_jobs` for pending/processing = 0).
5. `processV3Job` self-finalizes via `corpus_reprocess_mark_done_v3` → `finalize_v3`. Assert
   `creator_v3_ready(creatorId)=true` post-ingest (fail loud if false — surfaces a zero-unit
   section or missing centroid, per the 4d assertion).

Read path mirrored verbatim (from `retrieveKnowledgeV3`):
- embed query: gemini-embedding-001, `RETRIEVAL_QUERY`, 768-dim → `[v1,v2,...]` pg-text.
- `_creator_route_sections_v3(p_creator_id, p_query_vec, p_topic_tags, p_top_s, p_min_sim:0.0)`.
- `try_build_tsquery(p_text)`.
- `_creator_knowledge_topk_v3(p_creator_id, p_section_ids, p_query_vec, p_query_tsq, p_k_child,
  p_n_parent_per_section, p_min_sim, p_rank_mode, p_lambda)`.
- Voyage: POST `https://api.voyageai.com/v1/rerank`, `{model:'rerank-2.5', query, documents,
  top_k, truncation:true, return_documents:false}`, Bearer `VOYAGE_API_KEY`.

(Harness stays `.mjs` like the AoD script — direct supabase-js RPC + direct Gemini/Voyage. It
does NOT import the TS orchestrator; §7's latency anchor is explicitly route+topk+rerank, which
these calls reproduce. Rewrite/cache overhead is out of §7's latency scope and noted, not measured.)

---

## 5. Tuning sweep + freeze

### 5.1 Grid
- `p_rank_mode` ∈ {max, max_blend, vec_max, best_child}
- `S` (p_top_s) ∈ {2,3,4,6,8}
- `λ` ∈ {0.0, 0.05, 0.1, 0.2, 0.4} (max_blend only)
- `p_min_sim` ∈ {0.10, 0.15, 0.20, 0.30, 0.40}
Run the needle question set across the grid at book scale; record recall@k + routing precision
+ reach-reranker per cell. **Pick:** smallest S clearing the 95% routing floor; rank_mode+λ
maximizing recall@1/@2 (tiebreak: metric 7); p_min_sim = highest floor that loses no recall
(keeps junk out without dropping needles).

### 5.2 inject min-rerank-score (the unspecified one)
Collect the rerank-score distribution of (a) known-hit injected units vs (b) known-miss /
off-topic queries (ask questions the corpus genuinely can't answer — should inject NOTHING).
Set the floor between the two distributions: high enough that off-topic queries inject nothing
(no confident-wrong / no reciting a junk passage), low enough that real hits always clear it.
This is the metric-7 "ZERO confidently-wrong / ZERO blank" lever. Report both distributions;
freeze the floor at the separating value (or flag if they overlap = no safe floor exists).

### 5.3 Cost discipline within the sweep
The sweep is READ-ONLY (RPC + Voyage rerank); ingest happens once per scale tier. Voyage at
$0.05/1M and ~hundreds of rerank calls across the grid ≈ pennies. Ingest (the real cost) is
bounded by the worker's own pre-flight + per-section budget cap (fails closed). Harness prints
a running $ tally from `cogs_log` + Voyage `usage.total_tokens` and **hard-stops at a
configurable `EVAL_MAX_USD` (default $8)** before any ingest/sweep batch that would cross it —
a harness-side backstop independent of the worker cap, so a runaway loop can't blow Vuk's $10.

---

## 6. Validity threats + mitigations (the auditor's main target)

1. **Query↔document leakage** — query is the *question*, never the needle text. (3.1, 2.4)
2. **Planner instability at small N** — fixture must be large enough that HNSW is actually
   exercised (the EXPLAIN-assert lesson from step 5: ≤200 rows preferred Seq+Sort). Book scale
   clears this; Tier-1 results are directional only, flagged as such.
3. **Cache contamination** — `semantic_query_cache` keyed on `current_corpus_version`. The
   sweep varies rank_mode/λ/S/min_sim which are NOT in the cache key → a cache hit would serve
   stale ranking and corrupt the sweep. **Mitigation: harness bypasses cache entirely** —
   calls the RPCs directly (not `retrieveKnowledgeV3`, which does cache lookup). Confirm no RPC
   path writes/reads the cache. (This is also why §4 calls RPCs directly.)
4. **v2-vs-v3 fairness (metric 6)** — same questions, same embed model, v2 baseline INCLUDES
   the #3a BM25 fix, identical corpus content. Don't compare v3-with-rerank to v2-without.
5. **Needle split across units** — pre-flight assertion each needle = exactly one unit (3.1).
6. **Determinism** — embeddings are deterministic for fixed input+model; Flash chunking is
   NOT (temp 0.2). So re-ingesting reshuffles unit boundaries → needle ground-truth must be
   re-resolved per ingest (resolve by substring AFTER ingest, don't hardcode unit ids).
7. **Scratch-creator topic_tags** — chapter-as-sample requires every chapter tagged or the
   worker hard-fails (`embed-worker.js:959`). Harness applies one topic tag to all chapters.
8. **Off-topic / unanswerable queries** must be in the set (for 5.2) — without them there's no
   way to calibrate the silence gate or detect confidently-wrong.

---

## 7. Deliverables (this step)

- `docs/_planning/EVAL_V3_HARNESS_DESIGN.md` (this file).
- `scripts/eval-v3/needles.json` — needle spec.
- `scripts/eval-v3/synthetic/*.txt` — ≥3 authored distractor docs.
- `scripts/diag-eval-v3.mjs` — orchestrator: setup scratch creator(s) → drive worker → ingest
  → 6 read-only metrics + grid sweep → `cogs_log` tally → rubric CSV export. Sub-commands:
  `--ingest <tier>`, `--metrics`, `--sweep`, `--export-rubric`, `--cleanup`.
- (Later) `scripts/eval-v3/score-rubric.mjs` — tally the raters' filled CSV.

**Read-only on prod. Local Supabase only.** Scratch creators left in local DB; `db reset` wipes.

---

## 8. Open questions for the auditor
1. §2.2 — should ≥1 needle live in a synthetic doc (cross-doc routing test), or keep all
   needle ground-truth in Vuk-verifiable real content?
2. §3.1 — is substring-in-`parent_text` a robust hit definition, or do we need a unit-id
   ground-truth captured at plant time? (Determinism threat #6 argues for post-ingest resolve.)
3. §2.3 — separate scratch creator per scale tier vs one creator with docs added incrementally
   (the latter mutates `current_corpus_version` mid-experiment — cache + version churn). Leaning
   separate creators. Correct?
4. §4 — driving `worker.tick()` in a bare loop without the production `setInterval` + reaper
   cadence: any claim/lock hazard (e.g. the in-tick reaper RPC, advisory locks) when run
   single-threaded against a quiet local DB? 
5. §5.2 — if the hit vs off-topic rerank-score distributions OVERLAP (no clean separating
   floor), what's the ship decision — pick the floor that minimizes confident-wrong at some
   recall cost, or block the flip? (This is a metric-7-tiebreaker question.)
6. Is there a metric the plan §7 implies that this design drops or under-measures?

---

## 9. Revisions — auditor round 1 (ALL APPLIED; supersedes §0–§8 on conflict)

All 5 Critical + 7 Medium + the Smalls were accepted. C1, C4, M7 verified against source
(`…30:150`, `…31:306,312,325`). This section is the build contract.

### C1 — Two distinct floors; routing floor must be WIRED to prod, not just swept.
`_creator_route_sections_v3` has ONE floor: its `p_min_sim` param (`…30:150` `WHERE sim_max >=
min_sim`). Prod passes `0.0` (`retrieve-knowledge.ts:1300`) → routing currently does NOT gate,
just `LIMIT top_s`. There is no "internal floor." Plan §7 line 549 calls `p_min_sim`
"(routing/scoped-pass floor)" — i.e. BOTH layers are meant to be tuned. **Resolution:**
- Rename in the harness + freeze deliverable: **`route_min_sim`** (routing) vs
  **`topk_min_sim`** (scoped-pass, per-mode — see C2). Two separate constants.
- `route_min_sim` IS swept and frozen. Freezing it implies a **prod read-path wiring change**
  (Step 9): `retrieve-knowledge.ts:1300` must pass the frozen `route_min_sim` constant instead
  of `0.0`. Flagged as a Step-9 deliverable, not silently dropped.
- Freeze rule for `route_min_sim`: the highest value at which routing precision (metric 3)
  still clears the 95% floor at book scale — i.e. drop off-topic sections without dropping a
  needle's section. A nonzero routing floor is a real "stay-silent when nothing matches" lever
  (routing may return <S, even 0, sections → flat-fallback or silence).

### C2 — `topk_min_sim` is swept NESTED within rank_mode; frozen as a per-mode MAP.
Prod applies a per-mode scoped floor: `vec_max=0.40`, rrf-modes `=0.20`
(`DEFAULT_V3_MIN_SIM_BY_MODE`, `retrieve-knowledge.ts:1062-1065`) — because cosine (~0–1) and
RRF (~0.01–0.03) live on different scales. **Resolution:** the sweep grid is `rank_mode × S ×
λ × topk_min_sim` with `topk_min_sim` swept on a **mode-appropriate range** (rrf-modes:
{0.0,0.05,0.1,0.15,0.2,0.3}; vec_max: {0.2,0.3,0.4,0.5,0.6}). Freeze deliverable is the FULL
4-entry `DEFAULT_V3_MIN_SIM_BY_MODE` map (or at minimum the winning mode's), NEVER one scalar.

### C3 + M6 — COGS validity requires a CLEAN single-pass ingest (zero requeues).
Each chapter-sample job has a 9-min deadline (`embed-worker.js:505,1538`); on timeout the
`finally` flushes PARTIAL spend to `cogs_log` (`:1459-1464`), the reaper requeues
(enqueue_version bump), and re-run RE-SPENDS Flash/Haiku (corpus-idempotent, NOT spend-
idempotent). So `cogs_log` can contain partial + full spend → metric 5 overcounts non-
deterministically. **Resolution:**
- After ingest, assert **every** `corpus_reprocess_jobs` row for the creator is `status='done'`
  AND `attempts = 0` (or never-requeued — check `enqueue_version` unchanged). If any job
  requeued, the run's COGS + latency are SUSPECT → harness marks the tier COGS-invalid and
  RE-INGESTS on a fresh scratch creator (bounded: max 2 attempts, then abort the tier with a
  loud error — never silently re-spend toward `EVAL_MAX_USD`).
- Metric 5 then reads `cogs_log` for that clean creator (all spend belongs to successful jobs).
- Determinism (threat #6 / M6): set the narrative-chunk Flash temp to 0 for the eval ingest IF
  the worker honors an env override (verify `narrative-chunk.ts`); else accept temp 0.2 +
  single-paragraph needles + the bounded re-ingest cap as the guarantee. Either way, needle
  ground-truth is RESOLVED post-ingest (C4/OQ#2), never hardcoded to a unit-id.

### C4 + OQ#2 — Score hits against FULL unit text, by resolved `parent_unit_id`.
`_creator_knowledge_topk_v3` returns `LEFT(u.text, 3500) AS parent_text` (`…31:306,312`). A
needle past char 3500 of its unit → false miss → could fail the 95% routing floor on a
truncation artifact (or bias the fixture toward unit-starts, defeating the "buried fact"
purpose). **Resolution:**
- **Pre-flight (after ingest, before metrics):** for each needle, find the ONE
  `sample_content_narrative_units` row whose FULL `text` contains the needle substring (case/
  space-normalized). Assert exactly one match (fail loud if 0 or >1 — split/merged needle).
  Record its `parent_unit_id` as the needle's ground-truth id.
- **All metrics (recall@k, reach-reranker, routing precision) compare by `parent_unit_id`**, not
  substring against the truncated `parent_text`. Routing precision compares the unit's
  `section_id` (from the units table) against the routed top-S `section_id`s.

### C5 — Metric 6 (no-regression) reported BOTH ways + flatFallbackFired surfaced.
v3 has a flat fallback v2 lacks (`retrieve-knowledge.ts:1407-1452`), and the two systems'
floors aren't comparable. **Resolution:** report metric 6 as (a) **scoped-only** (v3 flat
fallback DISABLED — isolates routing+ranking architecture) AND (b) **full-pipeline** (fallback
on — mirrors prod). Run each system at its OWN tuned floor (v2 at its 0.30; v3 at frozen
per-mode `topk_min_sim`). Emit a `flat_fallback_fired` count per query so any v3 "win" driven by
the fallback (not by ranking) is visible, never hidden.

### M1 + M2 — Stable-state assertion before reads; cache-toucher documented.
No read RPC touches `semantic_query_cache` (confirmed: neither route nor topk references it).
The ONLY cache-touching path is worker `finalize_v3` bumping `current_corpus_version`
(`…50:115-118`) — runs during INGEST only, before any sweep read. Version churns once per
sample regardless of creator separation (so OQ#3's "version churn" rationale was wrong; separate
creators are still correct, for clean section counts). **Resolution:** before any metric read,
assert (a) zero `corpus_reprocess_jobs` pending/processing for the creator, and (b)
`current_corpus_version` identical across two reads ~1s apart (ingest fully quiesced). Sweep
bypasses cache by calling RPCs directly (not `retrieveKnowledgeV3`). Document the one cache
toucher so nobody "optimizes" the harness to read mid-ingest.

### M3 — Rerank floor is the LAST constant frozen, on the frozen config.
`inject_min_rerank_score` (§5.2) depends on the candidate set, which depends on
mode/S/λ/n_parent/topk_min_sim. **Resolution:** freeze ORDER is: (1) rank_mode, (2) S +
route_min_sim, (3) λ + topk_min_sim, (4) inject-K, THEN (5) `inject_min_rerank_score` —
calibrated on the EXACT frozen config. Re-run (5) if any earlier constant changes.

### M4 — Off-topic questions need a VERIFIED-empty ground truth.
**Resolution:** Vuk labels each off-topic/unanswerable question at authoring time; harness
asserts post-ingest that NO unit's full text substring-matches it (same rigor as needles). A
question the book glancingly covers is disqualified from the off-topic set. Without verified-
empty ground truth, the §5.2 off-topic distribution is noise.

### M5 — Latency: measure the FULL orchestrator turn for the gate; keep the leg split for diagnosis.
Prod races rewrite+embed+cache-lookup+route+topk+rerank against ONE `deadlineMs`
(`retrieve-knowledge.ts`). Freezing S/n_parent so route+topk+rerank alone fits 3500ms ignores
the budget rewrite+embed already spent. **Resolution:** the GATE latency = full
`retrieveKnowledgeV3` p50/p95 (so the harness DOES call the real orchestrator for the latency
metric specifically — via a thin tsx entry or by replicating rewrite+embed timing). Keep the
route+topk+rerank split as a diagnostic. If calling the TS orchestrator from .mjs is too heavy,
budget explicitly: gate leg ≤ (3500 − measured rewrite+embed p95). Document the subtraction.
NOTE: this is the one place the harness needs the orchestrator, not just RPCs — reconcile with
§4's "RPCs directly" (RPCs for sweep/recall; orchestrator for the latency gate number).

### M7 — Order candidates by `parent_score DESC` for ALL modes; never read `rrf_score`.
The RPC already returns rows `ORDER BY parent_score DESC` (`…31:325`), and `rrf_score` is
MEANINGLESS under `vec_max` (`…31:330` caller contract). **Resolution:** harness preserves the
RPC's returned row order; reads `parent_score` only. `rrf_score` is read ONLY for the v2-parity
path (metric 6 v2 side uses `creator_knowledge_topk_v2`'s `rrf_score`, which is legitimate
there).

### Smalls (answers to §8 open questions + nits)
- **OQ#1:** YES — plant exactly ONE low-stakes fact needle in a synthetic doc (tests cross-doc
  routing at the boundary); ground truth = a verbatim authored sentence Vuk can still verify.
  Lumberjack + high-value facts stay in the book.
- **OQ#2:** resolve to `parent_unit_id` at pre-flight, score by id (folded into C4).
- **OQ#3:** separate scratch creator per tier — correct, for clean section counts (NOT version
  churn, per M1).
- **OQ#4:** bare `tick()` loop is safe (single-threaded; job reaches done/errored within its
  tick before the next tick's reap; re-claim idempotent). Real hazard is the 9-min deadline →
  requeue (C3). Never sleep >600s mid-loop with a job in `processing` (reap TTL).
- **OQ#5:** if hit vs off-topic rerank distributions OVERLAP with no clean separator → **BLOCK
  the flip** and surface to Vuk as an explicit override decision (ZERO confidently-wrong is a
  hard floor; don't auto-ship a floor that knowingly admits confident-wrongs).
- **OQ#6 (important):** run the **v2 path (`creator_knowledge_topk_v2`) at ALL three scale
  tiers**, not just AoD. The "v2 demonstrably degrades as the corpus grows" half of metric 2
  (the core project justification) was unmeasured in §3; now scheduled. v2 has no routing/
  sections, so it runs flat over the whole creator corpus at each tier.
- Pin `rerank-2.5` (not bare `rerank`); confirm matches prod bridge model.
- Assert post-ingest each needle paragraph wasn't merged into an oversize unit that sub-packed
  into " (part k/N)" parts (would split the needle) — covered by the C4 "exactly one unit"
  assertion.

---

## 10. Validation results — AoD corpus (2026-05-29, machinery proof)

AoD (8 chapters, ~91k words, ~book-scale by tokens but only **15 sections**) ingested through
the REAL worker at v3. Purpose: prove the harness machinery + characterize behavior. NOT the
gate (the book + Vuk-verified questions is the gate; AoD questions were fast/oblique/unverified).

**Ingest:** clean 8/8 jobs, `creator_v3_ready=true`, 15 sections / 160 units / 189 chunks, ~16 min.
**Ingest COGS: $0.75** (Anthropic Haiku contextual-gen $0.52 + Gemini Flash+embed $0.23) — matches the §3 model; Haiku dominates as predicted.
**Latency (full-turn proxy):** p50 **910ms** / p95 **1774ms** vs 3500ms ceiling. Legs: rewrite 545ms (dominant), route 4ms, topk 5ms, rerank 328ms. Routing+topk add ~9ms — negligible.
**Per-turn COGS:** ~$0.0005 (rerank) — trivial.

**Retrieval (default S=4, max_blend, COLD/contextless oblique questions):** routing precision 58%,
recall@1 17%. Sweep (S up to 10, all modes/λ): routing caps ~75%, recall@1 stuck 16.7%.

**Per-needle debug trace — the real story (diagnosis, not verdict):**
- `twin-experiment`: section #1, unit #1, candidate #1, **post-rerank #1** — pipeline perfect when Q genuinely matches the unit. (Proof v3 retrieval is sound.)
- `lumberjack`: retrieval #1 → **Voyage demoted to #10** — CORRECT: the oblique question ("why do I keep failing forcing myself") isn't really answered by the lumberjack analogy; the cross-encoder rightly preferred other units.
- `dopamine`: unit ranks #4 *within its own section* — the question is oblique even to its own unit.
- `outwitting`: section ranks #11+ (below the **`p_top_s`≤10 clamp**) — bad question + the clamp.

**Findings (the harness's actual output):**
1. **Fixture-question quality dominates the recall number**, not the architecture. Cold/oblique/
   unverified questions are the worst case. The gate REQUIRES creator-verified questions (Vuk's book).
2. **Flash narrative-chunk is lossy** (~58% of source chars retained on AoD). A dropped fact is
   unretrievable regardless of routing — watch on the book (ingest-coverage is a real metric).
3. **`p_top_s` is clamped to [1,10]** (route RPC line 79) — may bite at book scale (100s of
   sections need S>10). Decide at freeze whether to raise the clamp.
4. **Production retrieval is NOT cold** — `topicTags` (= the hook the user tapped) feeds
   `route_sections_v3.topic_boost`; query-rewrite folds in `lastAssistantResponse`. The book run
   adds a **warm condition** (entry-hook topic_tags + a prior turn) alongside cold, to measure how
   much context is worth and whether the entry-video signal should boost stronger than topic_tags.
5. **v3 ingestion was more robust than v2** on AoD's messy `\!`/`\?` transcript: v3 8/8 clean; the
   v2 narrative-chunk route returned empty units on 6/8 (`narrative_chunk_fallback_to_v1`). AoD
   no-regression is therefore DEFERRED to the book (clean input); not a v3 defect.

**Harness bugs found+fixed during validation:** `corpus_reprocess_jobs` keys on `sample_id` (no
`creator_id`); `cogs_log` attributes via `metadata->>creator_id` (no `creator_id` column). Both fixed.

---

## 11. Auditor round 2 — harness CODE (2026-05-29, pre-commit)

Audited the built `diag-eval-v3.mjs`. Applied: **C1** (report candidate-set mean/min so
recall@5's min(5,cands) window is explicit), **C2** (off-topic verified-empty via
`forbidden_substring` absence, not the vacuous substring-of-question check), **C3** (budget
enforced per-question in the sweep + per-tick on the ingest drain via live cogs_log read — the
dominant cost path is now capped, not just accounted post-hoc), **C4** (debug route honestly
labels the p_top_s≤10 clamp; "NOT FOUND" = ranks worse than #10), **M1** (flat-fallback mirrors
prod: fires only when routing returned sections), **M4** (sweep GATES on the 95% routing floor
before ranking by recall — a sub-floor cell can't be surfaced as winner), **M5** (latency uses
fresh embeds so the embed leg is timed, not cache-zeroed), **M6** (failed rewrites excluded from
the latency distribution), **M7** (warn loudly if Voyage omits usage rather than silently
estimating), plus Smalls (per-mode topk_min_sim grid widened to the §9-C2 ranges; `V2_MIN_SIM`
named; Voyage top_k divergence documented).
**Accepted (low exposure, documented not code-fixed):** M2 (flat-fallback `.limit(50)` matches
prod's constant + first-by-index selection bias — same as prod, faithful), M3 (cogs read scoped
by `metadata->>creator_id` on a freshly-recreated creator per ingest — second-ingest-without-
cleanup is the only double-count path and the harness recreates the creator each `ingest`).
**Genuinely absent (owed before freeze, not mis-built):** `inject_min_rerank_score` calibration
(§5.2, last constant frozen — and now its off-topic negatives are properly verified-empty per
C2); the explicit cold-vs-warm context split (§10 finding 4 — current single condition is
topic-tag-warm, no prior turn).

---

### Net build-order impact
1. Fixtures (needles.json with verified-empty off-topic questions + 1 synthetic-doc needle;
   synthetic docs).
2. Ingest driver (drive worker; assert clean single-pass + creator_v3_ready + stable version).
3. Pre-flight needle→unit-id resolution (full text).
4. Metrics by unit-id: recall@k, reach-reranker (v2 AND v3 at all tiers), routing precision,
   COGS (clean-run only), no-regression (both ways), latency (full orchestrator).
5. Grid sweep (rank_mode × S × λ × per-mode topk_min_sim × route_min_sim), freeze in order
   (M3), inject floor last.
6. Rubric CSV export.
**Prod read-path wiring (`route_min_sim` → `retrieve-knowledge.ts:1300`) is a Step-9 item, not
this script.**
