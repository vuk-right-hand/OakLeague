-- engagement_depth formula must match ALGO_IMPLEMENTATION_PLAN §1144-1158
-- exactly: count of (dwell_end completion>=0.8 OR full_video_open OR
-- mic_tap session_opened) WITH skipped_reason IS NULL.
BEGIN;
SELECT plan(1);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('algo-engdep-admin@test');
  v_user  uuid := tests.create_auth_user('algo-engdep-user@test');
  v_summary jsonb;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'algo-engdep-admin@test', 'superadmin');

  -- 1 qualifying dwell_end (completion >= 0.8).
  INSERT INTO public.feed_events_raw (user_id, event_name, idempotency_key, payload)
    VALUES (v_user, 'hook_dwell_end', gen_random_uuid(),
            jsonb_build_object('completion_pct', 0.9));
  -- 1 qualifying full_video_open.
  INSERT INTO public.feed_events_raw (user_id, event_name, idempotency_key, payload)
    VALUES (v_user, 'full_video_open', gen_random_uuid(),
            jsonb_build_object('source', 'swipe'));
  -- 1 qualifying mic_tap session_opened.
  INSERT INTO public.feed_events_raw (user_id, event_name, idempotency_key, payload)
    VALUES (v_user, 'mic_tap', gen_random_uuid(),
            jsonb_build_object('mic_tap_outcome', 'session_opened'));
  -- NOT qualifying: low-completion dwell.
  INSERT INTO public.feed_events_raw (user_id, event_name, idempotency_key, payload)
    VALUES (v_user, 'hook_dwell_end', gen_random_uuid(),
            jsonb_build_object('completion_pct', 0.5));
  -- NOT qualifying: skipped_reason set.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, idempotency_key, payload, skipped_reason)
    VALUES (v_user, 'full_video_open', gen_random_uuid(),
            jsonb_build_object('source', 'swipe'), 'dead_zone_swipe');
  -- NOT qualifying: mic_tap with non-session outcome.
  INSERT INTO public.feed_events_raw (user_id, event_name, idempotency_key, payload)
    VALUES (v_user, 'mic_tap', gen_random_uuid(),
            jsonb_build_object('mic_tap_outcome', 'kill_switch_blocked'));

  PERFORM tests.set_authenticated(v_admin);
  v_summary := public.admin_algo_user_summary(v_user);

  RETURN NEXT is(
    (v_summary->>'engagement_depth')::int, 3,
    '1: engagement_depth counts only the 3 qualifying events'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
