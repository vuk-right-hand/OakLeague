-- 0503-05 — hook_global_stats (algo plan §3.2 migration 5)
--
-- Per-hook global quality signal. Populated by the rollup trigger
-- (migration 6) on positive events only (v_weight > 0). Laplace-smoothed
-- open-through-rate with a 3x mic_tap bonus — mic_tap is the north-star
-- event, so it weighs more than a full_video_open in the quality score.
--
-- Formula (maintained in the trigger):
--   global_quality = (1 + full_opens + 3*mic_taps) / (10 + impressions)
-- The +1/+10 smoothing prevents a single impression with a mic_tap from
-- producing a 100% quality score; brand-new hooks start at ~0.1 (prior)
-- and converge toward their true rate as data accumulates.

CREATE TABLE public.hook_global_stats (
  hook_id            uuid         PRIMARY KEY REFERENCES public.hooks(id) ON DELETE CASCADE,
  impressions        bigint       NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  full_opens         bigint       NOT NULL DEFAULT 0 CHECK (full_opens  >= 0),
  mic_taps           bigint       NOT NULL DEFAULT 0 CHECK (mic_taps    >= 0),
  avg_completion_pct real         NOT NULL DEFAULT 0 CHECK (avg_completion_pct BETWEEN 0 AND 1),
  global_quality     real         NOT NULL DEFAULT 0 CHECK (global_quality >= 0),
  last_event_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now()
);

-- Scorer's S_global path + anon feed's quality-order path both sort by
-- global_quality DESC.
CREATE INDEX hook_global_stats_quality_idx
  ON public.hook_global_stats (global_quality DESC);

-- RLS --------------------------------------------------------------------
-- Service-role only: authenticated readers see global_quality through the
-- feed_ranked_page RPC response (which is already scoped). Raw table stays
-- locked.
ALTER TABLE public.hook_global_stats ENABLE ROW LEVEL SECURITY;
-- No policies: zero authenticated/anon access.

-- Grants -----------------------------------------------------------------
REVOKE ALL ON public.hook_global_stats FROM PUBLIC, anon, authenticated;
-- service_role retains default privileges (used by the scorer RPC).
