-- Deleting auth.users cascades through profiles → creators → sessions,
-- preserves cogs_log rows (user_id goes NULL via FK cascade SET NULL; the
-- append-only UPDATE trigger permits FK-cascade nullings).
BEGIN;
SELECT plan(3);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('cascade@test');
  v_cuid uuid := tests.create_auth_user('cascade-c@test');
  v_cid uuid;
BEGIN
  UPDATE public.profiles SET handle = 'cascade' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'C', 'cascade', 'ready', now())
    RETURNING id INTO v_cid;

  INSERT INTO public.cogs_log (user_id, service, operation, units, unit_label, cost_usd)
    VALUES (v_uid, 'gemini', 'x', 1, 'u', 0);

  DELETE FROM auth.users WHERE id = v_uid;

  RETURN NEXT is(
    (SELECT count(*)::int FROM public.profiles WHERE id = v_uid),
    0,
    'profile cascaded on auth user delete'
  );

  RETURN NEXT ok(
    EXISTS (SELECT 1 FROM public.cogs_log WHERE user_id IS NULL),
    'cogs_log row preserved with user_id NULL'
  );

  RETURN NEXT is(
    (SELECT count(*)::int FROM public.creators WHERE id = v_cid),
    1,
    'unrelated creator not touched'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
