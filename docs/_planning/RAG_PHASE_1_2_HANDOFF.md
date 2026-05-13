# OakLeague RAG — Phase 1 + Phase 2 Implementation Plan Handoff

**For:** Implementation-planning agent (cold start, no prior context)
**Date:** 2026-05-13
**Goal:** Plan implementation of Phase 1 (corpus preprocessing + narrative chunking) and Phase 2 (hybrid retrieval + query rewriting + LLM reranker) for OakLeague's voice-mentorship product.

---

## Project context — what OakLeague is

OakLeague is interactive video mentorship. The user-facing flow: vertical 9:16 hook clip → swipe → long-form video → tap mic → live voice conversation with a cloned-voice AI avatar of the creator. The avatar's "brain" answers in the creator's own voice (Cartesia Sonic-3 clone) with the creator's face (Simli Trinity-1).

**The brain is the moat.** The face and voice are commodity providers behind clean bridges. What makes the conversation feel real is the avatar genuinely knowing the creator's content — that's the RAG system you're planning improvements to.

**Stack:** Next.js 15 · TypeScript · Supabase (Postgres + pgvector + Auth + RLS) · Gemini 3.1 Flash Live (audio-in, AUDIO mode with `outputAudioTranscription`) · Cartesia Sonic-3 · Fly.io (voice proxy with in-process embed-worker).

**Read these in order:**
1. `docs/OAKLEAGUE_WALKTHROUGH.md` — product + flows
2. `docs/_planning/PGVECTOR_RAG_PLAN.md` — the current RAG implementation
3. `CLAUDE.md` — hard rules (auth, RLS, voice constraints)

## Current state — what's been built (level-1 RAG)

| Component | Implementation | File |
|---|---|---|
| Chunker | 300-token windows, 100-token overlap, paragraph/sentence boundaries | `src/lib/voice/chunk-sample.ts` + mirror `server/voice-proxy/embed-worker.js` |
| Embedding | `gemini-embedding-001`, 768-dim, halfvec | `src/lib/voice/embed.ts` |
| Storage | `sample_content_chunks` table, HNSW index (m=16, ef=64) over halfvec_cosine_ops | migration `20260512000003` |
| Retrieval | Single embed → top-3 cosine, min_similarity=0.60 | `server/voice-proxy/retrieve-knowledge.js` + `creator_knowledge_topk` RPC |
| Persona | Per-mode compile, vector mode has clarifier rule | migration `20260512000014` |
| Wire-up | Closure-captured creator_id from voice ticket, injection envelope at turn boundary | `server/voice-proxy/index.js` |
| Worker | In-process polling worker on Fly, 5s tick, atomic claim via `claimed_by` host fence | `server/voice-proxy/embed-worker.js` |

**First dogfood (2026-05-12, real creator with a 71k-char transcript doc):** retrieval works mechanically — chunks come back, injection lands, model uses them. BUT:
- Top-3 similarity for "what's the one-eyed man story?" landed at 0.56-0.62 — barely above floor. Spike #4a calibration baseline for an aligned chunk was 0.79.
- Borderline-relevant chunks injected as noise. Model honestly disqualified ("that story doesn't register, friend").
- "Tell me more about that" follow-ups completely fail (we embed the literal words, which match nothing).

The pipeline is correct. The retrieval *quality* is level-1. This handoff is about getting it to level-3.

## Us vs state-of-the-art retrieval

| Capability | What we built (today) | State-of-the-art (target) |
|---|---|---|
| **Retrieval** | Single embed → top-3 cosine | Hybrid (BM25 + vector) → top-20 → LLM-rerank → top-3 |
| **Query** | Embed user's exact words | Conversation-aware query rewriting (resolves "tell me more about that" follow-ups) |
| **Chunking** | Fixed 300-token windows w/ overlap | Narrative-beat chunks (story-level units) + hierarchical (precision-chunk index, parent-narrative inject) |
| **Context** | Each turn embedded in isolation | Last assistant response + current user query rewritten as a self-contained search query |
| **Response shape** | "1-3 concise sentences" hard-coded in persona | Variable depth (Phase 3 — out of scope here) |
| **Verification** | Inject + hope | Self-rerank / answer-grounded scoring (Phase 4 — out of scope) |
| **Corpus preprocessing** | Raw text chunked blindly, slide markers embedded as content | Slide markers stripped; topic-title prefixes prepended to each chunk before embedding |
| **Embedder choice** | gemini-embedding-001 | Same (decision: stay on one vendor, optimize around it). LLM-Flash reranker compensates for the narrow-spread limitation. |
| **Reranker** | None | Gemini Flash as LLM-reranker (chosen over Cohere — same vendor, ~$0.0001/turn vs Cohere's ~$0.002/turn, ~90% of Cohere's quality per published benchmarks, no new vendor dependency) |

## Decisions already made (do NOT re-litigate)

