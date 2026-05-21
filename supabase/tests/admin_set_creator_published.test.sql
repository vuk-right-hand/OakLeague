-- admin_set_creator_published (FIVE_CREATOR_ONBOARDING_READINESS P0-1):
--   1.  Non-admin caller → 42501 forbidden
--   2.  Missing creator → creator_not_found
--   3.  NULL publish arg → publish_required
--   4.  Missing voice_id → voice_not_cloned
--   5.  Missing simli_face_id → face_not_uploaded
--   6.  Missing system_prompt → brain_not_compiled
--   7.  brain_status='errored' → brain_errored
--   8.  No corpus row with raw_text → no_corpus
--   9.  Happy path (drawer): brain_status→ready, published_at set, CHECK holds
--   10. Unpublish: published_at cleared, brain_status retained
--   11. vector+v2 with NO embedded chunk → no_v2_chunks (auditor C1 guard)
--   12. vector+v2 WITH an embedded child chunk → publishes
--   13. Audit row written
--   14. Revoked voice consent → publish fails voice_consent_missing (C1)
--   15. admin_revoke_creator_consent on a PUBLISHED creator auto-unpublishes (C1)
--
-- admin_audit_log has ZERO client policies; reset_role before asserting it.
BEGIN;
SELECT plan(15);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin   uuid := tests.create_auth_user('pub-admin@test');
  v_other   uuid := tests.create_auth_user('pub-other@test');
  v_cuid    uuid := tests.create_auth_user('pub-creator@test');
  v_cid     uuid;
  v_sample  uuid;
  v_pub     timestamptz;
  v_status  public.brain_status;
  v_audit   int;
  v_embed   public.halfvec(768) :=
    ('[' || array_to_string(array_fill(0.1::real, ARRAY[768]), ',') || ']')::public.halfvec(768);
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'pub-admin@test', 'superadmin');

  -- Fully-ready drawer creator: voice + face + persona + corpus.
  UPDATE public.profiles SET handle = 'pubc' WHERE id = v_cuid;
  INSERT INTO public.creators
    (user_id, display_name, handle, brain_status, voice_id, simli_face_id, system_prompt)
  VALUES
    (v_cuid, 'PubC', 'pubc', 'training', 'voice-x', 'face-x', 'You are PubC.')
  RETURNING id INTO v_cid;

  INSERT INTO public.creator_topics (creator_id, slug, title, sort_order)
    VALUES (v_cid, 'topicx', 'X topic', 1);
  INSERT INTO public.sample_content (creator_id, source_type, raw_text, topic_tags)
    VALUES (v_cid, 'transcript', 'some real corpus text', ARRAY['topicx'])
  RETURNING id INTO v_sample;
  -- Active voice/likeness consent — publish now requires it (holistic-audit C1).
  INSERT INTO public.creator_consents (user_id, consent_type, version, source)
    VALUES (v_cuid, 'voice_clone', '1.0', 'apply_form'),
           (v_cuid, 'likeness',    '1.0', 'apply_form');

  -- 1. Non-admin rejected.
  PERFORM tests.set_authenticated(v_other);
  RETURN NEXT throws_like(
    format('SELECT public.admin_set_creator_published(%L, true)', v_cid),
    '%forbidden%', '1: non-admin rejected');
  PERFORM tests.reset_role();

  PERFORM tests.set_authenticated(v_admin);

  -- 2. Missing creator.
  RETURN NEXT throws_like(
    format('SELECT public.admin_set_creator_published(%L, true)', gen_random_uuid()),
    '%creator_not_found%', '2: missing creator');

  -- 3. NULL publish.
  RETURN NEXT throws_like(
    format('SELECT public.admin_set_creator_published(%L, NULL)', v_cid),
    '%publish_required%', '3: null publish arg rejected');

  -- Fixture mutations run as postgres (reset_role) — creators / sample_content
  -- RLS would silently filter writes by the admin (who is not the owner).
  -- The RPC itself is SECURITY DEFINER, so it runs as owner regardless; only
  -- _assert_caller_is_admin needs auth.uid() = admin during the call.

  -- 4. Missing voice.
  PERFORM tests.reset_role();
  UPDATE public.creators SET voice_id = NULL WHERE id = v_cid;
  PERFORM tests.set_authenticated(v_admin);
  RETURN NEXT throws_like(
    format('SELECT public.admin_set_creator_published(%L, true)', v_cid),
    '%voice_not_cloned%', '4: missing voice rejected');

  -- 5. Missing face.
  PERFORM tests.reset_role();
  UPDATE public.creators SET voice_id = 'voice-x', simli_face_id = NULL WHERE id = v_cid;
  PERFORM tests.set_authenticated(v_admin);
  RETURN NEXT throws_like(
    format('SELECT public.admin_set_creator_published(%L, true)', v_cid),
    '%face_not_uploaded%', '5: missing face rejected');

  -- 6. Missing persona.
  PERFORM tests.reset_role();
  UPDATE public.creators SET simli_face_id = 'face-x', system_prompt = NULL WHERE id = v_cid;
  PERFORM tests.set_authenticated(v_admin);
  RETURN NEXT throws_like(
    format('SELECT public.admin_set_creator_published(%L, true)', v_cid),
    '%brain_not_compiled%', '6: missing persona rejected');

  -- 7. Errored brain.
  PERFORM tests.reset_role();
  UPDATE public.creators SET system_prompt = 'You are PubC.', brain_status = 'errored' WHERE id = v_cid;
  PERFORM tests.set_authenticated(v_admin);
  RETURN NEXT throws_like(
    format('SELECT public.admin_set_creator_published(%L, true)', v_cid),
    '%brain_errored%', '7: errored brain rejected');

  -- 8. No corpus.
  PERFORM tests.reset_role();
  UPDATE public.creators SET brain_status = 'training' WHERE id = v_cid;
  DELETE FROM public.sample_content WHERE creator_id = v_cid;
  PERFORM tests.set_authenticated(v_admin);
  RETURN NEXT throws_like(
    format('SELECT public.admin_set_creator_published(%L, true)', v_cid),
    '%no_corpus%', '8: missing corpus rejected');

  -- 9. Happy path (drawer, retrieval_version=1). Restore corpus first.
  PERFORM tests.reset_role();
  INSERT INTO public.sample_content (creator_id, source_type, raw_text, topic_tags)
    VALUES (v_cid, 'transcript', 'some real corpus text', ARRAY['topicx'])
  RETURNING id INTO v_sample;
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_set_creator_published(v_cid, true);
  PERFORM tests.reset_role();
  SELECT brain_status, published_at INTO v_status, v_pub
    FROM public.creators WHERE id = v_cid;
  RETURN NEXT ok(
    v_status = 'ready' AND v_pub IS NOT NULL,
    '9: drawer creator publishes (ready + published_at set)');

  -- 10. Unpublish leaves brain_status, clears published_at.
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_set_creator_published(v_cid, false);
  PERFORM tests.reset_role();
  SELECT brain_status, published_at INTO v_status, v_pub
    FROM public.creators WHERE id = v_cid;
  RETURN NEXT ok(
    v_status = 'ready' AND v_pub IS NULL,
    '10: unpublish clears published_at, keeps brain_status');

  -- 11. vector + v2 with no embedded chunks → no_v2_chunks.
  PERFORM tests.reset_role();
  UPDATE public.creators
     SET brain_mode = 'vector', retrieval_version = 2
   WHERE id = v_cid;
  PERFORM tests.set_authenticated(v_admin);
  RETURN NEXT throws_like(
    format('SELECT public.admin_set_creator_published(%L, true)', v_cid),
    '%no_v2_chunks%', '11: vector+v2 with no embedded chunks rejected');

  -- 12. vector + v2 WITH an embedded child chunk → publishes.
  PERFORM tests.reset_role();
  INSERT INTO public.sample_content_chunks
    (sample_id, creator_id, chunk_index, text, topic_tags, chunker_version, embedding, embedded_at)
  VALUES
    (v_sample, v_cid, 0, 'embedded child chunk text', ARRAY['topicx'], 2, v_embed, now());
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_set_creator_published(v_cid, true);
  PERFORM tests.reset_role();
  SELECT brain_status, published_at INTO v_status, v_pub
    FROM public.creators WHERE id = v_cid;
  RETURN NEXT ok(
    v_status = 'ready' AND v_pub IS NOT NULL,
    '12: vector+v2 with embedded chunk publishes');

  -- 13. Audit rows written (≥1 publish row).
  SELECT count(*) INTO v_audit
    FROM public.admin_audit_log
   WHERE target_id = v_cid AND action = 'creator_published_set';
  RETURN NEXT ok(v_audit >= 1, '13: audit row(s) written');

  -- 14. Revoked voice consent blocks publish (creator is published from #12).
  PERFORM tests.reset_role();
  UPDATE public.creator_consents SET revoked_at = now()
   WHERE user_id = v_cuid AND consent_type = 'voice_clone';
  PERFORM tests.set_authenticated(v_admin);
  RETURN NEXT throws_like(
    format('SELECT public.admin_set_creator_published(%L, true)', v_cid),
    '%voice_consent_missing%', '14: revoked voice consent blocks publish');

  -- 15. admin_revoke_creator_consent on the still-published creator unpublishes.
  -- (Creator is published from #12; #14 only revoked a consent row directly,
  -- which does NOT unpublish — only the RPC does.) Revoke likeness via RPC.
  PERFORM public.admin_revoke_creator_consent(v_cid, 'likeness');
  PERFORM tests.reset_role();
  SELECT published_at INTO v_pub FROM public.creators WHERE id = v_cid;
  RETURN NEXT ok(v_pub IS NULL, '15: revoke RPC auto-unpublishes a live creator');
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
