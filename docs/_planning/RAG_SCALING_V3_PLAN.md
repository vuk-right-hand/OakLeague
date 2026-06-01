# RAG Scaling — `retrieval_version=3` Implementation Plan

**Status:** BUILD (approved by Vuk 2026-05-28, post 3-round audit). Not deployable until `PROD_DEPLOY_GATE` Step 1c.
**Branch:** `rag-v3-scaling` (active). Step 2 (`section-segment.ts`) shipped 2026-05-28 — 44 unit tests + 1-round audit + 21/0 parity check against the spike on Vuk's 91k-word AoD corpus.
**Author brief:** `docs/_planning/RAG_SCALING_ARCHITECTURE_BRIEF.md`. This document is the *answer* to that brief.

> **The moat in one line.** Take retrieval from "works for one 13k-word transcript" to "flawless at
> book-scale" so the avatar surfaces the creator's *own* stories/facts on demand. The face is a
> commodity; the brain is the moat. Retrieval feeds the brain facts and stories — persona/voice
> ("exactly him" *style*) is a separate layer (`creators.system_prompt` + Cartesia) and is **out of
> scope here**.

---

## 0.0 North Star — UX is the acceptance bar, security/COGS are the floor

> The goal is the **"HOLY FUCK, that's EXACTLY him"** recognition moment that drives k>1 virality.
> Retrieval correctness, RLS, COGS, and migration discipline are the **price of admission, not the
> win.** When a tradeoff is forced, UX wins. Every design choice below is judged first by *"does
> this make the avatar feel like him talking, in real time?"* — then by the floors.

This plan's three retrieval levers map directly to three ways the recognition moment **dies**, and
each lever exists to prevent one. Read the rest of the plan through this table:

