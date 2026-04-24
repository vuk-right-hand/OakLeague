-- S-B1: feed_ranked_page (auth) respects p_exclude_hook_ids.
-- A published hook passed in the exclusion list must not appear in results;
-- the other hook in the same catalog must still appear.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user        uuid := tests.create_auth_user('algo-auth-excl@test');
  v_creator_u   uuid := tests.create_auth_user('algo-auth-excl-c@test');
  v_creator_id  uuid;
  v_video_id    uuid;
  v_excl_hook   uuid;
  v_other_hook  uuid;
  v_excl_found  boolean;
  v_other_found boolean;
BEGIN
  UPDATE public.profiles SET handle = 'authexclc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'AX', 'authexclc', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 2, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_authexcl_1', 30, ARRAY['cold_outreach'],
            'ready', now() - interval '1 second')
    RETURNING id INTO v_excl_hook;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 2, 'mux_authexcl_2', 30, ARRAY['cold_outreach'],
            'ready', now() - interval '2 seconds')
    RETURNING id INTO v_other_hook;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  PERFORM tests.set_authenticated(v_user);

  SELECT EXISTS (
    SELECT 1
      FROM public.feed_ranked_page(10, NULL, ARRAY[v_excl_hook])
     WHERE hook_id = v_excl_hook
  ) INTO v_excl_found;

  SELECT EXISTS (
    SELECT 1
      FROM public.feed_ranked_page(10, NULL, ARRAY[v_excl_hook])
     WHERE hook_id = v_other_hook
  ) INTO v_other_found;

  RETURN NEXT ok(
    NOT v_excl_found,
    '1: excluded hook_id does not appear in feed_ranked_page results'
  );
  RETURN NEXT ok(
    v_other_found,
    '2: non-excluded hook still appears in feed_ranked_page results'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
