-- 0503-02 — feed_events_raw (algo plan §3.2 migration 2)
--
-- Append-only behavioral event stream. Every swipe, dwell, full-video-open,
-- quartile, carousel tap, and mic_tap lands here via the ingest_feed_events
-- RPC (migration 7a). The rollup trigger (migration 6) reads AFTER INSERT to
-- update user_topic_affinity / user_creator_affinity / hook_global_stats.
--
-- Retention: 90 days raw (pg_cron GC in migration 10) → rollup tables keep
-- the compressed signal forever. mic_tap is preserved forever at the raw
-- level (business-critical north-star event).

CREATE TABLE public.feed_events_raw (
  id              bigserial       PRIMARY KEY,
  created_at      timestamptz     NOT NULL DEFAULT now(),
  user_id         uuid            NOT NULL REFERENCES public.profiles(id)  ON DELETE CASCADE,
  event_name      feed_event_name NOT NULL,
  hook_id         uuid            REFERENCES public.hooks(id)    ON DELETE SET NULL,
  video_id        uuid            REFERENCES public.videos(id)   ON DELETE SET NULL,
  creator_id      uuid            REFERENCES public.creators(id) ON DELETE SET NULL,
  session_id      uuid            REFERENCES public.sessions(id) ON DELETE SET NULL,
  idempotency_key uuid            NOT NULL,
  payload         jsonb           NOT NULL CHECK (octet_length(payload::text) <= 4096),
  skipped_reason  text            CHECK (skipped_reason IS NULL OR char_length(skipped_reason) <= 64),
  UNIQUE (user_id, event_name, idempotency_key)
);

-- Primary hot path: scorer scans the user's last 30 days by (user_id, time).
CREATE INDEX feed_events_raw_user_time_idx
  ON public.feed_events_raw (user_id, created_at DESC);

-- Cooldown lookup: the on-the-fly CTE in feed_ranked_page filters on
-- (user_id, hook_id) during candidate scoring.
CREATE INDEX feed_events_raw_user_hook_idx
  ON public.feed_events_raw (user_id, hook_id)
  WHERE hook_id IS NOT NULL;

-- Retention GC (migration 10): pg_cron scans by created_at.
CREATE INDEX feed_events_raw_created_at_idx
  ON public.feed_events_raw (created_at);

-- NM3: the cooldown CTE's full_video_open branch runs a correlated
-- NOT EXISTS join on (user_id, video_id, event_name) looking for a
-- subsequent full_video_quartile within 60 seconds. Without this index
-- that would be a full-range scan per feed_ranked_page call.
CREATE INDEX feed_events_raw_user_video_event_idx
  ON public.feed_events_raw (user_id, video_id, event_name)
  WHERE video_id IS NOT NULL;

-- Append-only guard. Reuses raise_append_only() from migration 0020.
-- DELETE is permitted so the retention job (migration 10) + profiles
-- CASCADE can purge rows.
CREATE TRIGGER feed_events_raw_no_update
  BEFORE UPDATE ON public.feed_events_raw
  FOR EACH ROW EXECUTE FUNCTION public.raise_append_only();

CREATE TRIGGER feed_events_raw_no_truncate
  BEFORE TRUNCATE ON public.feed_events_raw
  FOR EACH STATEMENT EXECUTE FUNCTION public.raise_append_only();

-- RLS --------------------------------------------------------------------
ALTER TABLE public.feed_events_raw ENABLE ROW LEVEL SECURITY;

-- Own-read only. Users can see their own event stream (admin UI may expose
-- later via service-role); never another user's events.
CREATE POLICY "feed_events_raw own read"
  ON public.feed_events_raw FOR SELECT
  USING (user_id = auth.uid());

-- No INSERT policy: all writes go through ingest_feed_events (migration 7a)
-- or ingest_feed_events_anon (migration 0), both SECURITY DEFINER.

-- Grants -----------------------------------------------------------------
REVOKE ALL ON public.feed_events_raw FROM PUBLIC, anon;
-- authenticated keeps default SELECT grant; the RLS policy above narrows it
-- to own-row. service_role keeps INSERT/DELETE for ingest + retention.
