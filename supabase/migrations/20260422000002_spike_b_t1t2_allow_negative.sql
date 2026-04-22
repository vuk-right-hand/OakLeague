-- 0047 — Spike B: widen t1_t2_ms CHECK to allow negative values.
--
-- Simli (livekit transport) streams a standby/idle animation frame as soon as
-- the session connects — before any audio is sent. This means t2 (first video
-- frame) is captured before t1 (first audio sent), making t1_t2_ms negative.
-- Negative t1t2 = "video started before audio", which is valid data for the
-- spike analysis (shows provider pre-streams vs waits for audio).

ALTER TABLE public.spike_b_runs
  DROP CONSTRAINT IF EXISTS spike_b_runs_t1_t2_ms_check;

ALTER TABLE public.spike_b_runs
  ADD CONSTRAINT spike_b_runs_t1_t2_ms_check
    CHECK (t1_t2_ms IS NULL OR (t1_t2_ms >= -120000 AND t1_t2_ms <= 120000));
