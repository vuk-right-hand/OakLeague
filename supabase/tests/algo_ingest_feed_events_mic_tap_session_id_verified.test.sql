-- §9.2 / M1: mic_tap events with a session_id_if_opened that doesn't
-- belong to the caller have session_id silently nulled (event is still
-- inserted; only the attribution is dropped).
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user     uuid := tests.create_auth_user('algo-mic-own@test');
  v_other    uuid := tests.create_auth_user('algo-mic-other@test');
  v_creator_u uuid := tests.create_auth_user('algo-mic-c@test');
  v_creator_id uuid;
  v_session_own_id uuid := gen_random_uuid();
  v_session_other_id uuid;
  v_row_session uuid;
  v_inserted int;
BEGIN
  UPDATE public.profiles SET handle = 'micowncreator' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'Mic', 'micowncreator', 'pending')
    RETURNING id INTO v_creator_id;

  -- v_user owns session_own; v_other owns session_other.
  INSERT INTO public.sessions
    (id, user_id, creator_id, model_used, tier_at_session, status)
    VALUES
    (v_session_own_id, v_user, v_creator_id,
     'gemini_3_1_flash_live_preview', 'free', 'active');
  INSERT INTO public.sessions
    (user_id, creator_id, model_used, tier_at_session, status)
    VALUES
    (v_other, v_creator_id, 'gemini_3_1_flash_live_preview', 'free', 'active')
    RETURNING id INTO v_session_other_id;

  PERFORM tests.set_authenticated(v_user);

  -- Case A: v_user's own session → attribution kept.
  SELECT inserted INTO v_inserted
    FROM public.ingest_feed_events(jsonb_build_array(jsonb_build_object(
      'event_name',           'mic_tap',
      'idempotency_key',      gen_random_uuid()::text,
      'session_id_if_opened', v_session_own_id::text,
      'payload',              jsonb_build_object('mic_tap_outcome','session_opened')
    )));
  RETURN NEXT is(v_inserted, 1, '1: own-session mic_tap inserted');

  SELECT session_id INTO v_row_session
    FROM public.feed_events_raw
   WHERE user_id = v_user AND event_name = 'mic_tap'
   ORDER BY id DESC LIMIT 1;
  RETURN NEXT is(
    v_row_session, v_session_own_id,
    '2: session_id preserved for own session'
  );

  -- Case B: someone else's session → event still inserted but session_id NULL.
  PERFORM public.ingest_feed_events(jsonb_build_array(jsonb_build_object(
      'event_name',           'mic_tap',
      'idempotency_key',      gen_random_uuid()::text,
      'session_id_if_opened', v_session_other_id::text,
      'payload',              jsonb_build_object('mic_tap_outcome','session_opened')
    )));
  SELECT session_id INTO v_row_session
    FROM public.feed_events_raw
   WHERE user_id = v_user AND event_name = 'mic_tap'
   ORDER BY id DESC LIMIT 1;
  RETURN NEXT is(
    v_row_session, NULL::uuid,
    '3: foreign session_id nulled, event still stored'
  );

  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
