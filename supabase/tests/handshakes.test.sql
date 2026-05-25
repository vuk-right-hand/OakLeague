-- handshakes (PROFILE_SYSTEM_PLAN U1 / §3.3):
--   1.  anon has NO EXECUTE on handshake (has_function_privilege — never SET ROLE
--       + CALL a REVOKE'd SECURITY DEFINER fn; that segfaults PG 17.6)
--   2.  authenticated HAS EXECUTE on handshake
--   3.  self-handshake rejected (bad_target)
--   4.  handshake to a nonexistent handle rejected (target_not_found)
--   5.  handshake increments followee's handshake_count (received)
--   6.  handshake increments follower's handshakes_given_count
--   7.  idempotent: second handshake does not double-count
--   8.  list_handshakers returns the follower's handle
--   9.  unhandshake decrements the received count
--   10. double-unhandshake floors at 0 (no negative, no error)
--   11. profile delete with edges in BOTH directions moves only counterparties (M1)
BEGIN;
SELECT plan(11);

-- 1 + 2: grant matrix (static, no CALL).
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'handshake'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  0, '1: anon has no EXECUTE on handshake');
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'handshake'
      AND has_function_privilege('authenticated', oid, 'EXECUTE')),
  1, '2: authenticated HAS EXECUTE on handshake');

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_a uuid := tests.create_auth_user('hs-a@test');
  v_b uuid := tests.create_auth_user('hs-b@test');
  v_c uuid := tests.create_auth_user('hs-c@test');
  v_d uuid := tests.create_auth_user('hs-d@test');
  v_e uuid := tests.create_auth_user('hs-e@test');
  v_f uuid := tests.create_auth_user('hs-f@test');
  v_recv int;
  v_given int;
  v_handle citext;
BEGIN
  -- Handles (as postgres — RLS own-update would block cross-row fixture writes).
  PERFORM tests.reset_role();
  UPDATE public.profiles SET handle = 'usera' WHERE id = v_a;
  UPDATE public.profiles SET handle = 'userb' WHERE id = v_b;
  UPDATE public.profiles SET handle = 'userc' WHERE id = v_c;
  UPDATE public.profiles SET handle = 'userd' WHERE id = v_d;
  UPDATE public.profiles SET handle = 'usere' WHERE id = v_e;
  UPDATE public.profiles SET handle = 'userf' WHERE id = v_f;

  -- 3. Self-handshake.
  PERFORM tests.set_authenticated(v_a);
  RETURN NEXT throws_like(
    'SELECT public.handshake(''usera''::citext)',
    '%bad_target%', '3: self-handshake rejected');

  -- 4. Nonexistent target.
  RETURN NEXT throws_like(
    'SELECT public.handshake(''nobody''::citext)',
    '%target_not_found%', '4: nonexistent target rejected');

  -- 5 + 6. A handshakes B.
  PERFORM public.handshake('userb'::citext);
  PERFORM tests.reset_role();
  SELECT handshake_count INTO v_recv FROM public.profiles WHERE id = v_b;
  SELECT handshakes_given_count INTO v_given FROM public.profiles WHERE id = v_a;
  RETURN NEXT is(v_recv, 1, '5: followee handshake_count = 1');
  RETURN NEXT is(v_given, 1, '6: follower handshakes_given_count = 1');

  -- 7. Idempotent re-handshake.
  PERFORM tests.set_authenticated(v_a);
  PERFORM public.handshake('userb'::citext);
  PERFORM tests.reset_role();
  SELECT handshake_count INTO v_recv FROM public.profiles WHERE id = v_b;
  RETURN NEXT is(v_recv, 1, '7: re-handshake does not double-count');

  -- 8. list_handshakers(userb) includes usera.
  SELECT handle INTO v_handle
    FROM public.list_handshakers('userb'::citext, NULL, 30) LIMIT 1;
  RETURN NEXT is(v_handle::text, 'usera', '8: list_handshakers returns the follower');

  -- 9. Unhandshake decrements.
  PERFORM tests.set_authenticated(v_a);
  PERFORM public.unhandshake('userb'::citext);
  PERFORM tests.reset_role();
  SELECT handshake_count INTO v_recv FROM public.profiles WHERE id = v_b;
  RETURN NEXT is(v_recv, 0, '9: unhandshake decrements received count to 0');

  -- 10. Double-unhandshake floors at 0, no error.
  PERFORM tests.set_authenticated(v_a);
  PERFORM public.unhandshake('userb'::citext);
  PERFORM tests.reset_role();
  SELECT handshake_count INTO v_recv FROM public.profiles WHERE id = v_b;
  RETURN NEXT is(v_recv, 0, '10: double-unhandshake floors at 0');

  -- 11. Cascade delete (fresh users d/e/f). Edges:
  --   d→e, f→e  (e.received = 2),  d→f  (f.received = 1, f.given = 1 via f→e).
  -- Delete d → only d's edges (d→e, d→f) vanish. Expect:
  --   e.received 2→1 (kept f→e — moved by EXACTLY 1, not zeroed)
  --   f.given    1→1 (f→e untouched — delete removed only d's edges)
  PERFORM tests.set_authenticated(v_d);
  PERFORM public.handshake('usere'::citext);
  PERFORM public.handshake('userf'::citext);
  PERFORM tests.set_authenticated(v_f);
  PERFORM public.handshake('usere'::citext);
  PERFORM tests.reset_role();
  DELETE FROM public.profiles WHERE id = v_d;  -- cascade deletes d→e, d→f
  SELECT handshake_count        INTO v_recv  FROM public.profiles WHERE id = v_e;
  SELECT handshakes_given_count INTO v_given FROM public.profiles WHERE id = v_f;
  RETURN NEXT ok(
    v_recv = 1 AND v_given = 1,
    '11: profile delete moves only counterparties (e.received 2->1, f.given untouched=1)');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
