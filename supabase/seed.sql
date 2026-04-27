-- Local-only seed. Applied by `supabase db reset` after migrations; NOT pushed
-- to remote/prod (supabase push ignores seed.sql). Exists solely to persist
-- pgTAP helpers so every test file sees the `tests` schema without needing
-- its own \i include.

CREATE SCHEMA IF NOT EXISTS tests;
CREATE EXTENSION IF NOT EXISTS pgtap;

-- Tests occasionally SET LOCAL role authenticated / service_role and need to
-- call tests.reset_role() or other helpers. Grant schema usage + execute.
GRANT USAGE ON SCHEMA tests TO authenticated, service_role, anon;

CREATE OR REPLACE FUNCTION tests.create_auth_user(p_email text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (
    id, instance_id, email, encrypted_password, email_confirmed_at,
    aud, role, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data, is_sso_user
  )
  VALUES (
    v_id, '00000000-0000-0000-0000-000000000000', p_email,
    'not-a-real-hash', now(),
    'authenticated', 'authenticated', now(), now(),
    '{}'::jsonb, '{}'::jsonb, false
  );
  RETURN v_id;
END;$$;

CREATE OR REPLACE FUNCTION tests.set_authenticated(p_user_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
END;$$;

CREATE OR REPLACE FUNCTION tests.reset_role()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
END;$$;

GRANT EXECUTE ON FUNCTION tests.create_auth_user(text),
                         tests.set_authenticated(uuid),
                         tests.reset_role()
  TO authenticated, service_role, anon;

-- ────────────────────────────────────────────────────────────────────────────
-- Local-only demo content. Runs once on every `supabase db reset` so the
-- /feed has something to render in dev. NOT applied to prod (seed.sql is
-- local-scoped). All hooks reuse one Mux playback ID since Mux playback
-- policy = public, and we're testing swipe/scroll/event-emission mechanics
-- — not unique video content.
--
-- Layout chosen for D5 verification matrix:
--   Video A — 3 lessons → horizontal carousel test
--   Video B — 1 lesson  → vertical scroll target #2
--   Video C — 1 lesson  → vertical scroll target #3 (also "scroll back up")
-- ────────────────────────────────────────────────────────────────────────────

DO $local_seed$
DECLARE
  v_creator_user uuid;
  v_creator_id   uuid;
  v_video_a      uuid;
  v_video_b      uuid;
  v_video_c      uuid;
  v_pb           text := '00HUqjoHSUi02ykoBnfxMDDtB01Aa01rwJUiN9c00nxjm00G4';
BEGIN
  -- Idempotent: bail if seed already ran (creator with this handle exists).
  IF EXISTS (SELECT 1 FROM public.creators WHERE handle = 'localvuk') THEN
    RETURN;
  END IF;

  v_creator_user := tests.create_auth_user('local-creator@oakleague.dev');
  UPDATE public.profiles SET handle = 'localvuk' WHERE id = v_creator_user;

  INSERT INTO public.creators (user_id, display_name, handle, brain_status, creator_type, published_at)
    VALUES (v_creator_user, 'Local Vuk', 'localvuk', 'ready', 'human', now())
    RETURNING id INTO v_creator_id;

  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'mental_models', 'Mental Models'),
           (v_creator_id, 'cold_outreach', 'Cold Outreach'),
           (v_creator_id, 'saas_pricing', 'SaaS Pricing');

  -- Video A: 3 lessons, mental_models. Tests horizontal carousel.
  -- Trigger guards publish-without-ready-hooks, so we insert the video
  -- unpublished, add hooks, then publish.
  INSERT INTO public.videos
    (creator_id, title, description, lesson_count, status)
    VALUES (v_creator_id, 'Argue with idiots', 'Why you really should not',
            3, 'ready')
    RETURNING id INTO v_video_a;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at, title, caption)
    VALUES
      (v_video_a, 1, v_pb, 46, ARRAY['mental_models'],
       'ready', now(), 'Why', 'They drag you to their level'),
      (v_video_a, 2, v_pb, 46, ARRAY['mental_models'],
       'ready', now() - interval '1 second', 'How',  'Recognizing the trap'),
      (v_video_a, 3, v_pb, 46, ARRAY['mental_models'],
       'ready', now() - interval '2 seconds', 'When to bail', 'Walk-away signals');
  UPDATE public.videos SET published_at = now() WHERE id = v_video_a;

  -- Video B: standalone, cold_outreach. Vertical scroll target.
  INSERT INTO public.videos
    (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'Cold email opener', 1, 'ready')
    RETURNING id INTO v_video_b;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at, title, caption)
    VALUES (v_video_b, 1, v_pb, 46, ARRAY['cold_outreach'],
            'ready', now() - interval '1 minute',
            'One sentence', 'The hook everyone replies to');
  UPDATE public.videos SET published_at = now() - interval '1 minute' WHERE id = v_video_b;

  -- Video C: standalone, saas_pricing. Third scroll target.
  INSERT INTO public.videos
    (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'Pricing your SaaS', 1, 'ready')
    RETURNING id INTO v_video_c;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags,
     mux_status, published_at, title, caption)
    VALUES (v_video_c, 1, v_pb, 46, ARRAY['saas_pricing'],
            'ready', now() - interval '2 minutes',
            'Stop guessing', 'Charge what they actually pay');
  UPDATE public.videos SET published_at = now() - interval '2 minutes' WHERE id = v_video_c;
END;
$local_seed$;
