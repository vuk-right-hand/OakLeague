-- Regression: PostgreSQL's format() doesn't support printf-style %.Nf
-- specifiers. Earlier the narrative helper used '%.2f' for S_topic /
-- S_creator values, which crashes the explainer for any user/hook combo
-- that triggers the "strong match" or "creator engaged with" branches.
-- Numeric values must be passed as %s with to_char(...) formatting.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-fmt-admin@test');
  v_user  uuid := tests.create_auth_user('algo-fmt-user@test');
  v_creat uuid := tests.create_auth_user('algo-fmt-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_resp jsonb;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-fmt-admin@test', 'superadmin');

  UPDATE public.profiles SET feed_regime = 'C' WHERE id = v_user;
  -- High S_topic + S_creator triggers both branches with numeric formatting.
  INSERT INTO public.user_topic_affinity (user_id, topic_slug, affinity_score)
    VALUES (v_user, 'general', 4.5);
  UPDATE public.profiles SET handle = 'fmtc' WHERE id = v_creat;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat, 'C', 'fmtc', 'ready', now()) RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'general', 'G');
  INSERT INTO public.user_creator_affinity (user_id, creator_id, affinity_score)
    VALUES (v_user, v_creator_id, 3.0);
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready') RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_fmt', 30, ARRAY['general'], 'ready', now())
    RETURNING id INTO v_hook_id;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  PERFORM tests.set_authenticated(v_admin);

  -- Pre-fix: this raises 22023 'unrecognized format() type specifier "."'.
  -- Post-fix: returns a narrative containing the formatted S_topic value.
  v_resp := public.admin_algo_score_explain(v_user, v_hook_id, gen_random_uuid());

  -- Creator-clause format() call exercises the same to_char path as the
  -- topic-clause one — proves no '%.Nf' crash for either.
  RETURN NEXT ok(
    v_resp->>'narrative' ~ '\(S_creator [0-9]+\.[0-9]{2}\)',
    '1: high-affinity narrative renders 2-decimal format via to_char, no crash'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
