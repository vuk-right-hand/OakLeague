-- §9.8 / NM4 + C5: C5-qualifying events (dwell completion>=0.8, full_video_open,
-- or mic_tap session_opened) promote feed_regime straight to C.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-regime-c@test');
  v_creator_u uuid := tests.create_auth_user('algo-regime-c-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_regime feed_regime;
BEGIN
  UPDATE public.profiles SET handle = 'rccreator' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'RC', 'rccreator', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_rc', 30, ARRAY['cold_outreach'])
    RETURNING id INTO v_hook_id;

  -- dwell completion 0.9 → C5-qualifying.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'hook_dwell_end', v_hook_id, gen_random_uuid(),
            jsonb_build_object('dwell_ms', 28000, 'completion_pct', 0.9));

  SELECT feed_regime INTO v_regime FROM public.profiles WHERE id = v_user;
  RETURN NEXT is(
    v_regime, 'C'::feed_regime,
    '1: dwell completion>=0.8 promotes feed_regime straight to C'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
