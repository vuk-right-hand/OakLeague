-- video_likes (COMMENTS_LIKES_PLAN L1):
--   1. anon has NO EXECUTE on like_video
--   2. authenticated HAS EXECUTE on like_video
--   3. like increments videos.like_count
--   4. idempotent re-like does not double-count
--   5. unlike decrements
--   6. double-unlike floors at 0
--   7. like on an unpublished creator's video is rejected (audit C4)
--   8. viewer_liked_state true after like, and false for a different user (own-read)
--   9. list_liked_videos returns the liked video; excludes a since-unpublished creator (takedown)
--   10. another user cannot read my video_likes rows (RLS own-read)
BEGIN;
SELECT plan(12);

SELECT is(
  (SELECT count(*)::int FROM pg_proc WHERE proname = 'like_video'
     AND has_function_privilege('anon', oid, 'EXECUTE')),
  0, '1: anon has no EXECUTE on like_video');
SELECT is(
  (SELECT count(*)::int FROM pg_proc WHERE proname = 'like_video'
     AND has_function_privilege('authenticated', oid, 'EXECUTE')),
  1, '2: authenticated HAS EXECUTE on like_video');

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('vl-user@test');
  v_other uuid := tests.create_auth_user('vl-other@test');
  v_creA uuid := tests.create_auth_user('vl-creA@test');
  v_creB uuid := tests.create_auth_user('vl-creB@test');
  v_cidA uuid; v_cidB uuid; v_vidA uuid; v_vidB uuid;
  v_lc int; v_cnt int; v_state boolean;
BEGIN
  PERFORM tests.reset_role();
  -- Published creator A + published video (needs a ready hook to publish).
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, voice_id, simli_face_id, system_prompt, published_at)
    VALUES (v_creA, 'A', 'vla', 'ready', 'v', 'f', 'x', now()) RETURNING id INTO v_cidA;
  INSERT INTO public.creator_topics (creator_id, slug, title) VALUES (v_cidA, 'general', 'G');
  INSERT INTO public.videos (creator_id, title, lesson_count, status) VALUES (v_cidA, 'A', 1, 'ready') RETURNING id INTO v_vidA;
  INSERT INTO public.hooks (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags, mux_status, published_at)
    VALUES (v_vidA, 1, 'mux_vla', 30, ARRAY['general'], 'ready', now());
  UPDATE public.videos SET published_at = now() WHERE id = v_vidA;

  -- UNPUBLISHED creator B + published video.
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, system_prompt)
    VALUES (v_creB, 'B', 'vlb', 'training', 'x') RETURNING id INTO v_cidB;
  INSERT INTO public.creator_topics (creator_id, slug, title) VALUES (v_cidB, 'general', 'G');
  INSERT INTO public.videos (creator_id, title, lesson_count, status) VALUES (v_cidB, 'B', 1, 'ready') RETURNING id INTO v_vidB;
  INSERT INTO public.hooks (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags, mux_status, published_at)
    VALUES (v_vidB, 1, 'mux_vlb', 30, ARRAY['general'], 'ready', now());
  UPDATE public.videos SET published_at = now() WHERE id = v_vidB;

  -- 3. Like increments.
  PERFORM tests.set_authenticated(v_user);
  PERFORM public.like_video(v_vidA);
  PERFORM tests.reset_role();
  SELECT like_count INTO v_lc FROM public.videos WHERE id = v_vidA;
  RETURN NEXT is(v_lc, 1, '3: like increments like_count');

  -- 4. Idempotent re-like.
  PERFORM tests.set_authenticated(v_user);
  PERFORM public.like_video(v_vidA);
  PERFORM tests.reset_role();
  SELECT like_count INTO v_lc FROM public.videos WHERE id = v_vidA;
  RETURN NEXT is(v_lc, 1, '4: re-like does not double-count');

  -- 5. Unlike decrements.
  PERFORM tests.set_authenticated(v_user);
  PERFORM public.unlike_video(v_vidA);
  PERFORM tests.reset_role();
  SELECT like_count INTO v_lc FROM public.videos WHERE id = v_vidA;
  RETURN NEXT is(v_lc, 0, '5: unlike decrements to 0');

  -- 6. Double-unlike floors at 0.
  PERFORM tests.set_authenticated(v_user);
  PERFORM public.unlike_video(v_vidA);
  PERFORM tests.reset_role();
  SELECT like_count INTO v_lc FROM public.videos WHERE id = v_vidA;
  RETURN NEXT is(v_lc, 0, '6: double-unlike floors at 0');

  -- 7. Unpublished creator rejected.
  PERFORM tests.set_authenticated(v_user);
  RETURN NEXT throws_like(
    format('SELECT public.like_video(%L)', v_vidB),
    '%video_not_available%', '7: like on unpublished creator rejected');

  -- 8. viewer_liked_state. Re-like A first.
  PERFORM public.like_video(v_vidA);
  RETURN NEXT is(public.viewer_liked_state(v_vidA), true, '8a: liker sees true');
  PERFORM tests.set_authenticated(v_other);
  SELECT public.viewer_liked_state(v_vidA) INTO v_state;
  RETURN NEXT is(v_state, false, '8: a different user sees false (own state)');

  -- 9. list_liked_videos returns A, then takedown hides it.
  PERFORM tests.set_authenticated(v_user);
  SELECT count(*)::int INTO v_cnt FROM public.list_liked_videos(NULL, NULL, 30) WHERE video_id = v_vidA;
  RETURN NEXT is(v_cnt, 1, '9a: list_liked_videos returns the liked video');
  PERFORM tests.reset_role();
  UPDATE public.creators SET published_at = NULL WHERE id = v_cidA;
  PERFORM tests.set_authenticated(v_user);
  SELECT count(*)::int INTO v_cnt FROM public.list_liked_videos(NULL, NULL, 30) WHERE video_id = v_vidA;
  RETURN NEXT is(v_cnt, 0, '9: takedown removes the video from the liked list');

  -- 10. Own-read isolation.
  PERFORM tests.set_authenticated(v_other);
  SELECT count(*)::int INTO v_cnt FROM public.video_likes WHERE user_id = v_user;
  RETURN NEXT is(v_cnt, 0, '10: another user cannot read my video_likes (RLS)');
  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
