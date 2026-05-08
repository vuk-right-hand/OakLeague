-- voice_tickets_purge_consumed (M5).
-- Purges:
--   * consumed_at IS NOT NULL AND consumed_at < now() - 7d
--   * consumed_at IS NULL     AND expires_at  < now() - 7d   (R3 audit M2)
-- Preserves:
--   * Recently-consumed (<7d ago)
--   * Recently-expired unconsumed (<7d ago)
--   * Active (unconsumed, not yet expired)
BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user        uuid := tests.create_auth_user('vtp@test');
  v_creat       uuid := tests.create_auth_user('vtpc@test');
  v_creator     uuid;
  v_session     uuid;
  v_purged      int;
  t_stale_cons  uuid := gen_random_uuid();
  t_stale_uncon uuid := gen_random_uuid();
  t_recent_cons uuid := gen_random_uuid();
  t_active      uuid := gen_random_uuid();
BEGIN
  UPDATE public.profiles SET handle = 'vtpcr' WHERE id = v_creat;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creat, 'C', 'vtpcr', 'training') RETURNING id INTO v_creator;
  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session, status, avatar_status)
    VALUES (v_user, v_creator, 'gemini_3_1_flash_live_preview', 'free', 'starting', 'pending')
    RETURNING id INTO v_session;

  -- Stale consumed (purgeable).
  INSERT INTO public.voice_tickets
    (ticket_id, user_id, creator_id, session_id, expected_tier, purpose,
     avatar_provider, expires_at, bound_ua_hash, consumed_at)
  VALUES
    (t_stale_cons, v_user, v_creator, v_session, 'free', 'voice_session',
     'simli', now() - interval '8 days', repeat('a', 64), now() - interval '8 days');

  -- Stale unconsumed-expired (purgeable, R3 audit M2).
  INSERT INTO public.voice_tickets
    (ticket_id, user_id, creator_id, session_id, expected_tier, purpose,
     avatar_provider, expires_at, bound_ua_hash)
  VALUES
    (t_stale_uncon, v_user, v_creator, v_session, 'free', 'voice_session',
     'simli', now() - interval '8 days', repeat('a', 64));

  -- Recently consumed (preserve).
  INSERT INTO public.voice_tickets
    (ticket_id, user_id, creator_id, session_id, expected_tier, purpose,
     avatar_provider, expires_at, bound_ua_hash, consumed_at)
  VALUES
    (t_recent_cons, v_user, v_creator, v_session, 'free', 'voice_session',
     'simli', now() - interval '3 days', repeat('a', 64), now() - interval '3 days');

  -- Active unconsumed (preserve).
  INSERT INTO public.voice_tickets
    (ticket_id, user_id, creator_id, session_id, expected_tier, purpose,
     avatar_provider, expires_at, bound_ua_hash)
  VALUES
    (t_active, v_user, v_creator, v_session, 'free', 'voice_session',
     'simli', now() + interval '120 seconds', repeat('a', 64));

  v_purged := public.voice_tickets_purge_consumed();

  RETURN NEXT is(v_purged, 2, '1: purge returns 2 (consumed-stale + unconsumed-stale)');
  RETURN NEXT ok(
    NOT EXISTS (SELECT 1 FROM voice_tickets WHERE ticket_id = t_stale_cons),
    '2: stale consumed deleted');
  RETURN NEXT ok(
    NOT EXISTS (SELECT 1 FROM voice_tickets WHERE ticket_id = t_stale_uncon),
    '3: stale unconsumed-expired deleted (R3 audit M2)');
  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM voice_tickets WHERE ticket_id = t_recent_cons)
    AND EXISTS (SELECT 1 FROM voice_tickets WHERE ticket_id = t_active),
    '4: recent + active rows preserved');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
