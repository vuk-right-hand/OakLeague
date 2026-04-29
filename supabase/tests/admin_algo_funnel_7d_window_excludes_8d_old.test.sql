-- funnel_7d excludes events older than 7 days.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-7dw-admin@test');
  v_user  uuid := tests.create_auth_user('algo-7dw-user@test');
  v_creat uuid := tests.create_auth_user('algo-7dw-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_funnel jsonb;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-7dw-admin@test', 'superadmin');

  UPDATE public.profiles SET handle = '7dwc' WHERE id = v_creat;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat, 'C', '7dwc', 'ready', now()) RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'general', 'G');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready') RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_7dw', 30, ARRAY['general'], 'ready', now())
    RETURNING id INTO v_hook_id;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  -- 8d-old event with valid hook FK.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, idempotency_key, payload, created_at)
    VALUES (v_user, 'hook_impression', v_hook_id, gen_random_uuid(),
            jsonb_build_object('served_rank', 0), now() - interval '8 days');

  PERFORM tests.set_authenticated(v_admin);
  v_funnel := public.admin_algo_funnel_7d(v_user);

  RETURN NEXT is((v_funnel->>'impressions')::int, 0,
                 '1: 8d-old event excluded from 7d window');

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
