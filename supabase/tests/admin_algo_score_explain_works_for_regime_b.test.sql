-- score_explain works for regime B — same breakdown shape; narrative
-- includes regime informational tail. v1 scorer is regime-agnostic.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-rB-admin@test');
  v_user  uuid := tests.create_auth_user('algo-rB-user@test');
  v_creat uuid := tests.create_auth_user('algo-rB-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_resp jsonb;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-rB-admin@test', 'superadmin');

  -- Force user into regime B.
  UPDATE public.profiles SET feed_regime = 'B' WHERE id = v_user;

  UPDATE public.profiles SET handle = 'rbc' WHERE id = v_creat;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat, 'C', 'rbc', 'ready', now()) RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title) VALUES (v_creator_id, 'general', 'G');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready') RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_rb', 30, ARRAY['general'], 'ready', now())
    RETURNING id INTO v_hook_id;

  UPDATE public.videos SET published_at = now() WHERE published_at IS NULL;
  PERFORM tests.set_authenticated(v_admin);
  v_resp := public.admin_algo_score_explain(v_user, v_hook_id, gen_random_uuid());

  RETURN NEXT is(v_resp->>'regime_label', 'B', '1: regime_label = B');
  RETURN NEXT ok(
    v_resp->>'narrative' LIKE '%Profile regime: B%',
    '2: narrative includes regime informational tail for B'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