| The moment dies when… | What kills it | The lever that saves it |
|---|---|---|
| **He blanks** on something he plainly knows ("tell me the lumberjack story" → "I don't have that") | retrieval miss — the right unit never reaches the brain | **Routing precision is THE book-scale recall gate** (§7 #3, round-3 M-1) — the flat fallback (§2.3) only restores *v2-parity*, and v2 is itself broken past ~20 units, so "≥ v2" is true-but-vacuous at book scale. Real floor: *needle's section in routed top-S ≥ target%*. The fallback catches small-scale / near-miss cases; routing precision catches book scale. *Never make him not-know his own content.* |
| **He recites** — sounds like he's reading a Wikipedia page, not talking | over-injection / raw dump into the brain prompt | **Top-1/2 low-blend injection** (§2.3 Stage 4) — one precise unit as *background*, the brain re-voices it. The injection envelope is the dial between "speaks" and "reads aloud." |
| **He generalizes** — gives a mushy summary instead of *the* story | SUM-RRF surfaces the parent with many mediocre chunks over the one with a single perfect beat | **MAX-child ranking** (§2.3, §3b) — the single strongest narrative beat wins, so he tells *the actual story*. This is the most "exactly him" part of the whole design. |
| **He's confidently WRONG** — says something off as if he knows it (worse than blanking) | MAX + top-1 is high-variance: a lexically-perfect / semantically-wrong single chunk can win and get injected alone with nothing to dilute it (round-2 M-2) | **Min-score inject gate** (§2.3 Stage 4) — top-1 injects only if the rerank score clears an absolute floor; below it, inject **nothing** and let the persona answer ("I'd have to think about that") — silence beats a confident wrong. Tuned on the harness adversarial set. |
| **He answers a different question** than asked | flat fallback (C2) floods the rerank set with high-lexical-wrong-meaning candidates when routing missed (round-2 M-1) | flat pass is rank-capped AND the min-score gate above still applies post-rerank; harness measures a **false-confident-answer rate**, not just recall. |
| **He lags** — the gap between question and answer breaks the live feel | extra route RPC + bigger rerank set blow the turn budget | **Latency invisibility** (§11/M5, §12/M-4) — 4s is a hard ceiling, *snappy* is the target; routing + rerank re-budgeted and harness-validated with a measured p50/p95 before freeze. |

**Consequence for acceptance (§7):** recall@k and "reaches-the-reranker" are *proxies*. The real
bar is a human who knows the creator saying *"that's exactly how he'd answer."* §7 adds that
qualitative rubric — a plan that maxes recall numbers but makes him recite has failed.

---

## 0. Ground truth — what I verified in the code (not prose)

Read end-to-end before writing this: `src/lib/voice/narrative-chunk.ts`, `src/lib/voice/retrieve-knowledge.ts`,
`creator_knowledge_topk_v2.sql`, `sample_content_chunks_v2.sql`,
`sample_content_narrative_units.sql`, `src/lib/voice/contextual-retrieval.ts`, `src/lib/voice/build-injection-envelope.ts`,
`server/voice-proxy/embed-worker.js` (both `makeEmbedWorker` + `makeCorpusReprocessWorker`),
`creators_current_corpus_version_finalize.sql`, `src/lib/voice/brain-prefix.ts`, `server/voice-proxy/index.js`
(dispatch).

> **Path note for builders.** All `embed-worker.js` citations below are at `server/voice-proxy/embed-worker.js` (NOT under `src/lib/voice/`). All proxy citations are at `server/voice-proxy/index.js`. Audit round-4 M5.

Confirmed facts that drive every decision below:

1. **Wall A is real and admitted in-code.** `narrative-chunk.ts:312-314`: one Flash call over the
   *whole* document, `maxOutputTokens: 65535`, comment says *"the real ceiling is the input doc
   size (chunk the input for pathologically large samples — future work)."* A 200k-word book blows
   both the input window and the output cap.

2. **Wall B is real and structural.** `creator_knowledge_topk_v2.sql:194-218`: children fuse by
   RRF (k=60), then **`SUM(rrf)` per parent**, then `ORDER BY rrf_sum DESC LIMIT k_parent` with
   `p_k_parent=20` hard-passed by `retrieve-knowledge.ts:701`. SUM rewards parents with *many*
   mediocre children over one with a *single perfect* child (the lumberjack: vec-rank #1, RRF-rank
   #5). At 1 doc that's harmless; at 3 books the right unit falls past global RRF-rank 20 and
   **never reaches the reranker**.

3. **BM25 is structurally dead.** `try_build_tsquery` → `websearch_to_tsquery` ANDs every term
   incl. question words; no 150-token chunk matches all → `bm25_score=0` on every row, and the dead
   list still pollutes RRF. (A small fix is in-flight in the RAG workstream; v3 *assumes lexical
   should work* and hardens it.)

4. **`topic_tags` exist but retrieval ignores them.** They're on `sample_content`,
   `sample_content_narrative_units`, and `sample_content_chunks`, validated against
   `creator_topics`. `brain-prefix.ts:173-180` already routes the *persona seed* by
   `hooks.topic_tags ↔ sample_content.topic_tags` overlap. **Retrieval (`topk_v2`) does not.** This
   is a free routing signal we're leaving on the floor.

5. **Contextual-gen is implemented, not a stub.** `embed-worker.js:1041-1070` calls
   `/api/internal/contextual-gen` (Haiku, 1h prompt-cache on the doc prefix) per child chunk;
   `chunk_context` folds into `text_search` via the GENERATED column
   (`sample_content_chunks_v2.sql:80-85`). Anthropic's published number: contextual embeddings +
   contextual BM25 = **49% fewer** top-20 failures; **+ rerank = 67%**.

6. **Hierarchy today = Document → Narrative Unit → Child Chunk.** No Section level. Flat per-creator
   chunk pool. The Section level is exactly what book routing needs.

7. **Gating is clean and reusable — but the v3 flip touches MORE objects than first stated
   (corrected after audit round 1).** `creators.retrieval_version` (read-path cutover, admin-flip,
   snapshot → `sessions.retrieval_version_at_session`) is **separate** from
   `creators.current_corpus_version` (cache-invalidation revision, snapshot →
   `sessions.corpus_version_at_session`). Proxy dispatches on the snapshot
   (`index.js:950`: v1 in-proc `retrieveTopK`, v2 HTTP shim). **CORRECTION:** I originally claimed
   the per-sample reprocess "finalize" bumps `current_corpus_version` and deletes old chunks via
   `corpus_reprocess_finalize`. **It does not.** The live worker calls
   `corpus_reprocess_mark_done` (`embed-worker.js:1205`), which only sets `status='done'` — it does
   **not** delete old chunks and does **not** bump `current_corpus_version`. `corpus_reprocess_
   finalize` exists with pgTAP tests but has **no caller**. Today `current_corpus_version` is bumped
   only by the admin downgrade path. This breaks the cache-invalidation assumption and is fixed in
   §11/C1. Also, EVERY gating object hard-pins `{1,2}` and must be migrated in lockstep for v3
   (verified): `creators.retrieval_version CHECK IN (1,2)` (`20260514000001:24`), the live admin RPC
   `admin_set_creator_retrieval_version` guard `NOT IN (1,2)` + its hardcoded `chunker_version=2`
   zombie-delete (`20260516000004`), `corpus_reprocess_jobs.target_version CHECK IN (2)`
   (`20260515000001:36`), the enqueue trigger that `RAISE feature_not_supported` for
   `retrieval_version ∉ {NULL,1,2}` (`20260517000004:96`), and
   `sessions.retrieval_version_at_session CHECK IN (1,2)` (`20260522000100:64`). `chunker_version`
   is a permanent enum `CHECK (1,2)`. v3 slots into the same *pattern* but the flip is a
   coordinated multi-object migration, not a one-liner — see §11/C3+C4.

8. **Injection is already top-1/2 + precise.** `build-injection-envelope.ts` wraps parents in a
   `BEGIN/END REFERENCE` envelope with a 4KB soft / 32KB hard ceiling and lowest-score-drop. The
   RAG workstream just set decoupled injection to **top-1**. v3 must preserve precise low-blend
   injection — *not* dump a section.

---

## 1. SOTA reviewed (verified against current sources, per "Verify, Don't Guess")

| Source | What it gives us | Decision impact |
|---|---|---|
| **Anthropic Contextual Retrieval** (anthropic.com/news/contextual-retrieval) | Contextual embeddings + contextual BM25 = 49% ↓ top-20 failure; +rerank = 67%. | Keep contextual-gen for v3. **Fix BM25** so "contextual BM25" actually fires. Keep cross-encoder rerank as precision layer. |
| **KohakuRAG** (arXiv 2603.07612, WattBot-2025 winner 0.861) | 4-level tree Doc→Section→Paragraph→Sentence; **bottom-up length-weighted child-embedding aggregation** for parent vectors (no per-node LLM); LLM **query planner** (n related queries) + **cross-query consensus rerank**; retrieve fine-grained then **expand to parent/siblings**; **prompt reordering = +80% relative**. | Adopt the routed hierarchy + bottom-up aggregation (cheap section vectors, no RAPTOR rebuild). Adopt small-to-retrieve/large-to-inject (already our model). Reorder injected passages best-first. Query-planner = optional v3.1. |
| **HiSem-RAG** (MDPI 2076-3417/16/2/903) | Titles + summaries for **bidirectional** routing; adaptive threshold for retrieval scope. | Section node carries an LLM title+summary used as a routing label + summary-vector. Adaptive section-count (don't fix S blindly). |
| **RAPTOR** (arXiv 2401.18059) + dynamic variant (2410.01736) | Recursive LLM-summary tree; **high build cost; painful rebuild on dynamic data**; adRAP only *mitigates* with added complexity. | **Reject full RAPTOR for v3.** OakLeague creators *continuously add* content (5th book, new course). RAPTOR's global-tree rebuild per content change is a COGS + latency liability our per-sample incremental model avoids. Revisit a single summary layer only if eval demands it. |
| **Late chunking** (arXiv 2409.04701 / Jina) | Long-context embed → mean-pool per chunk = contextual chunk embeddings **without** per-chunk LLM. | Cheaper alternative to Haiku contextual-gen, but needs an embedding-model swap (gemini-embedding-001 → late-chunking-capable). **Flag as v3.1 COGS lever behind the embedding bridge; do not couple to v3.** |
| **Voyage rerank-2.5** (docs.voyageai.com) | 32K ctx, query ≤8K tok, evals use **up to 100 first-stage candidates**, `truncation` default on. | Our scoped candidate budget (≈40, up to 100) is well within limits. |

Sources:
[Anthropic Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) ·
[KohakuRAG](https://arxiv.org/html/2603.07612) ·
[HiSem-RAG](https://www.mdpi.com/2076-3417/16/2/903) ·
[RAPTOR](https://arxiv.org/pdf/2401.18059) ·
[RAPTOR dynamic / adRAP](https://arxiv.org/html/2410.01736v1) ·
[Late Chunking](https://arxiv.org/abs/2409.04701) ·
[Voyage rerank-2.5](https://docs.voyageai.com/docs/reranker)

---

## 2. The chosen architecture — "Routed hierarchical retrieval" (Wikipedia-style)

> Find the article → the section → the passage. Concretely: **route to sections, search within them,
> rank parents by MAX child, rerank, inject top-1/2.**

### 2.1 Hierarchy (adds the Section level)

```
Document (sample_content)
  └─ Section  (sample_content_sections)         ← NEW. title + summary + routing vectors
       └─ Narrative Unit (…_narrative_units)     ← exists; the INJECT granularity
            └─ Child Chunk (…_chunks v3)          ← exists; the EMBED/RETRIEVE granularity
```

Section = a bounded slice of one document (a chapter, a heading-block, or a ~6–8k-token window for
unstructured transcripts). Two reasons it exists:
- **Ingestion (fixes Wall A):** the chunker LLM processes ONE section per call → bounded input +
  bounded output → book-safe. **Resumability is section-checkpointed** (audit C5): each section is
  an idempotent unit of work — before re-embedding a section on reclaim, DELETE that section's
  units+chunks only (not the whole sample), so a crash at section 200/400 of a book costs one
  section's re-pay, not the whole book (ties to COGS §3 / M2). This requires the chunk UNIQUE to
  carry the section dimension — see §11/C5 for the exact constraint + `chunk_index` allocation
  decision (section-local index, `UNIQUE (sample_id, chunker_version, section_index, chunk_index)`).
- **Retrieval (fixes Wall B):** routing target. We pick the right *sections* first, then the rerank
  window is filled from the right neighborhood instead of a global RRF top-20.

### 2.2 Ingestion (per sample, incremental — fixes Wall A)

```
preprocess (exists)
  → SEGMENT into sections   [NEW: structural-first, window-fallback; NO LLM for the split]
  → for each section (resumable):
       Flash narrative-chunk over THE SECTION ONLY  (bounded input, ≤ ~8k tok)
         → also emit a 1–2 sentence section summary + title  (same call, cheap)
       → for each unit → child chunks (existing chunkSample)
           → contextual-gen (Haiku, doc-prefix cached — exists)  [+ prepend section title to chunk_context]
           → embed child (gemini-embedding-001, RETRIEVAL_DOCUMENT — exists)
           → _insert_chunk_v3_unsafe(parent_unit_id, section_id, …)
       → section.centroid_embedding = length-weighted mean of its child embeddings   [bottom-up, no LLM]
       → section.summary_embedding  = embed(title + " " + summary, RETRIEVAL_DOCUMENT)
  → corpus_reprocess_finalize_v3 (atomic per-sample cutover + version bump — extends existing)
```

**Section segmentation (decision #2 — structural-first, window-fallback, NO LLM for the split):**
- Books/markdown/docs: split on headings (`^#{1,6} `, `^Chapter \d+`, `^\d+\.\s`, ALL-CAPS title
  lines, form-feed `\f`). Deterministic, free, resumable.
- Video/podcast/course transcripts: split on timestamp gaps + paragraph runs into ~6–8k-token
  windows (the brief's "timestamp/topic windows").
- Anything with no structure: fixed ~6–8k-token windows with ~200-token overlap.
- **Hard rule:** segmentation is pure-text + regex/heuristic, **never** an LLM call (LLM
  segmentation = a second Wall-A-class input-size problem + COGS + nondeterminism). The *summary*
  is LLM-generated, but it rides the per-section narrative-chunk call we're already making.

### 2.3 Retrieval (per turn — fixes Wall B)

```
rewrite (exists) → embed query (exists) → cache lookup (exists, keyed on corpus_version)
  on miss:
  Stage 1 — ROUTE:  creator_route_sections_v3(creator, qvec, qtsq, topic_tags?)
       score each section = max( cos(qvec, summary_emb), cos(qvec, centroid_emb) )
                            + soft topic_tags boost (NOT a hard gate)
       → take top-S sections (adaptive: S∈[2,6] via score-gap threshold)
  Stage 2 — SCOPED HYBRID SEARCH within the routed sections only:
       vector top-k_child + BM25 top-k_child  (BM25 now OR-semantics, question-words stripped)
       → RRF fuse at CHILD level (k=60, keep — RRF is good for fusing two lists)
       → group to parent unit, score = MAX(child_rrf) + λ·ln(1+matched_children)   [MAX, not SUM]
       → top-N parents PER section, union → ~30–40 candidates
  Stage 3 — RERANK (Voyage rerank-2.5, exists) over the scoped candidates → top-1/2
  Stage 4 — INJECT (build-injection-envelope, exists) best-first, low-blend
       MIN-SCORE GATE: inject top-1 only if rerank score ≥ floor; else inject NOTHING
                       (persona answers) — silence beats confidently-wrong (R2-M2)
```

**Why this kills the k_parent=20 failure:** candidates are drawn *per routed section*, so the right
unit competes only inside its own neighborhood's top-N, not against thousands of global units.

**Routing recall fallback (audit C2 — MANDATORY, not optional).** Hard section-scoping can make a
needle in a *mis-routed* section MORE unretrievable than flat v2 (the exact regression we exist to
kill). So Stage 1 is never a hard gate alone. Stage 2 runs unscoped (flat, all-section hybrid) AND
unions with the scoped pass whenever **either** trigger fires: (a) the section-score gap is below
the adaptive threshold (router is not confident), **or** (b) the scoped pass returns fewer than a
floor of candidates above `min_sim`. The flat pass is rank-capped so it can't flood the rerank set,
but it guarantees v3's recall floor is **≥ v2's**, never worse. The reranker sees the right
candidate because routing puts it in scope *when confident* and the flat fallback catches it *when
not*. The harness (§7) measures how often the fallback fires and whether it recovers the needle.

**Ranking — coupled with routing + window; the formula is harness-decided, not pre-committed
(addresses brief §3b hand-off).** §3b is an explicit carry-over from the RAG live-fix workstream:
they fixed BM25 (#3a) but *deliberately deferred* the parent-ranking change here because it only
bites at scale and must be *measured*, not bolted on. We treat **parent-ranking + rerank-candidate
window + routing as ONE problem**: SUM-burial only becomes a *miss* when it pushes the right unit
past the candidate window; routing shrinks the window's job, ranking decides who's in it. So v3
implements `topk_v3` with the parent-aggregation expression **parameterized** (`p_rank_mode`) and
A/Bs these candidates on the eval harness (§7), no pre-commit:
- (a) `MAX(child_rrf)` — pure max.
- (b) **max-dominant blend** `MAX(rrf) + λ·ln(1+n_children)` (λ small; my prior; conservative
  default).
- (c) `MAX(vector_sim)` with BM25 as tiebreak.
- (d) **best-child-per-parent dedupe** — take each parent's single best child as the candidate
  *unit*, rank those, skip parent-grouping entirely.

**Acceptance (brief §3b):** the "right unit reaches the reranker as the corpus grows 1→6 docs→book"
metric must improve, with **no regression** on the current ≤20-unit case (where rerank already
fixes order). The winning mode is frozen after the harness run; the others stay reachable via
`p_rank_mode` for future re-tuning.

**BM25 — reuse the workstream's #3a fix, do NOT re-implement.** The OR-semantics tsquery fix
(strip interrogatives/stopwords, `|`-join content terms) is **already live in the RAG branch** and
changes the RRF inputs. v3 retrieval calls *that* helper, and the eval harness measures v3 ranking
**on top of #3a**, never against pre-#3a behavior. If #3a is still a `try_build_tsquery`-shaped
helper at merge time, v3 reuses it directly; v3 adds no second BM25 implementation. (Migration item
7 below is therefore a *coordination/reuse* note, not new SQL, unless #3a hasn't merged.)

### 2.4 Routing mechanism (decision #3 from brief §4)

Chosen: **section summary-vector + centroid-vector search, with `topic_tags` as a soft boost** —
*not* topic_tags-as-hard-filter, *not* learned/fine-tuned section embeddings.
- Pure `topic_tags` routing is too coarse (≤5 topics/creator) and brittle (mistagged sample →
  unreachable). Use it only as a +boost and as a candidate-widener when section scores are flat.
- Learned section embeddings = training infra we don't own (anti-"infra company"). Rejected.
- Summary-vector (captures topical words/proper nouns) **OR'd with** centroid-vector (captures the
  section's actual distribution) is cheap (sections are few: a 200k-word book ≈ 30–80 sections),
  needs no training, and rebuilds per-sample. `MAX` of the two so a section wins on either signal.

### 2.5 RAPTOR vs this (decision #1 from brief §4) — explicit justification

We chose **routed parent/child + section summaries** over a **RAPTOR recursive summary tree**:
- **Rebuild cost is the deciding factor.** RAPTOR clusters + LLM-summarizes recursively across the
  *whole corpus*; adding a creator's 5th book or editing a transcript invalidates clusters and
  forces re-summarization. OakLeague's usage is *continuous incremental adds per creator*. Our
  per-sample sectioning rebuilds only the changed sample and bumps `current_corpus_version` — the
  finalize machinery already exists.
- **COGS.** RAPTOR adds an LLM summary per internal node at every tree level. Our design adds **one
  short summary per section** (≈30–80 per book) on a call we already make, plus a *free*
  length-weighted centroid. Order-of-magnitude cheaper at book scale.
- **Power retained.** RAPTOR's win is "high-level question matches a summary, specific request
  matches a leaf." We get the same two-altitude behavior: high-level → section summary routes;
  specific → child chunk retrieves; we inject the parent unit. KohakuRAG hits SOTA with exactly
  this shape and no recursive summary tree.
- **Escape hatch.** If the eval harness (§7) shows synthesis-style questions ("what's your overall
  philosophy on X") underperform, we add **one** optional summary layer (section-summary as an
  injectable unit) behind the same v3 plumbing — bounded, not a recursive tree.

### 2.5b Considered & rejected: GraphRAG / knowledge-graph retrieval (e.g. graphify)

Evaluated 2026-05-27 (Vuk raised graphify — a popular codebase-comprehension skill that builds a
Leiden-clustered entity/relationship knowledge graph and answers *relational* queries like "what
connects auth to the database?"). **Rejected for OakLeague's core retrieval, for four concrete
reasons:**
1. **Wrong problem shape.** GraphRAG wins when the value is in *relationships between entities*
   (code call-graphs, citation/medical ontologies) and queries are multi-hop. Our retrieval target
   is a *narrative passage* ("tell the lumberjack story", "his philosophy on sleep") — single-hop
   semantic recall + the creator's voice. Shredding a story into nodes/edges makes "tell the story"
   *harder*, not easier.
2. **No user-token win left to capture.** GraphRAG's token savings come from returning a compact
   subgraph instead of dumping files. **We already inject top-1/2 in a ~4KB envelope** (§2.3 Stage
   4) — a connected subgraph would be *larger*, not smaller. The premise "save user tokens on
   retrieval" is already solved by minimal injection.
3. **It worsens the cost we actually pay.** Our dominant spend is ingestion (per-chunk Haiku
   contextual-gen). A graph adds entity-extraction + community-detection passes on top, and
   reintroduces the **rebuild-cost wall** that made us reject RAPTOR (adding a creator's 5th book
   churns cross-entity edges → re-cluster). Our per-chapter-sample incremental model avoids it.
4. **It's infra we explicitly don't build.** CLAUDE.md: "operator-network + cloned-voice + RAG-brain
   company, not an infrastructure company." A graph DB + extraction pipeline + clustering is exactly
   the retrieval infra we said we wouldn't own. **Our Document→Section→Unit→Chunk hierarchy with
   parent FKs + topic-routing IS already a constrained graph (a tree)** — ~80% of the structural
   benefit, none of the rebuild/infra cost.

**What we keep from the idea:** (a) the synthesis/multi-hop need is real and is already the §2.5
summary-layer escape hatch — enable only if the harness proves it; (b) one cheap content-modeling
borrow (not a graph): a `unit_type: principle | story | fact` tag so frameworks/opinions are
first-class retrievable units, sharpening "exactly him" on opinion questions at ~zero cost.

**Reconciliation (see §15).** "Reject graph" applies to graph-as-PRIMARY-LOOKUP only. The
*interconnection* instinct is correct for two things — **centrality** (which ideas the creator
returns to = the PageRank analog) and **association adjacency** (pre-warming related units so
follow-ups flow). §15 folds those in as a *lightweight* relationship layer on top of the library
("library for finding, lightweight graph for connecting") — no graph DB, no entity-extraction
pipeline.

---

## 3. COGS model (CLAUDE.md hard rule — every paid call logged; ingestion is the big one)

All ingestion calls already write `cogs_log` (`embed-worker.js` flush helpers). v3 changes the
*shape* of ingestion, so re-model:

**Per-book ingest (≈200k words ≈ 50k tokens), one-time per creator-sample:**
- Segmentation: $0 (pure text).
- Narrative-chunk Flash: now **per section** (≈30–80 calls) instead of 1. Each call's input is one
  section (~6–8k tok) → input tokens *summed* across sections ≈ the whole doc once (same as today's
  single call), plus per-call prompt overhead × N sections. Output ≈ same total. Net: **~same Flash
  spend, +small per-call overhead**, but now it *completes* (today it truncates/fails). Add the
  section summary to each call's output: +~50 tok output/section ≈ negligible.
- Section summary embeddings: +(#sections) embed calls ≈ 30–80 × tiny. Negligible.
- Centroid: $0 (computed from existing child vectors).
- **Contextual-gen (Haiku) is the dominant cost** and is *unchanged in volume* (per child chunk,
  doc-prefix cached). This is the line to watch. **Model it explicitly in the rollout gate**: at ~4
  child chunks/unit and ~hundreds of units/book → low-thousands of Haiku calls, ~90% on cache-read
  ($0.10/M). Estimate + assert against `CREATOR_EMBEDDING_DAILY_CAP_USD` (currently $10) — **a book
  may exceed the daily cap; raise the per-creator ingest cap deliberately or chunk ingest across
  days.** (This is a real gate item, not hand-waving.)
- Child embeddings: unchanged volume.

**Per-turn (retrieval) cost:**
- +1 routing RPC (pure SQL, vector ops over few sections — sub-10ms, $0 external).
- Rerank candidate count goes from ≤20 → ≈30–40 → **slightly higher Voyage token spend per turn**;
  bounded by the per-section top-N cap. Model it; keep within the 4s turn budget.
- Query-planner (v3.1, optional): N× embed + N× retrieve per turn — **off by default**, behind a
  flag, only if eval shows recall needs it. Latency + COGS cost flagged.

**Guardrails:** kill-switch at 150% of quota (exists). New ingest path must write the same
`cogs_log` rows; **add a pre-flight book-size COGS estimate** that refuses/queues a sample whose
projected contextual-gen spend exceeds a new `creator_ingest_cap_usd` (admin-set), failing loud
(mirrors `creator_daily_budget_blown_preflight`).

---

## 4. Schema & migrations (CLAUDE.md migration discipline)

New migrations on a fresh date prefix (after current `20260525…`). Each is its own transaction;
full `npm run db:test` green after EACH; blast-radius grep before each.

1. **`…_sample_content_sections.sql`** — new table:
   `id, sample_id FK→sample_content ON DELETE CASCADE, creator_id FK, section_index int,
   title text (≤200), summary text (≤2000), summary_embedding halfvec(768) NULL,
   centroid_embedding halfvec(768) NULL, char_start int, char_end int, topic_tags text[]≥1,
   chunker_version smallint, created_at, updated_at, UNIQUE(sample_id, section_index)`.
   RLS: own-read (mirror narrative_units), service-role write, zero write policies. GIN on
   topic_tags. HNSW (halfvec_cosine_ops) on summary_embedding AND centroid_embedding. Slug-verify
   trigger + extend `creator_topics` orphan guards to cover this table (mirror
   `sample_content_narrative_units.sql:78-178` exactly — do not skip, that's the documented trap).

2. **`…_narrative_units_section_fk.sql`** — add `section_id uuid NULL REFERENCES
   sample_content_sections(id) ON DELETE CASCADE` + index. NULL = v2 unit (no section). Backfill
   left NULL for v2; v3 reprocess populates.

3. **`…_chunks_v3.sql`** — extend `sample_content_chunks.chunker_version CHECK` from `(1,2)` to
   `(1,2,3)` (permanent enum extension); add `section_id uuid NULL REFERENCES …sections(id) ON
   DELETE CASCADE` + index `(creator_id, chunker_version)` already exists. **NOTE the rewrite trap:**
   adding a NULLable column is metadata-only (no table rewrite) — unlike the GENERATED column in
   `…_chunks_v2.sql` which the guard there warns about. Re-assert the `>10000 rows` guard pattern is
   *not* needed for a plain NULLable add, but document why.

4. **`…_insert_chunk_v3_unsafe.sql`** — new RPC mirroring `_insert_chunk_v2_unsafe` but takes
   `p_section_id` (verified to belong to the same sample as the parent unit, server-derived — same
   parameter-trust closure as v2 C1), writes `chunker_version=3`. Service-role only.

5. **`…_creator_route_sections_v3.sql`** — routing RPC: SECURITY DEFINER, returns top-S section ids
   + scores; `MAX(cos(summary), cos(centroid)) + topic boost`; HNSW `strict_order` iterative-scan
   wrapper (copy the v2 pattern + caveat). Clamp S. GRANT service_role + authenticated.

6. **`…_creator_knowledge_topk_v3.sql`** — scoped hybrid RPC: takes `p_section_ids uuid[]`,
   `p_query_vec`, `p_query_tsq`, `p_k_child`, `p_n_parent_per_section`, `p_min_sim`,
   **`p_rank_mode` + `p_lambda`** (so §3b's ranking candidates a–d are switchable for the harness).
   `p_rank_mode` is an enum with **canonical IDs pinned at this same point in §7 #2** —
   `'max' | 'max_blend' | 'vec_max' | 'best_child'`, default `'max_blend'` (audit round-4 M2 — no
   ad-hoc renaming at freeze). Same vector+BM25+RRF at child level **scoped to `section_id =
   ANY(p_section_ids)` and `chunker_version=3`**, parent aggregation per `p_rank_mode`, top-N
   **per section**. Pre-truncate parent text 3500 chars before JOIN (keep v2's M6 optimization).
   Returns same column shape as v2 **plus a distinctly-named `parent_score`** (audit round-2 M7;
   round-4 Small) so v2 SUM and v3 MAX scores never get compared as the same metric in dashboards.
   **`p_min_sim` is a GATE OUTPUT of §7**, not a guess copied from v2's 0.30 (which was tuned
   for SUM-RRF and is meaningless for MAX); the migration ships with a placeholder default and the
   prod-flip blocker (§7 #3) is "harness-produced `p_min_sim` value pinned in code."

7. **BM25 OR-semantics — REUSE #3a, no new SQL.** The workstream's #3a OR-tsquery fix is already in
   the RAG branch and v3 calls it directly. This item is a merge-coordination checkpoint, **not** a
   migration, *unless* #3a hasn't landed by the time v3 retrieval is built — then (and only then)
   port it. Never ship two BM25 implementations.

8. **`…_corpus_reprocess_finalize_v3.sql`** — extend finalize to also DELETE this sample's
   `chunker_version IN (1,2)` chunks + its v2 narrative_units/sections on v3 cutover, bump
   `current_corpus_version`, advisory-lock per creator (copy the existing finalize exactly; the
   per-creator `pg_advisory_xact_lock` + `lock_timeout` are load-bearing).

9. **`…_retrieval_version_3_enqueue_routing.sql`** — extend the enqueue routing trigger
   (`20260516000003`) so a creator at `retrieval_version=3` routes edits to the v3 reprocess queue;
   extend the legacy worker's v2-skip to also skip v3 creators.

**Permanent-enum discipline:** `chunker_version=3` is forever. v1/v2/v3 readers must never mix —
each read RPC hard-filters its own version (the documented freeze pattern). Cache
(`semantic_query_cache`) is already keyed on `current_corpus_version`; the finalize bump invalidates
v2 cache rows on v3 cutover automatically.

---

## 5. Application code (bridge pattern preserved)

- **`src/lib/voice/section-segment.ts`** (NEW, pure): structural + window segmentation. Pure
  function, unit-tested with book/transcript/unstructured fixtures. No SDK, no network.
- **`narrative-chunk.ts`**: extend to accept a single section's text + return
  `{ units, sectionTitle, sectionSummary }`. Per-section call. Input now bounded → the
  `maxOutputTokens` truncation risk evaporates. Keep the one-retry contract + sanitizer + splitter.
- **`embed-worker.js` `makeCorpusReprocessWorker`**: restructure the per-sample loop to
  per-section → per-unit → per-child; compute centroid; insert sections; call v3 RPCs. Keep ALL the
  hard-won machinery (shutdown drain, idempotent cleanup, version-checked finalize, per-unit budget
  trip, cogs_log finally-flush). **This is the riskiest edit — it's the 700-line worker.** Land it
  behind the v3 queue so v2 creators are untouched.
- **`retrieve-knowledge.ts`**: add `retrieveKnowledgeV3` (route → scoped topk → rerank → parents).
  Reuse rewrite/embed/cache/rerank/telemetry legs unchanged. New telemetry fields:
  `sectionsRouted`, `sectionScores`, `candidatesFromScope`, `parentRankSource`.
- **Bridge boundaries unchanged.** Embeddings, rerank, chunker-LLM, contextual-gen all stay behind
  their typed interfaces; v3 adds no provider SDK leak. Late-chunking (v3.1) would be an
  embedding-bridge swap only.
- **Proxy `index.js` — collapse dispatch to ONE chokepoint (round-3 C-3, round-4 C5).** There
  are ~9 hardcoded `=== 2` / `version === 2` sites with a silent `else→v1` fall-through, including
  the **LIVE decoupled path** `retrieveEnvelopeForDecoupled` whose `else` runs `retrieveTopK`
  (chunker_version=1) — a v3 session there silently retrieves ZERO → he blanks every turn. Grep-for-
  `=== 2` cannot catch the dangerous site because the bug is the *absent* v3 arm, not a present v2 one.
  **Don't trust line-number enumerations** (they're stale across audit rounds — round-1 cited one set,
  round-2 another, round-4 found the real grep yields a third). **Use grep at build time:**
  `grep -nE '\bretrievalVersionAtSession === \d\b|Number\(cd\.retrieval_version\) === \d'
  server/voice-proxy/index.js`. Each match is either a DISPATCH (wrap in `resolveRetrievalPath()`)
  or a PROBE (wrap in `assertRetrievalPathSupportedOnSpike(version)`). **Fix shape: introduce a single
  `resolveRetrievalPath(version)`** helper that maps {1,2,3}→{v1 in-proc, v2 shim, v3 shim} and
  **throws on any unknown version** (fail-loud, never silent-v1). The spike-a admin-preview probe
  uses a sibling `assertRetrievalPathSupportedOnSpike(version)` that also throws on 3 with a guidance
  message (until v3 supports the preview path, which is a later, deliberate decision). The throw is
  what guarantees a future v4 (or a missed site) fails visibly instead of silently degrading to v1.
- **Injection**: `build-injection-envelope.ts` unchanged except reorder passages best-first
  (KohakuRAG's +80% finding) — already roughly the case via score sort; assert it. Keep top-1/2
  low-blend.

---

## 6. Backfill / re-ingestion (decision #5 — incremental, per-sample) — BUILD-THEN-FLIP ordering

> **CRITICAL ordering fix (round-3 external audit C-1). The flip is the LAST step, not the first.**
> `retrieval_version` is the *read path*, snapshotted at session-open. If we flip a creator to 3
> *before* v3 chunks exist, every session immediately reads `topk_v3` → filters `chunker_version=3`
> → finds none (the worker may take hours-to-days across daily caps for a book) → **zero retrieval
> on every turn for the entire rebuild window. He blanks on everything.** That is the exact UX death
> this plan exists to prevent, triggered by the rollout procedure itself. So the order is inverted:

1. **Stage the corpus while the read path still serves v2 (or v1).** Enqueue every existing sample
   into the v3 reprocess queue (`target_version=3`) **without touching `retrieval_version`.** The
   creator keeps reading their current path the entire time. v3 chunks/sections accumulate
   invisibly (they're version-filtered out of v2 reads).
2. **Verify.** `creator_v3_ready(creator_id) → boolean` is pinned (audit round-4 M3 — was vague,
   would let half-built creators pass) as: returns `true` ⇔ for **every** `sample_content` row
   belonging to that creator with `processing_status != 'errored'`, all three of:
   (a) `corpus_reprocess_jobs` has a row with `target_version=3 AND status='done'` for that
   `sample_id`,
   (b) `sample_content_sections` has ≥1 row for that `sample_id` AND every section in it has
   non-NULL `summary_embedding` AND non-NULL `centroid_embedding`,
   (c) `sample_content_chunks` has ≥1 row with `chunker_version=3` for **every**
   `section_id` from (b) (no orphan section without children).
   The eval harness (§7) green on that creator is part of "verified" before the admin flips.
3. **Flip last, gated.** `admin_set_creator_retrieval_version(creator, 3)` is **rejected unless
   `creator_v3_ready` is true** — the admin literally cannot flip a half-built creator. The flip is
   then a single atomic read-path cutover with the corpus already warm. Monotonic 1→2→3 still holds;
   the difference is the gate.
- Content updates after flip: edit → enqueue that sample only → reprocess → cutover-bump (R2-C1) →
  cache invalidation. **No global rebuild** (RAPTOR's cost does not exist here).
- v1 and v2 creators completely unaffected (frozen read paths + version-filtered RPCs).
- **Granularity decision (round-3, drives re-ingest COGS — DECIDE BEFORE CODE):** the worker DELETEs
  *all* of a sample's units on reprocess (`server/voice-proxy/embed-worker.js:948`), so if a 400-page
  book is ONE `sample_content` row, editing one chapter re-pays the **whole book's** Haiku
  contextual-gen. Section-checkpoint resumability (C5) only saves *crashes*, not deliberate edits.
  **Resolution:** a book is ingested as **many samples (≈one per chapter/upload unit)**, not one
  monolith — editing a chapter re-pays only that chapter, and it makes Decision-B's per-book cap
  mostly moot. The Section level still exists *within* each sample for routing. (Alternative —
  section-level incremental reprocess within one sample — is more worker surgery; chapter-as-sample
  is simpler and uses the existing per-sample machinery.)
- **Operator UX for chapter-as-sample (round-4 M6 — collateral of the granularity decision).**
  `sample_content.topic_tags` is NOT NULL and the worker hard-fails when empty
  (`server/voice-proxy/embed-worker.js:959`). Splitting one book into 30+ chapter-samples means
  admins must remember to tag every chapter — easy to miss on chapter 17, and the operator gets
  no clear recovery path from the resulting `markJobErrored` failure. **Sub-task for §8 step 4:**
  add a "book template" admin flow that captures `topic_tags[]` ONCE at book-create time, then
  pre-fills every chapter-sample upload from that template (overridable per chapter). Out-of-scope
  for v3 retrieval correctness but in-scope for "v3 doesn't make ingest worse than v2." UI sits in
  the existing admin console; data model is just a `book_templates` table (creator_id, title,
  topic_tags[], created_at) referenced by `sample_content.book_template_id NULL`.

---

## 7. Eval harness + acceptance (brief §7 — measure, don't guess)

Build `scripts/diag-eval-v3.mjs` (read-only against a scratch creator) + a fixture corpus:
- **Corpus:** current 13k transcript + ≥3 synthetic large docs + **≥1 real public-domain book**
  (e.g. a Gutenberg text) ingested as a creator sample.
- **Planted needles:** the lumberjack story + ≥10 facts buried at varying depths in the book
  (chapter 1, mid, last chapter) with hand-written question variants.
- **Metrics:**
  1. **Recall@k** for each needle (does the right unit appear in top-k injected?).
  2. **"Right unit reaches the reranker"** — the brief's §3b hard-scaling metric — measured as
     corpus grows 1 → 6 docs → book-scale, **run for each ranking mode a–d** (`p_rank_mode`) to pick
     the winner. v2 must demonstrably degrade; v3 must hold. **Baseline includes the #3a BM25 fix**
     (measure on top of it, per §3b), never pre-#3a.
  3. **Routing precision — THE book-scale recall gate (round-3 M-1), hard floor.** Is the needle's
     section in the routed top-S? Pass bar: **≥ target% (e.g. 95%) of planted needles' sections in
     routed top-S at book scale.** Below the floor, v3 does NOT ship — the flat fallback cannot save
     book-scale recall (it re-runs the same global ranker v2 already buried the needle with).
  4. **Turn latency held under the LIVE decoupled ceiling (round-3 M-2).** Anchor p50/p95 to
     `retrieveCeilingMs=3500` (`decoupled-orchestrator.js:142`), **NOT** the 4000ms orchestrator
     default — the live decoupled path is tighter and there's an in-code "2.6s vs 2500ms = coin-flip"
     warning. Route RPC (~free) + the 30–40-candidate Voyage rerank (latency scales with candidate
     count) are spent against 3500ms, not 4000. Measure before freeze.
  5. **Ingest COGS** per book within the modeled cap; **per-turn COGS** within target.
  6. **No small-scale regression** — side-by-side v2 vs v3 on the existing 13k corpus.
  7. **"Exactly him" rubric (the real bar — UX, not a proxy).** N≥30 held-out questions over the
     creator's known content, scored 1–5 Likert by ≥2 raters who know the creator, on: (a)
     *story-correctness* — did he tell the right STORY, not a generic summary? (b) *sounds-like-him*
     — talking vs reciting a document? (c) *blanked* — did he fail on something he clearly knows?
     plus a binary (d) *confidently-wrong* — did he assert something off as if he knew it?
     **Pass bar:** ≥80% "right story", **ZERO blanks on known-content questions, ZERO
     confidently-wrong**; rater disagreements adjudicated by Vuk. Run on the winning `p_rank_mode` ×
     {inject top-1, top-2}. A v3 that wins recall@k but recites, blanks, or confidently-wrongs has
     **failed** regardless of the numbers.
- **Gate:** v3 ships only when (2) holds at book-scale, (6) shows no regression, **and (7) the
  recognition moment is intact** (no blanking, tells the story, speaks not recites). λ, S, inject-K,
  **`p_min_sim` (routing/scoped-pass floor), and the inject min-rerank-score (Stage 4 silence gate)**
  are ALL tuned on this harness (round-4 C1 — these last two were unspecified before, defaults are
  meaningless because they were calibrated for v2's SUM-RRF). They are gate outputs, hard-blocked
  from prod-flip until §7 has produced concrete values pinned into code/migration constants —
  *with metric (7) as the tiebreaker when (1)–(6) are close* — then frozen. The numbers serve the
  recognition moment, not the other way around.

---

## 8. Strike-through checklist (execution order — TDD per step)

> Order chosen so each layer is testable before the next depends on it. Schema → ingest → retrieve
> → eval → rollout. The worker rewrite (step 4) is gated behind the v3 queue so nothing ships to
> v2 creators mid-build.

0. ☑ **PROVE THE CORE HYPOTHESIS CHEAP, FIRST (round-3 de-risk).** Has two parts (round-4 M1 split
   the muddled original):
   - **0a — synthetic Block-C pgTAP test.** DONE 2026-05-27. `supabase/tests/rag_v3_regression_baseline.test.sql`
     Block C is green: needle ranks #23 by SUM(rrf) but #1 by MAX(vector) on a synthetic 23-unit
     corpus. Ranking-lever proof on synthetic data — no schema. (`topk_v2` already returns both
     SUM and MAX columns at `20260521000002:197-198`; `k_parent` clamps to 50 vs caller's 20.)
   - **0b — real-corpus empirical proof.** DONE 2026-05-27 via `scripts/aod-needle-test.mjs`.
     Full Vuk AoD corpus (307 units / 834 chunks) ingested into local DB; 5 needle queries; 3
     show MAX-vs-SUM divergence including textbook case ("loop of manifestation" → literal
     title-match unit at MAX-rank #1 vs SUM-rank #6). **Pass bar (round-4 M1): ≥1 query where
     MAX surfaces the right unit AND SUM buries it deeper than rank-5.** Hit on multiple queries.
   - **Gate disposition: PASSED.** The entire-plan-go-or-no-go gate cleared on real Vuk content
     BEFORE any v3 code shipped. Proceed to step 1b+ with empirical justification.
1. ☐ **Reproduce Wall B at scale** with the eval harness scaffold + synthetic large corpus on a
   scratch creator (diag scripts) — capture the recall drop + unit-falls-out-of-rerank-window
   *before* changing anything. (Baseline evidence; pairs with step 0.)
1b. ☐ **Ship the v2 cache-bump as a STANDALONE pre-v3 migration (round-3 C-2)** — independent of the
   v3 lockstep, separately tested + deployed, so the live v2 ingestion RPC change can't ride into
   the experimental path's blast radius. Low-severity, self-healing; do it cleanly and alone.
2. ☑ **`section-segment.ts`** (pure) + unit tests (book/transcript/unstructured/empty/no-structure). **DONE 2026-05-28**: shipped at `src/lib/voice/section-segment.ts`; 44 unit tests; auditor pass applied 4 Critical + 7 Medium + several Smalls (form-feed line-anchored, source-slice identity invariant, dialog/EOF sentence-split, CJK auto-detect, numbered-heading mid-list filter, cueMode `book|transcript|auto`, leading-whitespace ownership, perf sanity). Parity-verified against `segment-dry-run.mjs` spike on Vuk's 91k-word AoD corpus: **21 sections, 0 oversize, max-tok 7321 (cap 7500), zero false-positive cues across all 8 modules.**
3. ☐ **Migrations 1–4** (sections table, unit FK, chunks v3 enum+section_id, insert_v3 RPC) +
   pgTAP for each (RLS, slug guards, parameter-trust, enum freeze). Full `db:test` green.
4. ☐ **Ingestion redesign** — `narrative-chunk.ts` per-section + summary; `server/voice-proxy/embed-worker.js`
   per-section loop + centroid + section inserts; route via v3 queue. Tests: worker fixture run,
   resumability, idempotent re-claim, cogs_log on every exit, book-size pre-flight cap. **Round-4
   sub-tasks (each is a build-blocker — do them under step 4, not "later"):**
   - **4a (round-4 C2):** land a real Gemini `responseSchema` on the per-section Flash call,
     resolving the TODO at `src/lib/voice/narrative-chunk.ts:269-272`. Schema enforces
     `{ units: [{title, text}], sectionTitle: string, sectionSummary: string }`. Per-section
     ingestion MULTIPLIES schema-drift retry-tax (30–80 sections/book × tax) — the §3 COGS model
     assumes the schema is enforced. Verify against the actual pinned `@google/genai` field name
     (`responseSchema` vs `responseJsonSchema`) before writing.
   - **4b (round-4 C3):** decide and pin the contextual-gen cache-key change. §11/M3 promises
     "per-section cache" but the cache key is owned by `/api/internal/contextual-gen`
     (`src/app/api/internal/contextual-gen/route.ts`), not the worker. Two options: (i) ROUTE owns
     the change — accept an optional `section_id` and key the cache on `{creator_id, section_id}`;
     (ii) WORKER owns it — pass `section_text` as the `doc` field (the whole-sample-as-prefix model
     dies). Pick (ii) — smaller blast radius, worker already knows the section boundaries. Update
     COGS model accordingly (cache write/read mix changes; M3 estimate revisits).
   - **4c (round-4 C4):** Section title/summary contract for downstream. When `Section.cue === null`
     (paragraph-pack mode) → Flash MUST synthesize `sectionTitle` from first ~100 chars of section
     text. When `Section.cue` is set and an oversize chapter sub-packs into N sub-sections →
     sub-section #k inherits the parent cue + suffix " (part k/N)" so the sections table's
     downstream uniqueness/dedup logic doesn't see N identical titles. Both rules enforced by a Zod
     check after Flash response; on violation, retry with a stricter prompt.
   - **4d (round-4 M7):** per-section "produced ≥1 unit OR explicit reason" assertion. A v3 worker
     that silently emits zero units for every section (e.g. because 4a was skipped and `responseSchema`
     is absent, or 4c failed validation and the retry didn't help) lets `creator_v3_ready` stay
     false forever with no operator-visible cause. Worker writes a per-section row to a new admin
     surface (`corpus_reprocess_sections` debug table or extends `corpus_reprocess_jobs.last_error`)
     with the success/skip/error reason; the admin queue surfaces sections with zero output as
     warnings, not silent-green.
5. ☐ **Migrations 5–7** (route RPC, topk_v3 scoped+MAX, OR-tsquery) + pgTAP (MAX-not-SUM proven on
   the lumberjack fixture; scoped to sections; BM25 OR fires).
6. ☐ **Retrieval redesign** — `retrieveKnowledgeV3` + proxy v3 dispatch + telemetry. Tests:
   route→scope→rank→rerank→inject; deadline behavior; cache keyed on corpus_version.
7. ☐ **Migrations 8–9** (finalize_v3, v3 enqueue routing) + pgTAP (cutover deletes v1/v2, version
   bump, per-creator advisory lock; v3 creators skip legacy worker).
8. ☐ **Full eval harness** (§7) — recall@k, reach-the-reranker across scale, latency, COGS,
   no-regression. Tune λ + S. Freeze.
9. ☐ **Auditor (Planning Loop) on the implementation** + phased rollout behind `retrieval_version=3`
   (scratch creator → Vuk's creator → general). **Does not deploy until PROD_DEPLOY_GATE Step 1c.**

---

## 9. Hard constraints honored (brief §5 checklist)

- ✅ **Provider-agnostic bridge** — embeddings/rerank/chunker-LLM/contextual-gen stay behind typed
  interfaces; v3 adds no SDK leak; late-chunking is an env+bridge swap only.
- ✅ **COGS on every paid call + kill-switch** — §3; ingest path keeps the existing cogs_log flushes;
  new book-size pre-flight cap.
- ✅ **Migration discipline** — full pgTAP after each; blast-radius grep; `chunker_version` permanent
  enum; cache keyed on `current_corpus_version`; local `db reset`/`db:test` only.
- ✅ **Don't break v1/v2** — frozen read paths + version-filtered RPCs; v3 is a third path behind the
  session snapshot.
- ✅ **Injection precision** — top-1/2 low-blend preserved; reorder best-first; section is a routing
  target, never the injected payload.
- ✅ **Retrieval ≠ persona/voice** — this plan touches facts/stories retrieval only.
- ✅ **PROD_DEPLOY_GATE** — branch + plan; no deploy until Step 1c + coordinated migration apply.

---

## 10. Open questions for the auditor / Vuk

1. **Section granularity for transcripts** — ~6–8k-token windows, or topic-shift detection
   (embedding-cosine valley between adjacent paragraph windows)? Window is simpler/cheaper; topic-
   shift is better routing. Lean: window for v3, topic-shift as v3.1 if eval shows section bleed.
2. **λ (count bonus) + S (sections routed) + `p_min_sim` + inject min-rerank-score** — ALL four
   tuned on the eval harness (§7), no pre-commits. Conservative seeds: λ≈0.1, S adaptive 2–6.
   `p_min_sim` and the inject floor are gate outputs (round-4 C1 — no v2-derived guess). The
   migration ships with placeholder defaults; freeze is hard-blocked until §7 produces values.
3. **Book ingest cap** — DOWNSTREAM of the granularity decision (§6, round-3): with a book = many
   chapter-samples, no single sample approaches `CREATOR_EMBEDDING_DAILY_CAP_USD=$10`, so the
   per-book cap is mostly moot. A `creator_ingest_cap_usd` pre-flight (M2) still guards pathological
   single samples. Decide granularity first (already leaned: chapter=sample), then the cap follows.
4. **Query-planner (v3.1)** — defer to a flag, off by default? (Latency + COGS cost.) Lean: defer.
5. **One optional summary layer** — add section-summary as an injectable unit only if synthesis-style
   questions underperform in eval? Lean: build the plumbing, enable only if measured.

---

## 11. Audit round 1 — findings + resolutions (CLAUDE.md Planning Loop step 2)

Auditor subagent reviewed this plan against the live code. All Critical + Medium applied; Smalls
folded in. Verified each cited line myself before accepting (one finding revealed my §0 #7 was
wrong). The plan above is amended; this section is the disposition record.

### Critical (all resolved)

- **C1 — finalize is not wired; cache-invalidation guarantee was false. FIXED.** Confirmed: worker
  calls `corpus_reprocess_mark_done` (`embed-worker.js:1205`), which neither deletes old chunks nor
  bumps `current_corpus_version`; `corpus_reprocess_finalize` has tests but no caller. **Resolution:**
  v3's cutover (DELETE this sample's v1/v2 chunks+units+sections + bump `current_corpus_version`)
  goes into the RPC the worker **actually calls**. Two options, decide before migration 8: (i) add
  a `corpus_reprocess_mark_done_v3` the v3 worker branch calls (leaves v2's `mark_done` untouched —
  preferred, zero v2 behavior change), or (ii) repoint the worker to `corpus_reprocess_finalize`
  and prove v2 unaffected. Pick (i). §0 #7 corrected. **The version bump is the cache key — without
  it the semantic cache serves pre-v3 parents for 7 days.**

- **C2 — routing had no recall fallback. FIXED** inline in §2.3: mandatory flat (unscoped) hybrid
  pass unioned with the scoped pass when the router is low-confidence or the scoped pass underfills.
  Guarantees v3 recall floor ≥ v2. This was the plan defeating its own purpose; now closed.

- **C3 — the `retrieval_version=3` flip is rejected by unmigrated CHECKs + leaves orphaned v3 rows
  on downgrade. FIXED** by expanding the migration list (below). Adds: `creators.retrieval_version`
  CHECK → `(1,2,3)`; the **live** `admin_set_creator_retrieval_version` (`20260516000004`, NOT the
  superseded `…000001`) — extend its `NOT IN (1,2)` guard to allow 3 AND parameterize its hardcoded
  `chunker_version=2` zombie-delete so a v3→1 downgrade cleans v3 chunks+sections too.

- **C4 — enqueue trigger hard-RAISEs on v3 + `target_version CHECK IN (2)` rejects v3 jobs → v3
  creators bricked on first sample edit. FIXED** by migrating, in lockstep: enqueue trigger
  `20260517000004` (the live one) to route v3 → v3 queue instead of raising;
  `corpus_reprocess_jobs.target_version` CHECK → `IN (2,3)`; the claim RPC
  (`claim_corpus_reprocess_job`), `mark_done`/finalize, and admin enqueue RPCs (`20260518000001`)
  every `target_version = 2` / `IN (2)` branch enumerated and extended;
  `sessions.retrieval_version_at_session` CHECK → `(1,2,3)` (`20260522000100:64` — the snapshot
  itself would otherwise reject v3 at session-open; **the auditor missed this one, I caught it on
  verification**). Legacy worker's `!== 1` skip already handles v3 correctly; update its comment.

- **C5 — "resumable per section" conflicted with the `(sample_id,chunker_version,chunk_index)`
  UNIQUE. FIXED:** chosen option (b). New UNIQUE `(sample_id, chunker_version, section_index,
  chunk_index)`; `chunk_index` is **section-local** in v3; per-section idempotent cleanup (DELETE
  that section's units+chunks before re-embed) replaces the v2 whole-sample DELETE. §2.2 amended.
  This is what makes book-scale ingest affordable to retry (one section, not the whole book).

### Medium (all resolved)

- **M1 — centroid vector under-specified. FIXED:** normalize each child halfvec to unit norm
  **before** the length-weighted mean, renormalize the result, then store. gemini-embedding-001 at
  `outputDimensionality=768` (Matryoshka) is not guaranteed unit-norm; halfvec is ~3–4 sig digits.
  Routing-discrimination across 30–80 sections is a harness assertion (§7 #3), not a claim.
- **M2 — book may exceed daily cap mid-loop → half-corpus + double COGS. FIXED:** the pre-flight
  book-size COGS estimate is promoted from open-question to a **hard gating item** (new migration +
  worker pre-flight): estimate projected contextual-gen + embed spend from `octet_length(raw_text)`;
  if > a new admin `creator_ingest_cap_usd`, refuse and surface (mirror
  `creator_daily_budget_blown_preflight`). Section-checkpoint resumability (C5) means a legitimately
  huge book can ingest across days/ticks without re-pay.
- **M3 — 1h Haiku prompt-cache TTL blows up at book scale. FIXED:** stop sending the whole
  `sanitizedDoc` as the cached prefix. Now that input is sectioned, send the **section** as the
  contextual-gen doc prefix (cache-keyed per section). A section processes well within 1h; cache
  stays warm; no repeated 2.0× cache-writes on a 50k-token prefix. Re-model COGS on the cache
  read/write *mix*, not just token count.
- **M4 — extending the `chunker_version` CHECK takes ACCESS EXCLUSIVE + full validate scan. FIXED:**
  `ADD CONSTRAINT … NOT VALID` then `VALIDATE CONSTRAINT` (SHARE UPDATE EXCLUSIVE, doesn't block
  in-flight v2 retrieval RPCs), or a maintenance window. The NULLable `section_id` add is still
  metadata-only; the CHECK swap is the hazard.
- **M5 — latency: extra route RPC + bigger rerank set, no budget headroom. FIXED (re-anchored in
  round-3):** `retrieveKnowledgeV3` gets an explicit reallocation — route ~8%, scoped-topk ~8%,
  rerank stays ~30% but candidate count capped so Voyage latency is bounded; rewrite drops to ~25%
  (v3 may skip rewrite when routing is confident — TBD on harness). **Budget against the live
  `retrieveCeilingMs=3500` decoupled ceiling, not 4000ms** (round-3 M-2; `decoupled-orchestrator.js:142`).
  Re-validate on the harness with the 30–40 candidate set BEFORE freezing (§7 #4 is a gate).
- **M6 — adding 2 fields to the un-`responseSchema` Flash call raises drift/retry tax. FIXED:**
  ship a real Gemini `responseSchema` as part of this work (the file's own TODO at
  `narrative-chunk.ts:269-272`) so `{units, sectionTitle, sectionSummary}` is enforced, killing the
  retry-tax that would otherwise re-send section input. Models the retry rate honestly.
- **M7 — MAX-based score reuses v2's `rrf_score` column → silent cross-version telemetry drift.
  FIXED:** v3 RPC returns the parent score in a distinctly-named column (`parent_score`) + emits
  `parentRankSource` (already planned); cache + dashboards key on `parentRankSource` so v2 SUM and
  v3 MAX scores are never compared as the same metric.

### Small (folded in)

Best-first injection is a **test**, not a comment (assert `parents` arrive rerank-sorted and the
envelope preserves order). Section title/summary run through `sanitizeForLLMPrompt` before embed
(same gap the narrative-chunk output sanitizer closes). Window-overlap children dedup by
`parent_unit_id` in the Stage-2 union. Single combined routing vector vs two HNSW indexes —
benchmark on harness (two indexes double maintenance). Verify #3a BM25 OR-fix actually merged before
writing "reuse, no new SQL"; current tree still has AND-semantics `try_build_tsquery`
(`20260521000002:45-62`) — if #3a hasn't landed at build time, migration item 7 becomes real SQL.
Tighten the `embed-worker.js:1047` contextual-gen citation. Update the legacy-worker v2-skip comment
to mention v3.

### Corrected migration list (supersedes §4 items 8–9 and adds the gating set)

The v3 flip is a **coordinated lockstep migration set**, applied + `db:test`-green together:
`retrieval_version` CHECK, `sessions.retrieval_version_at_session` CHECK, live
`admin_set_creator_retrieval_version` (guard + parameterized zombie-delete), `target_version` CHECK,
enqueue trigger `20260517000004`, claim RPC, admin enqueue RPCs, the worker-called
`mark_done`(_v3) carrying the C1 delete+version-bump, the v3 reprocess-on-flip enqueue, and the
`creator_ingest_cap_usd` pre-flight. Plus the §4 items 1–6 (sections table, unit FK, chunks v3
enum-via-NOT-VALID + section_id, insert_v3 RPC, route RPC, topk_v3) and the M-fixes above.

### Audit round 2?

Per CLAUDE.md, a third audit is for remaining *critical* gaps only — and per Vuk's standing
guidance, I don't auto-chain audits. C1–C5 were design-level and are resolved at the design level
here; the next natural audit point is the implementation plan once the C1 finalize-RPC decision and
the C5 constraint are locked. Recommend re-audit at **step 3 (migrations written)**, not now.

---

## 12. Audit round 2 — verifying the round-1 fixes + UX pressure-test

Second auditor pass (a) verified every §11 disposition against live code and (b) pressure-tested the
§0.0 UX claims. It confirmed the C1–C5 *design intentions* are sound but found the dispositions
**under-fixed** in four ways, plus two real UX-correctness risks the recall-focused §7 gate didn't
test. All verified against code and applied.

### Critical (round 2)

- **R2-C1 — live v2 cache bug, severity CORRECTED DOWN in round-3, and DECOUPLED from v3.** The v2
  worker calls `mark_done` (not finalize) so `current_corpus_version` is never bumped on a normal v2
  reprocess. **Severity was overstated as "he blanks" — it is not.** `retrieve-knowledge.ts:628-655`
  *falls through to a fresh retrieve* when cached parent IDs resolve to zero rows, so a stale cache
  self-heals per-query. Real symptom: **7-day cache uselessness (a cost regression, not a blank) +
  a partial-stale degradation only on cross-sample cached queries at multi-sample scale.** At the
  1-creator/1-sample dogfood scale it's nearly inert. **Therefore (round-3 C-2): do NOT entangle it
  with v3.** Ship the v2 cache-bump as its **own standalone migration, before v3 starts** (checklist
  step 1b) — isolate the live-path RPC change from the experimental path so a wrong edit can't break
  every live v2 reprocess. The v3 cutover then adds its own version-aware delete (`IN (1,2)`) on top.
  See [[project_corpus_finalize_not_wired]].

- **R2-C2 — `claim_corpus_reprocess_job` doesn't return `target_version`; the worker can't tell a v2
  job from a v3 job. FIXED.** Add `target_version` to the claim RPC's `RETURNS TABLE`
  (`20260521000005:43-47`) and add an explicit `if (job.target_version === 3)` pipeline branch in
  the worker. Migration list updated: it's a *return-value + dispatch* change, not just the CHECK
  widening.

- **R2-C3 — the proxy has ~9 hardcoded `=== 2` retrieval-dispatch branches; a v3 session falls
  through to the v1 in-proc path → queries `chunker_version=1` (none exist for a v3 creator) → ZERO
  retrieval on EVERY turn → he blanks. CATASTROPHIC, FIXED in round-3, refined in round-4 C5.** My
  §5 originally said "extend the dispatch at `index.js:950`" — wrong line (that's the `decoupled`
  const) and wrong scope. Round-3 enumerated by line number; round-4 confirmed those numbers had
  ALREADY rotted by the time of audit. **Real disposition (current as of round-4):** §5 directs
  builders to grep at build time (`grep -nE '\bretrievalVersionAtSession === \d\b|Number\(cd\.retrieval_version\) === \d' server/voice-proxy/index.js`), wrap dispatches in
  `resolveRetrievalPath()`, wrap the spike-a probe in `assertRetrievalPathSupportedOnSpike()`. Both
  throw on unknown version (fail-loud). **No `>= 2` shortcut** (v2 and v3 call different RPCs).
  Step 6 gets a blast-radius grep gate.

- **R2-C4 — the 4-col UNIQUE with NULL `section_index` silently disables dedup for v1/v2 rows
  (Postgres treats NULLs as distinct), reopening the exact duplicate-key bug `20260523000003` fixed.
  FIXED.** **Resolution:** keep the 3-col unique for v1/v2 and add a **partial** unique
  `(sample_id, chunker_version, section_index, chunk_index) WHERE chunker_version = 3` (cleanest; no
  v1/v2 behavior change). `NULLS NOT DISTINCT` is a fallback but requires verifying the prod PG15
  minor. v3 `section_index` is NOT NULL within its partial index.

### Medium (round 2)

- **R2-M1 (UX) — flat fallback can flood rerank with high-lexical-wrong-meaning candidates →
  "answers a different question." FIXED** in §0.0 (rank-cap + post-rerank min-score gate) + §7 adds a
  **false-confident-answer rate** on deliberately mis-routed/mis-tagged needles.
- **R2-M2 (UX, north-star-critical) — MAX + top-1 is the highest-variance ranker and can inject a
  precise-but-wrong single chunk with nothing to dilute it → confidently wrong, worse than blanking.
  FIXED** in §0.0 (new failure-mode row) + §2.3 Stage 4 **min-rerank-score inject gate** (below floor
  → inject nothing, persona answers). Harness adds the adversarial case where a *wrong* unit has a
  higher MAX-child than the right one (not just "right unit reaches reranker").
- **R2-M3 — admin enqueue RPC `_admin_enqueue_corpus_reprocess_unsafe` hardcodes `target_version=2`
  (3 sites, `20260518000001:117,192,200`); §6's "enqueue on v3 flip" has no working mechanism.
  FIXED:** parameterize `target_version` off the creator's `retrieval_version` in both force/non-force
  branches + the `j.target_version=2` join.
- **R2-M4 (UX) — "snappy inside 4s" is unbacked. FIXED:** §7 #4 must produce a measured p50/p95 with
  the 30–40-candidate set BEFORE freeze; "skip rewrite when routing is confident" gets its own
  correctness check (don't skip on a confident-but-mis-routed turn).
- **R2-M5 (UX) — the §7 "exactly him" rubric was too hand-wavy to gate. FIXED** in §7: N≥30 held-out
  questions over known content, 1–5 Likert on (story-correctness / sounds-like-him / blanked),
  numeric pass bar **≥80% "right story" + ZERO blanks on known-content questions + zero
  confidently-wrong**, ≥2 raters who know the creator, disagreements adjudicated by Vuk.
- **R2-M6 — the admin downgrade RPC does its deletes with NO advisory lock; can race an in-flight
  finalize for the same creator. FIXED:** the C3-amended downgrade takes the same
  `pg_advisory_xact_lock(hashtext('reprocess:'||creator_id))` key before its deletes, AND deletes
  `sample_content_sections` + broadens chunk delete to `IN (2,3)` on v3→1.

### Small (round 2)

- **#3a HAS merged** (`20260525000100_try_build_tsquery_or_semantics.sql`, signature unchanged) —
  plan item 7 correctly stays "reuse, no new SQL"; the §11 "still AND-semantics" note is stale,
  disregard it.
- §5 dispatch citation `index.js:950` is wrong (that's `decoupled` const) — real dispatch ~`:1484`.
- C3 downgrade: confirm FK cascade direction — `sample_content_sections` is the PARENT of units, so
  the creator-wide unit delete does NOT cascade up to sections; delete sections explicitly.
- Ensure the v3 RPC + telemetry read `parent_score` (R2/M7), not `rrf_score` out of habit → NULL.

### Net after two rounds
Design is sound and now concrete. The two rounds converted "good idea" into "a builder can't guess
wrong on the dangerous parts": cache-invalidation lands on the real RPC (both versions), the v3 flip
is a fully-enumerated lockstep migration set, the proxy dispatch + worker pipeline branch + chunk
unique are pinned, and the UX failure modes (blank / recite / generalize / confidently-wrong / lag)
each have a named lever AND a harness metric. **No third audit auto-chained** (Vuk's guidance);
re-audit at step 3 (migrations written).

---

## 13. External CTO audit (round 3) — verified + applied

A third, external review landed. I **verified every claim against the code before editing** (per
"Verify, Don't Guess"); all confirmed. It found four real gaps the two internal rounds missed —
including one that would brick a live creator. Applied:

- **R3-C1 — rollout ordering was backwards (flip-first bricks the creator). FIXED, headline change.**
  §6 said "flip to 3, then enqueue." Since `retrieval_version` is the read path snapshotted at
  session-open, flipping before v3 chunks exist = zero retrieval for the entire (hours-to-days)
  rebuild window = he blanks on everything. **§6 inverted: stage+verify the corpus while the read
  path still serves v2, then flip LAST, gated on a `creator_v3_ready` check that the admin flip RPC
  enforces.** This is the single most important fix in the whole plan.

- **R3-C2 — the R2-C1 fix mis-scoped: it edited the LIVE v2 ingestion RPC inside the v3 set. FIXED.**
  Verified the cache fall-through (`retrieve-knowledge.ts:628-655`) → R2-C1 severity was overstated
  ("he blanks" is wrong; real symptom = 7-day cache uselessness + cross-sample partial-stale,
  near-inert at dogfood scale). **So decoupled it entirely:** v2 cache-bump ships as a standalone
  pre-v3 migration (checklist step 1b), not entangled with the experimental path. §12/R2-C1 severity
  corrected.

- **R3-C3 — the proxy-dispatch fix (grep for `=== 2`) was fragile. FIXED with a chokepoint.**
  Verified the LIVE decoupled path `retrieveEnvelopeForDecoupled` (`index.js:1721-1746`) has the
  silent `else→retrieveTopK` (v1) shape — a v3 session there retrieves zero. Grep can't catch the
  *absent* v3 arm. §5 now mandates a single `resolveRetrievalPath(version)` helper that **throws on
  unknown version** (fail-loud, never silent-v1) with every call site routed through it.

- **R3-M1 — "recall floor ≥ v2" (C2 flat fallback) is vacuous at book scale. FIXED.** Verified the
  flat fallback re-runs the same global ranker that buried the needle — and v2 is itself broken past
  ~20 units, so "≥ v2" is true-but-empty at book scale. **Routing precision is now named as THE
  book-scale recall gate** with a hard floor (§7 #3: needle's section in routed top-S ≥ ~95%); the
  flat fallback is demoted to small-scale/near-miss insurance. §0.0 table corrected.

- **R3-M2 — latency budgeted against 4000ms, but the LIVE path is tighter. FIXED.** Verified
  `retrieveCeilingMs=3500` + the in-code "2.6s vs 2500ms = coin-flip" note
  (`decoupled-orchestrator.js:133-142`). §7 #4 + §11/M5 re-anchored to 3500ms.

- **R3-de-risk — prove the core hypothesis cheap BEFORE the expensive build. ADOPTED as step 0.**
  Verified `topk_v2` already computes `MAX(vec_sim)`/`MAX(bm25)` (`:197-198`) + clamps `k_parent` to
  50 (`:132`). So an afternoon — bump caller `k_parent` 20→50 + clone `topk_v2` with `MAX ORDER BY`,
  **no schema** — proves whether MAX-ranking + a wider window even helps, before the 700-line worker
  rewrite. Now checklist step 0, gating the whole plan.

- **R3-small — book→sample granularity decided.** A book = **many samples (≈per chapter)**, not one
  monolith, so editing a chapter re-pays only that chapter's Haiku, not the whole book (the worker
  DELETEs all of a sample's units on reprocess, `embed-worker.js:948`). This also makes the
  per-book ingest cap (Decision B) mostly moot. Folded into §6.

- **R3-small — per-section `topic_tags` source.** The sections table requires `topic_tags ≥ 1` and
  the worker hard-fails on empty (`embed-worker.js:959`); auto-segmented sections have no inherent
  tags. **Resolution: sections inherit their parent sample's `topic_tags`** (same propagation as
  units/children today) — write it explicitly so an 80-section book can't hit a NOT-NULL violation
  mid-ingest. (Migration item 1's `topic_tags text[]≥1` stays; the worker fills it from the sample.)

## 14. Regression-risk register — "what are the odds v3 breaks what works?"

Vuk's question (2026-05-27): the current system works *really well*; before coding, quantify the
odds v3 degrades it, and pin those odds with tests. Below: every **shared surface** v3 touches, the
working thing it could break, a probability rating, and the **guard** (existing test or the new
tripwire in `supabase/tests/rag_v3_regression_baseline.test.sql`, run via `npm run db:test`).

**The design principle that keeps the odds low: v3 is ADDITIVE, not a rewrite.** `chunker_version`
and `retrieval_version` are frozen enums; v1/v2 read paths filter their own version; v3 lands as a
*third* path behind the session snapshot. The danger is never "v3 logic is wrong" (that only hurts
v3 creators in dogfood) — it's **v3 work editing a SHARED object in place.** So the register is a
list of shared objects + the tripwire that fires if one is touched.

| Shared surface | What breaks if v3 touches it wrong | Odds (pre-guard) | Guard |
|---|---|---|---|
| `creator_knowledge_topk_v2` RPC | every live v2 retrieval — wrong order / zero rows | **Med** (plan step 0 *clones* it; risk only if someone edits in place) | `creator_knowledge_topk_v2.test.sql` (15 assertions incl. #13 SUM-behavior, #5 v2-only filter, #14 k-clamp). Red on any in-place change. |
| `corpus_reprocess_mark_done` (live v2 finish) | R2-C1 fix folds a version-bump + delete here → a wrong edit breaks **every v2 reprocess** | **High** (it's the live ingest finish; the plan deliberately isolates this as standalone step 1b) | **NEW A1/A2 tripwire** — pins "no bump, no delete" today; goes red *on purpose* when the bump lands → forces a conscious, isolated, tested change. |
| `sample_content_chunks` UNIQUE (3-col) | R2-C4 section dimension could loosen v1/v2 dedup via NULL-distinct → dup-key bug `20260523000003` returns | **Med** | **NEW B1 tripwire** — dup `(sample,chunker,index)` must raise 23505; red if a 4-col NULL-bearing unique replaces it without a partial-index guard. |
| `retrieval_version` CHECK + `admin_set_creator_retrieval_version` + `sessions…CHECK` | v3 flip rejected, or downgrade orphans v3 rows | **High** if forgotten (all hard-pin `{1,2}`) | `creators_retrieval_version.test.sql` #6/#7 already assert "v=3 rejected" → they flip red→green when the v3 migration lands = the checklist that the gating set was applied. |
| Proxy dispatch (~9 `=== 2` sites today, incl. live `retrieveEnvelopeForDecoupled`) | v3 session silently falls to v1 → **zero retrieval every turn ("he blanks")** | **High → eliminated** by R3-C3 + R4-C5 | the `resolveRetrievalPath(version)` chokepoint **throws on unknown version** — a missed site fails LOUD at session-open, never silent-v1. (Its own unit test ships with the helper.) Grep recipe pinned in §5 so the count stays current. |
| `enqueue_*` triggers + `target_version CHECK` + claim/enqueue RPCs | v3 creator's sample edit raises / wrong-pipeline | **High** if the lockstep set is incomplete | enumerated migration set (§11/§12); `enqueue_routes_by_retrieval_version.test.sql` + `claim_corpus_reprocess_job.test.sql` cover current behavior and must be extended in the same change. |
| `semantic_query_cache` (keyed on `current_corpus_version`) | stale parents after reprocess | **Low** (self-heals — `retrieve-knowledge.ts:628-655` falls through to fresh retrieve); R2-C1 corrects severity | the A1 tripwire (version-bump) is the fix's gate; cache test `semantic_query_cache.test.sql` covers key behavior. |
| `embed-worker.js` reprocess loop (~700 lines) | v3 restructure breaks v2 ingest | **Med→Low** — v3 branches on `target_version` (R2-C2); v2 path code unchanged | gated behind the v3 queue; v2 jobs (`target_version=2`) never enter the v3 branch. |

**Net odds of breaking the working system, with the plan's guards in place: LOW** — *provided* the
two High-risk shared edits (mark_done version-bump, the gating CHECK set) are done as the plan now
specifies (standalone pre-v3 migration for the cache-bump; lockstep migration set for the flip), and
the dispatch chokepoint replaces the grep. The tripwires make "did I break v2?" a red/green signal,
not a hope. **Highest residual risk is human, not architectural:** editing `topk_v2` or `mark_done`
in place instead of cloning/isolating — which the tripwires catch on the next `db:test`.

### Odds the plan WORKS to full extent — measured, not asserted

`supabase/tests/rag_v3_regression_baseline.test.sql` Block C is the cheap step-0 proof, and it
**passes green today** (6/6) on a synthetic 23-unit corpus with zero API calls:
- **C1** — Wall B reproduced: the single-strong "needle" unit is buried below the `k_parent=20`
  SUM-RRF window → never reaches the reranker. *The failure the plan exists to fix is real and now
  has a regression test.*
- **C2** — Lever 1 (wider `k_parent=50`, already supported, **no schema**) pulls the needle back
  into candidates.
- **C3** — Lever 2: in the same candidate set the needle ranks **#23 by SUM(rrf)** (buried) but
  **#1 by MAX(vector)** — `topk_v2` already returns both columns, so MAX-ranking is proven to fix
  the burial *before writing the v3 RPC*. 
This is as close to "know the outcome in advance" as it gets without the live book corpus: the core
lever (MAX + wider window) demonstrably recovers a buried needle. What's still unproven by this
synthetic test and MUST be measured on the real eval harness (§7): routing precision at book scale,
the cross-encoder's behavior on scoped candidates, latency under the 3500ms live ceiling, and the
"exactly him" rubric. Those are the genuine unknowns; the ranking lever is no longer one.

### Net after three rounds
Diagnosis verified correct by an independent reviewer; architecture (routed hierarchy + MAX, reject
RAPTOR) confirmed as the right call. The dangerous-to-get-wrong parts are now pinned: **build-then-
flip ordering** (can't brick a live creator), **live v2 RPC change isolated** from the experimental
path, **dispatch chokepoint that fails loud**, **routing precision as the real recall gate**, latency
anchored to the live ceiling, and a **cheap afternoon proof of the core hypothesis gating the
expensive build.** Re-audit at step 3 (migrations written) per Vuk's guidance — not auto-chained.

---

## 14a. Audit round 4 — final pre-build pass (Vuk-requested 2026-05-28)

Final adversarial review after the plan absorbed Step 2's "DONE" annotation + status-to-BUILD flip
and three rounds of prior edits. Auditor verdict: **NOT buildable as written** until 5 Criticals
fixed. All 5 Criticals + 7 Mediums + 6 Smalls applied; this section is the disposition record.

### Critical (round 4) — all FIXED inline

- **R4-C1 — `p_min_sim` (routing floor) and inject min-rerank-score (Stage 4 silence gate) had no
  source.** Plan referenced both but never said where the numbers come from. v2's 0.30 was
  SUM-RRF-calibrated, meaningless for MAX. **Fix:** §4 item 6 and §7 #3/#7 both now name these as
  harness-tuned gate outputs hard-blocking prod-flip; migration ships with placeholder; §10 OQ #2
  expanded.
- **R4-C2 — `responseSchema` for per-section Flash was a `narrative-chunk.ts:269-272` TODO; per-
  section ingest amplifies schema-drift retry tax by N (30–80 calls/book × tax) — §3 COGS assumes
  enforcement.** **Fix:** §8 step 4a is now an explicit sub-task: land `responseSchema` resolving
  the TODO, verify against pinned `@google/genai` field name.
- **R4-C3 — §11/M3 "per-section cache" was fixed-on-paper, broken-in-code.** The 1h cache key is
  owned by `/api/internal/contextual-gen`, not the worker. §8 step 4 didn't name the owning file.
  **Fix:** §8 step 4b pins: worker passes `section_text` as the `doc` field (option ii — smaller
  blast radius than route refactor).
- **R4-C4 — Section title/summary contract was undefined for paragraph-pack mode (cue=null) and
  for oversize-chapter sub-sections (which would inherit identical cues).** Downstream Flash and
  the sections table would silently misbehave. **Fix:** §8 step 4c pins: Flash synthesizes title
  for cue=null sections; sub-section #k gets parent cue + suffix " (part k/N)"; Zod-enforced.
- **R4-C5 — proxy dispatch line-number enumerations in §5 and §12/R2-C3 had ALREADY rotted by the
  time of round-4 audit (round-1 cited one set, round-2 another, current grep gave a third).**
  Builder following stale numbers would mis-wrap the spike-a probe (which isn't a dispatch).
  **Fix:** §5 replaces enumerations with a grep recipe + names `assertRetrievalPathSupportedOnSpike()`
  for the probe (distinct from the dispatch chokepoint).

### Medium (round 4) — all FIXED

- **R4-M1 — §8 step 0 had no defined pass bar; "afternoon proof" conflated synthetic and real-
  corpus probes.** **Fix:** step 0 split into 0a (synthetic Block-C, DONE) + 0b (real Vuk corpus,
  DONE via `aod-needle-test.mjs`) with explicit pass bar pinned. Gate disposition: PASSED.
- **R4-M2 — `p_rank_mode` IDs unpinned; §4 said "default = max-dominant blend" but §2.3 a–d had no
  canonical names.** Builder + harness would diverge on IDs. **Fix:** pinned in §4 item 6 +
  cross-referenced in §7: `'max' | 'max_blend' | 'vec_max' | 'best_child'`, default `'max_blend'`.
- **R4-M3 — `creator_v3_ready` definition was vague; "reflects the rebuild" could mean "any v3
  chunk exists" → flip a half-built creator → blanks on half the corpus.** **Fix:** §6 step 2
  pinned to three concrete conditions: completed job, sections with embeddings, every section
  has ≥1 chunk.
- **R4-M4 — `section-segment.test.ts` test name + assertion encoded safe=8000 but shipped code is
  safe=7500 (Flash responseSchema headroom).** **Fix:** test name + assertion updated to 7500;
  code comment justifies the choice.
- **R4-M5 — every `embed-worker.js` citation in the plan omitted the `server/voice-proxy/` prefix;
  builder grep would miss the actual file.** **Fix:** §0 adds a one-time path note for builders.
- **R4-M6 — chapter-as-sample (round-3 granularity decision) leaks operator pain: 30+ chapters
  per book × NOT NULL `topic_tags` = remembering tags every upload.** **Fix:** §6 adds a
  book-template sub-task to §8 step 4 — capture tags once at book-create, pre-fill chapters.
- **R4-M7 — silent-zero-output failure mode: worker succeeds for a section but Flash returns no
  units → `creator_v3_ready` stays false forever with no operator-visible cause.** **Fix:** §8
  step 4d pins a per-section "produced ≥1 unit OR explicit reason" assertion + admin surface.

### Small (round 4) — folded in

- §0 #7 migration `20260516000004_admin_set_retrieval_version_cleans_v2_zombies.sql` cite
  **verified** as accurate (auditor flagged for verification; file present).
- `section-segment.ts:48-49` headroom comment is informal; per-section dry-run measurement before
  step 4 freeze will pin the exact number. Acceptable as-is until Flash output volume on real
  sections is measured.
- §4 item 6 now lists `parent_score` in the column shape (was implicit via §11/M7 + §12/Small only).
- §14 table row corrected: "~9 sites" not "~11" (round-4 C5 grep).
- `server/voice-proxy/embed-worker.js:948` per-sample DELETE is correct under chapter-as-sample
  decision; the `sampleChunkIndex` variable stays as-is (chunk_index remains sample-wide per the
  R2-C4 partial-unique fix for v3 chunker_version=3); when section_index is added (v3), the index
  remains sample-wide for v1/v2 compatibility. Folded into §11/R2-C4 disposition by reference.
- §10 OQ #2 "Confirm" → upgraded to gate language (round-4 C1).
- `narrative-chunk.ts:288-297` already family-aware-dispatches `thinkingLevel` vs `thinkingBudget`;
  §8 step 4 builder MUST NOT re-implement this — preserve the existing dispatch.

### Net after four rounds

The plan is now **buildable as written**. Every "decided" item from rounds 1–3 was re-verified for
"actually present in the plan, not just declared FIXED on paper." The dangerous places where a
builder could legitimately make a wrong call (silent-v1 fallthrough, schema drift, cache thrash,
half-built flip, identical-titled sub-sections, vague gate floors) are now pinned to specific
files + specific functions + specific values (or named as harness-gate-outputs with placeholder
defaults). Step 0 cleared on real Vuk content. Step 2 shipped. Begin step 1b.

---

## 15. The proven playbook — Google/Perplexity ranking inside bounded knowledge

Vuk (2026-05-27): *there has to be a proven method to "clone a human brain"; Google/Perplexity
average the web fast + precise — we need that within the boundary of the creator's allowed
knowledge; and the brain works on association (question→association→answer→…).* Researched + verified
the actual mechanisms (DOJ trial + 2024 API leak for Google; Perplexity's published pipeline) and
mapped them to OakLeague. The conclusion reconciles the §2.5b GraphRAG rejection.

### What Google/Perplexity actually do (verified)
- **Google** ranks in two phases: (1) initial relevance + **PageRank** (authority via backlinks =
  endorsement, distance from trusted sources) + page quality; (2) **NavBoost re-ranks by engagement**
  — `goodClicks` / `badClicks` / `lastLongestClicks`, dwell time, 13-month window. *Relevance finds;
  authority + engagement re-order.*
- **Perplexity** = our exact shape + more: intent classification → **hybrid (BM25 + dense)** →
  **3-tier reranker** (incl. an authority/quality gate) → top-3–8 by directness + authority + recency.

### The synthesis — "library for FINDING, lightweight graph for CONNECTING"
v3's library (hierarchy + routing + rerank) is the *relevance* engine = Perplexity's hybrid+rerank
within the creator's boundary. On top of it sit **three proven mechanisms we don't yet use** — two
of which ARE the "interconnection / association web" instinct behind graphify. This is where the
graph idea is *right* (connection), having been *wrong* as the primary lookup (§2.5b):

1. **Authority / centrality — the PageRank analog (in-corpus, cheap, do early in v3.1).** A creator
   has no external backlinks, but has an internal endorsement signal: the ideas he **returns to,
   cross-references, builds frameworks around** = graphify's "god nodes." Compute a per-unit
   centrality score (concept co-occurrence / repetition across the corpus) and boost by it. Effect:
   his *core recurring beliefs* surface first — exactly what makes him feel like *him*. Cheap because
   it's computed once at ingestion from data we already extract.
2. **Engagement re-ranking — the NavBoost analog (v3.2+, needs usage data).** Google promotes what
   users click + dwell on. Our analog: log which injected units produced *engaged* turns (user keeps
   talking, thumbs-up, doesn't bail) and boost them on a rolling window. This is the **learning-to-
   rank loop that makes retrieval "precise" over time** — the real path from "good" to "uncanny,"
   bounded entirely within the creator's own corpus.
3. **Association adjacency — how the brain chains (v3.1–3.2, the graphify "web").** Conversation is
   associative: answer → related thought → follow-up. After we inject a unit, **pre-warm its
   neighbors** (same section, shared-concept units, units the creator explicitly links) so the
   follow-up is instant and flows *by association*, like talking to the real person. This is a
   **lightweight unit↔unit relationship layer** (shared-concept adjacency, NOT a full entity graph,
   NOT a Neo4j) — the bounded, right-sized version of the interconnected web.

### Why "sorting has the biggest impact" is exactly correct (Vuk's instinct = Google's architecture)
At query time we have ~3.5s and one shot — no room for heavy reasoning. So **all the intelligence
must be front-loaded into how knowledge is organized at ingestion**, exactly like Google spends
enormous offline compute building its index (crawl, PageRank, clustering) so that *query* time is a
fast lookup + rerank. Our ingestion already front-loads: sectioning, section summaries, contextual
headers, embeddings. v3.1 adds centrality + concept tags + association edges to the same offline
pass. **Get the right knowledge in the right places once; retrieval becomes a breeze forever.** This
validates the v3 emphasis on ingestion redesign over query-time cleverness.

### The "100% clone" expectation, honestly framed
Nothing retrieves perfectly — but the bar isn't perfect recall of every fact. It's: *the right answer
to the questions people actually ask, in his voice, reliably enough that the recognition fires.* The
proven stack (hybrid + rerank + authority + engagement, all within bounded knowledge) is exactly how
Google/Perplexity hit "feels like it knows everything" — and our boundary is far smaller and cleaner
than the open web, which makes the target *easier*, not harder.

### Strategic framing (YC)
This is **YC's Summer-2026 "Company Brain" Request for Startups** — *"pull knowledge from fragmented
sources, structure it, keep it current, turn it into [a brain] for AI; every company will need one;
the layer does not yet exist"* — applied to a **person/creator** instead of a company's internal
docs. Same primitive (bounded knowledge → structured → routed → retrieved), different target. See
[[project_yc_company_brain_rfs]].

### OakLeague's structural edge — the video-context prior (warm start) [Vuk, 2026-05-27]
Google/Perplexity answer cold queries against the whole web. **We don't — and that's our unfair
advantage.** An "ask" session is *born from a specific video* (hook clip → long-form → mic tap). The
vast majority of questions in that session are *about what the user just watched.* So we know the
likely topic **before the first word is spoken.** Three exploitations, all on top of the library:
1. **Warm start / pre-route.** At session-open we already have the video's + hook's `topic_tags`
   (`brain-prefix.ts` uses them for the persona seed). v3 reuses them as a **routing prior**: pre-
   compute the top sections for *that video's* topics and warm them — so the first answer is faster
   and lands in the right neighborhood. This is the routing prior the §2.3 router blends with the
   query (soft boost, never a hard gate — an off-topic question still works).
2. **Per-video question learning (NavBoost, localized).** Log the questions a video's session
   actually generates and which units satisfied them; **rank that video's likely topics by real
   demand.** "Cold" videos start from `topic_tags`; "warm" videos route from accumulated question
   patterns. This is engagement re-rank scoped to the *video*, which is a far stronger signal than
   global because intent is already narrowed by what they're watching.
3. **Optional intent picker (ChatGPT-style).** After "start convo," an optional "what do you want to
   get into — business / productivity / life?" tap further narrows the prior before question #1.
   Cheap, and it pre-warms the right shelf.
**Why competitors structurally can't copy this:** Google/Perplexity have no "what did you just
watch" prior and no bounded allowed-knowledge set — they must average the open web cold. We route
inside one creator's corpus, pre-narrowed by the exact video in front of the user. *The boundary is
the moat.* (Roadmap: the prior is a v3-core nicety via `topic_tags`; per-video learning is v3.2 with
the engagement loop.)

### Roadmap placement (no scope creep into v3 core)
v3 ships the **library (find)** — that's the moat-critical fix for the two walls. The three
mechanisms layer on AFTER, gated on evidence: **centrality (v3.1, cheap, in-corpus)** → **association
adjacency (v3.1–3.2)** → **engagement re-rank + per-video learning (v3.2+, needs usage data)**. The
video-context prior (above) rides v3 core via existing `topic_tags`. Each is additive behind the
same `retrieval_version`/bridge pattern; none blocks v3 shipping.
