-- §9.8 / NC1: ingest_feed_events_anon writes to the topic_affinity jsonb
-- blob with the same event-weight table as the authenticated rollup trigger.
-- full_video_open weight = 0.6 → blob["cold_outreach"] = 0.6.
BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_creator_u  uuid := tests.create_auth_user('algo-anon-ingest-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_anon_id    uuid := gen_random_uuid();
  v_inserted   int;
  v_dead       int;
  v_topic_score   real;
  v_creator_score real;
BEGIN
  UPDATE public.profiles SET handle = 'anoningest' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'Anon Ingest', 'anoningest', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'Cold Outreach');
  -- Video stays unpublished; the ingest RPC joins on h.video_id regardless
  -- of publish state, so the guard_published_requires_ready_hooks trigger
  -- doesn't need to be satisfied here.
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V1', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_test', 45, ARRAY['cold_outreach'])
    RETURNING id INTO v_hook_id;

  INSERT INTO public.anon_feed_sessions (anon_id) VALUES (v_anon_id);

  SELECT inserted, dead_zoned
    INTO v_inserted, v_dead
    FROM public.ingest_feed_events_anon(
      v_anon_id,
      jsonb_build_array(jsonb_build_object(
        'event_name', 'full_video_open',
        'hook_id',    v_hook_id::text,
        'payload',    jsonb_build_object('source', 'swipe')
      ))
    );

  RETURN NEXT is(v_inserted, 1, '1: 1 event inserted');
  RETURN NEXT is(v_dead,     0, '2: no dead-zone rejection');

  SELECT (topic_affinity->>'cold_outreach')::real,
         (creator_affinity->>v_creator_id::text)::real
    INTO v_topic_score, v_creator_score
    FROM public.anon_feed_sessions
   WHERE anon_id = v_anon_id;

  RETURN NEXT ok(
    abs(v_topic_score - 0.6) < 0.001,
    format('3: topic blob updated to full_video_open weight 0.6 (got %s)', v_topic_score)
  );
  RETURN NEXT ok(
    abs(v_creator_score - 0.6) < 0.001,
    format('4: creator blob updated to full_video_open weight 0.6 (got %s)', v_creator_score)
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
