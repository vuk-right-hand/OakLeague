-- 0015 — welcome_hooks
-- First-open full-screen intro. Only one active row at a time (partial UNIQUE).
-- Must reference a video owned by the same creator.

CREATE TABLE public.welcome_hooks (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id        uuid         NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  video_id          uuid         REFERENCES public.videos(id) ON DELETE SET NULL,
  mux_playback_id   text         NOT NULL,
  duration_seconds  int          NOT NULL CHECK (duration_seconds > 0 AND duration_seconds <= 120),
  transcript        text         CHECK (transcript IS NULL OR char_length(transcript) <= 8192),
  active            boolean      NOT NULL DEFAULT false,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX welcome_hooks_single_active_idx
  ON public.welcome_hooks ((true))
  WHERE active = true;

CREATE TRIGGER welcome_hooks_touch_updated_at
  BEFORE UPDATE ON public.welcome_hooks
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- video must belong to the same creator as this welcome_hook.

CREATE FUNCTION public.welcome_hooks_video_same_creator() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_video_creator uuid;
BEGIN
  IF NEW.video_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT creator_id INTO v_video_creator FROM public.videos WHERE id = NEW.video_id;
  IF v_video_creator IS NULL OR v_video_creator <> NEW.creator_id THEN
    RAISE EXCEPTION 'welcome_hook.video_id belongs to creator %, not %', v_video_creator, NEW.creator_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.welcome_hooks_video_same_creator() FROM public;

CREATE TRIGGER welcome_hooks_video_same_creator
  BEFORE INSERT OR UPDATE OF video_id, creator_id ON public.welcome_hooks
  FOR EACH ROW EXECUTE FUNCTION public.welcome_hooks_video_same_creator();

ALTER TABLE public.welcome_hooks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "welcome_hooks public read when active"
  ON public.welcome_hooks FOR SELECT
  USING (active = true);

CREATE POLICY "welcome_hooks own all"
  ON public.welcome_hooks FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.creators c
     WHERE c.id = creator_id AND c.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.creators c
     WHERE c.id = creator_id AND c.user_id = auth.uid()
  ));
