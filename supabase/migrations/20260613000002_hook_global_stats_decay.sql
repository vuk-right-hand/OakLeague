-- 0613-02 — hook_global_stats time decay + slot-bucketed impression counters
-- (FEED_PRETRAFFIC_FIXES §2).
--
-- Problem: global_quality is a Laplace-smoothed all-time ratio with no decay
-- and no position attribution. Early winners lock in (rich-get-richer via
-- top-slot impressions) and dead hooks keep stale quality forever.
--
-- Fix, three parts:
--   (1) Decayed shadow counters (real) drive global_quality; raw bigint
--       counters stay untouched forever (analytics truth). Seeded equal to
--       raw at migration time, so quality values do not move on deploy.
--   (2) Rollup trigger maintains decayed counters in BOTH upsert arms
--       (audit C2: INSERT VALUES arm too, derived from the row's own values
--       — audit M-R2-1) and bumps slot buckets for EVERY non-skipped
--       hook_impression in a separate unconditional upsert (audit C3 —
--       outside the v_weight > 0 gate, which would bias position data).
--       Buckets are logging-only for a future position-bias correction;
--       NOT consumed by scoring. served_rank 0..2 ⇒ top3, else/missing ⇒
--       rest.
--   (3) Nightly pg_cron job multiplies decayed counters by pow(0.5, 1/30)
--       (30-day half-life at daily cadence) and recomputes global_quality.
--       This is a DISCRETIZED exponential decay: counters earned within the
--       last day take up to one day's decay (≤2.3%) early — documented
--       approximation (audit M-R2-5), no last_event_at gate (gating would
--       freeze decay on hot hooks). Dust < 0.01 floors to 0; dead hooks
--       drift to the 1/10 prior.
--
-- avg_completion_pct deliberately stays ALL-TIME raw (audit M4): it is a
-- content-health diagnostic, not a freshness signal. Revisit when the
-- position-bias correction lands (CLEANUP_BACKLOG).
--
-- VALUES-arm global_quality semantics change (documented): previously the
-- INSERT arm wrote literal 0 and quality first materialized on the second
-- event. Now the INSERT arm computes the Laplace value from the row's own
-- decayed values (impression-first ⇒ 1/11; open-first ⇒ 2/10). The laplace
-- pgTAP test asserts the post-second-event value (2/11) — unchanged.

-- ── (1) Columns + seed ─────────────────────────────────────────────────────

ALTER TABLE public.hook_global_stats
  ADD COLUMN impressions_decayed real   NOT NULL DEFAULT 0 CHECK (impressions_decayed >= 0),
  ADD COLUMN full_opens_decayed  real   NOT NULL DEFAULT 0 CHECK (full_opens_decayed  >= 0),
  ADD COLUMN mic_taps_decayed    real   NOT NULL DEFAULT 0 CHECK (mic_taps_decayed    >= 0),
  ADD COLUMN impressions_top3    bigint NOT NULL DEFAULT 0 CHECK (impressions_top3    >= 0),
  ADD COLUMN impressions_rest    bigint NOT NULL DEFAULT 0 CHECK (impressions_rest    >= 0);

-- One-shot continuity: decayed == raw at migration time ⇒ global_quality
-- unchanged on deploy. ADD COLUMN DEFAULT 0 guards hypothetical re-apply.
UPDATE public.hook_global_stats SET
  impressions_decayed = impressions,
  full_opens_decayed  = full_opens,
  mic_taps_decayed    = mic_taps;

-- ── (2) Rollup trigger ─────────────────────────────────────────────────────
-- Body verbatim 0504-05 (hardened casts intact) except the hook_global_stats
-- arm (decayed columns both arms + derived VALUES-arm global_quality) and the
-- new unconditional bucket upsert.

CREATE OR REPLACE FUNCTION public.feed_events_raw_rollup()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  HALF_LIFE_DAYS constant real := 14.0;
  v_hook_topic_tags text[];
  v_hook_creator_id uuid;
  v_creator_id uuid;
  v_tag    text;
  v_weight real;
  v_is_c5  boolean;
  v_completion_pct real;
