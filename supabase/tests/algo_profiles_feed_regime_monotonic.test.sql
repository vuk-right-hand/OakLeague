-- §9.8 / NM4: feed_regime promotion is monotonic (A→B→C only, never
-- downgrade). After setting regime='C', subsequent low-weight events
-- (hook_impression weight 0.02) do not touch the column.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-regime-mono@test');
  v_creator_u uuid := tests.create_auth_user('algo-regime-mono-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_regime feed_regime;
BEGIN
  UPDATE public.profiles SET handle = 'rmono' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'RM', 'rmono', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_rm', 30, ARRAY['cold_outreach'])
    RETURNING id INTO v_hook_id;

  -- Manually set regime = 'C'.
  UPDATE public.profiles SET feed_regime = 'C' WHERE id = v_user;

  -- Fire 3 low-weight hook_impression events.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES
    (v_user, 'hook_impression', v_hook_id, gen_random_uuid(), '{}'::jsonb),
    (v_user, 'hook_impression', v_hook_id, gen_random_uuid(), '{}'::jsonb),
    (v_user, 'hook_impression', v_hook_id, gen_random_uuid(), '{}'::jsonb);

  SELECT feed_regime INTO v_regime FROM public.profiles WHERE id = v_user;
  RETURN NEXT is(
    v_regime, 'C'::feed_regime,
    '1: low-weight events never downgrade feed_regime (C stays C)'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
