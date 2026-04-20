-- 0028 — prevent two pending applications claiming the same handle (R2-C5).
-- Partial unique: only constrains while an application is awaiting review.
-- Rejected/approved rows are free to collide (the approval path promotes the
-- handle to creators and nulls the profile's copy; other pending apps would
-- then fail handle_taken in the creators_handle_sync path).

CREATE UNIQUE INDEX creator_applications_handle_pending_idx
  ON public.creator_applications (handle)
  WHERE status IN ('submitted', 'under_review');
