-- funnel_7d handles malformed completion_pct (string) without crashing.
-- The _jsonb_real helper returns NULL → comparison >=0.8 → NULL → row excluded.
-- Pre-hardening, the cast (payload->>'completion_pct')::real would raise
-- 22P02 (invalid_text_representation) and abort the funnel call entirely.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-fmal-admin@test');
  v_user  uuid := tests.create_auth_user('algo-fmal-user@test');
  v_creat uuid := tests.create_auth_user('algo-fmal-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_funnel jsonb;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-fmal-admin@test', 'superadmin');

  UPDATE public.profiles SET handle = 'fmalc' WHERE id = v_creat;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat, 'C', 'fmalc', 'ready', now()) RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title) VALUES (v_creator_id, 'general', 'G');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready') RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_fmal', 30, ARRAY['general'], 'ready', now())
    RETURNING id INTO v_hook_id;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  -- Malformed completion_pct (string). With hook_id non-null, the row
  -- reaches the WHERE clause's _jsonb_real comparison.
  INSERT INTO public.feed_events_raw (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'hook_dwell_end', v_hook_id, gen_random_uuid(),
            jsonb_build_object('completion_pct', '0.9'));

  PERFORM tests.set_authenticated(v_admin);
  v_funnel := public.admin_algo_funnel_7d(v_user);

  RETURN NEXT is((v_funnel->>'dwell_ge_80')::int, 0,
                 '1: malformed completion_pct row not counted; no crash');

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
