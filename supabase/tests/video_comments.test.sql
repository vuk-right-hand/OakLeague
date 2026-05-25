-- video_comments (COMMENTS_LIKES_PLAN C1). Heavy focus on the count-trigger
-- compound transitions (audit C1) and the depth guard (audit C2).
--   1.  anon has NO EXECUTE on post_comment
--   2.  authenticated HAS EXECUTE on post_comment
--   3.  authenticated has NO table SELECT on comment_reports (service-role only, audit C3/Small)
--   4.  post top-level → comment_count = 1
--   5.  valid reply → comment_count = 2
--   6.  reply-to-reply rejected (bad_parent, one-level)
--   7.  cross-video parent rejected (bad_parent)
--   8.  non-author delete_own is a no-op (count unchanged)
--   9.  author soft-deletes own reply → count back to 1
--   10. creator hides top-level → count 0
--   11. reply under a HIDDEN parent rejected (moderation-evasion, audit C2)
--   12. creator unhides → count 1
--   13. non-moderator moderate → forbidden
--   14. admin moderate delete → count 0
--   15. hide-then-delete is a SINGLE decrement, not two (audit C1)
--   16. hard-delete of an already-soft-deleted row does NOT decrement again (audit C1)
--   17. pin on a reply rejected (pin_top_level_only)
--   18. report inserts once, dedupes, and no-ops on a hidden comment (audit M3)
BEGIN;
SELECT plan(18);

SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='post_comment'
   AND has_function_privilege('anon', oid, 'EXECUTE')), 0, '1: anon no EXECUTE on post_comment');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='post_comment'
   AND has_function_privilege('authenticated', oid, 'EXECUTE')), 1, '2: authenticated HAS EXECUTE on post_comment');
SELECT is(has_table_privilege('authenticated', 'public.comment_reports', 'SELECT'), false,
   '3: authenticated cannot SELECT comment_reports (service-role only)');

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_cu uuid := tests.create_auth_user('vc-creator@test');   -- owns the creator (moderator)
  v_cm uuid := tests.create_auth_user('vc-commenter@test');
  v_ot uuid := tests.create_auth_user('vc-other@test');
  v_ad uuid := tests.create_auth_user('vc-admin@test');
  v_cid uuid; v_v1 uuid; v_v3 uuid;
  v_c1 uuid; v_r1 uuid; v_a1 uuid; v_a2 uuid; v_a3 uuid; v_a4 uuid;
  v_cc int; v_reports int;
