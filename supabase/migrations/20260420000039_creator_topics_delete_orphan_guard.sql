-- 0039 — creator_topics BEFORE DELETE orphan guard
-- Closes the race where a concurrent addSampleContent (tab B) slips in
-- between an app-level pre-check and DELETE (tab A). App layer still
-- pre-checks for a friendly error path; this trigger is the correctness wall.
-- Pattern mirrors creator_topics_prevent_orphan_slugs (0012) — plain plpgsql,
-- no SECURITY DEFINER (owner-policy RLS already gated the DELETE), REVOKE public.

CREATE FUNCTION public.creator_topics_prevent_orphan_on_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
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
  RETURN OLD;
END;$$;

REVOKE EXECUTE ON FUNCTION public.creator_topics_prevent_orphan_on_delete() FROM public;

CREATE TRIGGER creator_topics_prevent_orphan_on_delete
  BEFORE DELETE ON public.creator_topics
  FOR EACH ROW EXECUTE FUNCTION public.creator_topics_prevent_orphan_on_delete();
