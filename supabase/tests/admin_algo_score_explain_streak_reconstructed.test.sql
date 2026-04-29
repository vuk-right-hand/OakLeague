-- M-NEW4: streak reconstructed from feed_events_raw matches what the live
-- scorer saw. Seed 3 consecutive same-creator impressions in last 10 min;
-- assert reconstructed_creator_streak >= 2 AND breakdown reflects penalty.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-strk-admin@test');
  v_user  uuid := tests.create_auth_user('algo-strk-user@test');
  v_creat uuid := tests.create_auth_user('algo-strk-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id_a  uuid;
  v_hook_id_b  uuid;
  v_hook_id_c  uuid;
  v_resp jsonb;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-strk-admin@test', 'superadmin');

  UPDATE public.profiles SET handle = 'strkc' WHERE id = v_creat;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat, 'C', 'strkc', 'ready', now()) RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title) VALUES (v_creator_id, 'general', 'G');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 3, 'ready') RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_strk_a', 30, ARRAY['general'], 'ready', now())
    RETURNING id INTO v_hook_id_a;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 2, 'mux_strk_b', 30, ARRAY['general'], 'ready', now())
    RETURNING id INTO v_hook_id_b;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 3, 'mux_strk_c', 30, ARRAY['general'], 'ready', now())
    RETURNING id INTO v_hook_id_c;

  -- Three consecutive same-creator impressions in the last 10 minutes,
  -- ordered most-recent-first when the streak helper reads them.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, creator_id, idempotency_key, payload, created_at)
    VALUES
      (v_user, 'hook_impression', v_hook_id_a, v_creator_id, gen_random_uuid(),
       jsonb_build_object('served_rank', 0), now() - interval '3 minutes'),
      (v_user, 'hook_impression', v_hook_id_b, v_creator_id, gen_random_uuid(),
       jsonb_build_object('served_rank', 1), now() - interval '2 minutes'),
      (v_user, 'hook_impression', v_hook_id_c, v_creator_id, gen_random_uuid(),
       jsonb_build_object('served_rank', 2), now() - interval '1 minute');

  UPDATE public.videos SET published_at = now() WHERE published_at IS NULL;
  PERFORM tests.set_authenticated(v_admin);
  -- Asking about a 4th hook from the same creator → streak from tail = 3.
  v_resp := public.admin_algo_score_explain(v_user, v_hook_id_a, gen_random_uuid());

  RETURN NEXT ok(
    (v_resp->>'reconstructed_creator_streak')::int >= 2,
    format('1: streak >= 2 (got %s)', v_resp->>'reconstructed_creator_streak')
  );
  -- streak >= 3 → P_repeat = 0.8 → -W_REPEAT × P_repeat = -0.4.
  RETURN NEXT ok(
    (v_resp->'breakdown'->'weighted'->>'- W_REPEAT x P_repeat')::real <= -0.4,
    'breakdown weighted repeat term is <= -0.4 (penalty applied)'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
