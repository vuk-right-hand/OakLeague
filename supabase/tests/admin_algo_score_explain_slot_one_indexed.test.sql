-- Round-3 critical 4: slot is 0-indexed in payload (slot_idx) but 1-indexed
-- in narrative ("Shown in slot #1") and envelope (display_slot_one_indexed).
-- Seeded served_rank=0 → narrative says "slot #1", display_slot_one_indexed=1.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-soi-admin@test');
  v_user  uuid := tests.create_auth_user('algo-soi-user@test');
  v_creat uuid := tests.create_auth_user('algo-soi-c@test');
  v_creator_id uuid;
  v_video_id   uuid;
  v_hook_id    uuid;
  v_resp jsonb;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-soi-admin@test', 'superadmin');

  UPDATE public.profiles SET handle = 'soic' WHERE id = v_creat;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat, 'C', 'soic', 'ready', now()) RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title) VALUES (v_creator_id, 'general', 'G');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready') RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_id, 1, 'mux_soi', 30, ARRAY['general'], 'ready', now())
    RETURNING id INTO v_hook_id;

  -- Seed an impression with served_rank=0 (slot 0, top of feed page).
  INSERT INTO public.feed_events_raw
    (user_id, event_name, hook_id, idempotency_key, payload)
    VALUES (v_user, 'hook_impression', v_hook_id, gen_random_uuid(),
            jsonb_build_object('served_rank', 0));

  UPDATE public.videos SET published_at = now() WHERE published_at IS NULL;
  PERFORM tests.set_authenticated(v_admin);
  v_resp := public.admin_algo_score_explain(v_user, v_hook_id, gen_random_uuid());

  RETURN NEXT is(
    (v_resp->>'display_slot_one_indexed')::int, 1,
    '1: display_slot_one_indexed = served_rank + 1 = 1'
  );
  RETURN NEXT ok(
    v_resp->>'narrative' LIKE '%slot #1%',
    '2: narrative contains "slot #1" (1-indexed for humans)'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
