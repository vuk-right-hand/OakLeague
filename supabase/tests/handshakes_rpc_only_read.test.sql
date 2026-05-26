-- handshakes_rpc_only_read (20260525000011). The follow table is locked to
-- RPC-only reads so a direct PostgREST query can't scrape raw auth.users.id
-- UUIDs / the follow graph. The SECURITY DEFINER read fns must still work.
BEGIN;
SELECT plan(3);

SELECT is(has_table_privilege('anon', 'public.handshakes', 'SELECT'), false,
   '1: anon CANNOT SELECT handshakes directly (no raw-uuid scrape)');
SELECT is(has_table_privilege('authenticated', 'public.handshakes', 'SELECT'), false,
   '2: authenticated CANNOT SELECT handshakes directly');

-- The SECDEF write + read RPCs run as owner and are unaffected by the revoke.
CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_a uuid := tests.create_auth_user('hs-a@test');
  v_b uuid := tests.create_auth_user('hs-b@test');
BEGIN
  PERFORM tests.reset_role();
  UPDATE public.profiles SET handle = 'hsbtarget' WHERE id = v_b;
  PERFORM tests.set_authenticated(v_a);
  PERFORM public.handshake('hsbtarget');   -- write RPC still works
  RETURN NEXT is(public.viewer_handshake_state('hsbtarget'), true,
    '3: SECDEF read RPC still works after the table SELECT revoke');
  PERFORM tests.reset_role();
END;
$fn$;
SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
