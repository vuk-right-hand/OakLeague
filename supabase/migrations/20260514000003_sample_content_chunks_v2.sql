-- 20260514000003 — sample_content_chunks v2 columns + insert RPC + legacy v1 RPC freeze.
--
-- M3-M4 of RAG SOTA plan (docs/_planning/RAG_SOTA_PLAN.md §3, audit-2 + audit-3 fixes).
--
-- Adds the v2 schema surface to the EXISTING sample_content_chunks table:
--   * parent_unit_id  — links each child chunk to its parent narrative unit
--   * chunk_context   — Anthropic-style 50-100 token contextual header generated
--                       per chunk before embedding (35% retrieval-failure reduction
--                       per Anthropic's published numbers)
--   * chunker_version — discriminates v1 (legacy 300-token windows) and v2
--                       (narrative + contextual) chunks. Default 1 keeps every
--                       existing chunk at v1; new chunks go to v2.
--   * text_search     — tsvector for hybrid BM25 retrieval, GENERATED from
--                       coalesce(chunk_context, '') || ' ' || text. The
--                       IMMUTABLE-typed to_tsvector('english'::regconfig, ...)
--                       overload makes this safe as a GENERATED STORED column.
--
-- Single-write insert RPC (_insert_chunk_v2_unsafe) prevents triple-write
-- GENERATED tsvector amplification (audit-2 M4). Takes ONLY p_parent_unit_id as
-- the root identifier and derives sample_id + creator_id server-side from the
-- parent unit row (audit-2 C1: closes parameter-trust gap that would have let
-- a buggy/malicious caller cross-link a child chunk to a parent under a
-- different sample).
--
-- Legacy creator_knowledge_topk gets a chunker_version=1 filter via CREATE OR
-- REPLACE in THIS migration (audit-3 C4) — not Phase 2 — so v1 reads stay
-- deterministic from the moment v2 chunks first land. Otherwise during the
-- Phase 1 → Phase 2 window, re-processed v2 chunks would bleed into v1
-- retrieval, masking whether v2 actually moved the needle.


-- ── v2 columns on sample_content_chunks ──────────────────────────────────────

ALTER TABLE public.sample_content_chunks
  ADD COLUMN parent_unit_id  uuid
    REFERENCES public.sample_content_narrative_units(id) ON DELETE CASCADE,
  ADD COLUMN chunk_context   text
    CHECK (chunk_context IS NULL OR char_length(chunk_context) BETWEEN 1 AND 1000),
  ADD COLUMN chunker_version smallint NOT NULL DEFAULT 1
    CHECK (chunker_version IN (1, 2));

-- ── Pre-flight chunk-count guard (audit-4 C5) ────────────────────────────────
--
-- Adding a STORED GENERATED column rewrites the entire table AND all its
-- indexes — including the existing HNSW halfvec_cosine_ops index from
-- 20260512000003:46-50. On a populated production table this is a multi-minute
-- ACCESS EXCLUSIVE lock, which would block in-flight voice sessions calling
-- creator_knowledge_topk.
--
-- Pre-α' production currently has <1K chunks; this is harmless today. The
-- guard hard-fails if the table grows past the threshold so a future deploy
-- that hits the same migration on a populated DB doesn't take prod downtime
-- by surprise. If you hit this hard-fail, the ONLY supported recovery path
-- on Supabase prod (currently PostgreSQL 15) is a documented maintenance
-- window with voice traffic paused. The PG17-only `ALTER COLUMN ... SET
-- EXPRESSION` syntax for GENERATED columns is NOT available on PG15 — do
-- not try it (audit-6 C3 caught the misleading earlier comment that
-- suggested it as an option).
DO $$
DECLARE
  v_chunk_count bigint;
BEGIN
  SELECT count(*) INTO v_chunk_count FROM public.sample_content_chunks;
  IF v_chunk_count > 10000 THEN
    RAISE EXCEPTION
      'sample_content_chunks has % rows — in-place GENERATED column ALTER would take a multi-minute ACCESS EXCLUSIVE lock and rebuild the HNSW index. See migration header for staged-migration alternatives. Run in a maintenance window or stage the migration.',
      v_chunk_count
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END $$;

-- text_search is a separate ALTER so the column add above completes before we
-- compute the GENERATED expression (Postgres needs the columns visible).
-- to_tsvector('english'::regconfig, text) is IMMUTABLE for the regconfig-typed
-- overload — required for GENERATED ... STORED.
--
-- Audit-4 small fix: avoid leading space when chunk_context is NULL.
-- `coalesce(chunk_context || ' ', '') || text` puts the space INSIDE the
-- coalesce so the NULL branch contributes nothing, not a stray ' '.
ALTER TABLE public.sample_content_chunks
  ADD COLUMN text_search tsvector
    GENERATED ALWAYS AS (
      to_tsvector('english'::regconfig,
        coalesce(chunk_context || ' ', '') || text)
    ) STORED;

CREATE INDEX sample_content_chunks_text_search_gin_idx
  ON public.sample_content_chunks USING gin (text_search);

CREATE INDEX sample_content_chunks_parent_unit_idx
  ON public.sample_content_chunks (parent_unit_id)
  WHERE parent_unit_id IS NOT NULL;

CREATE INDEX sample_content_chunks_chunker_version_idx
  ON public.sample_content_chunks (creator_id, chunker_version);

COMMENT ON COLUMN public.sample_content_chunks.parent_unit_id IS
  'Parent narrative unit for hierarchical retrieval. Child chunks embed precisely; on hit we pull this parent unit''s text and inject IT, not the child. NULL for chunker_version=1 (legacy chunks have no parent).';

COMMENT ON COLUMN public.sample_content_chunks.chunk_context IS
  'Anthropic-style 50-100 token contextual header generated per chunk before embedding. Prepended to chunk text in BOTH the embedding input AND the tsvector. NULL for chunker_version=1 (legacy chunks have no context header).';

COMMENT ON COLUMN public.sample_content_chunks.chunker_version IS
  '1 = legacy 300-token windows. 2 = narrative + contextual (RAG SOTA plan Phase 1). Default 1 keeps existing chunks intact during the v1→v2 reprocess migration.';


-- ── _insert_chunk_v2_unsafe ──────────────────────────────────────────────────
--
-- Single-write insert. Derives sample_id + creator_id server-side from the
-- parent unit row (audit-2 C1). Worker calls this once per chunk with all
-- fields filled in, so the GENERATED tsvector computes once instead of three
-- times (audit-2 M4).
--
-- Naming follows the existing convention: underscore prefix + _unsafe suffix
-- = "SECURITY DEFINER; trust derived from a single root ID. Service-role only."
-- (cf _creator_brain_compile_unsafe in 20260512000010.)

CREATE FUNCTION public._insert_chunk_v2_unsafe(
  p_parent_unit_id  uuid,
  p_chunk_index     int,
  p_text            text,
  p_chunk_context   text,
  p_token_count     int,
  p_topic_tags      text[],
  p_embedding       halfvec(768),
  p_embedding_model text DEFAULT 'gemini-embedding-001'
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_sample_id  uuid;
  v_creator_id uuid;
  v_chunk_id   uuid;
  v_bad        text[];
BEGIN
  -- Derive canonical IDs from the parent unit row. Audit-2 C1: callers do NOT
  -- supply sample_id or creator_id; the parent unit row is the single root.
  SELECT sample_id, creator_id INTO v_sample_id, v_creator_id
    FROM public.sample_content_narrative_units
   WHERE id = p_parent_unit_id;

  IF v_sample_id IS NULL THEN
    RAISE EXCEPTION USING errcode='42704', message='parent_unit_not_found';
  END IF;

  -- Audit-4 M1: verify topic_tags reference registered creator_topics slugs.
  -- sample_content has verify_sample_topic_slugs (20260420000013); chunks
  -- inserted via this RPC bypass that trigger because they're a separate
  -- table. Apply the same check here.
  SELECT array_agg(t) INTO v_bad
    FROM unnest(p_topic_tags) t
    WHERE NOT EXISTS (
      SELECT 1 FROM public.creator_topics
       WHERE creator_id = v_creator_id AND slug = t
    );
  IF v_bad IS NOT NULL AND cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION 'sample_content_chunks.topic_tags contains unregistered slugs: %', v_bad
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, chunk_context, token_count,
     topic_tags, embedding, embedding_model, embedded_at,
     parent_unit_id, chunker_version)
  VALUES
    (v_sample_id, v_creator_id, p_chunk_index, p_text, p_chunk_context,
     p_token_count, p_topic_tags, p_embedding, p_embedding_model, now(),
     p_parent_unit_id, 2)
  RETURNING id INTO v_chunk_id;

  RETURN v_chunk_id;
END;$$;

COMMENT ON FUNCTION public._insert_chunk_v2_unsafe(uuid, int, text, text, int, text[], halfvec(768), text) IS
  'Single-write insert for v2 chunks. Derives sample_id + creator_id from the parent narrative unit row — caller never supplies them (audit-2 C1 parameter-trust closure). Service-role only.';

REVOKE ALL ON FUNCTION public._insert_chunk_v2_unsafe(uuid, int, text, text, int, text[], halfvec(768), text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._insert_chunk_v2_unsafe(uuid, int, text, text, int, text[], halfvec(768), text)
  TO service_role;


-- ── Legacy creator_knowledge_topk: chunker_version=1 filter ──────────────────
--
-- Audit-3 C4: v3 plan deferred this filter to Phase 2 migration. That left a
-- 5-day window where re-processed v2 chunks would bleed into v1 retrieval
-- reads (masking whether v2 actually moved the needle). Fix: replace the v1
-- RPC in THIS migration, same transaction as the column ADD. From now on the
-- legacy RPC sees ONLY v1 chunks; v2 chunks sit invisibly until the new
-- creator_knowledge_topk_v2 RPC arrives in Phase 2.
--
-- Signature MUST match the existing function from 20260512000005 exactly
-- (CREATE OR REPLACE doesn't allow signature changes).

CREATE OR REPLACE FUNCTION public.creator_knowledge_topk(
  p_creator_id     uuid,
  p_query_vec      halfvec(768),
  p_k              int     DEFAULT 3,
  p_min_similarity numeric DEFAULT 0.55
) RETURNS TABLE (
  chunk_id    uuid,
  sample_id   uuid,
  text        text,
  source_type sample_source_type,
  similarity  numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH ranked AS (
    SELECT c.id AS chunk_id,
           c.sample_id,
           LEFT(c.text, 2000) AS text,
           s.source_type,
           (1 - (c.embedding <=> p_query_vec))::numeric AS similarity,
           md5(LEFT(c.text, 200)) AS dedup_key,
           c.embedding <=> p_query_vec AS dist
      FROM public.sample_content_chunks c
      JOIN public.sample_content s ON s.id = c.sample_id
     WHERE c.creator_id = p_creator_id
       AND c.chunker_version = 1                          -- audit-3 C4: v1-only
       AND c.embedding IS NOT NULL
       AND s.fetch_status <> 'errored'
       AND (1 - (c.embedding <=> p_query_vec)) >= GREATEST(p_min_similarity, 0.30)
     ORDER BY c.embedding <=> p_query_vec
     LIMIT LEAST(p_k, 5) * 4  -- pre-dedup overshoot
  )
  SELECT DISTINCT ON (dedup_key)
         chunk_id, sample_id, text, source_type, similarity
    FROM ranked
   ORDER BY dedup_key, dist
   LIMIT LEAST(p_k, 5);
$$;

COMMENT ON FUNCTION public.creator_knowledge_topk(uuid, halfvec(768), int, numeric) IS
  'Top-K vector retrieval over a creator''s v1 sample_content_chunks (chunker_version=1 only — audit-3 C4 freezes v1 reads at v1-only chunks even after Phase 1 re-process lands v2 chunks in the same table). Application-layer invariant: caller passes the verified creator_id captured at voice-ticket consume time. Service-role only. K hard-capped at 5; text truncated at 2000 chars server-side; duplicate-text passages deduped by md5 of first 200 chars.';

-- ACLs preserved from 20260512000005 (CREATE OR REPLACE keeps existing GRANTs,
-- but re-emit for defense-in-depth — matches the pattern in 20260511000003).
REVOKE ALL ON FUNCTION public.creator_knowledge_topk(uuid, halfvec(768), int, numeric)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.creator_knowledge_topk(uuid, halfvec(768), int, numeric)
  TO service_role;
