-- 20260528000010 — sample_content_sections (RAG v3 Step 3 / plan §4 item 1).
--
-- The Section level v3 adds between Document and Narrative-Unit in the
-- retrieval hierarchy (plan §2.1):
--
--   Document (sample_content)
--     └─ Section  (THIS TABLE)             ← title + summary + routing vectors
--          └─ Narrative Unit (existing)     ← INJECT granularity
--               └─ Child Chunk (chunks v3)  ← EMBED / RETRIEVE granularity
--
-- Two roles per Section, both load-bearing:
--
--   INGESTION (fixes Wall A from plan §0 #1): the per-section Flash call
--   processes ONE section at a time — bounded input, bounded output — so
--   a book-scale doc never blows the chunker. char_start / char_end pin
--   each section to an absolute span of the (CRLF-normalized) source so
--   per-section idempotent re-embed (audit C5) has a stable identity:
--   crash at section 200/400 of a book costs ONE section's re-pay, not
--   the whole book.
--
--   RETRIEVAL (fixes Wall B from plan §0 #2): summary_embedding +
--   centroid_embedding are the routing targets for
--   creator_route_sections_v3 (Step 5). Caller queries cosine against
--   BOTH and takes max — so a section wins on either signal (topical
--   words via summary, distribution via length-weighted child centroid).
--
-- title + summary land via the per-section narrative-chunk Flash call
-- (`narrative-chunk.ts` extension in Step 4); summary_embedding via the
-- gemini-embedding-001 RETRIEVAL_DOCUMENT call on (title + ' ' + summary);
-- centroid_embedding is a $0 length-weighted mean of the section's child
-- embeddings, computed bottom-up after children land (audit M1: normalize
-- each child halfvec to unit norm BEFORE the mean, renormalize the result,
-- then store — gemini-embedding-001 at outputDimensionality=768 Matryoshka
-- is not guaranteed unit-norm + halfvec is ~3-4 sig digits).
--
-- topic_tags propagates from the parent sample (plan §13 R3-small) so
-- the worker's NOT-NULL ≥1 check never trips on an auto-segmented
-- section that has no inherent tags of its own.
--
-- chunker_version = 3 sits on every section row for consistency with the
-- v3 chunks chunker_version=3 + the existing freeze pattern (one writer
-- per version, one reader per version, no mixing).
--
-- RLS shape mirrors sample_content_narrative_units exactly: own-read for
-- the owning creator, service-role write, no INSERT/UPDATE/DELETE policy.
-- Slug-verify trigger mirrors verify_narrative_unit_topic_slugs. The
-- creator_topics orphan-rename and orphan-delete guards extend to cover
-- this table (plan §4 item 1: "mirror sample_content_narrative_units.sql
-- exactly — do not skip, that's the documented trap").
--
-- HNSW indexes use halfvec_cosine_ops (matches the existing chunk index).
-- v1-scale per-creator section count is small (~30-80 sections per book ×
-- few creators), but seq-scan over cosine defeats the routing layer's
-- sub-millisecond purpose at any scale; index from day one.

CREATE TABLE public.sample_content_sections (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_id            uuid          NOT NULL REFERENCES public.sample_content(id) ON DELETE CASCADE,
  creator_id           uuid          NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  section_index        int           NOT NULL CHECK (section_index >= 0),
  title                text          NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  summary              text          NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  -- Embeddings start NULL: worker INSERTs the row when narrative-chunk
  -- Flash returns the section's title+summary; populates summary_embedding
  -- after the per-section embed call; populates centroid_embedding after
  -- all child chunks for the section land. A section row with NULL on
  -- both embeddings is a worker-in-flight signal; creator_v3_ready (plan
  -- §6) rejects creators whose sections have NULL embeddings, blocking
  -- prod-flip until ingest is genuinely complete.
  summary_embedding    halfvec(768)  NULL,
  centroid_embedding   halfvec(768)  NULL,
  char_start           int           NOT NULL CHECK (char_start >= 0),
  char_end             int           NOT NULL CHECK (char_end >= char_start),
  topic_tags           text[]        NOT NULL CHECK (cardinality(topic_tags) >= 1),
  -- Kept for symmetry with sample_content_chunks.chunker_version — sections
  -- are v3-only by construction, so the CHECK is dead-weight but the column
  -- makes "what chunker version produced this section" greppable from a row
  -- inspection without joining back through chunks (audit round-4 S1).
  chunker_version      smallint      NOT NULL DEFAULT 3 CHECK (chunker_version = 3),
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (sample_id, section_index)
);

CREATE INDEX sample_content_sections_creator_idx
  ON public.sample_content_sections (creator_id);
CREATE INDEX sample_content_sections_sample_idx
  ON public.sample_content_sections (sample_id);
CREATE INDEX sample_content_sections_topic_tags_gin_idx
  ON public.sample_content_sections USING gin (topic_tags);

-- HNSW indexes on BOTH embeddings (plan §4 item 1). Routing RPC scores
-- each section = max(cos(query, summary), cos(query, centroid)) so both
-- need to be index-pushdown-friendly. m=16 / ef_construction=64 matches
-- the existing chunks HNSW from 20260512000003 — same workload shape.
-- WHERE … IS NOT NULL keeps the index lean during the brief NULL-embedding
-- window between section INSERT and embed completion.
--
-- ROUTING-RPC INVARIANT (step 5 / audit round-4 M3): the partial WHERE
-- requires the caller's query to TEXTUALLY include `summary_embedding IS
-- NOT NULL` (and same for centroid_embedding) for the planner to pick the
-- partial index. PG 15 does NOT infer non-NULL from `<=> $vec`. The step-5
-- creator_route_sections_v3 RPC MUST add both predicates in its WHERE; its
-- pgTAP MUST EXPLAIN-assert "Index Scan using ..._hnsw_idx" not "Seq Scan."
CREATE INDEX sample_content_sections_summary_embedding_hnsw_idx
  ON public.sample_content_sections
  USING hnsw (summary_embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE summary_embedding IS NOT NULL;

CREATE INDEX sample_content_sections_centroid_embedding_hnsw_idx
  ON public.sample_content_sections
  USING hnsw (centroid_embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE centroid_embedding IS NOT NULL;

CREATE TRIGGER sample_content_sections_touch_updated_at
  BEFORE UPDATE ON public.sample_content_sections
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.sample_content_sections ENABLE ROW LEVEL SECURITY;

-- Owning creator may read for dashboard visibility ("X sections / Y units
-- across Z chunks indexed for this sample"). No INSERT/UPDATE/DELETE
-- policy — service_role writes via the v3 worker; CASCADE handles deletion.
CREATE POLICY "sample_content_sections own read"
  ON public.sample_content_sections FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.creators c
     WHERE c.id = creator_id AND c.user_id = auth.uid()
  ));

COMMENT ON TABLE public.sample_content_sections IS
  'v3 routing layer between Document and Narrative-Unit. INGESTION: bounded per-section Flash call (fixes Wall A); char_start/char_end pin idempotent re-embed (audit C5). RETRIEVAL: summary_embedding + centroid_embedding are the routing targets for creator_route_sections_v3; caller takes max cosine across both so a section wins on either signal. topic_tags inherits from parent sample. chunker_version frozen at 3.';

COMMENT ON COLUMN public.sample_content_sections.char_start IS
  'Absolute char offset (inclusive) in the CRLF-normalized sample.raw_text. Produced by section-segment.ts. Load-bearing for the audit-C5 resume path — re-embed targets the same char span byte-identically.';

COMMENT ON COLUMN public.sample_content_sections.char_end IS
  'Absolute char offset (exclusive) in the CRLF-normalized sample.raw_text. char_end > char_start strictly enforced.';

COMMENT ON COLUMN public.sample_content_sections.summary_embedding IS
  'gemini-embedding-001 RETRIEVAL_DOCUMENT vector of (title || '' '' || summary). NULL during the brief worker-in-flight window between section INSERT and embed completion. NOT NULL is enforced by the creator_v3_ready check (plan §6) gating the retrieval_version flip.';

COMMENT ON COLUMN public.sample_content_sections.centroid_embedding IS
  'Length-weighted mean of the section''s child chunk embeddings, computed bottom-up after children land. Audit M1: each child halfvec is normalized to unit norm BEFORE the mean, the result renormalized, then stored. NULL during worker-in-flight.';

-- ── Slug verification trigger (mirror narrative_units, audit-4 C4 / M1) ──
CREATE FUNCTION public.verify_section_topic_slugs() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_bad text[];
BEGIN
  SELECT array_agg(t) INTO v_bad
    FROM unnest(NEW.topic_tags) t
    WHERE NOT EXISTS (
      SELECT 1 FROM public.creator_topics
       WHERE creator_id = NEW.creator_id AND slug = t
    );
  IF v_bad IS NOT NULL AND cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION 'sample_content_sections.topic_tags contains unregistered slugs: %', v_bad
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.verify_section_topic_slugs() FROM public;

CREATE TRIGGER verify_section_topic_slugs
  BEFORE INSERT OR UPDATE OF topic_tags, creator_id
  ON public.sample_content_sections
  FOR EACH ROW EXECUTE FUNCTION public.verify_section_topic_slugs();

-- ── Extend creator_topics orphan guards to cover sections ────────────────
-- Mirrors the audit-4 C4 extension narrative_units made. Without these,
-- slug rename / delete silently orphans section topic_tags.
CREATE OR REPLACE FUNCTION public.creator_topics_prevent_orphan_slugs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS DISTINCT FROM OLD.slug THEN
    IF EXISTS (
      SELECT 1 FROM public.sample_content
       WHERE creator_id = OLD.creator_id AND OLD.slug = ANY(topic_tags)
    ) THEN
      RAISE EXCEPTION 'cannot rename slug % — referenced by sample_content.topic_tags', OLD.slug
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.hooks h
       JOIN public.videos v ON v.id = h.video_id
       WHERE v.creator_id = OLD.creator_id AND OLD.slug = ANY(h.topic_tags)
    ) THEN
      RAISE EXCEPTION 'cannot rename slug % — referenced by hooks.topic_tags', OLD.slug
        USING ERRCODE = 'check_violation';
    END IF;
    -- Audit-4 C4 (existing): narrative_units.
    IF EXISTS (
      SELECT 1 FROM public.sample_content_narrative_units
       WHERE creator_id = OLD.creator_id AND OLD.slug = ANY(topic_tags)
    ) THEN
      RAISE EXCEPTION 'cannot rename slug % — referenced by sample_content_narrative_units.topic_tags', OLD.slug
        USING ERRCODE = 'check_violation';
    END IF;
    -- v3 step 3 (NEW): sections.
    IF EXISTS (
      SELECT 1 FROM public.sample_content_sections
       WHERE creator_id = OLD.creator_id AND OLD.slug = ANY(topic_tags)
    ) THEN
      RAISE EXCEPTION 'cannot rename slug % — referenced by sample_content_sections.topic_tags', OLD.slug
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;$$;

CREATE OR REPLACE FUNCTION public.creator_topics_prevent_orphan_on_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- CASCADE-safety guard (preserved from 20260512000013 / narrative_units).
  IF NOT EXISTS (SELECT 1 FROM public.creators WHERE id = OLD.creator_id) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sample_content
     WHERE creator_id = OLD.creator_id
       AND OLD.slug = ANY(topic_tags)
  ) THEN
    RAISE EXCEPTION 'topic_referenced_by_sample_content'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.hooks h
     JOIN public.videos v ON v.id = h.video_id
     WHERE v.creator_id = OLD.creator_id AND OLD.slug = ANY(h.topic_tags)
  ) THEN
    RAISE EXCEPTION 'topic_referenced_by_hooks'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Audit-4 C4 (existing): narrative_units.
  IF EXISTS (
    SELECT 1 FROM public.sample_content_narrative_units
     WHERE creator_id = OLD.creator_id
       AND OLD.slug = ANY(topic_tags)
  ) THEN
    RAISE EXCEPTION 'topic_referenced_by_narrative_units'
      USING ERRCODE = 'check_violation';
  END IF;
  -- v3 step 3 (NEW): sections.
  IF EXISTS (
    SELECT 1 FROM public.sample_content_sections
     WHERE creator_id = OLD.creator_id
       AND OLD.slug = ANY(topic_tags)
  ) THEN
    RAISE EXCEPTION 'topic_referenced_by_sections'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;$$;

-- ── Explicit table privileges (CLAUDE.md rule, ff7bb11 — Supabase removed
--    default-grant 2026-10-30; new tables MUST grant explicitly or the
--    admin client hits permission_denied on .from() calls). Pattern mirrors
--    semantic_query_cache (20260521000003:129-130) — REVOKE ALL FROM the
--    three groups FIRST so default PUBLIC inheritance doesn't leak SELECT
--    to anon, THEN grant exactly what each role needs. RLS still gates
--    per-row visibility on top. ────────────────────────────────────────
REVOKE ALL   ON TABLE public.sample_content_sections FROM public, anon, authenticated;
GRANT  ALL   ON TABLE public.sample_content_sections TO service_role;
GRANT  SELECT ON TABLE public.sample_content_sections TO authenticated;
