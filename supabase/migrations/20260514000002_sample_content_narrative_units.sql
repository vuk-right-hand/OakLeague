-- 20260514000002 — sample_content_narrative_units.
--
-- M2 of RAG SOTA plan (docs/_planning/RAG_SOTA_PLAN.md §3).
--
-- Parent narrative units for hierarchical retrieval. The new chunker emits two
-- granularities per sample:
--   * narrative units (~500-800 tokens, this table) = "the twins story"
--     as a self-contained beat. These are what we INJECT into Gemini Live
--     at retrieval time.
--   * child chunks (~150-200 tokens, sample_content_chunks with chunker_version=2)
--     = finer-grained embedding units that retrieve precisely; each child has
--     parent_unit_id pointing here, and at hit-time we pull the parent and
--     inject IT, not the child.
--
-- This is the standard "small to retrieve, large to inject" hierarchical
-- retrieval pattern. The handoff doc calls it out as a Phase 1 deliverable.
--
-- Design:
--   * Same RLS shape as sample_content_chunks (own-read, service-role write).
--   * Token cap 2048 mirrors gemini-embedding-001's input ceiling — narrative
--     units aren't embedded themselves (children are), but keeping the cap
--     consistent avoids the "what if we later want to embed parents too" surprise.
--   * char_length cap 8000 same as children. Worst case Unicode-heavy unit
--     stays within Postgres TOAST efficient inline range.
--   * topic_tags inherits from parent sample (same propagation as children).
--   * title is the LLM-generated narrative-unit label ("The Twins Story",
--     "Why Sleep Beats Hustle"); becomes a soft context label inside the
--     injection envelope's L2 wrapper.

CREATE TABLE public.sample_content_narrative_units (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_id    uuid          NOT NULL REFERENCES public.sample_content(id) ON DELETE CASCADE,
  creator_id   uuid          NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  unit_index   int           NOT NULL CHECK (unit_index >= 0),
  title        text          NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  text         text          NOT NULL CHECK (char_length(text) BETWEEN 1 AND 8000),
  token_count  int           NOT NULL CHECK (token_count BETWEEN 1 AND 2048),
  topic_tags   text[]        NOT NULL CHECK (cardinality(topic_tags) >= 1),
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (sample_id, unit_index)
);

CREATE INDEX sample_content_narrative_units_creator_idx
  ON public.sample_content_narrative_units (creator_id);
CREATE INDEX sample_content_narrative_units_sample_idx
  ON public.sample_content_narrative_units (sample_id);
CREATE INDEX sample_content_narrative_units_topic_tags_gin_idx
  ON public.sample_content_narrative_units USING gin (topic_tags);

CREATE TRIGGER sample_content_narrative_units_touch_updated_at
  BEFORE UPDATE ON public.sample_content_narrative_units
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.sample_content_narrative_units ENABLE ROW LEVEL SECURITY;

-- Owning creator may read for dashboard visibility ("X of Y units indexed").
-- No INSERT/UPDATE/DELETE policy — service_role writes via the worker;
-- CASCADE on sample_content handles deletion.
CREATE POLICY "sample_content_narrative_units own read"
  ON public.sample_content_narrative_units FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.creators c
     WHERE c.id = creator_id AND c.user_id = auth.uid()
  ));

COMMENT ON TABLE public.sample_content_narrative_units IS
  'Parent narrative units for hierarchical retrieval. Children (sample_content_chunks.chunker_version=2) embed precisely; on hit we inject the parent unit (this table). LLM-generated title acts as soft context label inside the injection envelope.';


-- ── Slug verification trigger (audit-4 C4 / M1 fix) ──────────────────────────
--
-- Mirrors verify_sample_topic_slugs from 20260420000013:28-50. Without this,
-- a buggy worker could write narrative_units with topic_tags referencing
-- slugs not registered in creator_topics, and the orphaned tags would silently
-- shrink retrieval recall.

CREATE FUNCTION public.verify_narrative_unit_topic_slugs() RETURNS trigger
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
    RAISE EXCEPTION 'sample_content_narrative_units.topic_tags contains unregistered slugs: %', v_bad
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.verify_narrative_unit_topic_slugs() FROM public;

CREATE TRIGGER verify_narrative_unit_topic_slugs
  BEFORE INSERT OR UPDATE OF topic_tags, creator_id
  ON public.sample_content_narrative_units
  FOR EACH ROW EXECUTE FUNCTION public.verify_narrative_unit_topic_slugs();


-- ── Extend creator_topics orphan guards to cover narrative_units (audit-4 C4)
--
-- The two existing guards (slug-rename in 20260420000012:51-78 + slug-delete in
-- 20260512000013:31-59) check sample_content and hooks but not narrative_units.
-- Without this, slug rename / delete silently orphans narrative-unit tags.
-- We CREATE OR REPLACE both functions to add a third reference check.

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
    -- Audit-4 C4: extended to cover narrative_units.
    IF EXISTS (
      SELECT 1 FROM public.sample_content_narrative_units
       WHERE creator_id = OLD.creator_id AND OLD.slug = ANY(topic_tags)
    ) THEN
      RAISE EXCEPTION 'cannot rename slug % — referenced by sample_content_narrative_units.topic_tags', OLD.slug
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;$$;

CREATE OR REPLACE FUNCTION public.creator_topics_prevent_orphan_on_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- CASCADE-safety guard (preserved from 20260512000013). When the parent
  -- creator is already gone, this delete is part of CASCADE; child rows are
  -- about to be CASCADE-deleted too, so the orphan check would falsely block.
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
  -- Audit-4 C4: extended to cover narrative_units.
  IF EXISTS (
    SELECT 1 FROM public.sample_content_narrative_units
     WHERE creator_id = OLD.creator_id
       AND OLD.slug = ANY(topic_tags)
  ) THEN
    RAISE EXCEPTION 'topic_referenced_by_narrative_units'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;$$;
