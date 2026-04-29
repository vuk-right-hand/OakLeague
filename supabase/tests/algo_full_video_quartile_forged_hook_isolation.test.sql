-- T-0504-8: AUDIT C4 SQL BELT. A forged full_video_quartile event whose
-- hook_id belongs to video B but whose video_id is video A must cooldown
-- only A's hooks, not B's. Pass B keys on f.video_id and JOINs hooks ON
-- hooks.video_id; the hook_id field is irrelevant to fanout.
--
-- The SSR null-out (page.tsx /v/[id] entry-hook validation) is the
-- suspenders; this test is the SQL belt. Even if a malicious client
-- forges hook_id at the API boundary, the cooldown applies to the
-- correct video — never the unrelated video whose hook was forged.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user       uuid := tests.create_auth_user('lf-forged@test');
  v_creator_u  uuid := tests.create_auth_user('lf-forged-c@test');
  v_creator_id uuid;
  v_video_a    uuid;
  v_video_b    uuid;
  v_video_a_lesson1 uuid;
  v_video_b_lesson1 uuid;
  v_count_a    int;
  v_count_b    int;
BEGIN
  UPDATE public.profiles SET handle = 'lfforgedc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator_u, 'C', 'lfforgedc', 'ready', now())
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');

  -- Two videos under the same creator. 2 hooks each (enough to verify
  -- "all hooks of A absent" + "all hooks of B present").
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'Video A', 2, 'ready')
    RETURNING id INTO v_video_a;
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'Video B', 2, 'ready')
    RETURNING id INTO v_video_b;
  FOR i IN 1..2 LOOP
    INSERT INTO public.hooks
      (video_id, lesson_number, mux_playback_id, duration_seconds,
       topic_tags, mux_status, published_at)
      VALUES (v_video_a, i, 'mux_forged_a_' || i::text, 30,
              ARRAY['cold_outreach'], 'ready', now());
    INSERT INTO public.hooks
      (video_id, lesson_number, mux_playback_id, duration_seconds,
       topic_tags, mux_status, published_at)
      VALUES (v_video_b, i, 'mux_forged_b_' || i::text, 30,
              ARRAY['cold_outreach'], 'ready', now());
  END LOOP;
  UPDATE public.videos SET published_at = now() WHERE id IN (v_video_a, v_video_b);
  SELECT id INTO v_video_a_lesson1
    FROM public.hooks WHERE video_id = v_video_a AND lesson_number = 1;
  SELECT id INTO v_video_b_lesson1
    FROM public.hooks WHERE video_id = v_video_b AND lesson_number = 1;

  -- Forged event: hook_id is from video B, but video_id is video A.
  -- (This shape would arrive if a client passed ?from=<B's hook id> on
  -- the long-form route for video A, before the SSR null-out fix. The
  -- ingest RPC doesn't validate hook_id belongs to video_id.)
  INSERT INTO public.feed_events_raw
    (user_id, hook_id, video_id, creator_id,
     event_name, idempotency_key, payload)
    VALUES (
      v_user, v_video_b_lesson1, v_video_a, v_creator_id,
      'full_video_quartile', gen_random_uuid(),
      jsonb_build_object('quartile', 100, 'source', 'pill')
    );

  PERFORM tests.set_authenticated(v_user);

  SELECT COUNT(*)::int INTO v_count_a
    FROM public.feed_ranked_page(50, NULL, '{}'::uuid[])
   WHERE video_id = v_video_a;
  SELECT COUNT(*)::int INTO v_count_b
    FROM public.feed_ranked_page(50, NULL, '{}'::uuid[])
   WHERE video_id = v_video_b;

  -- Pass B JOINs hooks ON hooks.video_id = events.video_id. The forged
  -- hook_id is ignored. Video A's hooks (the actual video_id of the
  -- event) get the 14d cooldown. Video B's hooks are unaffected.
  RETURN NEXT ok(
    v_count_a = 0,
    format('1: forged event still cooldowns the correct video (A) — 0 of 2 (got %s)', v_count_a)
  );
  RETURN NEXT ok(
    v_count_b = 2,
    format('2: video B hooks unaffected by forged hook_id — 2 of 2 served (got %s)', v_count_b)
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
