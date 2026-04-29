-- Streak resets when a different creator is interleaved most-recently.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin   uuid := tests.create_auth_user('algo-srst-admin@test');
  v_user    uuid := tests.create_auth_user('algo-srst-user@test');
  v_creat_a uuid := tests.create_auth_user('algo-srst-ca@test');
  v_creat_b uuid := tests.create_auth_user('algo-srst-cb@test');
  v_creator_a uuid;
  v_creator_b uuid;
  v_video_a   uuid;
  v_video_b   uuid;
  v_hook_a    uuid;
  v_hook_b    uuid;
  v_resp jsonb;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-srst-admin@test', 'superadmin');

  UPDATE public.profiles SET handle = 'srsta' WHERE id = v_creat_a;
  UPDATE public.profiles SET handle = 'srstb' WHERE id = v_creat_b;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat_a, 'A', 'srsta', 'ready', now()) RETURNING id INTO v_creator_a;
  INSERT INTO public.creator_topics (creator_id, slug, title) VALUES (v_creator_a, 'general', 'G');
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat_b, 'B', 'srstb', 'ready', now()) RETURNING id INTO v_creator_b;
  INSERT INTO public.creator_topics (creator_id, slug, title) VALUES (v_creator_b, 'general', 'G');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_a, 'VA', 1, 'ready') RETURNING id INTO v_video_a;
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_b, 'VB', 1, 'ready') RETURNING id INTO v_video_b;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_a, 1, 'mux_srst_a', 30, ARRAY['general'], 'ready', now())
    RETURNING id INTO v_hook_a;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_b, 1, 'mux_srst_b', 30, ARRAY['general'], 'ready', now())
    RETURNING id INTO v_hook_b;

  -- 2 consecutive A, then most-recent B. Streak from tail for "next A" = 0.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, creator_id, idempotency_key, payload, created_at)
    VALUES
      (v_user, 'hook_impression', v_hook_a, v_creator_a, gen_random_uuid(),
       jsonb_build_object('served_rank', 0), now() - interval '3 minutes'),
      (v_user, 'hook_impression', v_hook_a, v_creator_a, gen_random_uuid(),
       jsonb_build_object('served_rank', 1), now() - interval '2 minutes'),
      (v_user, 'hook_impression', v_hook_b, v_creator_b, gen_random_uuid(),
       jsonb_build_object('served_rank', 2), now() - interval '1 minute');

  UPDATE public.videos SET published_at = now() WHERE published_at IS NULL;
  PERFORM tests.set_authenticated(v_admin);
  -- Asking about creator A — but most recent is creator B → streak = 0.
  v_resp := public.admin_algo_score_explain(v_user, v_hook_a, gen_random_uuid());

  RETURN NEXT ok(
    (v_resp->>'reconstructed_creator_streak')::int <= 1,
    format('1: streak resets when different creator is most-recent (got %s)',
           v_resp->>'reconstructed_creator_streak')
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
