-- 0016 — hooks
-- Vertical MP4 lessons (1-5 per video). topic_tags[] must be registered on
-- the parent video's creator.

CREATE TABLE public.hooks (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id          uuid         NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
  lesson_number     int          NOT NULL CHECK (lesson_number BETWEEN 1 AND 5),
  mux_playback_id   text         NOT NULL,
  duration_seconds  int          NOT NULL CHECK (duration_seconds > 0 AND duration_seconds <= 300),
  transcript        text         CHECK (transcript IS NULL OR char_length(transcript) <= 8192),
  caption           text         CHECK (caption IS NULL OR char_length(caption) <= 280),
  opening_prompt    text         CHECK (opening_prompt IS NULL OR char_length(opening_prompt) <= 500),
  question_seeds    jsonb        CHECK (question_seeds IS NULL OR octet_length(question_seeds::text) <= 8192),
  topic_tags        text[]       NOT NULL CHECK (cardinality(topic_tags) >= 1),
  published_at      timestamptz,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (video_id, lesson_number)
);

CREATE INDEX hooks_video_idx          ON public.hooks (video_id);
CREATE INDEX hooks_topic_tags_gin_idx ON public.hooks USING gin (topic_tags);
CREATE INDEX hooks_published_idx      ON public.hooks (published_at) WHERE published_at IS NOT NULL;

CREATE TRIGGER hooks_touch_updated_at
  BEFORE UPDATE ON public.hooks
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- topic_tags must match slugs on the parent video's creator.

CREATE FUNCTION public.verify_hook_topic_slugs() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_creator uuid;
  v_bad text[];
BEGIN
  SELECT creator_id INTO v_creator FROM public.videos WHERE id = NEW.video_id;
  IF v_creator IS NULL THEN
    RAISE EXCEPTION 'hooks.video_id % does not exist', NEW.video_id USING ERRCODE = '23503';
  END IF;
  SELECT array_agg(t) INTO v_bad
    FROM unnest(NEW.topic_tags) t
    WHERE NOT EXISTS (
      SELECT 1 FROM public.creator_topics
       WHERE creator_id = v_creator AND slug = t
    );
  IF v_bad IS NOT NULL AND cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION 'hooks.topic_tags contains unregistered slugs: %', v_bad
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.verify_hook_topic_slugs() FROM public;

CREATE TRIGGER verify_hook_topic_slugs
  BEFORE INSERT OR UPDATE OF topic_tags, video_id ON public.hooks
  FOR EACH ROW EXECUTE FUNCTION public.verify_hook_topic_slugs();

-- RLS ---------------------------------------------------------------------

ALTER TABLE public.hooks ENABLE ROW LEVEL SECURITY;

-- Public read iff parent video is published.
CREATE POLICY "hooks public read when parent published"
  ON public.hooks FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.videos v
     WHERE v.id = video_id AND v.published_at IS NOT NULL
  ));

-- Owning creator manages.
CREATE POLICY "hooks own all"
  ON public.hooks FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.videos v
     JOIN public.creators c ON c.id = v.creator_id
     WHERE v.id = video_id AND c.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.videos v
     JOIN public.creators c ON c.id = v.creator_id
     WHERE v.id = video_id AND c.user_id = auth.uid()
  ));
