-- T-D3-2: regime-A user (no affinity, no events) gets hooks ordered by
-- global_quality + recency. High-quality hook must rank first (served_rank=0).
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user       uuid := tests.create_auth_user('algo-regA@test');
  v_creator_u  uuid := tests.create_auth_user('algo-regA-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hi_hook    uuid;
  v_lo_hook    uuid;
  v_hi_rank    int;
  v_lo_rank    int;
BEGIN
  UPDATE public.profiles SET handle = 'regac' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'RA', 'regac', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 2, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_rega_hi', 30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_hi_hook;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 2, 'mux_rega_lo', 30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_lo_hook;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  -- High-quality wins exploit ranking; no user affinity so only global + recency
  -- scores differ between the two.
  INSERT INTO public.hook_global_stats (hook_id, impressions, full_opens, mic_taps, global_quality)
    VALUES (v_hi_hook, 100, 90, 20, 0.9),
           (v_lo_hook, 100,  5,  0, 0.1);

  PERFORM tests.set_authenticated(v_user);

  SELECT served_rank INTO v_hi_rank
    FROM public.feed_ranked_page(10, NULL, '{}'::uuid[])
   WHERE hook_id = v_hi_hook;

  SELECT served_rank INTO v_lo_rank
    FROM public.feed_ranked_page(10, NULL, '{}'::uuid[])
   WHERE hook_id = v_lo_hook;

  RETURN NEXT ok(
    v_hi_rank < v_lo_rank,
    format('1: regime-A — high-quality hook ranks above low-quality (hi=%s, lo=%s)',
           v_hi_rank, v_lo_rank)
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
