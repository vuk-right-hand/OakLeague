-- 0503-03 — user_topic_affinity (algo plan §3.2 migration 3, M6 signed EMA)
--
-- Per-(user, topic_slug) rollup. Maintained by the rollup trigger
-- (migration 6) AFTER INSERT on feed_events_raw. affinity_score is the
-- time-decayed signed EMA that drives S_topic in feed_ranked_page.
--
-- Signed: negative-weight events (fast-dismiss swipes, M6) push the score
-- below zero. The scorer clamps the low end at -0.5 so one bad session
-- can't permanently crater a topic. last_event_at anchors the 14-day
-- half-life decay applied at each ON CONFLICT UPDATE (trigger body).

CREATE TABLE public.user_topic_affinity (
  user_id         uuid         NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  topic_slug      text         NOT NULL CHECK (char_length(topic_slug) BETWEEN 1 AND 40),
  impressions     int          NOT NULL DEFAULT 0 CHECK (impressions    >= 0),
  dwell_ms_total  bigint       NOT NULL DEFAULT 0 CHECK (dwell_ms_total >= 0),
  completions     int          NOT NULL DEFAULT 0 CHECK (completions    >= 0),
  full_opens      int          NOT NULL DEFAULT 0 CHECK (full_opens     >= 0),
  carousel_opens  int          NOT NULL DEFAULT 0 CHECK (carousel_opens >= 0),
  mic_taps        int          NOT NULL DEFAULT 0 CHECK (mic_taps       >= 0),
  negatives       int          NOT NULL DEFAULT 0 CHECK (negatives      >= 0),
  -- Signed EMA; can go negative. Clamped at the scorer, not here.
  affinity_score  real         NOT NULL DEFAULT 0,
  last_event_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic_slug)
);

-- Scorer hits (user_id, topic_slug) via the PK on every feed call and
-- additionally sorts by affinity_score for top-N in the admin surface.
CREATE INDEX user_topic_affinity_user_score_idx
  ON public.user_topic_affinity (user_id, affinity_score DESC);

-- RLS --------------------------------------------------------------------
ALTER TABLE public.user_topic_affinity ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_topic_affinity own read"
  ON public.user_topic_affinity FOR SELECT
  USING (user_id = auth.uid());

-- No INSERT/UPDATE policies: rollup trigger (SECURITY DEFINER, migration 6)
-- owns writes. merge_anon_feed_state (migration 0) also writes via
-- SECURITY DEFINER.

-- Grants -----------------------------------------------------------------
REVOKE ALL ON public.user_topic_affinity FROM PUBLIC, anon;
-- authenticated keeps default SELECT grant; RLS narrows to own-row.