BEGIN
  IF NEW.skipped_reason IS NOT NULL THEN RETURN NULL; END IF;

  v_hook_topic_tags := NULL;
  v_hook_creator_id := NULL;
  IF NEW.hook_id IS NOT NULL THEN
    SELECT h.topic_tags, v.creator_id
      INTO v_hook_topic_tags, v_hook_creator_id
      FROM public.hooks h
      JOIN public.videos v ON v.id = h.video_id
     WHERE h.id = NEW.hook_id;
  END IF;

  v_weight := public.compute_event_weight(NEW.event_name::text, NEW.payload);
  v_completion_pct := LEAST(1.0, GREATEST(0.0,
    COALESCE(public._jsonb_real(NEW.payload, 'completion_pct'), 0)
  ));

  IF v_hook_topic_tags IS NOT NULL THEN
    FOREACH v_tag IN ARRAY v_hook_topic_tags LOOP
      INSERT INTO public.user_topic_affinity AS t
        (user_id, topic_slug, impressions, dwell_ms_total, completions, full_opens,
         carousel_opens, mic_taps, negatives, affinity_score, last_event_at, updated_at)
      VALUES (
        NEW.user_id, v_tag,
        CASE WHEN NEW.event_name = 'hook_impression' THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_name = 'hook_dwell_end'
             THEN COALESCE(public._jsonb_int(NEW.payload, 'dwell_ms'), 0) ELSE 0 END,
        CASE WHEN NEW.event_name = 'hook_dwell_end' AND v_completion_pct >= 0.8
             THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_name = 'full_video_open' THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_name = 'creator_carousel_open' THEN 1 ELSE 0 END,
        CASE WHEN NEW.event_name = 'mic_tap'
              AND NEW.payload->>'mic_tap_outcome' = 'session_opened' THEN 1 ELSE 0 END,
        CASE WHEN v_weight < 0 THEN 1 ELSE 0 END,
        v_weight, NEW.created_at, NEW.created_at
      )
      ON CONFLICT (user_id, topic_slug) DO UPDATE SET
        impressions    = t.impressions    + EXCLUDED.impressions,
        dwell_ms_total = t.dwell_ms_total + EXCLUDED.dwell_ms_total,
        completions    = t.completions    + EXCLUDED.completions,
        full_opens     = t.full_opens     + EXCLUDED.full_opens,
        carousel_opens = t.carousel_opens + EXCLUDED.carousel_opens,
        mic_taps       = t.mic_taps       + EXCLUDED.mic_taps,
        negatives      = t.negatives      + EXCLUDED.negatives,
        affinity_score = (
          t.affinity_score
            * pow(0.5, EXTRACT(EPOCH FROM (NEW.created_at - t.last_event_at))
                       / (HALF_LIFE_DAYS * 86400))
          + v_weight
        ),
        last_event_at  = NEW.created_at,
        updated_at     = NEW.created_at;
    END LOOP;
  END IF;

  v_creator_id := COALESCE(v_hook_creator_id, NEW.creator_id);
  IF v_creator_id IS NOT NULL THEN
    INSERT INTO public.user_creator_affinity AS t
      (user_id, creator_id, impressions, full_opens, carousel_opens, mic_taps,
       negatives, affinity_score, last_event_at, updated_at, total_session_seconds)
    VALUES (
      NEW.user_id, v_creator_id,
      CASE WHEN NEW.event_name = 'hook_impression' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'full_video_open' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'creator_carousel_open' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'mic_tap'
            AND NEW.payload->>'mic_tap_outcome' = 'session_opened' THEN 1 ELSE 0 END,
      CASE WHEN v_weight < 0 THEN 1 ELSE 0 END,
      v_weight, NEW.created_at, NEW.created_at, 0
    )
    ON CONFLICT (user_id, creator_id) DO UPDATE SET
      impressions    = t.impressions    + EXCLUDED.impressions,
      full_opens     = t.full_opens     + EXCLUDED.full_opens,
      carousel_opens = t.carousel_opens + EXCLUDED.carousel_opens,
      mic_taps       = t.mic_taps       + EXCLUDED.mic_taps,
      negatives      = t.negatives      + EXCLUDED.negatives,
      affinity_score = (
        t.affinity_score
          * pow(0.5, EXTRACT(EPOCH FROM (NEW.created_at - t.last_event_at))
                     / (HALF_LIFE_DAYS * 86400))
        + v_weight
      ),
      last_event_at  = NEW.created_at,
      updated_at     = NEW.created_at;
  END IF;

  IF NEW.hook_id IS NOT NULL AND v_weight > 0 THEN
    INSERT INTO public.hook_global_stats AS g
      (hook_id, impressions, full_opens, mic_taps, avg_completion_pct,
       global_quality, last_event_at, updated_at, dwell_ends,
       impressions_decayed, full_opens_decayed, mic_taps_decayed)
    VALUES (
      NEW.hook_id,
      CASE WHEN NEW.event_name = 'hook_impression' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'full_video_open' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'mic_tap'
            AND NEW.payload->>'mic_tap_outcome' = 'session_opened'
           THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'hook_dwell_end' THEN v_completion_pct ELSE 0 END,
      -- audit C2 + M-R2-1: Laplace from THIS ROW's own values (decayed ==
      -- raw on first insert). Impression-first ⇒ 1/11; open-first ⇒ 2/10.
      (1 + CASE WHEN NEW.event_name = 'full_video_open' THEN 1 ELSE 0 END
         + 3 * CASE WHEN NEW.event_name = 'mic_tap'
                     AND NEW.payload->>'mic_tap_outcome' = 'session_opened'
                    THEN 1 ELSE 0 END)::real
      / (10 + CASE WHEN NEW.event_name = 'hook_impression' THEN 1 ELSE 0 END)::real,
      NEW.created_at, NEW.created_at,
      CASE WHEN NEW.event_name = 'hook_dwell_end' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'hook_impression' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'full_video_open' THEN 1 ELSE 0 END,
      CASE WHEN NEW.event_name = 'mic_tap'
            AND NEW.payload->>'mic_tap_outcome' = 'session_opened'
           THEN 1 ELSE 0 END
    )
    ON CONFLICT (hook_id) DO UPDATE SET
      impressions = g.impressions + EXCLUDED.impressions,
      full_opens  = g.full_opens  + EXCLUDED.full_opens,
      mic_taps    = g.mic_taps    + EXCLUDED.mic_taps,
      dwell_ends  = g.dwell_ends  + EXCLUDED.dwell_ends,
      impressions_decayed = g.impressions_decayed + EXCLUDED.impressions_decayed,
      full_opens_decayed  = g.full_opens_decayed  + EXCLUDED.full_opens_decayed,
      mic_taps_decayed    = g.mic_taps_decayed    + EXCLUDED.mic_taps_decayed,
      avg_completion_pct = CASE
        WHEN NEW.event_name = 'hook_dwell_end'
        THEN ((g.avg_completion_pct * g.dwell_ends) + v_completion_pct)
             / (g.dwell_ends + 1)
        ELSE g.avg_completion_pct
      END,
      -- Inputs are now the DECAYED sums (== raw until the first decay run).
      -- No ::real casts (baseline 0504-05 had them): *_decayed columns are
      -- already real, so the division is real. Do NOT "restore" int casts.
      global_quality = (1 + (g.full_opens_decayed + EXCLUDED.full_opens_decayed)
                          + 3 * (g.mic_taps_decayed + EXCLUDED.mic_taps_decayed))
                       / (10 + (g.impressions_decayed + EXCLUDED.impressions_decayed)),
      last_event_at  = NEW.created_at,
      updated_at     = NEW.created_at;
  END IF;

  -- audit C3: slot buckets count EVERY non-skipped impression, outside the
  -- v_weight > 0 gate (position data must not be filtered by outcome).
  -- Only the two bucket columns; everything else rides NOT NULL DEFAULTs
  -- when this arm creates the row (unreachable today: impressions weigh
  -- 0.02 > 0, so the arm above inserts first; ordering makes it moot).
  IF NEW.hook_id IS NOT NULL AND NEW.event_name = 'hook_impression' THEN
    INSERT INTO public.hook_global_stats AS g (hook_id, impressions_top3, impressions_rest)
    VALUES (
      NEW.hook_id,
      CASE WHEN public._jsonb_int(NEW.payload, 'served_rank') BETWEEN 0 AND 2
           THEN 1 ELSE 0 END,
      CASE WHEN COALESCE(public._jsonb_int(NEW.payload, 'served_rank'), 99) BETWEEN 0 AND 2
           THEN 0 ELSE 1 END
    )
    ON CONFLICT (hook_id) DO UPDATE SET
      impressions_top3 = g.impressions_top3 + EXCLUDED.impressions_top3,
      impressions_rest = g.impressions_rest + EXCLUDED.impressions_rest;
  END IF;

  IF v_weight >= 0.6
     OR (NEW.event_name = 'mic_tap'
         AND NEW.payload->>'mic_tap_outcome' = 'session_opened') THEN
    UPDATE public.profiles SET feed_regime = 'B'
     WHERE id = NEW.user_id AND feed_regime = 'A';

    v_is_c5 :=
         (NEW.event_name = 'hook_dwell_end' AND v_completion_pct >= 0.8)
      OR NEW.event_name = 'full_video_open'
      OR (NEW.event_name = 'mic_tap'
          AND NEW.payload->>'mic_tap_outcome' = 'session_opened');

    IF v_is_c5 THEN
      UPDATE public.profiles SET feed_regime = 'C'
       WHERE id = NEW.user_id AND feed_regime IN ('A', 'B');
    END IF;
  END IF;

  RETURN NULL;
