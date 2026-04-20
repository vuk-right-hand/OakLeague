-- 0014 — videos
-- Topic container: one video = five lessons (hooks) on one topic.

CREATE TABLE public.videos (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id     uuid          NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  title          text          NOT NULL CHECK (char_length(title) <= 200),
  description    text          CHECK (description IS NULL OR char_length(description) <= 2000),
  thumbnail_url  text          CHECK (thumbnail_url IS NULL OR char_length(thumbnail_url) <= 500),
  lesson_count   int           NOT NULL DEFAULT 0 CHECK (lesson_count BETWEEN 0 AND 5),
  status         video_status  NOT NULL DEFAULT 'processing',
  published_at   timestamptz,
  created_at     timestamptz   NOT NULL DEFAULT now(),
  updated_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX videos_creator_idx   ON public.videos (creator_id);
CREATE INDEX videos_published_idx ON public.videos (published_at) WHERE published_at IS NOT NULL;

CREATE TRIGGER videos_touch_updated_at
  BEFORE UPDATE ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.videos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "videos public read when published"
  ON public.videos FOR SELECT
  USING (published_at IS NOT NULL);

CREATE POLICY "videos own all"
  ON public.videos FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.creators c
     WHERE c.id = creator_id AND c.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.creators c
     WHERE c.id = creator_id AND c.user_id = auth.uid()
  ));
