-- §9.4: feed_ranked_page with the same cursor_epoch returns hooks in the
-- same order (seeded explore-slot positions don't drift across retries).
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-det@test');
  v_creator_u uuid := tests.create_auth_user('algo-det-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_cursor bigint := 1714567890;
  v_order_1 uuid[];
  v_order_2 uuid[];
  i int;
BEGIN
  UPDATE public.profiles SET handle = 'detcreator' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'Det', 'detcreator', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;

  -- Seed 5 hooks; the unique playback_id constraint makes each real.
  FOR i IN 1..5 LOOP
    INSERT INTO public.hooks
      (video_id, lesson_number, mux_playback_id, duration_seconds,
       topic_tags, mux_status, published_at)
      VALUES (v_video_id, i, 'mux_pb_det_' || i::text, 30,
              ARRAY['cold_outreach'], 'ready', now());
  END LOOP;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  PERFORM tests.set_authenticated(v_user);

  SELECT array_agg(hook_id ORDER BY served_rank)
    INTO v_order_1
    FROM public.feed_ranked_page(5, v_cursor, '{}'::uuid[]);

  SELECT array_agg(hook_id ORDER BY served_rank)
    INTO v_order_2
    FROM public.feed_ranked_page(5, v_cursor, '{}'::uuid[]);

  RETURN NEXT is(
    v_order_1, v_order_2,
    '1: same cursor_epoch → same hook_id order across calls'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