1. **Stay on `gemini-embedding-001`.** Switching embedders is out of scope. We compensate for its narrow spread with reranking.
2. **Reranker = Gemini Flash, not Cohere.** Reason: ~20× cheaper per turn ($0.0001 vs $0.002), no new vendor, same key. Acceptable quality trade-off.
3. **Hybrid retrieval uses Postgres' built-in `to_tsvector` for BM25** — no new infra. Reciprocal Rank Fusion (RRF) merges the two rankings.
4. **Slide markers are noise, not structure.** The creator's transcript has lines like `42-` because he was reading off slides and the number told him which slide he was on. These bytes ADD positional noise to embeddings (the model correlates "1-" with intro-content, etc.). Strip them in preprocessing.
5. **Latency budget is forgiving.** Up to +500ms per retrieval call is acceptable. The clarifier rule (persona always asks a clarifying question first on substantive questions) hides retrieval RTT inside the model's own clarifier-and-user-response window (~3-8 seconds). Adding 200-500ms of retrieval work has near-zero perceived impact.
6. **Per-turn embedding cost is rounding error.** The big costs are Gemini Live audio + Cartesia synthesis. Retrieval can be ~5-10% of session COGS and we accept it.

## Phase 1 scope — corpus preprocessing + narrative chunking

**Why:** The single biggest quality win FOR THIS CREATOR's corpus. Their transcripts are narrative ("Let me tell you about two twins...") with slide-marker numbers stripping in. 300-token windows fragment the stories; numbers pollute embeddings.

**Concrete deliverables:**

1. **Slide-marker stripping in chunker preprocessing.** Before chunking, run `rawText.replace(/^\s*\d+-\s*/gm, '')` (or similar — agent should design the regex against the actual corpus structure). MUST stay safe on text that has legitimate "42-" mid-sentence (uncommon but possible).

2. **Narrative-aware chunking.** Replace fixed 300-token windows with semantic chunks at narrative-beat boundaries. Approach options for the agent to evaluate:
   - **(A) LLM-driven chunking:** prompt Gemini Flash with the raw doc + "split into 100-300 word self-contained narrative units, return JSON `[{title, text}, ...]`". One-shot per sample. Cost: ~$0.001 per 10k-token doc.
   - **(B) Heuristic narrative detection:** detect story openers ("Let me tell you about...", "Imagine...", "Here's an example..."), conclusion phrases ("the takeaway is...", "what this means...") to find unit boundaries. Cheaper but brittle.
   - **Recommended: A.** One-time cost per sample, much higher quality, fits the "quality over speed" mandate.

3. **Topic-title prefix prepending.** After narrative chunking, prepend each chunk with its discovered title + a short doc-title prefix before embedding: `"[<doc-title>] [<chunk-title>] <chunk-body>"`. Improves recall on questions that use document-level vocabulary.

4. **Hierarchical retrieval.** Keep the small/precise chunks for embedding (~150-200 tokens). When one matches, fetch its PARENT narrative unit (~500-800 tokens) and inject the parent. Schema: add `parent_chunk_id` column to `sample_content_chunks`, OR a separate `sample_content_narrative_units` table. Agent designs.

5. **Migration story:** existing creators have 91 chunks from the old chunker. Need a re-embed pathway that:
   - Strips slide markers
   - Runs new chunker
   - Deletes old chunks
   - Inserts new chunks + parents
   - Is idempotent (re-run-safe)
   - Logs progress per sample (resumability if it crashes mid-run)

**Expected impact:** For the dogfood corpus, top-3 similarity on the "twins story" question goes from ~0.59 today to ~0.80+. Real fix.

**Open questions for the agent to answer:**
- What's the right parent chunk size — fixed 600 tokens, or "the whole narrative beat regardless of size"?
- How do we handle samples that aren't narratives (e.g., bullet-point reference docs)? Same chunker or detect-and-fall-back?
- Where does Phase 1 implementation live — extend the existing embed-worker or carve out a separate "preprocessor" stage?

## Phase 2 scope — hybrid retrieval + query rewriting + LLM reranker

**Why:** Phase 1 fixes precision on direct questions. Phase 2 fixes everything else: follow-up questions, paraphrased questions, edge-of-corpus questions. Adds the smarts that turn "decent retrieval" into "actually feels like the creator knows the topic."

**Concrete deliverables:**

1. **BM25 keyword retrieval alongside vector.** Postgres' built-in `to_tsvector` + `ts_rank_cd`. Add a `text_search` `tsvector` column on `sample_content_chunks` (GENERATED ALWAYS AS), GIN index, query against it.

2. **Reciprocal Rank Fusion (RRF) merger.** Run both vector and BM25 searches, get two ranked lists of ~20 candidates each, fuse via RRF (`score = sum(1 / (k + rank_i))` where k=60 conventional). Output: single top-20 list.

