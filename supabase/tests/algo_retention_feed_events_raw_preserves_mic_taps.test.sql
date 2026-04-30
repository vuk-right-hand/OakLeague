-- T-D7-2: purge_feed_events_raw preserves mic_tap events forever, even at
-- 200 days old. The mic_tap is the north-star event; raw-level rows are
-- preserved permanently for analytics and historical scoring fidelity.
--
-- See feed_events_raw.sql:9-10 ("mic_tap is preserved forever at the raw level
-- (business-critical north-star event)") and ALGO_IMPLEMENTATION_PLAN.md §9.7
-- (retention_sweep_preserves_mic_taps_forever).
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('d7-mic-tap@test');
  v_mic_id bigint;
  v_imp_id bigint;
  v_returned int;
BEGIN
  -- 200d-old mic_tap with session_opened outcome.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, idempotency_key, payload, skipped_reason, created_at)
    VALUES (v_user, 'mic_tap', gen_random_uuid(),
            jsonb_build_object('mic_tap_outcome', 'session_opened'),
            'test_fixture',
            now() - interval '200 days')
    RETURNING id INTO v_mic_id;

  -- 200d-old hook_impression (control: should be purged).
  INSERT INTO public.feed_events_raw
    (user_id, event_name, idempotency_key, payload, skipped_reason, created_at)
    VALUES (v_user, 'hook_impression', gen_random_uuid(),
            '{}'::jsonb, 'test_fixture',
            now() - interval '200 days')
    RETURNING id INTO v_imp_id;

  SELECT public.purge_feed_events_raw() INTO v_returned;

  RETURN NEXT is(v_returned, 1, '1: only 1 row purged (the impression, not the mic_tap)');

  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.feed_events_raw WHERE id = v_mic_id),
    '2: 200d-old mic_tap preserved (north-star event)'
  );
  RETURN NEXT ok(
    NOT EXISTS (SELECT 1 FROM public.feed_events_raw WHERE id = v_imp_id),
    '3: 200d-old hook_impression purged (control)'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
