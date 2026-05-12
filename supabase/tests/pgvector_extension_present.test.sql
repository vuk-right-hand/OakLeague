-- pgvector RAG plan — verify M1 (extension) + M3 HNSW index landed.

BEGIN;
SELECT plan(3);

SELECT ok(
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector'),
  '1: pgvector extension installed'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE indexname = 'sample_content_chunks_embedding_hnsw_idx'
  ),
  '2: HNSW index on sample_content_chunks.embedding present'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'sample_content_chunks'
       AND column_name = 'embedding'
       AND udt_name = 'halfvec'
  ),
  '3: embedding column is halfvec'
);

SELECT * FROM finish();
ROLLBACK;
