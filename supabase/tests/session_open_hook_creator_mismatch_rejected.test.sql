-- session_open and session_rollover must reject {creator_id: A, hook_id: <of_B>}.
-- Pre-fix (migration 20260502000002), session_open trusted both ids
-- independently; a cross-creator request would succeed and brain-prefix
-- would later seed creator A's sample_content under creator B's hook UI.
-- See docs/_planning/BRAIN_WIRE_UP_PLAN.md Phase 0 (M0).
BEGIN;
SELECT plan(6);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user      uuid := tests.create_auth_user('binding-user@test');
  v_creat_a   uuid := tests.create_auth_user('binding-cA@test');
  v_creat_b   uuid := tests.create_auth_user('binding-cB@test');
  v_creator_a uuid;
  v_creator_b uuid;
  v_video_a   uuid;
  v_video_b   uuid;
  v_hook_a    uuid;
  v_hook_b    uuid;
  v_new_session_id uuid;
  v_old_session_id uuid;
  v_err_state text;
  v_old_ended  timestamptz;
  v_old_status text;
  v_old_reason text;
  v_old_active int;
  v_csess      int;
  v_rsess      smallint;
BEGIN
  -- Two creators, each with one published video + hook.
  UPDATE public.profiles SET handle = 'cabnda' WHERE id = v_creat_a;
  UPDATE public.profiles SET handle = 'cabndb' WHERE id = v_creat_b;
  -- creator_a at current_corpus_version=2 so the rollover snapshot assertion
  -- (test 6) catches a DEFAULT-1 fallthrough, not just "some int landed".
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at, current_corpus_version)
    VALUES (v_creat_a, 'CA', 'cabnda', 'ready', now(), 2) RETURNING id INTO v_creator_a;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat_b, 'CB', 'cabndb', 'ready', now()) RETURNING id INTO v_creator_b;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_a, 'general', 'G'), (v_creator_b, 'general', 'G');
  -- Videos as drafts first (publishing checks for ready hooks).
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_a, 'Va', 1, 'ready') RETURNING id INTO v_video_a;
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_b, 'Vb', 1, 'ready') RETURNING id INTO v_video_b;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_a, 1, 'mux_a', 30, ARRAY['general'], 'ready', now())
    RETURNING id INTO v_hook_a;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds,
     topic_tags, mux_status, published_at)
    VALUES (v_video_b, 1, 'mux_b', 30, ARRAY['general'], 'ready', now())
    RETURNING id INTO v_hook_b;
  -- Publish videos now that ready hooks exist.
  UPDATE public.videos SET published_at = now()
    WHERE id IN (v_video_a, v_video_b);

  PERFORM tests.set_authenticated(v_user);

  -- 1) Mismatch: creator_id=A, hook_id=B → must raise 42501.
  BEGIN
    PERFORM session_id FROM public.session_open(
      v_creator_a, v_hook_b, 'gemini_3_1_flash_live_preview'::voice_model
    );
    RETURN NEXT fail('1: cross-creator binding should have raised but succeeded');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err_state = RETURNED_SQLSTATE;
    RETURN NEXT is(v_err_state, '42501', '1: cross-creator binding raises 42501');
  END;

  -- 2) Match: creator_id=A, hook_id=A → succeeds, returns a session id.
  SELECT session_id INTO v_new_session_id
    FROM public.session_open(
      v_creator_a, v_hook_a, 'gemini_3_1_flash_live_preview'::voice_model
    );
  RETURN NEXT ok(v_new_session_id IS NOT NULL,
                 '2: same-creator binding returns a session id');

  -- 3) Rollover mismatch: rollover requesting creator_id=B against the open
  --    session (creator A, hook A) with hook B → must raise 42501.
  BEGIN
    PERFORM new_session_id FROM public.session_rollover(
      v_new_session_id, v_creator_b, v_hook_a,
      'gemini_3_1_flash_live_preview'::voice_model
    );
    RETURN NEXT fail('3: rollover cross-creator should have raised');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err_state = RETURNED_SQLSTATE;
    RETURN NEXT is(v_err_state, '42501',
                   '3: rollover cross-creator binding raises 42501');
  END;

  -- 4) Rollover match: same creator + matching hook → succeeds.
  --    Re-use v_hook_a; session_rollover closes the old then opens new.
  v_old_session_id := v_new_session_id;  -- the still-open session to be rolled
  SELECT new_session_id INTO v_new_session_id
    FROM public.session_rollover(
      v_old_session_id, v_creator_a, v_hook_a,
      'gemini_3_1_flash_live_preview'::voice_model
    );
  RETURN NEXT ok(v_new_session_id IS NOT NULL,
                 '4: same-creator rollover returns a new session id');

  -- 5) Rollover must CLOSE the old session (regression-pin, auditor Medium #3).
  --    The 20260521000009/000100 regression dropped this UPDATE — yet test 4
  --    above still passes (a new id came back). Assert the old row is actually
  --    ended so a future drop-the-close cannot silently re-ship.
  SELECT ended_at, status::text, end_reason, active_seconds
    INTO v_old_ended, v_old_status, v_old_reason, v_old_active
    FROM public.sessions WHERE id = v_old_session_id;
  RETURN NEXT ok(
    v_old_ended IS NOT NULL
      AND v_old_status = 'ended'
      AND v_old_reason = 'gemini_15min_cap'
      AND v_old_active IS NOT NULL,
    format('5: rollover closed the old session (ended=%s status=%s reason=%s active=%s)',
           v_old_ended IS NOT NULL, v_old_status, v_old_reason, v_old_active)
  );

  -- 6) New session must carry the corpus_version/retrieval_version SNAPSHOT
  --    (auditor Medium #4). creator_a is at current_corpus_version=2,
  --    retrieval_version=1 (default) → assert the new row pinned both, proving
  --    the snapshot survived the rollover rewrite and isn't a DEFAULT-1 stub.
  SELECT corpus_version_at_session, retrieval_version_at_session
    INTO v_csess, v_rsess
    FROM public.sessions WHERE id = v_new_session_id;
  RETURN NEXT ok(
    v_csess = 2 AND v_rsess = 1,
    format('6: rollover snapshots corpus_version=%s (want 2) + retrieval_version=%s (want 1)',
           v_csess, v_rsess)
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