END;$$;

REVOKE EXECUTE ON FUNCTION public.feed_events_raw_rollup() FROM PUBLIC;
-- No grants needed — trigger fires as the inserting role, no direct call path.

-- ── (3) Decay function + nightly cron ──────────────────────────────────────

CREATE FUNCTION public.hook_global_stats_decay() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  -- Multiplier inline as pow(0.5, 1.0/30.0) — never a hand-typed literal
  -- (audit S-R2-5). Dust < 0.01 floors to 0 so reals never underflow-drift.
  -- global_quality recomputed from the POST-decay values (SET expressions
  -- read the pre-UPDATE row, so the decay is repeated inside the formula).
  UPDATE public.hook_global_stats SET
    impressions_decayed = CASE WHEN impressions_decayed * pow(0.5, 1.0/30.0) < 0.01
                               THEN 0 ELSE impressions_decayed * pow(0.5, 1.0/30.0) END,
    full_opens_decayed  = CASE WHEN full_opens_decayed * pow(0.5, 1.0/30.0) < 0.01
                               THEN 0 ELSE full_opens_decayed * pow(0.5, 1.0/30.0) END,
    mic_taps_decayed    = CASE WHEN mic_taps_decayed * pow(0.5, 1.0/30.0) < 0.01
                               THEN 0 ELSE mic_taps_decayed * pow(0.5, 1.0/30.0) END,
    global_quality =
      (1 + (CASE WHEN full_opens_decayed * pow(0.5, 1.0/30.0) < 0.01
                 THEN 0 ELSE full_opens_decayed * pow(0.5, 1.0/30.0) END)
         + 3 * (CASE WHEN mic_taps_decayed * pow(0.5, 1.0/30.0) < 0.01
                     THEN 0 ELSE mic_taps_decayed * pow(0.5, 1.0/30.0) END))
      / (10 + (CASE WHEN impressions_decayed * pow(0.5, 1.0/30.0) < 0.01
                    THEN 0 ELSE impressions_decayed * pow(0.5, 1.0/30.0) END)),
    updated_at = now();
$$;

REVOKE ALL ON FUNCTION public.hook_global_stats_decay() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hook_global_stats_decay() TO service_role;

-- pg_cron registration — exact 20260425000003 pattern (unschedule-first,
-- DO/EXCEPTION so environments without pg_cron still land the migration).
DO $guard$
BEGIN
  PERFORM cron.unschedule('hook_global_stats_decay_daily');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$guard$;

DO $guard$
BEGIN
  PERFORM cron.schedule(
    'hook_global_stats_decay_daily',
    '47 3 * * *',
    $job$ SELECT public.hook_global_stats_decay() $job$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available; hook_global_stats_decay_daily not scheduled. Enable pg_cron in Supabase → Database → Extensions and re-run this migration.';
END;
$guard$;

NOTIFY pgrst, 'reload schema';
