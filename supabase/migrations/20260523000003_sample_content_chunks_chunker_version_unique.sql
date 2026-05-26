-- 20260523000003 — sample_content_chunks unique constraint: include chunker_version.
--
-- Bug fix discovered 2026-05-20 during Day-14 dogfood reprocess of creator
-- vuk_lehendas. Migration 20260512000003 created UNIQUE (sample_id, chunk_index).
-- v2 migration 20260514000003 added chunker_version + parent_unit_id columns
-- but never updated this constraint, so v2 chunks at chunk_index 0..N collide
-- with the legacy v1 chunks at indices 0..N for the same sample.
--
-- Symptom: corpus_reprocess worker errors with
--   "duplicate key value violates unique constraint
--    \"sample_content_chunks_sample_id_chunk_index_key\""
-- on the first chunker_version=2 insert for any sample that already has v1
-- chunks. Affects every creator currently on retrieval_version=1 being
-- promoted to v2 (the entire user base today).
--
-- Fix: drop the 2-column unique, replace with a 3-column unique that includes
-- chunker_version. Each (sample_id, chunker_version) gets its own contiguous
-- chunk_index space. v1 and v2 chunks coexist (intended design per
-- 20260514000003 header).
--
-- Safety: instantaneous on tables with even millions of rows (constraint
-- swap, no row rewrite). No app-level read path uses the old constraint
-- name. The legacy v1 read path (creator_knowledge_topk) filters by
-- chunker_version=1 in WHERE; the v2 path (creator_knowledge_topk_v2) by
-- chunker_version=2. Neither relies on the unique constraint at query time.

ALTER TABLE public.sample_content_chunks
  -- IF EXISTS (audit small) — replay-safe on a fresh rebuild even if a future
  -- hotfix ever renames/drops the auto-named 2-col constraint upstream.
  DROP CONSTRAINT IF EXISTS sample_content_chunks_sample_id_chunk_index_key;

ALTER TABLE public.sample_content_chunks
  ADD CONSTRAINT sample_content_chunks_sample_id_chunker_version_chunk_index_key
    UNIQUE (sample_id, chunker_version, chunk_index);
