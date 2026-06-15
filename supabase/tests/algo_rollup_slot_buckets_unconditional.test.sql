-- Audit C3 guard: slot buckets must count EVERY non-skipped impression
-- (position data unfiltered by outcome) and must NOT count skipped/dead-zone
-- debug rows (trigger exits before any arm).
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-sbu@test');
  v_creator_u uuid := tests.create_auth_user('algo-sbu-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_row record;
BEGIN
  UPDATE public.profiles SET handle = 'sbuc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'B', 'sbuc', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_sbu', 30, ARRAY['cold_outreach'])
    RETURNING id INTO v_hook_id;

  -- Two live impressions + one skipped debug row.
  INSERT INTO public.feed_events_raw (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES
    (v_user, 'hook_impression', v_hook_id, gen_random_uuid(), jsonb_build_object('served_rank', 0)),
    (v_user, 'hook_impression', v_hook_id, gen_random_uuid(), jsonb_build_object('served_rank', 7));
  INSERT INTO public.feed_events_raw (user_id, event_name, hook_id, idempotency_key, payload, skipped_reason)
    VALUES (v_user, 'hook_impression', v_hook_id, gen_random_uuid(),
            jsonb_build_object('served_rank', 0), 'dead_zone_swipe');

  SELECT * INTO v_row FROM public.hook_global_stats WHERE hook_id = v_hook_id;

  RETURN NEXT ok(v_row.impressions_top3 + v_row.impressions_rest = 2,
    format('1: bucket total == live impressions (2), skipped row excluded (top3=%s rest=%s)',
           v_row.impressions_top3, v_row.impressions_rest));
  RETURN NEXT ok(v_row.impressions_top3 = 1 AND v_row.impressions_rest = 1,
    '2: rank 0 → top3, rank 7 → rest');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
