-- funnel_7d counts distinct (user_id, hook_id) pairs at impressions stage.
-- Two impressions on the same hook → impressions = 1.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-fdc-admin@test');
  v_user  uuid := tests.create_auth_user('algo-fdc-user@test');
  v_creat uuid := tests.create_auth_user('algo-fdc-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_funnel jsonb;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-fdc-admin@test', 'superadmin');

  UPDATE public.profiles SET handle = 'fdcc' WHERE id = v_creat;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat, 'FDC', 'fdcc', 'ready', now()) RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title) VALUES (v_creator_id, 'general', 'G');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready') RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_fdc', 30, ARRAY['general'], 'ready', now())
    RETURNING id INTO v_hook_id;

  -- Two impressions on the same hook.
  INSERT INTO public.feed_events_raw (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'hook_impression', v_hook_id, gen_random_uuid(),
            jsonb_build_object('served_rank', 0));
  INSERT INTO public.feed_events_raw (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'hook_impression', v_hook_id, gen_random_uuid(),
            jsonb_build_object('served_rank', 0));

  UPDATE public.videos SET published_at = now() WHERE published_at IS NULL;
  PERFORM tests.set_authenticated(v_admin);
  v_funnel := public.admin_algo_funnel_7d(v_user);

  RETURN NEXT is((v_funnel->>'impressions')::int, 1,
                 '1: 2 impressions same hook → distinct count = 1');
  RETURN NEXT is((v_funnel->>'window_days')::int, 7,
                 '2: window_days = 7');

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
