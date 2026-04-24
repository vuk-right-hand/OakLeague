-- §9.4: score_breakdown jsonb has all documented fields (regime, slot_type,
-- components, weighted, score_total, served_rank).
BEGIN;
SELECT plan(8);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-shape@test');
  v_creator_u uuid := tests.create_auth_user('algo-shape-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_bd jsonb;
BEGIN
  UPDATE public.profiles SET handle = 'shapec' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'SH', 'shapec', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_pb_shape', 30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_hook_id;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  PERFORM tests.set_authenticated(v_user);

  SELECT score_breakdown INTO v_bd
    FROM public.feed_ranked_page(10, NULL, '{}'::uuid[])
   WHERE hook_id = v_hook_id;

  RETURN NEXT ok(v_bd ? 'regime',      '1: breakdown has regime');
  RETURN NEXT ok(v_bd ? 'slot_type',   '2: breakdown has slot_type');
  RETURN NEXT ok(v_bd ? 'top_topic',   '3: breakdown has top_topic');
  RETURN NEXT ok(v_bd ? 'age_days',    '4: breakdown has age_days');
  RETURN NEXT ok(v_bd ? 'components',  '5: breakdown has components');
  RETURN NEXT ok(v_bd ? 'weighted',    '6: breakdown has weighted');
  RETURN NEXT ok(v_bd ? 'score_total', '7: breakdown has score_total');
  RETURN NEXT ok(v_bd ? 'served_rank', '8: breakdown has served_rank');

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
