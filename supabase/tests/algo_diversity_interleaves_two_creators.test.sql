-- 0613-03 fix 2: slate diversity penalized re-rank, exact-order assertion.
-- Creator A holds the top-3 scores (affinity 5.0), creator B the next 3.
-- With W_DIVERSITY_STEP=2 the penalized keys are:
--   A1: rn1 seq1 -> 1     B1: rn4 seq1 -> 4 (tie w/ A2, rn breaks -> A2 first)
--   A2: rn2 seq2 -> 4     B2: rn5 seq2 -> 7 (tie w/ A3 -> A3 first)
--   A3: rn3 seq3 -> 7     B3: rn6 seq3 -> 10
-- Served creator order: A, A, B, A, B, B. Non-sparse topic => no explore rows.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-div2@test');
  v_ca_u uuid := tests.create_auth_user('algo-div2-a@test');
  v_cb_u uuid := tests.create_auth_user('algo-div2-b@test');
  v_ca uuid; v_cb uuid;
  v_va uuid; v_vb uuid;
  v_i int;
  v_order text;
BEGIN
  UPDATE public.profiles SET handle = 'div2a' WHERE id = v_ca_u;
  UPDATE public.profiles SET handle = 'div2b' WHERE id = v_cb_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_ca_u, 'A', 'div2a', 'ready', now()) RETURNING id INTO v_ca;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cb_u, 'B', 'div2b', 'ready', now()) RETURNING id INTO v_cb;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_ca, 'cold_outreach', 'C'), (v_cb, 'cold_outreach', 'C');

  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_ca, 'VA', 3, 'ready') RETURNING id INTO v_va;
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_cb, 'VB', 3, 'ready') RETURNING id INTO v_vb;

  -- A hooks newest (rn 1-3 by score: affinity + recency), B hooks older.
  FOR v_i IN 1..3 LOOP
    INSERT INTO public.hooks
      (video_id, lesson_number, mux_playback_id, duration_seconds,
       topic_tags, mux_status, published_at, created_at)
      VALUES (v_va, v_i, 'mux_div2_a' || v_i, 30, ARRAY['cold_outreach'],
              'ready', now() - (v_i || ' minutes')::interval,
              now() - (v_i || ' minutes')::interval);
    INSERT INTO public.hooks
      (video_id, lesson_number, mux_playback_id, duration_seconds,
       topic_tags, mux_status, published_at, created_at)
      VALUES (v_vb, v_i, 'mux_div2_b' || v_i, 30, ARRAY['cold_outreach'],
              'ready', now() - ((10 + v_i) || ' minutes')::interval,
              now() - ((10 + v_i) || ' minutes')::interval);
  END LOOP;
  UPDATE public.videos SET published_at = now() WHERE id IN (v_va, v_vb);

  -- A dominates via creator affinity; non-sparse topic kills explore.
  INSERT INTO public.user_creator_affinity (user_id, creator_id, affinity_score)
    VALUES (v_user, v_ca, 5.0);
  INSERT INTO public.user_topic_affinity (user_id, topic_slug, impressions, affinity_score)
    VALUES (v_user, 'cold_outreach', 5, 0);

  PERFORM tests.set_authenticated(v_user);
  SELECT string_agg(CASE WHEN p.creator_id = v_ca THEN 'A' ELSE 'B' END, '' ORDER BY p.served_rank)
    INTO v_order
    FROM public.feed_ranked_page(6, NULL, '{}'::uuid[]) p;
  PERFORM tests.reset_role();

  RETURN NEXT is(length(v_order), 6, format('1: six slots served (%s)', v_order));
  RETURN NEXT is(v_order, 'AABABB',
    format('2: penalized re-rank interleaves AABABB per step-2 math (got %s)', v_order));
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
