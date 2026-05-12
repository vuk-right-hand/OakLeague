-- 20260512000003 — sample_content_chunks.
--
-- M3 of pgvector RAG plan. Per-chunk halfvec(768) embeddings of every
-- sample_content.raw_text, written by the in-process embed-worker.
--
-- Service-role-driven (no creator INSERT/UPDATE/DELETE policy). Owning
-- creator may SELECT for dashboard visibility ("X of Y chunks embedded").
--
-- Design:
--   * halfvec(768) — gemini-embedding-001 default dim. 1544 bytes per row
--     (1536 data + 8 header). 100K chunks ≈ 154MB vector data; HNSW index
--     adds ~250MB; chunk text adds ~200MB; total ~600MB (Pro plan headroom).
--   * 2048-token cap per chunk aligns with both the chunker's hard cap AND
--     gemini-embedding-001's 2048-token input ceiling.
--   * 8000-char ceiling on text covers the worst-case Unicode-heavy chunk
--     (2048 tokens × ~4 chars/token = 8192 chars; we round down for safety).
--   * Partial HNSW index WHERE embedding IS NOT NULL keeps the index lean
--     during the brief window between INSERT and embed-worker landing the
--     vector (in-flight chunks don't pollute the index).
--   * topic_tags propagates from parent sample_content unchanged. Chunks
--     inherit, not re-tag (chunk auto-tagging is out of scope per plan).

CREATE TABLE public.sample_content_chunks (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_id       uuid          NOT NULL REFERENCES public.sample_content(id) ON DELETE CASCADE,
  creator_id      uuid          NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  chunk_index     int           NOT NULL CHECK (chunk_index >= 0),
  text            text          NOT NULL CHECK (char_length(text) BETWEEN 1 AND 8000),
  token_count     int           CHECK (token_count IS NULL OR (token_count > 0 AND token_count <= 2048)),
  topic_tags      text[]        NOT NULL CHECK (cardinality(topic_tags) >= 1),
  embedding       halfvec(768),
  embedding_model text          NOT NULL DEFAULT 'gemini-embedding-001'
                                CHECK (char_length(embedding_model) <= 64),
  embedded_at     timestamptz,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (sample_id, chunk_index)
);

CREATE INDEX sample_content_chunks_creator_idx
  ON public.sample_content_chunks (creator_id);
CREATE INDEX sample_content_chunks_topic_tags_gin_idx
  ON public.sample_content_chunks USING gin (topic_tags);
-- HNSW over halfvec_cosine_ops. m=16 / ef_construction=64 = Supabase-recommended
-- defaults for <5M vectors. Partial WHERE keeps in-flight rows out.
CREATE INDEX sample_content_chunks_embedding_hnsw_idx
  ON public.sample_content_chunks
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;

CREATE TRIGGER sample_content_chunks_touch_updated_at
  BEFORE UPDATE ON public.sample_content_chunks
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.sample_content_chunks ENABLE ROW LEVEL SECURITY;

-- Owning creator may read for dashboard visibility. No INSERT/UPDATE/DELETE
-- policy — service_role writes via the worker; CASCADE on sample_content
-- handles deletion.
CREATE POLICY "sample_content_chunks own read"
  ON public.sample_content_chunks FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.creators c
     WHERE c.id = creator_id AND c.user_id = auth.uid()
  ));
