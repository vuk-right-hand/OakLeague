-- Empty weights table ⇒ helper returns hardcoded defaults and the scorer
-- produces the SAME score as with the seeded table (inertness fallback).
-- (0613-01)
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-wfb@test');
  v_creator_u uuid := tests.create_auth_user('algo-wfb-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_score_seeded real;
  v_score_empty  real;
BEGIN
  UPDATE public.profiles SET handle = 'wfbc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'WFB', 'wfbc', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_pb_wfb', 30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_hook_id;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  v_score_seeded := (public.compute_hook_score(
    v_user, v_hook_id, 'exploit', 'C', 0, 5.0, 5.0, '{}'::text[]
  )->>'score_total')::real;

  DELETE FROM public.feed_algo_weights;

  v_score_empty := (public.compute_hook_score(
    v_user, v_hook_id, 'exploit', 'C', 0, 5.0, 5.0, '{}'::text[]
  )->>'score_total')::real;

  RETURN NEXT ok(v_score_seeded IS NOT NULL AND v_score_seeded = v_score_seeded,
    format('1: seeded-table score is finite (%s)', v_score_seeded));
  RETURN NEXT ok(abs(v_score_seeded - v_score_empty) < 1e-6,
    format('2: empty-table fallback score identical (%s vs %s)',
           v_score_seeded, v_score_empty));
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
