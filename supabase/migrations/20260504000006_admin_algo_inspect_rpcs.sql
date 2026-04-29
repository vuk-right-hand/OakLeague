-- 0504-06 — admin algo inspector RPCs (D6 — "Why this hook?" debugger)
--
-- Adds 7 SECURITY DEFINER RPCs + 1 private narrative helper, all gated on
-- the canonical admin predicate (admin_roles WHERE user_id = auth.uid()
-- AND revoked_at IS NULL). Each RPC is documented in
-- docs/_planning/ADMIN_ALGO_INSPECTOR.md §1.
--
-- Audit-row pattern: state-changing actions (the "Why this hook?" click and
-- the page-load) write a single audit row; the read-only fan-out RPCs
-- (top_topics / top_creators / funnel / recent_events / user_summary) do
-- NOT audit per-call — the page-scoped admin_algo_log_inspector_view is the
-- single point of trace for an inspector session. Multi-event sessions
-- group via after->>'session_correlation_id' (minted server-side in the
-- page render and reused for the explain RPC).
--
-- Failure mode: hook_not_found raises P0002 and rolls back the audit row.
-- Matches admin_set_profile_tier:71 / admin_force_close_session:167.
-- Forensic visibility into probes is deliberately out of scope for v1; if
-- needed later, a separate access-log table with autonomous-transaction
-- writes (dblink) is the right home — not a widening of admin_audit_log.
--
-- Scorer regime-agnosticism note: compute_hook_score (0503-10:51,187) takes
-- p_regime as an echo-only parameter; it does NOT branch on regime in v1.
-- This explainer always passes 'C' to compute_hook_score; the user's actual
-- profiles.feed_regime is surfaced in the response envelope as an
-- informational label and in the narrative as a tail clause for A/B users.
-- When v2 introduces regime-specific scoring, this explainer extends.

