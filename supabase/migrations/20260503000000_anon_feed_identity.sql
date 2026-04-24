-- 0503-00 — anon feed identity + shared event-weight helper
-- (algo plan §3.2 migration 0 + D1 audit C1/C2/M2/M7/S1)
--
-- Persistent anon-visitor identity for pre-signup feed continuity. YC reviewers
-- who swipe in Incognito before signing up have their behavioral signal
-- captured as jsonb affinity blobs and merged into the real user's rollup
-- tables on auth callback.
--
-- Forward refs to user_topic_affinity / user_creator_affinity (migrations 3 & 4)
-- resolve at first invocation, by which point 0–5 have applied.

-- Table ------------------------------------------------------------------

CREATE TABLE public.anon_feed_sessions (
  anon_id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_active_at    timestamptz NOT NULL DEFAULT now(),
  event_count       int         NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  -- Compact EMA blobs keyed by topic_slug / creator_id::text.
  -- Values clamped to [-0.5, 5.0] at write time (see ingest_feed_events_anon).
  -- 4096 byte CHECK is the hard ceiling; the RPC defensively refuses NEW keys
  -- once either blob exceeds 3500 bytes (M2 guard) so the session can never
  -- zombie (permanent CHECK failure) by writing one event too many.
  topic_affinity    jsonb       NOT NULL DEFAULT '{}'::jsonb
                                CHECK (octet_length(topic_affinity::text)   <= 4096),
  creator_affinity  jsonb       NOT NULL DEFAULT '{}'::jsonb
                                CHECK (octet_length(creator_affinity::text) <= 4096)
);

-- Index exists for the GC job (migration 10, D7). Until then the table grows
-- unbounded at anon-visitor cadence — fine at YC-demo scale, documented so
-- future eyes don't assume GC is in place.
CREATE INDEX anon_feed_sessions_last_active_idx
  ON public.anon_feed_sessions (last_active_at);

ALTER TABLE public.anon_feed_sessions ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only. Anon / authenticated callers never touch
-- this table directly; all reads/writes go through SECURITY DEFINER RPCs.

-- compute_event_weight — shared weight helper (C1) -----------------------
-- Single source of truth for per-event affinity weight. Called by:
--   (1) ingest_feed_events_anon (below — anon path)
--   (2) feed_events_raw_rollup trigger (migration 6, D2 — authenticated path)
-- Drift between the two paths is structurally impossible because both paths
-- invoke this function. Tuning a weight = editing one CASE arm here.
--
-- Param type is `text` (not feed_event_name) so this function can live in
-- migration 0 without forward-referencing the enum created in migration 1.
-- Callers pass the event_name value directly (jsonb text field on the anon
-- path; NEW.event_name::text on the authenticated path).

CREATE OR REPLACE FUNCTION public.compute_event_weight(
  p_event_name text,
  p_payload    jsonb
) RETURNS real
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT (CASE p_event_name
    WHEN 'hook_impression' THEN 0.02
    WHEN 'hook_dwell_end'  THEN
      LEAST(1.0, GREATEST(-0.3, COALESCE((p_payload->>'completion_pct')::real, 0)))
    WHEN 'hook_swipe' THEN
      CASE (p_payload->>'direction')
        WHEN 'right' THEN 0.5
        WHEN 'left'  THEN 0.0
        ELSE CASE WHEN COALESCE((p_payload->>'seconds_to_decision_ms')::int, 9999) < 2000
                       AND COALESCE((p_payload->>'completion_pct')::real, 0) < 0.2
                  THEN -0.3 ELSE -0.05 END
      END
    WHEN 'full_video_open' THEN 0.6
    WHEN 'full_video_quartile' THEN
      CASE COALESCE((p_payload->>'quartile')::int, 0)
        WHEN 25  THEN 0.2
        WHEN 50  THEN 0.4
        WHEN 75  THEN 0.6
        WHEN 100 THEN 1.0
        ELSE 0
      END
    WHEN 'creator_carousel_open'      THEN 0.4
    WHEN 'creator_carousel_hook_open' THEN 0.5
    WHEN 'mic_tap' THEN
      CASE (p_payload->>'mic_tap_outcome')
        WHEN 'session_opened' THEN 2.0
        ELSE 0.3
      END
    ELSE 0
  END)::real;
$$;

REVOKE EXECUTE ON FUNCTION public.compute_event_weight(text, jsonb) FROM PUBLIC, anon, authenticated;
-- Called only from SECURITY DEFINER RPCs; no external-role grants needed.

