-- §9.8 / NM2: S_creator uses GREATEST(5.0, MAX(affinity_score)) as the
-- normalization ceiling so a heavy-engagement user (affinity = 7.0 after
-- two 10-min sessions) doesn't saturate at 1.0 and lose ranking resolution.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-nm2@test');
  v_creator_u uuid := tests.create_auth_user('algo-nm2-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
  v_bd jsonb;
  v_s_creator real;
BEGIN
  UPDATE public.profiles SET handle = 'nm2c' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'N2', 'nm2c', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_pb_nm2', 30, ARRAY['cold_outreach'],
            'ready', now())
    RETURNING id INTO v_hook_id;
  UPDATE public.videos SET published_at = now() WHERE id = v_video_id;

  -- Seed creator_affinity = 7.0 (realistic post-2-session accumulation).
  INSERT INTO public.user_creator_affinity (user_id, creator_id, affinity_score)
    VALUES (v_user, v_creator_id, 7.0);

  -- With hardcoded 5.0 ceiling: S_creator = min(1.0, 7.0/5.0) = 1.0 (saturated).
  -- With dynamic max = 7.0: S_creator = min(1.0, 7.0/7.0) = 1.0 still, but any
  -- OTHER creator with score 3.0 would compute 3/7 = 0.43 vs the pre-fix 3/5 =
  -- 0.6 — preserving resolution for that 3.0 creator. The key test is that
  -- the dynamic ceiling is actually applied, not the hardcoded 5.0.

  -- Compute directly with user_creator_max = 7.0 (what feed_ranked_page
  -- would compute) and expect S_creator = 7/7 = 1.0.
  v_bd := public.compute_hook_score(
    v_user, v_hook_id, 'exploit', 'C', 0, 5.0, 7.0, '{}'::text[]
  );
  v_s_creator := (v_bd->'components'->>'S_creator')::real;
  RETURN NEXT ok(
    abs(v_s_creator - 1.0) < 1e-6,
    format('1: with p_user_creator_max=7.0, S_creator = 1.0 (got %s)', v_s_creator)
  );

  -- Pass hardcoded p_user_creator_max = 5.0 and expect LEAST(1.0, 7.0/5.0) = 1.0.
  -- Same saturated number, but different ceiling math. The dynamic-ceiling
  -- fix's value shows up when a SECOND creator at score 3.0 is compared.
  -- Seed a second creator with affinity 3.0, score its hook, compare:
  --   - With user_creator_max = 7.0 (dynamic): 3/7 ≈ 0.4286
  --   - With user_creator_max = 5.0 (hardcoded): 3/5 = 0.6
  DECLARE
    v_creator2_u uuid := tests.create_auth_user('algo-nm2-c2@test');
    v_creator2_id uuid;
    v_video2_id uuid;
    v_hook2_id uuid;
    v_bd_dyn jsonb;
    v_bd_hard jsonb;
  BEGIN
    UPDATE public.profiles SET handle = 'nm2c2' WHERE id = v_creator2_u;
    INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
      VALUES (v_creator2_u, 'N2-2', 'nm2c2', 'ready', now())
      RETURNING id INTO v_creator2_id;
    INSERT INTO public.creator_topics (creator_id, slug, title)
      VALUES (v_creator2_id, 'cold_outreach', 'C');
    INSERT INTO public.videos (creator_id, title, lesson_count, status)
      VALUES (v_creator2_id, 'V2', 1, 'ready')
      RETURNING id INTO v_video2_id;
    INSERT INTO public.hooks
      (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
       mux_status, published_at)
      VALUES (v_video2_id, 1, 'mux_pb_nm2_2', 30, ARRAY['cold_outreach'],
              'ready', now())
      RETURNING id INTO v_hook2_id;
    UPDATE public.videos SET published_at = now() WHERE id = v_video2_id;

    INSERT INTO public.user_creator_affinity (user_id, creator_id, affinity_score)
      VALUES (v_user, v_creator2_id, 3.0);

    v_bd_dyn  := public.compute_hook_score(v_user, v_hook2_id, 'exploit', 'C', 0,
                                            5.0, 7.0, '{}'::text[]);
    v_bd_hard := public.compute_hook_score(v_user, v_hook2_id, 'exploit', 'C', 0,
                                            5.0, 5.0, '{}'::text[]);

    RETURN NEXT ok(
      (v_bd_dyn->'components'->>'S_creator')::real
        < (v_bd_hard->'components'->>'S_creator')::real,
      format(
        '2: dynamic ceiling (3/7=%s) preserves resolution below hardcoded (3/5=%s)',
        v_bd_dyn->'components'->>'S_creator',
        v_bd_hard->'components'->>'S_creator'
      )
    );
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