-- ─────────────────────────────────────────────────────────────────────────
-- Private helper: narrative formatter
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._admin_algo_narrative_from_breakdown(
  p_breakdown        jsonb,
  p_served_slot_zero int,
  p_streak           int,
  p_regime_label     text
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT
    -- Lead clause: 1-indexed slot for human readability.
    CASE
      WHEN p_served_slot_zero IS NULL
        THEN 'Hook not yet served to this user — '
      ELSE format('Shown in slot #%s — ', (p_served_slot_zero + 1)::text)
    END
    ||
    -- Body: empty-state vs topic match vs negative topic vs new topic.
    -- format() supports only %s/%I/%L — no printf-style %.Nf. Numeric
    -- values are rounded via to_char and passed as %s.
    CASE
      WHEN COALESCE((p_breakdown->'components'->>'S_topic')::real,   0) <= 0.05
       AND COALESCE((p_breakdown->'components'->>'S_creator')::real, 0) <= 0.05
        THEN 'score driven by global quality + recency only — no affinity history yet'
      WHEN COALESCE((p_breakdown->'components'->>'S_topic')::real, 0) > 0.5
        THEN format('strong match on top topic "%s" (S_topic %s)',
                    p_breakdown->>'top_topic',
                    to_char((p_breakdown->'components'->>'S_topic')::real, 'FM0.00'))
      WHEN COALESCE((p_breakdown->'components'->>'S_topic')::real, 0) > 0.1
        THEN format('moderate match on "%s"', p_breakdown->>'top_topic')
      WHEN COALESCE((p_breakdown->'components'->>'S_topic')::real, 0) < 0
        THEN format('user has dismissed "%s" content before — served as exploration',
                    p_breakdown->>'top_topic')
      ELSE 'new topic — served to expand taste'
    END
    ||
    -- Creator addition.
    CASE
      WHEN COALESCE((p_breakdown->'components'->>'S_creator')::real, 0) > 0.3
        THEN format(', creator engaged with (S_creator %s)',
                    to_char((p_breakdown->'components'->>'S_creator')::real, 'FM0.00'))
      WHEN COALESCE((p_breakdown->'components'->>'S_creator')::real, 0) < -0.1
        THEN ', creator user tends to skip'
      ELSE ''
    END
    ||
    -- Recency note.
    CASE
      WHEN COALESCE((p_breakdown->>'age_days')::real, 0) < 2
        THEN '. Just published.'
      WHEN COALESCE((p_breakdown->'components'->>'S_recency')::real, 0) < 0.3
        THEN format('. Recency reduced (%s days old).',
                    ROUND(COALESCE((p_breakdown->>'age_days')::real, 0)::numeric, 0))
      ELSE '.'
    END
    ||
    -- Streak penalty mention.
    CASE
      WHEN COALESCE(p_streak, 0) >= 2
        THEN format(' Repeat-creator penalty applied (streak %s).', p_streak)
      ELSE ''
    END
    ||
    -- Regime informational tail (A/B only).
    CASE
      WHEN p_regime_label IN ('A','B')
        THEN format(' (Profile regime: %s — informational; v1 scorer treats all regimes identically.)',
                    p_regime_label)
      ELSE ''
    END
$$;

REVOKE ALL ON FUNCTION public._admin_algo_narrative_from_breakdown(jsonb, int, int, text)
  FROM public, anon, authenticated;
-- service_role only; called by SECURITY DEFINER RPCs as the function owner.

-- ─────────────────────────────────────────────────────────────────────────
-- RPC #1 — admin_algo_log_inspector_view
-- Single audit-writer for the read-only fan-out. 5s debounce coalesces
-- accidental refresh-loops. NULL session_correlation_id → 22023.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_algo_log_inspector_view(
  p_user_id                uuid,
  p_session_correlation_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_action   text;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_roles
     WHERE user_id = v_admin_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'admin not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_session_correlation_id IS NULL THEN
    RAISE EXCEPTION 'session_correlation_id required' USING ERRCODE = '22023';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id required' USING ERRCODE = '22023';
  END IF;

  -- 5s debounce: coalesce refresh-loops. Multi-tab and intentional second
  -- views still trace via session_correlation_id correlation in the explain
  -- RPC's audit row.
  IF EXISTS (
    SELECT 1 FROM public.admin_audit_log
     WHERE admin_user_id = v_admin_id
       AND target_kind   = 'profile'
       AND target_id     = p_user_id
       AND action IN ('algo_profile_viewed', 'algo_profile_viewed_self')
       AND created_at    > now() - interval '5 seconds'
  ) THEN
    RETURN;
  END IF;

  v_action := CASE WHEN v_admin_id = p_user_id
                   THEN 'algo_profile_viewed_self'
                   ELSE 'algo_profile_viewed' END;

  INSERT INTO public.admin_audit_log
    (admin_user_id, action, target_kind, target_id, before, after)
  VALUES (
    v_admin_id, v_action, 'profile', p_user_id, NULL,
    jsonb_build_object(
      'rpc',                    'admin_algo_log_inspector_view',
      'session_correlation_id', p_session_correlation_id,
      'ts',                     now()
    )
  );
END;$$;

REVOKE ALL    ON FUNCTION public.admin_algo_log_inspector_view(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_algo_log_inspector_view(uuid, uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- RPC #2 — admin_algo_user_summary
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_algo_user_summary(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_admin_id        uuid := auth.uid();
  v_profile         jsonb;
  v_engagement      int;
  v_events_total    int;
  v_events_by_event jsonb;
  v_topic_max       real;
  v_creator_max     real;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_roles
     WHERE user_id = v_admin_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'admin not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
           'id',             p.id,
           'handle',         p.handle,
           'display_name',   p.display_name,
           'tier',           p.tier,
           'timezone',       p.timezone,
           'created_at',     p.created_at,
           'interest_slugs', p.interest_slugs,
           'feed_regime',    p.feed_regime,
           'goals',          p.goals,
           'obstacles',      p.obstacles
         )
    INTO v_profile
    FROM public.profiles p
   WHERE p.id = p_user_id;

  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = 'P0002';
  END IF;

  -- Engagement depth — formula must match
  -- ALGO_IMPLEMENTATION_PLAN.md §1144-1158 exactly.
  SELECT COUNT(*) INTO v_engagement
    FROM public.feed_events_raw
   WHERE user_id = p_user_id
     AND skipped_reason IS NULL
     AND (
       (event_name = 'hook_dwell_end'
        AND public._jsonb_real(payload, 'completion_pct') >= 0.8)
       OR event_name = 'full_video_open'
       OR (event_name = 'mic_tap'
           AND payload->>'mic_tap_outcome' = 'session_opened')
     );

  -- Events in the last 30 days, broken down by event_name.
  SELECT COUNT(*),
         COALESCE(jsonb_object_agg(event_name, c), '{}'::jsonb)
    INTO v_events_total, v_events_by_event
    FROM (
      SELECT event_name::text AS event_name, COUNT(*)::int AS c
        FROM public.feed_events_raw
       WHERE user_id = p_user_id
         AND created_at > now() - interval '30 days'
       GROUP BY event_name
    ) x;

  SELECT GREATEST(5.0, COALESCE(MAX(affinity_score), 5.0))::real
    INTO v_topic_max
    FROM public.user_topic_affinity WHERE user_id = p_user_id;

  SELECT GREATEST(5.0, COALESCE(MAX(affinity_score), 5.0))::real
    INTO v_creator_max
    FROM public.user_creator_affinity WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'profile',           v_profile,
    'engagement_depth',  v_engagement,
    'events_30d',        jsonb_build_object(
                           'total',    COALESCE(v_events_total, 0),
                           'by_event', v_events_by_event
                         ),
    'user_topic_max',    v_topic_max,
    'user_creator_max',  v_creator_max
  );
END;$$;

REVOKE ALL    ON FUNCTION public.admin_algo_user_summary(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_algo_user_summary(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- RPC #3 — admin_algo_top_topics
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_algo_top_topics(
  p_user_id uuid,
  p_limit   int DEFAULT 5
) RETURNS TABLE (
  topic_slug     text,
  affinity_score real,
  impressions    int,
  mic_taps       int,
  full_opens     int,
  completions    int,
  negatives      int,
  last_event_at  timestamptz,
  sign           text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_limit    int  := GREATEST(1, LEAST(50, COALESCE(p_limit, 5)));
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_roles
     WHERE user_id = v_admin_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'admin not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT uta.topic_slug,
           round(uta.affinity_score::numeric, 4)::real AS affinity_score,
           uta.impressions, uta.mic_taps, uta.full_opens,
           uta.completions, uta.negatives, uta.last_event_at,
           CASE
             WHEN uta.affinity_score > 0 THEN 'positive'
             WHEN uta.affinity_score < 0 THEN 'negative'
             ELSE 'neutral'
           END AS sign
      FROM public.user_topic_affinity uta
     WHERE uta.user_id = p_user_id
     ORDER BY uta.affinity_score DESC NULLS LAST
     LIMIT v_limit;
END;$$;

REVOKE ALL    ON FUNCTION public.admin_algo_top_topics(uuid, int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_algo_top_topics(uuid, int) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- RPC #4 — admin_algo_top_creators
--
-- For a debugger, we want forensic visibility: show ALL creators with
-- non-zero user affinity, including delisted / non-human / unpublished.
-- The `published_at IS NOT NULL` and `creator_type = 'human'` filters that
-- feed_ranked_page applies are SURFACED as columns instead of applied as
-- WHERE clauses — admin can see "user has affinity to creator X but creator
-- X is unpublished/non-human" which is exactly the kind of question an
-- inspector should answer.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_algo_top_creators(
  p_user_id uuid,
  p_limit   int DEFAULT 5
) RETURNS TABLE (
  creator_id            uuid,
  handle                text,
  display_name          text,
  creator_type          text,
  is_published          boolean,
  affinity_score        real,
  impressions           int,
  full_opens            int,
  mic_taps              int,
  total_session_seconds int,
  last_event_at         timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_limit    int  := GREATEST(1, LEAST(50, COALESCE(p_limit, 5)));
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_roles
     WHERE user_id = v_admin_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'admin not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT c.id AS creator_id,
           c.handle::text AS handle,
           c.display_name,
           c.creator_type::text AS creator_type,
           (c.published_at IS NOT NULL) AS is_published,
           round(uca.affinity_score::numeric, 4)::real AS affinity_score,
           uca.impressions, uca.full_opens, uca.mic_taps,
           uca.total_session_seconds, uca.last_event_at
      FROM public.user_creator_affinity uca
      JOIN public.creators c ON c.id = uca.creator_id
     WHERE uca.user_id = p_user_id
     ORDER BY uca.affinity_score DESC NULLS LAST
     LIMIT v_limit;
END;$$;

REVOKE ALL    ON FUNCTION public.admin_algo_top_creators(uuid, int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_algo_top_creators(uuid, int) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- RPC #5 — admin_algo_funnel_7d
-- 7-day window; payload extracts use _jsonb_real for type safety. Distinct
-- (user_id, hook_id) pairs at each stage except session_opened (event count).
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_algo_funnel_7d(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_imp      int;
  v_dwell    int;
  v_full     int;
  v_mic      int;
  v_session  int;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_roles
     WHERE user_id = v_admin_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'admin not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(DISTINCT hook_id) INTO v_imp
    FROM public.feed_events_raw
   WHERE user_id = p_user_id
     AND event_name = 'hook_impression'
     AND hook_id IS NOT NULL
     AND created_at > now() - interval '7 days'
     AND skipped_reason IS NULL;

  SELECT COUNT(DISTINCT hook_id) INTO v_dwell
    FROM public.feed_events_raw
   WHERE user_id = p_user_id
     AND event_name = 'hook_dwell_end'
     AND hook_id IS NOT NULL
     AND created_at > now() - interval '7 days'
     AND skipped_reason IS NULL
     AND public._jsonb_real(payload, 'completion_pct') >= 0.8;

  SELECT COUNT(DISTINCT video_id) INTO v_full
    FROM public.feed_events_raw
   WHERE user_id = p_user_id
     AND event_name = 'full_video_open'
     AND video_id IS NOT NULL
     AND created_at > now() - interval '7 days'
     AND skipped_reason IS NULL;

  SELECT COUNT(DISTINCT hook_id) INTO v_mic
    FROM public.feed_events_raw
   WHERE user_id = p_user_id
     AND event_name = 'mic_tap'
     AND hook_id IS NOT NULL
     AND created_at > now() - interval '7 days'
     AND skipped_reason IS NULL;

  SELECT COUNT(*) INTO v_session
    FROM public.feed_events_raw
   WHERE user_id = p_user_id
     AND event_name = 'mic_tap'
     AND created_at > now() - interval '7 days'
     AND skipped_reason IS NULL
     AND payload->>'mic_tap_outcome' = 'session_opened';

  RETURN jsonb_build_object(
    'window_days',     7,
    'impressions',     v_imp,
    'dwell_ge_80',     v_dwell,
    'full_video_open', v_full,
    'mic_tap',         v_mic,
    'session_opened',  v_session,
    'rates', jsonb_build_object(
      'impression_to_dwell80',
        CASE WHEN v_imp = 0 THEN NULL
             ELSE round((v_dwell::real / v_imp)::numeric, 4)::real END,
      'dwell80_to_full_open',
        CASE WHEN v_dwell = 0 THEN NULL
             ELSE round((v_full::real / v_dwell)::numeric, 4)::real END,
      'full_open_to_mic_tap',
        CASE WHEN v_full = 0 THEN NULL
             ELSE round((v_mic::real / v_full)::numeric, 4)::real END,
      'mic_tap_to_session',
        CASE WHEN v_mic = 0 THEN NULL
             ELSE round((v_session::real / v_mic)::numeric, 4)::real END,
      'impression_to_session',
        CASE WHEN v_imp = 0 THEN NULL
             ELSE round((v_session::real / v_imp)::numeric, 4)::real END
    )
  );
END;$$;

REVOKE ALL    ON FUNCTION public.admin_algo_funnel_7d(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_algo_funnel_7d(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- RPC #6 — admin_algo_recent_events
-- payload_safe is a whitelist projection; non-whitelisted keys are dropped
-- and numeric keys preserve their JSON number type via jsonb_typeof guard.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_algo_recent_events(
  p_user_id uuid,
  p_limit   int DEFAULT 50
) RETURNS TABLE (
  id             bigint,
  created_at     timestamptz,
  event_name     feed_event_name,
  hook_id        uuid,
  video_id       uuid,
  creator_id     uuid,
  session_id     uuid,
  payload_safe   jsonb,
  skipped_reason text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_limit    int  := GREATEST(1, LEAST(200, COALESCE(p_limit, 50)));
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_roles
     WHERE user_id = v_admin_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'admin not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT f.id, f.created_at, f.event_name,
           f.hook_id, f.video_id, f.creator_id, f.session_id,
           jsonb_strip_nulls(jsonb_build_object(
             'completion_pct',
               CASE WHEN jsonb_typeof(f.payload->'completion_pct') = 'number'
                    THEN f.payload->'completion_pct' END,
             'quartile',
               CASE WHEN jsonb_typeof(f.payload->'quartile') = 'number'
                    THEN f.payload->'quartile' END,
             'served_rank',
               CASE WHEN jsonb_typeof(f.payload->'served_rank') = 'number'
                    THEN f.payload->'served_rank' END,
             'lesson_number',
               CASE WHEN jsonb_typeof(f.payload->'lesson_number') = 'number'
                    THEN f.payload->'lesson_number' END,
             'seconds_to_decision_ms',
               CASE WHEN jsonb_typeof(f.payload->'seconds_to_decision_ms') = 'number'
                    THEN f.payload->'seconds_to_decision_ms' END,
             'mic_tap_outcome', f.payload->>'mic_tap_outcome',
             'direction',       f.payload->>'direction',
             'source',          f.payload->>'source'
           )) AS payload_safe,
           f.skipped_reason
      FROM public.feed_events_raw f
     WHERE f.user_id = p_user_id
     ORDER BY f.created_at DESC
     LIMIT v_limit;
END;$$;

REVOKE ALL    ON FUNCTION public.admin_algo_recent_events(uuid, int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_algo_recent_events(uuid, int) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- RPC #7 — admin_algo_score_explain  (the "Why this hook?" debugger)
--
-- Single path — v1 scorer is regime-agnostic, so there is no Path A vs B
-- branching. Always reconstructs streak from the user's last 20 impressions
-- in the past 10 minutes (matches feed_ranked_page exactly via array_agg
-- ORDER BY) and feeds it to compute_hook_score.
--
-- Audit row written AFTER compute completes (codebase pattern from
-- admin_set_profile_tier:115). Hook_not_found rolls back the audit row;
-- this is the established codebase precedent for failed admin actions.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_algo_score_explain(
  p_user_id                uuid,
  p_hook_id                uuid,
  p_session_correlation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_admin_id          uuid := auth.uid();
  v_action            text;
  v_served_slot_zero  int;
  v_served_at         timestamptz;
  v_hook_creator_id   uuid;
  v_last_creators     uuid[] := '{}'::uuid[];
  v_streak            int := 0;
  v_user_topic_max    real := 5.0;
  v_user_creator_max  real := 5.0;
  v_interest_slugs    text[] := '{}'::text[];
  v_regime_current    text;
  v_breakdown         jsonb;
  v_narrative         text;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_roles
     WHERE user_id = v_admin_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'admin not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_session_correlation_id IS NULL THEN
    RAISE EXCEPTION 'session_correlation_id required' USING ERRCODE = '22023';
  END IF;
  IF p_user_id IS NULL OR p_hook_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id and p_hook_id required' USING ERRCODE = '22023';
  END IF;

  -- Most recent impression for slot + timestamp.
  SELECT (payload->>'served_rank')::int, created_at
    INTO v_served_slot_zero, v_served_at
    FROM public.feed_events_raw
   WHERE user_id = p_user_id AND hook_id = p_hook_id
     AND event_name = 'hook_impression'
     AND jsonb_typeof(payload->'served_rank') = 'number'
   ORDER BY created_at DESC
   LIMIT 1;

  -- Hook → creator (RAISE if hook missing — matches admin_set_profile_tier:71).
  SELECT v.creator_id INTO v_hook_creator_id
    FROM public.hooks h JOIN public.videos v ON v.id = h.video_id
   WHERE h.id = p_hook_id;
  IF v_hook_creator_id IS NULL THEN
    RAISE EXCEPTION 'hook_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Streak — array_agg ORDER BY pattern matches feed_ranked_page exactly.
  SELECT COALESCE(array_agg(creator_id ORDER BY created_at DESC), '{}'::uuid[])
    INTO v_last_creators
    FROM (
      SELECT creator_id, created_at
        FROM public.feed_events_raw
       WHERE user_id     = p_user_id
         AND event_name  = 'hook_impression'
         AND creator_id IS NOT NULL
         AND created_at  > now() - interval '10 minutes'
       ORDER BY created_at DESC
       LIMIT 20
    ) recent;
  v_streak := public._consecutive_streak_from_tail(v_last_creators, v_hook_creator_id);

  -- Dynamic maxes match scorer.
  SELECT GREATEST(5.0, COALESCE(MAX(affinity_score), 5.0))::real
    INTO v_user_topic_max
    FROM public.user_topic_affinity   WHERE user_id = p_user_id;
  SELECT GREATEST(5.0, COALESCE(MAX(affinity_score), 5.0))::real
    INTO v_user_creator_max
    FROM public.user_creator_affinity WHERE user_id = p_user_id;

  SELECT COALESCE(p.interest_slugs, '{}'::text[]),
         COALESCE(p.feed_regime::text, 'A')
    INTO v_interest_slugs, v_regime_current
    FROM public.profiles p WHERE p.id = p_user_id;

  IF v_regime_current IS NULL THEN
    -- profiles row missing for the target user.
    RAISE EXCEPTION 'user not found' USING ERRCODE = 'P0002';
  END IF;

  -- Compute. p_regime is echo-only in v1 (compute_hook_score:51,187).
  -- Hook existence already pre-checked above (RAISE P0002 on missing); the
  -- compute call cannot return {error: 'hook_not_found'} from here.
  SELECT public.compute_hook_score(
           p_user_id, p_hook_id, 'exploit', 'C',
           v_streak,
           v_user_topic_max, v_user_creator_max,
           v_interest_slugs
         ) INTO v_breakdown;

  v_narrative := public._admin_algo_narrative_from_breakdown(
                   v_breakdown, v_served_slot_zero, v_streak, v_regime_current);

  v_action := CASE WHEN v_admin_id = p_user_id
                   THEN 'algo_score_explained_self'
                   ELSE 'algo_score_explained' END;

  INSERT INTO public.admin_audit_log
    (admin_user_id, action, target_kind, target_id, before, after)
  VALUES (
    v_admin_id, v_action, 'profile', p_user_id, NULL,
    jsonb_build_object(
      'rpc',                    'admin_algo_score_explain',
      'hook_id',                p_hook_id,
      'session_correlation_id', p_session_correlation_id,
      'ts',                     now()
    )
  );

  RETURN jsonb_build_object(
    'breakdown',                    v_breakdown,
    'narrative',                    v_narrative,
    'display_slot_one_indexed',
      CASE WHEN v_served_slot_zero IS NULL
           THEN NULL ELSE v_served_slot_zero + 1 END,
    'served_at_last_impression',    v_served_at,
    'reconstructed_creator_streak', v_streak,
    'regime_label',                 v_regime_current,
    'notes', jsonb_build_object(
      'scorer_regime_agnostic_v1',
        'profiles.feed_regime is a label only; v1 scorer is regime-agnostic. '
        'When v2 introduces regime-specific scoring, this explainer extends.',
      'streak_window',
        'last 20 impressions in past 10 minutes',
      'served_slot_meaning',
        'display_slot_one_indexed = persisted slot_idx + 1; 1 = top of feed page'
    )
  );
END;$$;

REVOKE ALL    ON FUNCTION public.admin_algo_score_explain(uuid, uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_algo_score_explain(uuid, uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
