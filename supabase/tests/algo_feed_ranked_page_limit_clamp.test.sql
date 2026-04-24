-- T-D3-4: p_limit is clamped: p_limit=0 returns exactly 1 row (minimum clamp),
-- and p_limit=1 with 2 published hooks returns exactly 1 row.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user       uuid := tests.create_auth_user('algo-clamp@test');
  v_creator_u  uuid := tests.create_auth_user('algo-clamp-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_count_0    int;
  v_count_1    int;
  i            int;
BEGIN
  UPDATE public.profiles SET handle = 'clampc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'CL', 'clampc', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 3, 'ready')
    RETURNING id INTO v_video_id;
  FOR i IN 1..3 LOOP
    INSERT INTO public.hooks
      (video_id, lesson_number, mux_playback_id, duration_seconds,
       topic_tags, mux_status, published_at)
      VALUES (v_video_id, i, 'mux_clamp_' || i, 30,
              ARRAY['cold_outreach'], 'ready', now());
  END LOOP;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  PERFORM tests.set_authenticated(v_user);

  SELECT COUNT(*)::int INTO v_count_0
    FROM public.feed_ranked_page(0, NULL, '{}'::uuid[]);

  SELECT COUNT(*)::int INTO v_count_1
    FROM public.feed_ranked_page(1, NULL, '{}'::uuid[]);

  RETURN NEXT ok(
    v_count_0 = 1,
    format('1: p_limit=0 clamped to 1, returns 1 row (got %s)', v_count_0)
  );
  RETURN NEXT ok(
    v_count_1 = 1,
    format('2: p_limit=1 returns exactly 1 row (got %s)', v_count_1)
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
