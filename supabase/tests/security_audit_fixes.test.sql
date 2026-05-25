-- security_audit_fixes (20260525000010). Closes the auditor findings on the
-- profile + engagement migrations.
--   (A) C1   — profiles column-write allowlist (privilege-level, no role-switch)
--   (B) C1   — bio scam-link guard trigger (non-creators), creators exempt
--   (C) C2   — handshake existence oracle on unpublished creators
--   (D) M4   — comment moderation is superadmin-only + honors revocation
--   (E) M1/7 — report queue uses handle (not uuid) + resolve lifecycle
--   (F) M5   — handle_available is authenticated-only
BEGIN;
SELECT plan(18);

-- ── (A) C1 column-write allowlist — privilege checks (safe, no SECDEF call) ──
SELECT is(has_column_privilege('authenticated','public.profiles','tier','UPDATE'), false,
   '1: authenticated CANNOT UPDATE profiles.tier');
SELECT is(has_column_privilege('authenticated','public.profiles','handshake_count','UPDATE'), false,
   '2: authenticated CANNOT UPDATE profiles.handshake_count');
SELECT is(has_column_privilege('authenticated','public.profiles','public_id','UPDATE'), false,
   '3: authenticated CANNOT UPDATE profiles.public_id');
SELECT is(has_column_privilege('authenticated','public.profiles','bio','UPDATE'), true,
   '4: authenticated CAN UPDATE profiles.bio');
SELECT is(has_column_privilege('authenticated','public.profiles','display_name','UPDATE'), true,
   '5: authenticated CAN UPDATE profiles.display_name');

-- ── (F) M5 + Small — grant surface ──────────────────────────────────────────
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='handle_available'
   AND has_function_privilege('anon', oid, 'EXECUTE')), 0, '6: anon has NO EXECUTE on handle_available');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='handle_available'
   AND has_function_privilege('authenticated', oid, 'EXECUTE')), 1, '7: authenticated HAS EXECUTE on handle_available');
SELECT is((SELECT count(*)::int FROM pg_proc WHERE proname='handshakes_maintain_counts'
   AND has_function_privilege('authenticated', oid, 'EXECUTE')), 0, '8: authenticated has NO EXECUTE on handshakes_maintain_counts');

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_norm uuid := tests.create_auth_user('sa-normal@test');    -- non-creator
  v_pub  uuid := tests.create_auth_user('sa-pubcreator@test'); -- published creator
  v_unp  uuid := tests.create_auth_user('sa-unpcreator@test'); -- unpublished creator
  v_cm   uuid := tests.create_auth_user('sa-commenter@test');
  v_sad  uuid := tests.create_auth_user('sa-superadmin@test');
  v_rev  uuid := tests.create_auth_user('sa-reviewer@test');
  v_rvk  uuid := tests.create_auth_user('sa-revoked@test');    -- revoked superadmin
  v_pubcid uuid; v_v1 uuid; v_c1 uuid; v_bio text;
