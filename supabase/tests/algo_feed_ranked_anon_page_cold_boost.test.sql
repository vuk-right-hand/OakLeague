-- §9.8 / NC3 + M11: anon topic_affinity jsonb boosts hooks tagged with
-- matching topics. Two equal-quality hooks; anon has affinity for one
-- topic → that hook ranks higher.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_creator_u uuid := tests.create_auth_user('algo-anon-boost-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_favored_hook uuid;
  v_other_hook uuid;
  v_anon_id uuid := gen_random_uuid();
  v_favored_rank int;
  v_other_rank int;
BEGIN
  UPDATE public.profiles SET handle = 'anonbc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'AB', 'anonbc', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach',   'CO'),
           (v_creator_id, 'build_in_public', 'BIP');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 2, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_pb_boost_fav', 30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_favored_hook;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at)
    VALUES (v_video_id, 2, 'mux_pb_boost_oth', 30, ARRAY['build_in_public'],
            'ready', now())
    RETURNING id INTO v_other_hook;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  -- Equal global_quality.
  INSERT INTO public.hook_global_stats (hook_id, impressions, full_opens, mic_taps, global_quality)
    VALUES (v_favored_hook, 100, 5, 1, 0.5),
           (v_other_hook,   100, 5, 1, 0.5);

  -- Anon affinity points strongly at cold_outreach.
  INSERT INTO public.anon_feed_sessions (anon_id, topic_affinity)
    VALUES (v_anon_id, jsonb_build_object('cold_outreach', 2.0));

  SELECT served_rank INTO v_favored_rank
    FROM public.feed_ranked_anon_page(v_anon_id, 10, NULL)
   WHERE hook_id = v_favored_hook;
  SELECT served_rank INTO v_other_rank
    FROM public.feed_ranked_anon_page(v_anon_id, 10, NULL)
   WHERE hook_id = v_other_hook;

  RETURN NEXT ok(
    v_favored_rank < v_other_rank,
    format('1: matching-topic hook ranks above non-match (fav=%s, other=%s)',
           v_favored_rank, v_other_rank)
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