BEGIN
  PERFORM tests.reset_role();
  INSERT INTO public.admin_roles (user_id, email, role) VALUES (v_ad, 'vc-admin@test', 'superadmin');
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, voice_id, simli_face_id, system_prompt, published_at)
    VALUES (v_cu, 'C', 'vcc', 'ready', 'v', 'f', 'x', now()) RETURNING id INTO v_cid;
  INSERT INTO public.creator_topics (creator_id, slug, title) VALUES (v_cid, 'general', 'G');
  -- two published videos (V1 for depth-guard sequence, V3 for isolated count tests)
  INSERT INTO public.videos (creator_id, title, lesson_count, status) VALUES (v_cid, 'V1', 1, 'ready') RETURNING id INTO v_v1;
  INSERT INTO public.hooks (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags, mux_status, published_at)
    VALUES (v_v1, 1, 'mux_v1', 30, ARRAY['general'], 'ready', now());
  UPDATE public.videos SET published_at = now() WHERE id = v_v1;
  INSERT INTO public.videos (creator_id, title, lesson_count, status) VALUES (v_cid, 'V3', 1, 'ready') RETURNING id INTO v_v3;
  INSERT INTO public.hooks (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags, mux_status, published_at)
    VALUES (v_v3, 1, 'mux_v3', 30, ARRAY['general'], 'ready', now());
  UPDATE public.videos SET published_at = now() WHERE id = v_v3;

  -- 4. Post top-level on V1.
  PERFORM tests.set_authenticated(v_cm);
  v_c1 := public.post_comment(v_v1, 'top comment');
  PERFORM tests.reset_role();
  SELECT comment_count INTO v_cc FROM public.videos WHERE id = v_v1;
  RETURN NEXT is(v_cc, 1, '4: top-level post increments comment_count');

  -- 5. Valid reply.
  PERFORM tests.set_authenticated(v_cm);
  v_r1 := public.post_comment(v_v1, 'a reply', v_c1);
  PERFORM tests.reset_role();
  SELECT comment_count INTO v_cc FROM public.videos WHERE id = v_v1;
  RETURN NEXT is(v_cc, 2, '5: valid reply increments comment_count');

  -- 6. Reply-to-reply rejected.
  PERFORM tests.set_authenticated(v_cm);
  RETURN NEXT throws_like(format('SELECT public.post_comment(%L, %L, %L)', v_v1, 'nested', v_r1),
    '%bad_parent%', '6: reply-to-reply rejected (one level)');

  -- 7. Cross-video parent rejected (parent c1 is on V1, post claims V3).
  RETURN NEXT throws_like(format('SELECT public.post_comment(%L, %L, %L)', v_v3, 'xvid', v_c1),
    '%bad_parent%', '7: cross-video parent rejected');

  -- 8. Non-author delete_own no-op.
  PERFORM tests.set_authenticated(v_ot);
  PERFORM public.delete_own_comment(v_c1);
  PERFORM tests.reset_role();
  SELECT comment_count INTO v_cc FROM public.videos WHERE id = v_v1;
  RETURN NEXT is(v_cc, 2, '8: non-author delete is a no-op (count unchanged)');

  -- 9. Author soft-deletes own reply.
  PERFORM tests.set_authenticated(v_cm);
  PERFORM public.delete_own_comment(v_r1);
  PERFORM tests.reset_role();
  SELECT comment_count INTO v_cc FROM public.videos WHERE id = v_v1;
  RETURN NEXT is(v_cc, 1, '9: author soft-delete decrements');

  -- 10. Creator hides the top-level.
  PERFORM tests.set_authenticated(v_cu);
  PERFORM public.moderate_comment(v_c1, 'hide');
  PERFORM tests.reset_role();
  SELECT comment_count INTO v_cc FROM public.videos WHERE id = v_v1;
  RETURN NEXT is(v_cc, 0, '10: creator hide decrements');

  -- 11. Reply under hidden parent rejected.
  PERFORM tests.set_authenticated(v_cm);
  RETURN NEXT throws_like(format('SELECT public.post_comment(%L, %L, %L)', v_v1, 'sneaky', v_c1),
    '%bad_parent%', '11: reply under hidden parent rejected');

  -- 12. Creator unhides.
  PERFORM tests.set_authenticated(v_cu);
  PERFORM public.moderate_comment(v_c1, 'unhide');
  PERFORM tests.reset_role();
  SELECT comment_count INTO v_cc FROM public.videos WHERE id = v_v1;
  RETURN NEXT is(v_cc, 1, '12: unhide re-increments');

  -- 13. Non-moderator cannot moderate.
  PERFORM tests.set_authenticated(v_ot);
  RETURN NEXT throws_like(format('SELECT public.moderate_comment(%L, %L)', v_c1, 'delete'),
    '%forbidden%', '13: non-moderator moderate rejected');

  -- 14. Admin can moderate.
  PERFORM tests.set_authenticated(v_ad);
  PERFORM public.moderate_comment(v_c1, 'delete');
  PERFORM tests.reset_role();
  SELECT comment_count INTO v_cc FROM public.videos WHERE id = v_v1;
  RETURN NEXT is(v_cc, 0, '14: admin delete decrements');

  -- 15. hide-then-delete = single decrement (V3, fresh). a1 + a2 visible (2).
  PERFORM tests.set_authenticated(v_cm);
  v_a1 := public.post_comment(v_v3, 'a1');
  v_a2 := public.post_comment(v_v3, 'a2');
  PERFORM tests.set_authenticated(v_cu);
  PERFORM public.moderate_comment(v_a1, 'hide');     -- 2 → 1
  PERFORM tests.set_authenticated(v_cm);
  PERFORM public.delete_own_comment(v_a1);           -- already hidden → no further decrement
  PERFORM tests.reset_role();
  SELECT comment_count INTO v_cc FROM public.videos WHERE id = v_v3;
  RETURN NEXT is(v_cc, 1, '15: hide-then-delete is a single decrement (not -2)');

  -- 16. Hard-delete of an already-soft-deleted row does not decrement again.
  --     a2 still visible (count 1). Soft-delete a2 → 0. Hard-delete the row → still 0.
  PERFORM tests.set_authenticated(v_cm);
  PERFORM public.delete_own_comment(v_a2);           -- 1 → 0
  PERFORM tests.reset_role();
  DELETE FROM public.video_comments WHERE id = v_a2; -- already soft-deleted → DELETE branch no-op
  SELECT comment_count INTO v_cc FROM public.videos WHERE id = v_v3;
  RETURN NEXT is(v_cc, 0, '16: cascade/hard-delete of soft-deleted row does not double-decrement');

  -- 17. Pin a reply → rejected. Fresh top a3 + reply a4.
  PERFORM tests.set_authenticated(v_cm);
  v_a3 := public.post_comment(v_v3, 'a3 top');
  v_a4 := public.post_comment(v_v3, 'a4 reply', v_a3);
  PERFORM tests.set_authenticated(v_cu);
  RETURN NEXT throws_like(format('SELECT public.moderate_comment(%L, %L)', v_a4, 'pin'),
    '%pin_top_level_only%', '17: cannot pin a reply');

  -- 18. report inserts once, dedupes, no-ops on hidden. a3 visible; a1 hidden.
  PERFORM tests.set_authenticated(v_ot);
  PERFORM public.report_comment(v_a3, 'spam');
  PERFORM public.report_comment(v_a3, 'spam again');  -- dedupe
  PERFORM public.report_comment(v_a1, 'on hidden');   -- no-op (a1 hidden)
  PERFORM tests.reset_role();
  SELECT count(*)::int INTO v_reports FROM public.comment_reports WHERE comment_id IN (v_a3, v_a1);
  RETURN NEXT is(v_reports, 1, '18: report dedupes + no-ops on hidden (one row, for a3 only)');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
