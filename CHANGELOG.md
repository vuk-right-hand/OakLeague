# Changelog

OakLeague — material, ship-affecting changes. Newest first. Phase 2
adds the RAG retrieval orchestrator behind a per-creator
`retrieval_version` gate; flipping creators to v2 is a manual admin
action gated on Day-13 work landing.

## Unreleased — `rag-sota-phase-2-days-8-12` (Days 8–13)

### Added (Day 13 — proxy → Vercel shim wiring)
- `/api/internal/retrieve-knowledge` HTTP shim wrapping
  `retrieveKnowledgeV2`. Vercel Node runtime; HMAC-signed envelope
  (Authorization Bearer + X-Internal-Timestamp + X-Internal-Body-Sha256)
  with ±60s skew; body's `user_id`/`creator_id`/`corpus_version_at_session`
  re-derived from `sessions.id` (Day-13 audit C3/M5). Body's
  `budget_ms` is RELATIVE duration; shim computes deadline locally to
  defuse Fly↔Vercel clock skew (audit C4).
- `src/lib/voice/internal-request-signature.ts` + proxy JS mirror —
  HMAC sign/verify with timing-safe equality, 64-hex length pinning.
- `server/voice-proxy/retrieve-knowledge-v2-client.js` — fire-once
  shim caller. NO retry on any status (audit M3 — orchestrator
  increments budget before throw). Per-turn AbortController wired
  into bridge `interrupted` so barge-in cancels the in-flight fetch
  (audit-build C1). External signal listener auto-detached on happy
  path (audit-build C2).
- `server/voice-proxy/voice-session-state-writer.js` — durable-
  fallback UPSERT, length-gated ≥20 chars (audit M4).
- `server/voice-proxy/posthog-client.js` — fire-and-forget batch
  emitter, queueMicrotask dispatch, 1500ms AbortController, queue cap
  16. Boot-logs once when POSTHOG_API_KEY unset. Drained on SIGTERM
  with 1500ms grace (audit-build M2).
- `server/voice-proxy/build-injection-envelope.js` — ported v2
  features (title rendering, score-aware drop, 32KB hard input
  ceiling, `oversize` + `droppedPassages` fields). Vitest drift test
  in `src/lib/voice/build-injection-envelope-drift.test.ts` asserts
  byte-identical TS↔JS output across 10 fixtures.
- `sessions.retrieval_version_at_session smallint NOT NULL DEFAULT 1`
  + CHECK(1,2). Snapshot column written by patched `session_open` +
  `session_rollover` RPCs under the same FOR SHARE row lock that
  already snapshots `corpus_version_at_session`. Migration
  `20260522000001_sessions_retrieval_version_snapshot.sql`.
- Proxy in-memory closure `lastAssistantResponseClosure` is the
  source-of-truth for the next turn's rewriter (audit C5 / audit-
  build M3). DB UPSERT is durable fallback only; written BEFORE
  `ws.send(turn_end_ack)` to avoid race with synchronous
  `input_transcription` events.
- Boot-fatal config check on Fly when `RAG_V2_PROXY_ENABLED=1` —
  proxy `process.exit(1)` if `RAG_V2_SHIM_URL` or
  `INTERNAL_API_SECRET` is missing or invalid (audit-build C4).
  v2 sessions reaching a v2-disabled proxy SKIP retrieval entirely
  (not fall through to v1) with a loud Sentry signal.
- Spike-a admin path probes `creators.retrieval_version` and emits a
  warning when the creator is on v2 but the path hard-pins v1 (audit-
  build M4).
- M5 audit response collapse — all five session-validation failures
  return opaque `403 forbidden`; reason is logged server-side only,
  closing the existence/ownership oracle.

### Added (Days 8-12 — original Phase 2 ship)
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
