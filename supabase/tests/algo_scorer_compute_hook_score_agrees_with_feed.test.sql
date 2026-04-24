-- §9.4 sanity call 7: compute_hook_score and feed_ranked_page call the
-- SAME function, so scoring output must agree when invoked with matching
-- args. Drift between admin debugger and live scorer is structurally
-- impossible.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-agree@test');
  v_creator_u uuid := tests.create_auth_user('algo-agree-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_feed_score real;
  v_feed_regime text;
  v_feed_breakdown jsonb;
  v_direct jsonb;
  v_direct_score real;
BEGIN
  UPDATE public.profiles SET handle = 'agreec' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'A', 'agreec', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'raising_seed', 'R');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_pb_agree', 30, ARRAY['raising_seed'],
            'ready', now())
    RETURNING id INTO v_hook_id;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  -- Seed some user state.
  INSERT INTO public.user_topic_affinity (user_id, topic_slug, affinity_score)
    VALUES (v_user, 'raising_seed', 1.2);
  INSERT INTO public.user_creator_affinity (user_id, creator_id, affinity_score)
    VALUES (v_user, v_creator_id, 2.0);

  PERFORM tests.set_authenticated(v_user);

  -- Live path: feed_ranked_page produces the score for this hook.
  SELECT score_total, (score_breakdown->>'regime'), score_breakdown
    INTO v_feed_score, v_feed_regime, v_feed_breakdown
    FROM public.feed_ranked_page(10, NULL, '{}'::uuid[])
   WHERE hook_id = v_hook_id;

  PERFORM tests.reset_role();

  -- Direct call with the same args. The scoring pipeline uses default ceilings
  -- of 5.0 when the user's max_affinity < 5.0; both our topic (1.2) and
  -- creator (2.0) affinity are below the default, so pass 5.0 / 5.0 to match.
  v_direct := public.compute_hook_score(
    v_user, v_hook_id, 'exploit',
    v_feed_regime,
    0,               -- streak 0: no impressions yet
    5.0, 5.0,
    '{}'::text[]
  );
  v_direct_score := (v_direct->>'score_total')::real;

  RETURN NEXT ok(
    abs(v_feed_score - v_direct_score) < 1e-4,
    format(
      '1: feed_ranked_page (%s) and compute_hook_score (%s) agree within 1e-4',
      v_feed_score, v_direct_score
    )
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
