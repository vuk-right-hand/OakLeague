-- 20260512000013 — creator_topics orphan-guard CASCADE safety.
--
-- Bug: creator_topics_prevent_orphan_on_delete (migration 20260420000039) fires
-- on EVERY delete of creator_topics, including the implicit CASCADE chain when
-- a creator (or auth.users transitively) is deleted. The trigger queries
-- sample_content WHERE creator_id = OLD.creator_id, sees the still-living
-- sample rows (which WILL also be CASCADE-deleted in the same statement but
-- haven't been yet by the time the topic trigger fires), and raises
-- 'topic_referenced_by_sample_content'. The CASCADE aborts.
--
-- Impact:
--   * Blocks GDPR right-to-deletion today: DELETE FROM auth.users fails for
--     any account with a creator row that has both topics + samples.
--   * Blocks the future admin "delete creator" UI.
--   * Blocks test cleanup (surfaced 2026-05-12 by Spike #4 path 2's
--     auth.admin.deleteUser call returning "Database error deleting user").
--
-- Fix: at the top of the trigger, if the parent creator row no longer exists,
-- we're inside a CASCADE delete chain. In PostgreSQL's referential-integrity
-- CASCADE, the parent row is removed before child triggers fire on that
-- parent's children. So EXISTS(creators...) returns false specifically when
-- we're in CASCADE territory — which is exactly when we want to skip the
-- orphan check, because sample_content/hooks rows are also about to be
-- CASCADE-deleted in the same statement; the orphans cannot actually exist.
--
-- Explicit "delete a single topic" admin actions still work: the parent
-- creator row still exists at trigger-fire time, EXISTS returns true, the
-- orphan check runs normally and blocks the delete if samples/hooks still
-- reference the slug.

CREATE OR REPLACE FUNCTION public.creator_topics_prevent_orphan_on_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- CASCADE-safety guard. When the parent creator is already gone, this
  -- delete is part of CASCADE; sample_content/hooks rows will also be
  -- deleted in the same statement, so the "orphan" the trigger guards
  -- against cannot actually exist after the statement settles.
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
  RETURN OLD;
END;$$;

-- Grants/REVOKE inherited from the original CREATE FUNCTION in 0039.