-- merge_anon_feed_state (C6 + audit C2) ----------------------------------
-- Called from the auth callback after a successful sign-in or sign-up.
-- Blends anon EMA affinity into the real user's rollup tables.
--
-- Blend formula (audit C2): for returning users with existing affinity, the
-- anon contribution is added additively at 30% weight. This preserves
-- established signal (user with 4.0 cold_outreach + one Incognito fast-dismiss
-- anon-score -0.1 → 4.0 + -0.03 = 3.97, not 1.95). For first-touch users with
-- no existing row, the anon value is inserted at full weight — there's
-- nothing to erode.

CREATE OR REPLACE FUNCTION public.merge_anon_feed_state(
  p_anon_id uuid,
  p_user_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_anon record;
  v_key  text;
  v_val  real;
BEGIN
  IF p_anon_id IS NULL OR p_user_id IS NULL THEN RETURN; END IF;

  SELECT topic_affinity, creator_affinity
    INTO v_anon
    FROM public.anon_feed_sessions
   WHERE anon_id = p_anon_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  -- Blend topic affinity. First-touch = full value; on conflict = additive × 0.3.
  -- NOTE: user_topic_affinity.affinity_score has no DB-level upper CHECK. If
  -- one is ever added, this line must clamp too (max anon contribution per
  -- merge = 5.0 ceiling × 0.3 = +1.5, so a heavy returning user + hot anon
  -- session could cross any CHECK bound and raise check_violation here).
  FOR v_key, v_val IN
    SELECT key, value::real
      FROM jsonb_each_text(v_anon.topic_affinity)
  LOOP
    INSERT INTO public.user_topic_affinity
      (user_id, topic_slug, affinity_score, last_event_at, updated_at)
    VALUES (p_user_id, v_key, v_val, now(), now())
    ON CONFLICT (user_id, topic_slug) DO UPDATE
      SET affinity_score = user_topic_affinity.affinity_score + EXCLUDED.affinity_score * 0.3,
          last_event_at  = now(),
          updated_at     = now();
  END LOOP;

  -- Blend creator affinity. Same blend rule + same unclamped-CHECK note as above.
  FOR v_key, v_val IN
    SELECT key, value::real
      FROM jsonb_each_text(v_anon.creator_affinity)
  LOOP
    BEGIN
      INSERT INTO public.user_creator_affinity
        (user_id, creator_id, affinity_score, last_event_at, updated_at)
      VALUES (p_user_id, v_key::uuid, v_val, now(), now())
      ON CONFLICT (user_id, creator_id) DO UPDATE
        SET affinity_score = user_creator_affinity.affinity_score + EXCLUDED.affinity_score * 0.3,
            last_event_at  = now(),
            updated_at     = now();
    EXCEPTION WHEN invalid_text_representation THEN
      -- Skip any malformed creator key rather than aborting the merge.
      CONTINUE;
    END;
  END LOOP;

  DELETE FROM public.anon_feed_sessions WHERE anon_id = p_anon_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.merge_anon_feed_state(uuid, uuid) FROM PUBLIC, anon, authenticated;
-- Service-role only; called from server-side auth callback.

-- ingest_feed_events_anon (NC1 + audit M2) -------------------------------
-- Called from /api/events/feed-batch when auth.uid() IS NULL. Validates
-- identity via the anon_id cookie against anon_feed_sessions. Applies the
-- same per-event weight table (compute_event_weight) as the authenticated
-- rollup trigger but writes directly into the jsonb affinity blobs — no
-- normalized per-event rows are kept for anon.
--
-- M2 blob-size guard: once either blob crosses 3500 bytes (headroom under
-- the 4096-byte CHECK), NEW keys are refused but EXISTING keys still
-- update. This prevents permanent zombie sessions where one over-cap event
-- would lock the anon_id into always-throwing check_violation state.

CREATE OR REPLACE FUNCTION public.ingest_feed_events_anon(
  p_anon_id uuid,
  p_events  jsonb
) RETURNS TABLE(inserted int, deduped int, dead_zoned int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  BLOB_SOFT_CAP constant int := 3500;  -- M2 guard; hard CHECK at 4096.
  v_anon record;
  v_evt  jsonb;
  v_event_name text;
  -- Scalar hook fields (not a record) so the NULL-hook branch doesn't trip
  -- "record not yet assigned" when the event has no hook_id.
  v_hook_topic_tags text[];
  v_hook_creator_id uuid;
  v_tag  text;
  v_weight real;
  v_creator_id text;
  v_inserted int := 0;
  v_deduped  int := 0;
  v_dead     int := 0;
  v_new_topic_aff   jsonb;
  v_new_creator_aff jsonb;
  v_old_score real;
  v_new_score real;
BEGIN
  -- Validate anon session exists (acts as auth in lieu of JWT).
  SELECT topic_affinity, creator_affinity
    INTO v_anon
    FROM public.anon_feed_sessions
   WHERE anon_id = p_anon_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'anon_session_not_found' USING ERRCODE = '28000';
  END IF;

  IF jsonb_typeof(p_events) <> 'array' THEN
    RAISE EXCEPTION 'p_events must be a jsonb array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_events) > 50 THEN
    RAISE EXCEPTION 'batch too large (max 50)' USING ERRCODE = '22023';
  END IF;

  v_new_topic_aff   := v_anon.topic_affinity;
  v_new_creator_aff := v_anon.creator_affinity;

  FOR v_evt IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    v_event_name := v_evt->>'event_name';

    -- Dead-zone: sub-500ms swipes are noise, not signal. Counted but not
    -- applied; event_count increments only on inserted (non-dead) events
    -- so regime B threshold (>=3 meaningful events) can't be farmed by
    -- rapid-fire dead-zone swipes.
    IF v_event_name = 'hook_swipe'
       AND COALESCE((v_evt->'payload'->>'seconds_to_decision_ms')::int, 0) < 500 THEN
      v_dead := v_dead + 1;
      CONTINUE;
    END IF;

    -- Resolve topic_tags + creator_id from hooks (same resolution as
    -- authenticated rollup trigger in migration 6).
    v_hook_topic_tags := NULL;
    v_hook_creator_id := NULL;
    IF (v_evt->>'hook_id') IS NOT NULL THEN
      BEGIN
        SELECT h.topic_tags, v.creator_id
          INTO v_hook_topic_tags, v_hook_creator_id
          FROM public.hooks h
          JOIN public.videos v ON v.id = h.video_id
         WHERE h.id = (v_evt->>'hook_id')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        v_hook_topic_tags := NULL;
        v_hook_creator_id := NULL;
      END;
    END IF;

    -- C1: single source of truth for event → weight mapping.
    v_weight := public.compute_event_weight(v_event_name, v_evt->'payload');

    -- Apply to topic_affinity jsonb blob. No time decay for anon — anon
    -- sessions are short-lived by definition; decay adds noise.
    IF v_hook_topic_tags IS NOT NULL THEN
      FOREACH v_tag IN ARRAY v_hook_topic_tags LOOP
        v_old_score := COALESCE((v_new_topic_aff->>v_tag)::real, 0);
        v_new_score := GREATEST(-0.5, LEAST(5.0, v_old_score + v_weight));
        -- M2: refuse NEW keys once blob near cap; updating existing keys
        -- is always safe (doesn't grow the object).
        IF (v_new_topic_aff ? v_tag)
           OR octet_length(v_new_topic_aff::text) < BLOB_SOFT_CAP THEN
          v_new_topic_aff := jsonb_set(v_new_topic_aff, ARRAY[v_tag], to_jsonb(v_new_score));
        END IF;
      END LOOP;
    END IF;

    -- Apply to creator_affinity jsonb blob.
    v_creator_id := COALESCE(v_hook_creator_id::text, v_evt->>'creator_id');
    IF v_creator_id IS NOT NULL THEN
      v_old_score := COALESCE((v_new_creator_aff->>v_creator_id)::real, 0);
      v_new_score := GREATEST(-0.5, LEAST(5.0, v_old_score + v_weight));
      IF (v_new_creator_aff ? v_creator_id)
         OR octet_length(v_new_creator_aff::text) < BLOB_SOFT_CAP THEN
        v_new_creator_aff := jsonb_set(v_new_creator_aff, ARRAY[v_creator_id], to_jsonb(v_new_score));
      END IF;
    END IF;

    v_inserted := v_inserted + 1;
  END LOOP;

  -- Persist updated blobs + bump event_count / last_active_at.
  UPDATE public.anon_feed_sessions SET
    topic_affinity   = v_new_topic_aff,
    creator_affinity = v_new_creator_aff,
    event_count      = event_count + v_inserted,
    last_active_at   = now()
  WHERE anon_id = p_anon_id;

  RETURN QUERY SELECT v_inserted, v_deduped, v_dead;
END;$$;

REVOKE EXECUTE ON FUNCTION public.ingest_feed_events_anon(uuid, jsonb) FROM PUBLIC, anon, authenticated;
-- Service-role only; called from /api/events/feed-batch (anon path).

-- Grants -----------------------------------------------------------------
REVOKE ALL ON public.anon_feed_sessions FROM PUBLIC, anon, authenticated;
-- service_role retains default privileges for the API route.
