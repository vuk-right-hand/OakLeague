-- watch_history (PROFILE_SYSTEM_PLAN U1 / §3.4):
--   1. anon has NO EXECUTE on record_watch
--   2. authenticated HAS EXECUTE on record_watch
--   3. record_watch on a published video+creator writes a row (view_count = 1)
--   4. re-record bumps view_count to 2 (upsert)
--   5. record_watch on an UNPUBLISHED creator's video is rejected (audit C3/M6)
--   6. list_watch_history returns the watched video
--   7. takedown: unpublishing the creator drops the video from history (audit C3)
--   8. own-read isolation: another user cannot see my watch_history (RLS)
--   9. clear_watch_history empties own history
BEGIN;
SELECT plan(9);

SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'record_watch'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  0, '1: anon has no EXECUTE on record_watch');
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'record_watch'
      AND has_function_privilege('authenticated', oid, 'EXECUTE')),
  1, '2: authenticated HAS EXECUTE on record_watch');

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_owner uuid := tests.create_auth_user('wh-owner@test');
  v_other uuid := tests.create_auth_user('wh-other@test');
  v_creA  uuid := tests.create_auth_user('wh-creA@test');
  v_creB  uuid := tests.create_auth_user('wh-creB@test');
  v_cidA  uuid;
  v_cidB  uuid;
  v_vidA  uuid;
  v_vidB  uuid;
  v_vc    int;
  v_cnt   int;
BEGIN
  PERFORM tests.reset_role();
  -- Published creator A + published video (needs a ready hook before publish —
  -- videos publish guard, 20260425000001).
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, voice_id, simli_face_id, system_prompt, published_at)
  VALUES (v_creA, 'Cre A', 'wha', 'ready', 'v', 'f', 'x', now())
  RETURNING id INTO v_cidA;
  INSERT INTO public.creator_topics (creator_id, slug, title) VALUES (v_cidA, 'general', 'G');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
  VALUES (v_cidA, 'Vid A', 1, 'ready') RETURNING id INTO v_vidA;
  INSERT INTO public.hooks (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags, mux_status, published_at)
  VALUES (v_vidA, 1, 'mux_a', 30, ARRAY['general'], 'ready', now());
  UPDATE public.videos SET published_at = now() WHERE id = v_vidA;

  -- UNPUBLISHED creator B + a published video.
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, system_prompt)
  VALUES (v_creB, 'Cre B', 'whb', 'training', 'x')
  RETURNING id INTO v_cidB;
  INSERT INTO public.creator_topics (creator_id, slug, title) VALUES (v_cidB, 'general', 'G');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
  VALUES (v_cidB, 'Vid B', 1, 'ready') RETURNING id INTO v_vidB;
  INSERT INTO public.hooks (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags, mux_status, published_at)
  VALUES (v_vidB, 1, 'mux_b', 30, ARRAY['general'], 'ready', now());
  UPDATE public.videos SET published_at = now() WHERE id = v_vidB;

  -- 3. record_watch (published) → view_count 1.
  PERFORM tests.set_authenticated(v_owner);
  PERFORM public.record_watch(v_vidA);
  PERFORM tests.reset_role();
  SELECT view_count INTO v_vc FROM public.watch_history WHERE user_id = v_owner AND video_id = v_vidA;
  RETURN NEXT is(v_vc, 1, '3: record_watch writes a row (view_count = 1)');

  -- 4. Re-record bumps view_count.
  PERFORM tests.set_authenticated(v_owner);
  PERFORM public.record_watch(v_vidA);
  PERFORM tests.reset_role();
  SELECT view_count INTO v_vc FROM public.watch_history WHERE user_id = v_owner AND video_id = v_vidA;
  RETURN NEXT is(v_vc, 2, '4: re-record bumps view_count to 2');

  -- 5. Unpublished creator's video rejected.
  PERFORM tests.set_authenticated(v_owner);
  RETURN NEXT throws_like(
    format('SELECT public.record_watch(%L)', v_vidB),
    '%video_not_available%', '5: record_watch on unpublished creator rejected');

  -- 6. list_watch_history returns vidA.
  SELECT count(*)::int INTO v_cnt FROM public.list_watch_history(NULL, 30) WHERE video_id = v_vidA;
  RETURN NEXT is(v_cnt, 1, '6: list_watch_history returns the watched video');
  PERFORM tests.reset_role();

  -- 7. Takedown: unpublish creator A → vidA drops from history.
  UPDATE public.creators SET published_at = NULL WHERE id = v_cidA;
  PERFORM tests.set_authenticated(v_owner);
  SELECT count(*)::int INTO v_cnt FROM public.list_watch_history(NULL, 30) WHERE video_id = v_vidA;
  RETURN NEXT is(v_cnt, 0, '7: takedown removes the video from watch history');

  -- 8. Own-read isolation: other user sees none of owner's rows.
  PERFORM tests.set_authenticated(v_other);
  SELECT count(*)::int INTO v_cnt FROM public.watch_history WHERE user_id = v_owner;
  RETURN NEXT is(v_cnt, 0, '8: another user cannot read my watch_history (RLS)');

  -- 9. clear_watch_history empties own.
  PERFORM tests.set_authenticated(v_owner);
  PERFORM public.clear_watch_history();
  PERFORM tests.reset_role();
  SELECT count(*)::int INTO v_cnt FROM public.watch_history WHERE user_id = v_owner;
  RETURN NEXT is(v_cnt, 0, '9: clear_watch_history empties own history');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
