# RAG Scaling Architecture — Implementation-Planning Brief

**Owner of this brief:** RAG/voice workstream (Vuk + Claude). **Audience:** the engineer who will
write the implementation plan for the scalable retrieval architecture (#4 / "the moat").
**Status:** problem + target defined here; YOU produce the plan (auditor-reviewed, per CLAUDE.md
Planning Loop) before any code.

> This is the project's competitive moat. OakLeague is "operator-network + cloned-voice +
> RAG-brain," NOT an infra company. The brain must retrieve a creator's knowledge **flawlessly at
> book-scale** so the avatar is "exactly him." Today it works for ONE 13k-word transcript and
> breaks past that. Fixing that ceiling is this work.

---

## 0. Ramp: read these first (the current pipeline)

- `src/lib/voice/narrative-chunk.ts` — the LLM chunker (one Flash call per document).
- `src/lib/voice/retrieve-knowledge.ts` — the per-turn v2 orchestrator (rewrite→cache→embed→topk→rerank→inject).
- `supabase/migrations/20260521000002_creator_knowledge_topk_v2.sql` — the hybrid retrieval RPC (vector+BM25+RRF).
- `supabase/migrations/20260521000003_semantic_query_cache.sql` — the semantic cache.
- `supabase/migrations/20260514000003_sample_content_chunks_v2.sql` — chunk table (child chunks, halfvec(768), tsvector).
- `src/lib/voice/embed.ts`, `rerank.ts`, `query-rewrite.ts`, `semantic-cache.ts` — the legs.
- Tables: `sample_content` (the uploaded doc + `topic_tags`), `sample_content_narrative_units` (parent units), `sample_content_chunks` (child chunks), `corpus_reprocess_jobs` (ingestion queue).
- `docs/_planning/PROD_DEPLOY_GATE.md` — deploy gating (this work is NOT deployable until Step 1c).
- Diag scripts (read-only, `node --env-file=.env.local scripts/diag-*.mjs`): `diag-v2-corpus`, `diag-retrieve-v2`, `diag-find-unit`, `diag-cache-probe` — use these to measure, not guess.

## 1. Current architecture (what exists)

**Ingestion** (per uploaded doc): preprocess/sanitize → `narrativeChunk` makes **ONE Gemini Flash
call over the WHOLE document** → LLM-decided "narrative units" (≤8000 chars each) →
embed-worker splits each unit into **child chunks** (~150–200 tokens) → `sample_content_chunks`
(chunker_version=2, halfvec(768) embedding + `text_search` tsvector, `parent_unit_id` FK).

**Retrieval** (per turn): rewrite (gemini-2.5-flash) → embed query (gemini-embedding-001, 768,
RETRIEVAL_QUERY) → semantic-cache lookup (0.92 cosine, 7-day TTL) → on miss:
`creator_knowledge_topk_v2` (vector top-30 children + BM25 top-30 children → **RRF fuse k=60** →
group by parent, **SUM child RRF** → top-20 parents) → **Voyage rerank-2.5** → top-K → inject
envelope into the decoupled brain.

**Hierarchy today:** Document → Narrative Unit → Child Chunk. Flat per-creator chunk pool.
`topic_tags` exist on `sample_content` but **retrieval ignores them**.

## 2. The two walls (measured, not theorized)

**Wall A — ingestion can't handle a book.** `narrativeChunk` sends the entire document to Flash in
one call (maxOutputTokens 65535). A 13k-word transcript fits; a 400-page book (~200k words) blows
both the input window and the output-token cap. The code itself admits it:
*"the real ceiling is the input doc size (chunk the input for pathologically large samples — future work)."*

**Wall B — flat retrieval buries precise answers and drops them as the corpus grows.**
- **RRF sums child contributions per parent** → a parent with MANY mediocre chunks outranks a parent
  with ONE perfect chunk. Proven: the "lumberjack" unit was vector-rank #1 (sim 0.7397) but
  RRF-rank #5; only the cross-encoder rerank rescued it.
- **BM25 is structurally dead.** `try_build_tsquery` → `websearch_to_tsquery` ANDs every term,
  including question words ("what","learn","story"), so no 150-token chunk ever matches all terms →
  `bm25_score = 0` on every row. The dead rank-list still pollutes RRF. (A separate small fix is
  underway in the RAG workstream; the scaling design must assume lexical signal SHOULD work.)
- **k_parent=20 rerank window.** Only the top-20 RRF parents reach the reranker. At 1 doc / 20 units
  that's everything. At 3 books / thousands of units, the correct unit falls below RRF-rank 20 by
  sheer volume and **never reaches the reranker → permanently unretrievable.** This is the hard
  scaling failure.
- **No routing.** Flat dense+lexical over ALL chunks regardless of topic/document/section.

## 3. Target: "Wikipedia-style" routed, hierarchical, book-scale retrieval

Find the article → the section → the passage. Three pillars:

**A. Hierarchical, book-capable ingestion.**
- Segment large docs BEFORE the LLM chunker (chapters/headings for books; timestamp/topic windows
  for video transcripts) so each chunker call sees a bounded window → resumable, book-safe.
- Add a **Section/Chapter level**: Document → Section → Narrative Unit → Child Chunk (today the
  Section level is missing — it's what books need for routing).
- Evaluate **RAPTOR-style** recursive summary nodes: parents are LLM summaries of children, so a
  high-level question ("your philosophy on X") matches a summary and a specific request ("tell the
  lumberjack story") matches a leaf. (Trade-off: expensive to build + rebuild on content update.)
- Evaluate **Anthropic Contextual Retrieval**: prepend an LLM-generated context blurb to each chunk
  before embedding so chunks aren't context-orphaned. (Check whether the referenced "Day 4
  contextual-gen" pass is actually implemented or still a stub.)

**B. Topic-routed retrieval (kills the k_parent=20 global-window problem).**
- Stage 1 — **route**: narrow to the relevant document(s)/section(s) first via `topic_tags`,
  section-summary vectors, or a coarse summary-node search.
- Stage 2 — **scoped hybrid search + rerank** WITHIN the routed scope, so rerank candidates come
  from the right neighborhood, not a global RRF top-20.

**C. Ranking that doesn't bury single-strong answers.**
- Rank parents by **MAX child relevance** (or a max + count blend), not pure SUM-RRF.
- Make BM25 actually contribute (OR-semantics, strip question words) — critical at scale for proper
  nouns / jargon that embeddings miss.
- Keep the cross-encoder rerank as the precision layer; the job is ensuring the right candidate
  REACHES it.

## 3b. CARRIED OVER FROM FIX #3 — parent ranking by MAX child, not SUM-RRF

This is an explicit hand-off, not a suggestion. The RAG live-fix workstream fixed BM25 (#3a, OR-
semantics) but **deliberately deferred the parent-ranking change to you**, because it only bites at
scale and must be designed + measured here, not bolted on.

**The mechanism** (`creator_knowledge_topk_v2`, the `parent_grouped` CTE):
`SUM(rrf) AS rrf_sum` then `ORDER BY rrf_sum DESC LIMIT k_parent`. Grouping child-chunk RRF by
**SUM** rewards a parent with MANY mediocre children over a parent with ONE excellent child.

**Measured** (`scripts/diag-retrieve-v2.mjs`, vuk): the "lumberjack" unit had the single strongest
child (vector sim 0.7397, the highest of any chunk) but ranked **RRF #5** (and #4 even after the
BM25 fix) because the worldview/paradigm units each have more children in the top-30. The
cross-encoder rerank then correctly pulls it to #1 — **but only because it reached the reranker.**

**Why it's a scale failure, not a today failure:** `k_parent=20` and vuk has 20 units → every unit
reaches the reranker, so SUM-burial changes nothing for him. Once a creator exceeds ~20 units
(6 docs, a book), the correct single-strong unit gets SUM-buried below rank 20 and **never reaches
the reranker → permanently unretrievable.** This is the same failure as the missing-routing problem
in §2/§3, approached from the ranking side.

**What your plan must do with it:**
- Treat parent-ranking + the rerank-candidate window + routing (§3B) as ONE coupled problem — SUM-burial
  only becomes a MISS when it pushes the right unit past the candidate window; routing shrinks the
  window's job; ranking decides who's in it.
- Evaluate ranking options against the eval harness (§7): MAX(child rrf); a max-dominant blend
  (max + small sum bonus); MAX(vector sim) with BM25 tiebreak; or "best-child-per-parent then dedupe"
  candidate construction instead of SUM-over-children.
- **Acceptance:** the "right unit reaches the reranker as the corpus grows 1→6 docs→book" metric must
  improve, with **no regression** on the current ≤20-unit case (where rerank already handles order).
- It interacts with the #3a BM25 change (already live in the RAG branch — it alters RRF inputs), so
  measure on top of that, not against pre-#3a behavior.

## 4. Design decisions YOUR plan must make + justify

1. RAPTOR summary-tree vs flat parent/child + topic routing (cost vs power; rebuild-on-update cost).
2. Section level: LLM-segmented vs structural (headings/chapters/video timestamps)?
3. Routing mechanism: creator `topic_tags` (coarse) vs learned section embeddings vs summary-node vector search?
4. Rerank candidate budget at scale (how many, from where).
5. Re-ingestion on content update: incremental vs full rebuild (drives `current_corpus_version` bump + cache invalidation).
6. New `retrieval_version=3` behind the snapshot gate, leaving v1/v2 paths intact.

## 5. Hard constraints (do not violate)

- **Provider-agnostic bridge** (embeddings, rerank, chunker LLM behind typed interfaces; swap = env + bridge file). No SDK types leak past the bridge.
- **COGS log on every paid call** + kill-switch. Ingestion (contextual-gen, summary tree) is a big one-time per-creator cost — model it.
- **Migration discipline** (CLAUDE.md): full pgTAP suite green; blast-radius grep; `chunker_version` is a permanent enum; cache keyed on `current_corpus_version`. Local `db reset`/`db:test` is Vuk-authorized; never target remote without per-action auth.
- **Don't break v1** (`retrieval_version=1`) or the existing v2 path — gate v3 on the session snapshot.
- **Injection precision matters**: the decoupled brain consumes the injected envelope; the RAG workstream just set decoupled injection to **top-1** (one precise unit, not a 5-unit blend). The scaling design must preserve precise, low-blend injection.
- Retrieval is **separate from persona/voice** ("exactly him" style is the brain layer; retrieval feeds facts/stories). Don't conflate.
- **PROD_DEPLOY_GATE**: nothing here deploys until Step 1c clears + coordinated migration apply.

## 6. SOTA to read before choosing

Anthropic *Contextual Retrieval*; *RAPTOR* (recursive abstractive tree); parent-document /
hierarchical retrieval (LangChain ParentDocumentRetriever); hybrid search + RRF tuning;
cross-encoder reranking at scale; semantic / late chunking; query routing & multi-index retrieval.
Verify every claim against current official docs (CLAUDE.md "Verify, Don't Guess").

## 7. Validation / acceptance

- Build a scale test corpus: current 1 doc + synthetic large docs + at least one real book.
- **Recall@k for planted needles** (the lumberjack test + facts buried deep in a book).
- **"Right unit reaches the reranker"** metric as corpus grows from 1 → 6 docs → book-scale.
- Turn latency budget held (4s); ingestion COGS + per-turn COGS within target.
- Side-by-side vs current v2 on the existing corpus (no regression at small scale).

## 8. Suggested plan sequence (turn this into the strike-through checklist)

1. Read §0 files + reproduce Wall B with a synthetic large corpus (show recall drop + unit falling out of rerank window) using the diag scripts.
2. Pick the architecture (routing + hierarchy + ranking) with justification + COGS model.
3. Schema (section level, summary nodes, routing index) → migrations.
4. Ingestion redesign (input segmentation, resumable jobs, contextual gen, optional summary tree).
5. Retrieval redesign (route → scoped hybrid → max-based parent ranking → rerank → top-1/2 inject).
6. Backfill existing corpora (chunker_version / corpus_version bump path).
7. Eval harness (recall@k, reach-the-reranker, latency, COGS).
8. Auditor (Planning Loop) → phased rollout behind `retrieval_version=3`.
