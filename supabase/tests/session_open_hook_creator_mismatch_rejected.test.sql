-- session_open and session_rollover must reject {creator_id: A, hook_id: <of_B>}.
-- Pre-fix (migration 20260502000002), session_open trusted both ids
-- independently; a cross-creator request would succeed and brain-prefix
-- would later seed creator A's sample_content under creator B's hook UI.
-- See docs/_planning/BRAIN_WIRE_UP_PLAN.md Phase 0 (M0).
BEGIN;
SELECT plan(4);

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
  v_err_state text;
BEGIN
  -- Two creators, each with one published video + hook.
  UPDATE public.profiles SET handle = 'cabnda' WHERE id = v_creat_a;
  UPDATE public.profiles SET handle = 'cabndb' WHERE id = v_creat_b;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creat_a, 'CA', 'cabnda', 'ready', now()) RETURNING id INTO v_creator_a;
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
  SELECT new_session_id INTO v_new_session_id
    FROM public.session_rollover(
      v_new_session_id, v_creator_a, v_hook_a,
      'gemini_3_1_flash_live_preview'::voice_model
    );
  RETURN NEXT ok(v_new_session_id IS NOT NULL,
                 '4: same-creator rollover returns a new session id');

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
