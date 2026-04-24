-- §9.8 / NC3: unknown anon_id (expired cookie, never-minted) is not an
-- error — the RPC falls back to quality-ordered ranking.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_creator_u uuid := tests.create_auth_user('algo-anon-unk-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_count int;
BEGIN
  UPDATE public.profiles SET handle = 'anonunkc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'AU', 'anonunkc', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_pb_unk', 30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_hook_id;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  -- Call with a bogus anon_id that doesn't exist in anon_feed_sessions.
  -- Must NOT raise; must return the published hook.
  SELECT count(*)::int INTO v_count
    FROM public.feed_ranked_anon_page(gen_random_uuid(), 10, NULL);
  RETURN NEXT ok(
    v_count >= 1,
    format('1: unknown anon_id returns results gracefully (got %s rows)', v_count)
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
