-- R4-S4: exactly one BEFORE INSERT trigger on session_turns, owning both
-- user_id population and kill-switch enforcement.
BEGIN;
SELECT plan(3);

SELECT is(
  (SELECT count(*)::int FROM pg_trigger
     WHERE tgrelid = 'public.session_turns'::regclass
       AND NOT tgisinternal
       AND tgtype & 2 = 2),  -- BEFORE
  1,
  'exactly one BEFORE INSERT trigger on session_turns'
);

SELECT is(
  (SELECT tgname FROM pg_trigger
     WHERE tgrelid = 'public.session_turns'::regclass
       AND NOT tgisinternal
       AND tgtype & 2 = 2),
  'session_turns_guard',
  'trigger name is session_turns_guard'
);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('single-trig@test');
  v_cuid uuid := tests.create_auth_user('creator-st@test');
  v_cid uuid;
  v_sid uuid;
  v_tid uuid;
  v_turn_user uuid;
BEGIN
  UPDATE public.profiles SET handle = 'cst' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'CST', 'cst', 'ready', now())
    RETURNING id INTO v_cid;
  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_uid, v_cid, 'gemini_3_1_flash_live_preview', 'free')
    RETURNING id INTO v_sid;
  INSERT INTO public.session_turns (session_id, turn_number, role)
    VALUES (v_sid, 1, 'user') RETURNING id, user_id INTO v_tid, v_turn_user;
  RETURN NEXT ok(v_turn_user = v_uid, 'single trigger populates user_id from parent session');
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
