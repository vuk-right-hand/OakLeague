-- Round-3 medium: the 0-indexed slot field was killed; envelope must NOT
-- contain served_slot_zero_indexed. Single canonical field
-- (display_slot_one_indexed) avoids consumer confusion.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-nzi-admin@test');
  v_user  uuid := tests.create_auth_user('algo-nzi-user@test');
  v_creat uuid := tests.create_auth_user('algo-nzi-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_resp jsonb;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-nzi-admin@test', 'superadmin');

  UPDATE public.profiles SET handle = 'nzic' WHERE id = v_creat;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat, 'C', 'nzic', 'ready', now()) RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title) VALUES (v_creator_id, 'general', 'G');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready') RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_nzi', 30, ARRAY['general'], 'ready', now())
    RETURNING id INTO v_hook_id;

  UPDATE public.videos SET published_at = now() WHERE published_at IS NULL;
  PERFORM tests.set_authenticated(v_admin);
  v_resp := public.admin_algo_score_explain(v_user, v_hook_id, gen_random_uuid());

  RETURN NEXT ok(
    NOT (v_resp ? 'served_slot_zero_indexed'),
    '1: envelope does NOT contain served_slot_zero_indexed (single canonical field)'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
