-- §9.8 / NC3: feed_ranked_anon_page with empty anon_feed_sessions affinity
-- returns hooks ordered by global_quality (highest first).
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_creator_u uuid := tests.create_auth_user('algo-anon-q-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_high_q_hook uuid;
  v_low_q_hook uuid;
  v_anon_id uuid := gen_random_uuid();
  v_high_rank int;
  v_low_rank int;
BEGIN
  UPDATE public.profiles SET handle = 'anonqc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'AQ', 'anonqc', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 2, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_pb_hi',  30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_high_q_hook;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at)
    VALUES (v_video_id, 2, 'mux_pb_lo',  30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_low_q_hook;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  -- Seed quality directly.
  INSERT INTO public.hook_global_stats (hook_id, impressions, full_opens, mic_taps, global_quality)
    VALUES (v_high_q_hook, 100, 50, 10, 0.8),
           (v_low_q_hook,  100,  5,  0, 0.1);

  INSERT INTO public.anon_feed_sessions (anon_id) VALUES (v_anon_id);

  SELECT served_rank INTO v_high_rank
    FROM public.feed_ranked_anon_page(v_anon_id, 10, NULL)
   WHERE hook_id = v_high_q_hook;
  SELECT served_rank INTO v_low_rank
    FROM public.feed_ranked_anon_page(v_anon_id, 10, NULL)
   WHERE hook_id = v_low_q_hook;

  RETURN NEXT ok(
    v_high_rank < v_low_rank,
    format('1: high-quality hook ranks above low-quality (hi=%s, lo=%s)',
           v_high_rank, v_low_rank)
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
