# Changelog

OakLeague — material, ship-affecting changes. Newest first. Phase 2
adds the RAG retrieval orchestrator behind a per-creator
`retrieval_version` gate; flipping creators to v2 is a manual admin
action gated on Day-13 work landing.

## Unreleased — `rag-sota-phase-2-days-8-12` (Days 8–12)

### Added
- Hybrid retrieval pipeline: query rewrite (Gemini Flash) → embed
  (Gemini embedding-001) → semantic cache lookup (16-way HASH partitioned,
  per-partition HNSW) → hybrid RPC (`creator_knowledge_topk_v2`, vector
  + BM25 + RRF) → cross-encoder rerank (Voyage rerank-2.5) → cache
  upsert. Behind per-creator `creators.retrieval_version=2` gate.
- `src/lib/voice/retrieve-knowledge.ts` `retrieveKnowledgeV2` orchestrator
  with try/finally cogs_log flush, `withDeadline` timeout helper for
  every DB + embed call, id-based rerank mapping, cache-hit
  zero-fetched fall-through.
- `src/lib/voice/rag-telemetry.ts` `RagTurnTelemetry` aggregator;
  `toCogsLogRows` emits per-leg `cogs_log` rows; `toPostHogEventBatch`
  maps fallback reasons → event names (`rag_cache_hit`/`miss`,
  `rag_session_corpus_drift`, `rag_budget_exceeded`,
  `rag_rewrite_no_context_post_resumption`, `rag_rerank_*` taxa).
- `src/lib/voice/rerank.ts` Voyage rerank bridge with `RerankBridge`
  interface, `performance.now()` monotonic token bucket, synthetic
  monotonic-decreasing scores on degrade (NOT NaN), 429 penalizes bucket.
  Cohere fallback explicitly deferred.
- `src/lib/voice/build-injection-envelope.ts` hard 32KB input ceiling;
  drops lowest-score passage iteratively; `oversize=true` signal.
- `scripts/seed-rag-test-fixture.mjs` idempotent staging-only fixture
  creator seed. Refuses non-staging URLs without
  `--force-non-staging` flag.
- `src/lib/voice/retrieve-knowledge.real-api.test.ts` gated real-API
  integration test (`RUN_REAL_API_TESTS=1`).
- `docs/_planning/RAG_SOTA_PHASE_2_HANDOFF.md` ship handoff for Day-13+.

### Changed
- `voice_session_state.last_assistant_response` cap bumped 2000 → 4000
  chars to match Gemini Live `outputTranscript` per-turn cap. Migration
  `20260521000010`.
- `semantic_query_cache_upsert` switched to first-write-wins on race:
  concurrent writers to the same hash bump telemetry only. Migration
  `20260521000008`.
- `session_open` + `session_rollover` now snapshot
  `creators.current_corpus_version` into `sessions.corpus_version_at_session`
  under `FOR SHARE`. Migration `20260521000009` — without this the cache
  is permanently broken for any creator past version 1.
- `build-injection-envelope` accepts optional `title` + `score`; title
  renders as soft context label inside the L2 wrapper.

### Not changed (deferred)
- **Fly voice-proxy still routes v1 retrieval.** The proxy imports a
  v1-only JS mirror (`server/voice-proxy/retrieve-knowledge.js`). All
  Phase-2 TS code is unreachable from the runtime path until Day-13
  ships the HTTP shim (`/api/internal/retrieve-knowledge`).
- **Do not flip any creator to `retrieval_version=2` before Day-13
  lands.** Doing so silently bricks the avatar — v1 mirror queries
  `chunker_version=1` chunks that may not exist for a v2-reprocessed
  creator.
- Cohere rerank fallback. Voyage-only single-provider per "no fallback
  until scale" (2026-05-14).
- M3 budget-counter split (SQL change deferred), M4 AbortSignal
  threading through `withDeadline` (supabase-js change deferred),
  PostHog client wiring (Day-13 proxy author).
