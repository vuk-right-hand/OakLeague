-- T-0504-1: videos.long_form_duration_seconds DB CHECK is loose 60–3600.
-- The user-facing 5–55 min (300–3300) rule lives in publishLongForm at the
-- application layer; the DB CHECK is belt-and-suspenders against
-- nonsense values landing through the webhook on a non-policy-checked path.
BEGIN;
SELECT plan(5);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_creator_u  uuid := tests.create_auth_user('lf-dur-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
BEGIN
  UPDATE public.profiles SET handle = 'lfdurc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'LF Dur', 'lfdurc', 'ready', now())
    RETURNING id INTO v_creator_id;

  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;

  -- 1. NULL accepted (column is nullable; long-form is optional).
  UPDATE public.videos SET long_form_duration_seconds = NULL WHERE id = v_video_id;
  RETURN NEXT ok(
    (SELECT long_form_duration_seconds IS NULL FROM public.videos WHERE id = v_video_id),
    '1: NULL accepted'
  );

  -- 2. 60 (lower bound) accepted.
  UPDATE public.videos SET long_form_duration_seconds = 60 WHERE id = v_video_id;
  RETURN NEXT ok(
    (SELECT long_form_duration_seconds = 60 FROM public.videos WHERE id = v_video_id),
    '2: 60 accepted (lower bound)'
  );

  -- 3. 3600 (upper bound) accepted.
  UPDATE public.videos SET long_form_duration_seconds = 3600 WHERE id = v_video_id;
  RETURN NEXT ok(
    (SELECT long_form_duration_seconds = 3600 FROM public.videos WHERE id = v_video_id),
    '3: 3600 accepted (upper bound)'
  );

  -- 4. 59 rejected.
  RETURN NEXT throws_ok(
    format($q$UPDATE public.videos SET long_form_duration_seconds = 59 WHERE id = %L$q$, v_video_id),
    '23514',
    NULL,
    '4: 59 rejected (below 60)'
  );

  -- 5. 3601 rejected.
  RETURN NEXT throws_ok(
    format($q$UPDATE public.videos SET long_form_duration_seconds = 3601 WHERE id = %L$q$, v_video_id),
    '23514',
    NULL,
    '5: 3601 rejected (above 3600)'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
