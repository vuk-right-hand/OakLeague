-- 0031 — serialize the ≤5-topics-per-creator check (R2-M-η).
-- Without the lock, two concurrent INSERTs can each count 4 rows and both
-- succeed → creator ends up with 6 topics. pg_advisory_xact_lock keyed by
-- creator_id serializes the count+insert within the transaction.

CREATE OR REPLACE FUNCTION public.creator_topics_enforce_max_five() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('creator_topics:' || NEW.creator_id::text));
  SELECT count(*) INTO v_count
    FROM public.creator_topics
   WHERE creator_id = NEW.creator_id;
  IF v_count >= 5 THEN
    RAISE EXCEPTION 'creator % already has 5 topics (max)', NEW.creator_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;$$;
