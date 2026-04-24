-- §9.8 / NM4: rollup trigger promotes profiles.feed_regime A→B on any event
-- with weight >= 0.6 (meaningful but not C5-qualifying). Uses
-- full_video_open which IS C5 → actually promotes to C, so we use
-- full_video_quartile=100 (weight 1.0) which is >= 0.6 but NOT in C5.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-regime-b@test');
  v_creator_u uuid := tests.create_auth_user('algo-regime-b-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_regime feed_regime;
BEGIN
  UPDATE public.profiles SET handle = 'rbcreator' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'RB', 'rbcreator', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_rb', 30, ARRAY['cold_outreach'])
    RETURNING id INTO v_hook_id;

  -- quartile=100 has weight 1.0 (>= 0.6) but is NOT in the C5 list.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'full_video_quartile', v_hook_id, gen_random_uuid(),
            jsonb_build_object('quartile', 100));

  SELECT feed_regime INTO v_regime
    FROM public.profiles WHERE id = v_user;
  RETURN NEXT is(
    v_regime, 'B'::feed_regime,
    '1: weight-1.0 non-C5 event promotes feed_regime A → B'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
