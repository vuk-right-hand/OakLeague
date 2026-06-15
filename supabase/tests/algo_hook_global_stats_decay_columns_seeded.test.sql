-- 0613-02 schema: decayed shadow + slot-bucket columns exist with NOT NULL
-- DEFAULT 0 and >= 0 CHECKs. (The one-shot decayed:=raw seeding UPDATE ran at
-- migration time; per-row parity for trigger-created rows is asserted in
-- algo_rollup_first_insert_sets_decayed.)
BEGIN;
SELECT plan(6);

SELECT has_column('public', 'hook_global_stats', 'impressions_decayed', '1: impressions_decayed exists');
SELECT has_column('public', 'hook_global_stats', 'full_opens_decayed',  '2: full_opens_decayed exists');
SELECT has_column('public', 'hook_global_stats', 'mic_taps_decayed',    '3: mic_taps_decayed exists');
SELECT has_column('public', 'hook_global_stats', 'impressions_top3',    '4: impressions_top3 exists');
SELECT has_column('public', 'hook_global_stats', 'impressions_rest',    '5: impressions_rest exists');

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_creator_u uuid := tests.create_auth_user('algo-dcs-c@test');
  v_creator_id uuid;
  v_video_id uuid;
  v_hook_id uuid;
BEGIN
  UPDATE public.profiles SET handle = 'dcsc' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'C', 'dcsc', 'pending')
    RETURNING id INTO v_creator_id;
  INSERT INTO public.creator_topics (creator_id, slug, title)
    VALUES (v_creator_id, 'cold_outreach', 'C');
  INSERT INTO public.videos (creator_id, title, lesson_count, status)
    VALUES (v_creator_id, 'V', 1, 'ready')
    RETURNING id INTO v_video_id;
  INSERT INTO public.hooks
    (video_id, lesson_number, mux_playback_id, duration_seconds, topic_tags)
    VALUES (v_video_id, 1, 'mux_pb_dcs', 30, ARRAY['cold_outreach'])
    RETURNING id INTO v_hook_id;

  RETURN NEXT throws_ok(
    format($$INSERT INTO public.hook_global_stats (hook_id, impressions_decayed)
             VALUES (%L, -1)$$, v_hook_id),
    '23514', NULL,
    '6: negative decayed counter violates CHECK (23514)'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
