-- T-D3-3: M-D3-1 — feed_ranked_anon_page respects p_exclude_hook_ids.
-- A published hook passed in the exclusion list must not appear in results.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_creator_u   uuid := tests.create_auth_user('algo-anon-excl-c@test');
  v_creator_id  uuid;
  v_video_id    uuid;
  v_excl_hook   uuid;
  v_other_hook  uuid;
  v_anon_id     uuid := gen_random_uuid();
  v_found       boolean;
BEGIN
  UPDATE public.profiles SET handle = 'anonexclc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'AE', 'anonexclc', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 2, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_excl_1', 30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_excl_hook;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 2, 'mux_excl_2', 30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_other_hook;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  INSERT INTO public.anon_feed_sessions (anon_id) VALUES (v_anon_id);

  -- Both hooks exist in the catalog; passing one as excluded must suppress it.
  SELECT EXISTS (
    SELECT 1
      FROM public.feed_ranked_anon_page(v_anon_id, 10, NULL, ARRAY[v_excl_hook])
     WHERE hook_id = v_excl_hook
  ) INTO v_found;

  RETURN NEXT ok(
    NOT v_found,
    '1: excluded hook_id does not appear in feed_ranked_anon_page results'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
