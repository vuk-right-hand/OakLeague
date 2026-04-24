-- §9.4 / M6: a topic with negative user affinity drives S_topic below 0,
-- pushing hooks with that topic down in rank vs neutral-topic hooks.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-neg-scorer@test');
  v_creator_u uuid := tests.create_auth_user('algo-neg-scorer-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hated_hook uuid;
  v_neutral_hook uuid;
  v_hated_rank int;
  v_neutral_rank int;
BEGIN
  UPDATE public.profiles SET handle = 'negs' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'NS', 'negs', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'hated_topic', 'H'),
           (v_creator_id, 'neutral_topic', 'N');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 2, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_pb_hated',   30, ARRAY['hated_topic'],
            'ready', now())
    RETURNING id INTO v_hated_hook;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at)
    VALUES (v_video_id, 2, 'mux_pb_neutral', 30, ARRAY['neutral_topic'],
            'ready', now())
    RETURNING id INTO v_neutral_hook;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  -- Seed strongly negative affinity on hated_topic.
  INSERT INTO public.user_topic_affinity (user_id, topic_slug, affinity_score)
    VALUES (v_user, 'hated_topic', -0.4);

  PERFORM tests.set_authenticated(v_user);

  SELECT served_rank INTO v_hated_rank
    FROM public.feed_ranked_page(10, NULL, '{}'::uuid[])
   WHERE hook_id = v_hated_hook;
  SELECT served_rank INTO v_neutral_rank
    FROM public.feed_ranked_page(10, NULL, '{}'::uuid[])
   WHERE hook_id = v_neutral_hook;

  RETURN NEXT ok(
    v_neutral_rank < v_hated_rank,
    format('1: neutral hook ranks above hated-topic hook (neutral=%s, hated=%s)',
           v_neutral_rank, v_hated_rank)
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
