-- 0013 — sample_content
-- Topic drawer content. topic_tags[] must be non-empty and every element
-- must be a registered slug on the creator's topics (verify_sample_topic_slugs).

CREATE TABLE public.sample_content (
  id           uuid                 PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id   uuid                 NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  source_type  sample_source_type   NOT NULL,
  title        text                 CHECK (title IS NULL OR char_length(title) <= 200),
  source_url   text                 CHECK (source_url IS NULL OR char_length(source_url) <= 2048),
  raw_text     text                 CHECK (raw_text IS NULL OR char_length(raw_text) <= 262144),
  topic_tags   text[]               NOT NULL CHECK (cardinality(topic_tags) >= 1),
  fetch_status brain_status         NOT NULL DEFAULT 'pending',
  fetched_at   timestamptz,
  created_at   timestamptz          NOT NULL DEFAULT now(),
  updated_at   timestamptz          NOT NULL DEFAULT now()
);

CREATE INDEX sample_content_creator_idx ON public.sample_content (creator_id);
CREATE INDEX sample_content_topic_tags_gin_idx ON public.sample_content USING gin (topic_tags);

CREATE TRIGGER sample_content_touch_updated_at
  BEFORE UPDATE ON public.sample_content
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Verify every topic_tag is a registered slug on the same creator.

CREATE FUNCTION public.verify_sample_topic_slugs() RETURNS trigger
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
    RAISE EXCEPTION 'sample_content.topic_tags contains unregistered slugs: %', v_bad
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.verify_sample_topic_slugs() FROM public;

CREATE TRIGGER verify_sample_topic_slugs
  BEFORE INSERT OR UPDATE OF topic_tags, creator_id ON public.sample_content
  FOR EACH ROW EXECUTE FUNCTION public.verify_sample_topic_slugs();

-- RLS ---------------------------------------------------------------------

ALTER TABLE public.sample_content ENABLE ROW LEVEL SECURITY;

-- Owning creator may read / manage. Not public.
CREATE POLICY "sample_content own all"
  ON public.sample_content FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.creators c
     WHERE c.id = creator_id AND c.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.creators c
     WHERE c.id = creator_id AND c.user_id = auth.uid()
  ));