BEGIN
  PERFORM tests.reset_role();
  INSERT INTO public.admin_roles (user_id, email, role) VALUES (v_sad, 'sa-superadmin@test', 'superadmin');
  INSERT INTO public.admin_roles (user_id, email, role) VALUES (v_rev, 'sa-reviewer@test', 'reviewer');
  INSERT INTO public.admin_roles (user_id, email, role) VALUES (v_rvk, 'sa-revoked@test', 'superadmin');
  UPDATE public.admin_roles SET revoked_at = now() WHERE user_id = v_rvk;

  -- published creator (handle promotes to creators.handle, profiles.handle NULLed)
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, voice_id, simli_face_id, system_prompt, published_at)
    VALUES (v_pub, 'Pub', 'pubc', 'ready', 'v', 'f', 'x', now()) RETURNING id INTO v_pubcid;
  INSERT INTO public.creator_topics (creator_id, slug, title) VALUES (v_pubcid, 'general', 'G');
  -- unpublished creator
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, voice_id, simli_face_id, system_prompt, published_at)
    VALUES (v_unp, 'Unp', 'unpc', 'ready', 'v', 'f', 'x', NULL);
  -- a published video + comment for moderation tests
  INSERT INTO public.videos (creator_id, title, lesson_count, status) VALUES (v_pubcid, 'V1', 1, 'ready') RETURNING id INTO v_v1;
  INSERT INTO public.hooks (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags, mux_status, published_at)
    VALUES (v_v1, 1, 'mux_sa1', 30, ARRAY['general'], 'ready', now());
  UPDATE public.videos SET published_at = now() WHERE id = v_v1;
  PERFORM tests.set_authenticated(v_cm);
  v_c1 := public.post_comment(v_v1, 'a normal comment');
  PERFORM tests.reset_role();

  -- ── (B) bio scam-link guard ────────────────────────────────────────────────
  -- 9. non-creator setting a link in bio → blocked at the trigger.
  PERFORM tests.set_authenticated(v_norm);
  RETURN NEXT throws_like(format('UPDATE public.profiles SET bio = %L WHERE id = %L', 'visit scam.com now', v_norm),
    '%link_not_allowed%', '9: non-creator bio with a link is blocked');
  -- 10. non-creator clean bio → allowed.
  UPDATE public.profiles SET bio = 'just a regular bio, no links' WHERE id = v_norm;
  SELECT bio INTO v_bio FROM public.profiles WHERE id = v_norm;
  PERFORM tests.reset_role();
  RETURN NEXT is(v_bio, 'just a regular bio, no links', '10: non-creator clean bio saves');
  -- 11. creator may put a link in their bio (exempt).
  PERFORM tests.set_authenticated(v_pub);
  -- creators edit handle/bio via studio, but the guard must still EXEMPT them at
  -- the DB level — assert the trigger does not raise (update as the creator row).
  RETURN NEXT lives_ok(format('UPDATE public.profiles SET bio = %L WHERE id = %L', 'my course: mycourse.com', v_pub),
    '11: creator bio with a link is exempt');
  PERFORM tests.reset_role();

  -- ── (C) C2 handshake oracle ─────────────────────────────────────────────────
  -- 12. handshake to an UNPUBLISHED creator handle → target_not_found (no oracle).
  PERFORM tests.set_authenticated(v_norm);
  RETURN NEXT throws_like(format('SELECT public.handshake(%L)', 'unpc'),
    '%target_not_found%', '12: handshake to unpublished-creator handle is target_not_found');
  -- 13. handshake to a PUBLISHED creator handle → succeeds; viewer state true.
  PERFORM public.handshake('pubc');
  RETURN NEXT is(public.viewer_handshake_state('pubc'), true, '13: handshake to published creator works');
  PERFORM tests.reset_role();

  -- ── (D) M4 moderation = superadmin only + revocation ────────────────────────
  -- 14. reviewer cannot moderate.
  PERFORM tests.set_authenticated(v_rev);
  RETURN NEXT throws_like(format('SELECT public.moderate_comment(%L, %L)', v_c1, 'hide'),
    '%forbidden%', '14: reviewer CANNOT moderate');
  -- 15. revoked superadmin cannot moderate.
  PERFORM tests.set_authenticated(v_rvk);
  RETURN NEXT throws_like(format('SELECT public.moderate_comment(%L, %L)', v_c1, 'hide'),
    '%forbidden%', '15: revoked superadmin CANNOT moderate');
  -- 16. active superadmin can moderate.
  PERFORM tests.set_authenticated(v_sad);
  RETURN NEXT lives_ok(format('SELECT public.moderate_comment(%L, %L)', v_c1, 'hide'),
    '16: active superadmin CAN moderate');
  PERFORM public.moderate_comment(v_c1, 'unhide');  -- restore for report test
  PERFORM tests.reset_role();

  -- ── (E) M1/M7 report queue: handle projection + resolve lifecycle ───────────
  PERFORM tests.set_authenticated(v_norm);
  PERFORM public.report_comment(v_c1, 'spam');
  PERFORM tests.reset_role();
  -- 17. queue (default unresolved) shows the report, projecting a handle not a uuid.
  PERFORM tests.set_authenticated(v_sad);
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.admin_list_comment_reports() WHERE comment_id = v_c1 AND resolved = false),
    1, '17: report appears in the unresolved queue');
  -- 18. resolving it removes it from the default queue.
  PERFORM public.admin_resolve_comment_report(v_c1);
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.admin_list_comment_reports() WHERE comment_id = v_c1),
    0, '18: resolved report drops out of the default queue');
  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
