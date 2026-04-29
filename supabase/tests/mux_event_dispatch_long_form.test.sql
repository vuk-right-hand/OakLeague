-- T-0504-2: apply_mux_event dispatches video.asset.ready to the
-- 'video_long_form' branch when the payload's passthrough matches
-- videos.long_form_mux_passthrough. Asserts status, playback id,
-- aspect ratio, duration_ms, and CEIL'd duration_seconds all land.
BEGIN;
SELECT plan(5);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_creator_u   uuid := tests.create_auth_user('lf-disp@test');
  v_creator_id  uuid;
  v_video_id    uuid;
  v_passthrough uuid;
  v_status      text;
  v_pb          text;
  v_ar          text;
  v_ms          integer;
  v_secs        integer;
BEGIN
  UPDATE public.profiles SET handle = 'lfdisp' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'LF Disp', 'lfdisp', 'ready', now())
    RETURNING id INTO v_creator_id;

  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id, long_form_mux_passthrough INTO v_video_id, v_passthrough;

  -- Simulate Mux video.asset.ready webhook with our passthrough.
  PERFORM public.apply_mux_event(
    'evt_lf_ready_' || gen_random_uuid()::text,
    'video.asset.ready',
    jsonb_build_object(
      'data', jsonb_build_object(
        'id', 'asset_lf_001',
        'passthrough', v_passthrough::text,
        'playback_ids', jsonb_build_array(jsonb_build_object('id', 'pb_lf_001')),
        'aspect_ratio', '16:9',
        -- 1234.6 seconds = 1234600 ms; CEIL(1234.6) = 1235 seconds
        'duration', 1234.6
      )
    )
  );

  SELECT long_form_mux_status, long_form_mux_playback_id,
         long_form_mux_aspect_ratio, long_form_mux_duration_ms,
         long_form_duration_seconds
    INTO v_status, v_pb, v_ar, v_ms, v_secs
    FROM public.videos WHERE id = v_video_id;

  RETURN NEXT ok(v_status = 'ready', format('1: status=ready (got %s)', v_status));
  RETURN NEXT ok(v_pb = 'pb_lf_001', format('2: playback_id set (got %s)', v_pb));
  RETURN NEXT ok(v_ar = '16:9', format('3: aspect_ratio=16:9 (got %s)', v_ar));
  RETURN NEXT ok(v_ms = 1234600, format('4: duration_ms=1234600 (got %s)', v_ms));
  RETURN NEXT ok(v_secs = 1235, format('5: duration_seconds CEIL''d to 1235 (got %s)', v_secs));
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
