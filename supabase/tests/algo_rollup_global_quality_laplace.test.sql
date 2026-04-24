-- §9.3: hook_global_stats.global_quality uses Laplace smoothing:
--   quality = (1 + full_opens + 3 * mic_taps) / (10 + impressions)
-- Prior of (1/10)=0.1 prevents brand-new hooks from jumping to 100%.
--
-- NOTE: the trigger only upserts hook_global_stats on events with
-- v_weight > 0. An impression with weight 0.02 > 0 qualifies, so the
-- impressions counter DOES bump for positive events. But an "impression
-- only" scenario (no positive engagement) still gets counted as
-- impressions. Here we seed with 1 impression + 1 full_open:
--   quality = (1 + 1 + 0) / (10 + 1) = 2/11 ≈ 0.1818
BEGIN;
SELECT plan(5);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-lap@test');
  v_creator_u uuid := tests.create_auth_user('algo-lap-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_quality real;
  v_impressions bigint;
  v_full_opens bigint;
  v_avg_completion real;
  v_dwell_ends bigint;
BEGIN
  UPDATE public.profiles SET handle = 'lapc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'L', 'lapc', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_lap', 30, ARRAY['cold_outreach'])
    RETURNING id INTO v_hook_id;

  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES
    (v_user, 'hook_impression', v_hook_id, gen_random_uuid(), '{}'::jsonb),
    (v_user, 'full_video_open', v_hook_id, gen_random_uuid(),
     jsonb_build_object('source','swipe'));

  SELECT impressions, full_opens, global_quality
    INTO v_impressions, v_full_opens, v_quality
    FROM public.hook_global_stats WHERE hook_id = v_hook_id;

  RETURN NEXT is(v_impressions::int, 1, '1: impressions counter = 1');
  RETURN NEXT is(v_full_opens::int,  1, '2: full_opens counter = 1');
  RETURN NEXT ok(
    abs(v_quality - (2.0/11.0)) < 1e-4,
    format('3: quality = (1+1+0)/(10+1) ≈ 0.1818 (got %s)', v_quality)
  );

  -- Audit M1 fix: avg_completion_pct uses dwell_ends as denominator, not
  -- impressions. Fire one hook_dwell_end with completion=0.8; first dwell
  -- on the hook → avg should be exactly 0.8 (not 0.8/2=0.4 as in the pre-fix
  -- formula that divided by impressions).
  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'hook_dwell_end', v_hook_id, gen_random_uuid(),
            jsonb_build_object('dwell_ms', 24000, 'completion_pct', 0.8));

  SELECT avg_completion_pct, dwell_ends
    INTO v_avg_completion, v_dwell_ends
    FROM public.hook_global_stats WHERE hook_id = v_hook_id;

  RETURN NEXT is(v_dwell_ends::int, 1, '4: dwell_ends counter bumps on hook_dwell_end');
  RETURN NEXT ok(
    abs(v_avg_completion - 0.8) < 1e-4,
    format('5: M1 fix — avg_completion_pct = 0.8 (got %s)', v_avg_completion)
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
