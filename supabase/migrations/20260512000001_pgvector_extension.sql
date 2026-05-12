-- 20260512000001 — pgvector extension.
--
-- M1 of pgvector RAG plan. Enables halfvec + HNSW for per-turn semantic
-- retrieval (Pipeline α''). Supabase ships pgvector 0.8.0+ which supports
-- both halfvec (2 bytes/dim, 4000-dim HNSW cap) and HNSW (m + ef_construction
-- tunables). Idempotent.

CREATE EXTENSION IF NOT EXISTS vector;
