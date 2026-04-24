-- 0503-04 — user_creator_affinity (algo plan §3.2 migration 4, M7 + NM2)
--
-- Per-(user, creator) rollup. Maintained by the rollup trigger (migration
-- 6) on every event, plus an additional boost from the session-close trigger
-- (migration 7b) proportional to session duration — a 10-min conversation
-- is categorically different from a 10-second mic-tap that closed. The
-- mic_tap event records the INTENT (weight 2.0); session close records the
-- DEPTH (up to +1.5 for a 10-min session).
--
-- NM2: S_creator normalization uses MAX(affinity_score) dynamically, not a
-- hardcoded 5.0. After 2 sessions a heavy user accumulates ~7.0 (2× mic_tap
-- + 2× session boost) — fixed ceiling would saturate and lose resolution
-- permanently.

CREATE TABLE public.user_creator_affinity (
  user_id               uuid         NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  creator_id            uuid         NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  impressions           int          NOT NULL DEFAULT 0 CHECK (impressions           >= 0),
  full_opens            int          NOT NULL DEFAULT 0 CHECK (full_opens            >= 0),
  carousel_opens        int          NOT NULL DEFAULT 0 CHECK (carousel_opens        >= 0),
  mic_taps              int          NOT NULL DEFAULT 0 CHECK (mic_taps              >= 0),
  negatives             int          NOT NULL DEFAULT 0 CHECK (negatives             >= 0),
  total_session_seconds int          NOT NULL DEFAULT 0 CHECK (total_session_seconds >= 0),
  affinity_score        real         NOT NULL DEFAULT 0,
  last_event_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, creator_id)
);

CREATE INDEX user_creator_affinity_user_score_idx
  ON public.user_creator_affinity (user_id, affinity_score DESC);

-- RLS --------------------------------------------------------------------
ALTER TABLE public.user_creator_affinity ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_creator_affinity own read"
  ON public.user_creator_affinity FOR SELECT
  USING (user_id = auth.uid());

-- Grants -----------------------------------------------------------------
REVOKE ALL ON public.user_creator_affinity FROM PUBLIC, anon;
