-- Dev-only demo content. Apply manually after `supabase db reset` if you
-- want a populated feed for local UI work:
--
--     npm run seed:dev
--
-- This file is NOT part of the standard supabase seed pipeline — it's
-- separate so `supabase test db` runs against an empty schema (pgTAP
-- tests assume no pre-existing rows). It is local-only; never pushed
-- to prod (prod content goes through /admin/content/videos).
--
-- All hooks reuse one prod-grade Mux playback ID (public playback policy
-- = works from any client). We're testing swipe/scroll/event-emission
-- mechanics here, not unique content.

DO $dev_seed$
DECLARE
  v_creator_user uuid;
  v_creator_id   uuid;
  v_video_a      uuid;
  v_video_b      uuid;
  v_video_c      uuid;
  v_pb           text := '00HUqjoHSUi02ykoBnfxMDDtB01Aa01rwJUiN9c00nxjm00G4';
BEGIN
  -- Idempotent: bail if already applied.
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

  -- Video A: 3 lessons → horizontal carousel test.
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

  -- Video B: standalone, cold_outreach.
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

  -- Video C: standalone, saas_pricing.
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
$dev_seed$;