3. **Query rewriting.** Before retrieval, pass `<last_assistant_response_text>` + `<current_user_query>` to Gemini Flash with a prompt like: *"Rewrite this user query as a self-contained search query that resolves any references to prior conversation. Output only the rewritten query."*
   - Cost: ~$0.0001-0.0003 per turn
   - Latency: ~100-300ms
   - Fully parallel with the clarifier generation, so net perceived latency = 0
   - When there's no prior turn, skip rewriting (first user turn embeds as-is)

4. **LLM-as-reranker.** After RRF gives top-20, pass top-20 + the (rewritten) query to Gemini Flash with: *"Score each chunk 1-10 for how well it answers the query. Return JSON `[{id, score}]`."* Sort by score, take top-3.
   - Cost: ~$0.0001 per turn
   - Latency: ~200-300ms
   - Combined with vector + BM25 + RRF: total retrieval ~500-1000ms (vs current 300-500ms)
   - All hidden inside the clarifier window

5. **Telemetry:** add fields to the existing `cogs_log` retrieval metadata: `rewrite_query`, `bm25_top1_score`, `rrf_top1_score`, `rerank_top1_score`, so we can watch the funnel.

**Expected impact:** Follow-up questions actually work. Borderline-vocabulary questions ("what's that mental thing where I assume...") hit the right chunks via BM25 token overlap even when vector cosine misses.

**Open questions for the agent to answer:**
- BM25 needs corpus-wide IDF stats — does pgvector's built-in tsvector compete fairly across creators with very different corpus sizes, or do we need per-creator tsvector scoping?
- Query rewriting needs the last assistant response — do we cache it in session state or query Supabase per turn?
- What's the failure mode if Gemini Flash rate-limits during a session? Fallback to vector-only top-3?
- Should the LLM reranker also DROP chunks scoring below a threshold, or always return top-3 (current floor behavior)?

## Files the agent will touch

- `src/lib/voice/chunk-sample.ts` + tests
- `server/voice-proxy/embed-worker.js` (chunker mirror, narrative chunking call)
- `server/voice-proxy/retrieve-knowledge.js` (hybrid + rewrite + rerank pipeline)
- `src/lib/voice/retrieve-knowledge.ts` (mirror for tests + future Next callers)
- `server/voice-proxy/index.js` (caller wiring + conversation memory for rewrites)
- New migration(s) for: `parent_chunk_id` column or `sample_content_narrative_units` table; `text_search` tsvector column + GIN index; possibly a `last_assistant_response` cache table
- `src/lib/posthog-events.ts` (new telemetry events for funnel visibility)

## Constraints / things to honor

1. **Production from line one.** No hardcoded creator IDs, no v2-shortcuts, no "we'll fix it later." Every change must work for creator #50 signing up next week.
2. **Service-role-only writes** to `sample_content_chunks` / new tables (no creator INSERT/UPDATE policy). RLS own-read for dashboard visibility.
3. **Closure-captured creator_id** trust chain stays intact. Never accept `creator_id` from per-message client input.
4. **Drawer-mode rollback path stays alive.** `creators.brain_mode = 'drawer'` flips back to the legacy pipeline. Phase 1 + 2 only enhance vector mode.
5. **Budget caps:** existing per-user `voice_retrieval_budget` (200/day) and per-creator `creator_embedding_budget` ($5/day) must still bound the new costs. The agent should propose budget adjustments if Phase 1+2 push past them.
6. **Spike #2 boundary:** persona length stays under ~770 chars for vector-mode (gemini-3.1-flash-live-preview resumption-handle replay regression). Phase 1+2 don't change persona, but the agent should know this exists.
7. **Cold-start fairness:** new chunker preprocessing adds time at index-time, not per-turn. Existing 91-chunk creators need a one-time re-process; new creator onboarding takes ~30s longer.

## Out of scope for THIS handoff

- **Phase 3** (drop "1-3 sentences" persona constraint, variable-depth response) — handled by the founder + main team
- **Phase 4** (speculative answer drafting during clarifier wait) — handled later
- **Switching embedders** away from gemini-embedding-001
- **Switching to a third-party reranker** (Cohere, Voyage). Decided: LLM-reranker via Gemini Flash.
- **Multimodal RAG** (images/video from the creator's content) — future phase, not now.

## Deliverable expected from the agent

A step-by-step implementation plan with:
1. Migration list (in order, with rollback)
2. File-by-file change scope (with line-count estimates)
3. Test coverage (vitest for libs, pgTAP for migrations, gated integration test against a fixture corpus)
4. Backfill / re-process strategy for the existing creator's 91 chunks
5. Rollout staging (does Phase 1 ship alone, or bundled with Phase 2?)
6. Risk list — what could break, what's the blast radius

**Use the auditor subagent (`.claude/agents/auditor.md`) at least once before presenting the plan.** Surface its findings in the response.
