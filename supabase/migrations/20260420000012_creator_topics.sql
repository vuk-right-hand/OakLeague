-- 0012 — creator_topics
-- Up to 5 topic drawers per creator. Slug is immutable once referenced by
-- sample_content / hooks (orphan-prevention trigger on UPDATE of slug).

CREATE TABLE public.creator_topics (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id  uuid         NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  slug        text         NOT NULL CHECK (
                             char_length(slug) BETWEEN 2 AND 40
                             AND slug ~ '^[a-z0-9_-]+$'
                           ),
  title       text         NOT NULL CHECK (char_length(title) <= 100),
  description text         CHECK (description IS NULL OR char_length(description) <= 500),
  sort_order  int          NOT NULL DEFAULT 0,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (creator_id, slug)
);

CREATE INDEX creator_topics_creator_idx ON public.creator_topics (creator_id, sort_order);

CREATE TRIGGER creator_topics_touch_updated_at
  BEFORE UPDATE ON public.creator_topics
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Enforce ≤ 5 topics per creator at insert time.

CREATE FUNCTION public.creator_topics_enforce_max_five() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.creator_topics
    WHERE creator_id = NEW.creator_id;
  IF v_count >= 5 THEN
    RAISE EXCEPTION 'creator % already has 5 topics (max)', NEW.creator_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.creator_topics_enforce_max_five() FROM public;

CREATE TRIGGER creator_topics_enforce_max_five
  BEFORE INSERT ON public.creator_topics
  FOR EACH ROW EXECUTE FUNCTION public.creator_topics_enforce_max_five();

-- Prevent slug rename if other rows reference it via topic_tags[].

CREATE FUNCTION public.creator_topics_prevent_orphan_slugs() RETURNS trigger
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
  END IF;
  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.creator_topics_prevent_orphan_slugs() FROM public;

CREATE TRIGGER creator_topics_prevent_orphan_slugs
  BEFORE UPDATE OF slug ON public.creator_topics
  FOR EACH ROW EXECUTE FUNCTION public.creator_topics_prevent_orphan_slugs();

-- RLS ---------------------------------------------------------------------

ALTER TABLE public.creator_topics ENABLE ROW LEVEL SECURITY;

-- Read-public iff parent creator is published.
CREATE POLICY "creator_topics public read when parent published"
  ON public.creator_topics FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.creators c
     WHERE c.id = creator_id
       AND c.published_at IS NOT NULL
       AND c.creator_type = 'human'
  ));

-- Owning creator may read / manage their own topics.
CREATE POLICY "creator_topics own all"
  ON public.creator_topics FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.creators c
     WHERE c.id = creator_id AND c.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.creators c
     WHERE c.id = creator_id AND c.user_id = auth.uid()
  ));
