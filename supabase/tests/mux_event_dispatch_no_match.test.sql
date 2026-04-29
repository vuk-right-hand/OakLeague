-- T-0504-3: apply_mux_event with a passthrough that matches no row
-- (hooks, welcome_hooks, OR videos.long_form_mux_passthrough) marks the
-- event as processed and updates nothing. Catches the case where the
-- third dispatch branch exists but a stale passthrough is replayed.
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_event_id text := 'evt_no_match_' || gen_random_uuid()::text;
  v_unknown  uuid := gen_random_uuid();
  v_processed timestamptz;
  v_video_changes int;
BEGIN
  PERFORM public.apply_mux_event(
    v_event_id,
    'video.asset.ready',
    jsonb_build_object(
      'data', jsonb_build_object(
        'id', 'asset_no_match',
        'passthrough', v_unknown::text,
        'playback_ids', jsonb_build_array(jsonb_build_object('id', 'pb_no_match')),
        'duration', 600.0
      )
    )
  );

  -- 1. Event row exists and was marked processed.
  SELECT processed_at INTO v_processed
    FROM public.mux_webhook_events WHERE id = v_event_id;
  RETURN NEXT ok(
    v_processed IS NOT NULL,
    '1: unknown passthrough event still marked processed'
  );

  -- 2. No videos row was touched. Use long_form_mux_playback_id as the
  -- canary: the dispatch branch would set it; non-dispatch must leave
  -- every row's value as the default (NULL).
  SELECT COUNT(*)::int INTO v_video_changes
    FROM public.videos WHERE long_form_mux_playback_id = 'pb_no_match';
  RETURN NEXT ok(
    v_video_changes = 0,
    format('2: no videos row updated by unknown passthrough (got %s)', v_video_changes)
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
