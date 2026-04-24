-- 0503-07b — session-close creator-affinity boost (algo plan §3.2 migration 7b, M7)
--
-- Fires AFTER UPDATE OF status on sessions when the transition is
-- non-terminal → terminal (ended / errored) and active_seconds >= 30.
-- Boosts user_creator_affinity proportional to active_seconds, capped at
-- 10 minutes = +1.5 affinity. On top of the 2.0 the mic_tap event wrote,
-- a 10-min conversation accumulates ~3.5 creator affinity — well above
-- passive-scroll activity.
--
-- Guarded against double-firing: OLD.status must be non-terminal. A row
-- updated from ended → ended still fires the trigger (OF status applies
-- whenever the column appears in the UPDATE's target list, even on same-
-- value writes), so the OLD.status check is load-bearing.

CREATE OR REPLACE FUNCTION public.sessions_creator_affinity_on_close()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  HALF_LIFE_DAYS    constant real := 14.0;
  MAX_BOOST_SECONDS constant int  := 600;   -- 10 minutes
  MAX_BOOST         constant real := 1.5;   -- max affinity delta per session
  v_duration_boost real;
BEGIN
  -- Only fire on the first non-terminal → terminal transition with
  -- meaningful conversation.
  IF NEW.status NOT IN ('ended', 'errored') THEN RETURN NULL; END IF;
  IF OLD.status IN ('ended', 'errored')     THEN RETURN NULL; END IF;
  IF COALESCE(NEW.active_seconds, 0) < 30   THEN RETURN NULL; END IF;
  IF NEW.creator_id IS NULL                 THEN RETURN NULL; END IF;

  -- Linear proportional to active_seconds, capped at MAX_BOOST.
  v_duration_boost :=
    LEAST(NEW.active_seconds, MAX_BOOST_SECONDS)::real
      / MAX_BOOST_SECONDS::real
      * MAX_BOOST;

  -- Upsert; apply decay on the existing score the same way the rollup
  -- trigger does, so consecutive boosts feel natural against time-decayed
  -- history.
  INSERT INTO public.user_creator_affinity AS t
    (user_id, creator_id, affinity_score, last_event_at, updated_at,
     total_session_seconds, impressions, full_opens, carousel_opens, mic_taps, negatives)
  VALUES (
    NEW.user_id, NEW.creator_id,
    v_duration_boost, now(), now(),
    NEW.active_seconds, 0, 0, 0, 0, 0
  )
  ON CONFLICT (user_id, creator_id) DO UPDATE SET
    total_session_seconds = t.total_session_seconds + EXCLUDED.total_session_seconds,
    affinity_score = (
      t.affinity_score
        * pow(0.5, EXTRACT(EPOCH FROM (now() - t.last_event_at))
                   / (HALF_LIFE_DAYS * 86400))
      + EXCLUDED.affinity_score
    ),
    last_event_at = now(),
    updated_at    = now();

  RETURN NULL;
END;$$;

REVOKE EXECUTE ON FUNCTION public.sessions_creator_affinity_on_close() FROM PUBLIC;

CREATE TRIGGER sessions_creator_affinity_on_close
  AFTER UPDATE OF status ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.sessions_creator_affinity_on_close();
