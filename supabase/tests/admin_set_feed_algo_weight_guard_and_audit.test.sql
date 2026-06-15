-- admin_set_feed_algo_weight: guards + bounds + audit row. (0613-01)
--   1. Non-admin → 42501
--   2. Revoked admin → 42501
--   3. Unknown key → P0002
--   4. Out-of-bounds value → 22023
--   5. NULL value → 22023
--   6. Happy path: row updated, updated_by stamped
--   7. Audit row: action/target_kind/target_id NULL/before/after key+value
BEGIN;
SELECT plan(9);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin   uuid := tests.create_auth_user('weights-admin@test');
  v_revoked uuid := tests.create_auth_user('weights-revoked@test');
  v_other   uuid := tests.create_auth_user('weights-other@test');
  v_row     record;
  v_audit   record;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'weights-admin@test', 'superadmin');
  INSERT INTO public.admin_roles (user_id, email, role, revoked_at)
    VALUES (v_revoked, 'weights-revoked@test', 'superadmin', now());

  -- 1. Non-admin.
  PERFORM tests.set_authenticated(v_other);
  RETURN NEXT throws_ok(
    $$SELECT public.admin_set_feed_algo_weight('W_TOPIC', 1.5)$$,
    '42501', NULL, '1: non-admin caller rejected (42501)');
  PERFORM tests.reset_role();

  -- 2. Revoked admin.
  PERFORM tests.set_authenticated(v_revoked);
  RETURN NEXT throws_ok(
    $$SELECT public.admin_set_feed_algo_weight('W_TOPIC', 1.5)$$,
    '42501', NULL, '2: revoked admin rejected (42501)');
  PERFORM tests.reset_role();

  PERFORM tests.set_authenticated(v_admin);

  -- 3. Unknown key.
  RETURN NEXT throws_ok(
    $$SELECT public.admin_set_feed_algo_weight('W_NOPE', 1.0)$$,
    'P0002', NULL, '3: unknown weight key → P0002');

  -- 4. Out-of-bounds (W_TOPIC max is 3.0).
  RETURN NEXT throws_ok(
    $$SELECT public.admin_set_feed_algo_weight('W_TOPIC', 9.0)$$,
    '22023', NULL, '4: out-of-bounds value → 22023');

  -- 5. NULL value.
  RETURN NEXT throws_ok(
    $$SELECT public.admin_set_feed_algo_weight('W_TOPIC', NULL::real)$$,
    '22023', NULL, '5: NULL value → 22023');

  -- 6. Happy path.
  PERFORM public.admin_set_feed_algo_weight('W_TOPIC', 1.5);
  PERFORM tests.reset_role();

  SELECT weight_value, updated_by INTO v_row
    FROM public.feed_algo_weights WHERE weight_key = 'W_TOPIC';
  RETURN NEXT ok(abs(v_row.weight_value - 1.5) < 1e-6,
    format('6: weight_value updated to 1.5 (got %s)', v_row.weight_value));
  RETURN NEXT is(v_row.updated_by, v_admin, '7: updated_by stamped with admin id');

  -- 7. Audit row shape.
  SELECT action, target_kind, target_id, before, after INTO v_audit
    FROM public.admin_audit_log
   WHERE admin_user_id = v_admin AND action = 'feed_algo_weight_set'
   ORDER BY created_at DESC LIMIT 1;
  RETURN NEXT ok(
    v_audit.action = 'feed_algo_weight_set'
      AND v_audit.target_kind = 'system'
      AND v_audit.target_id IS NULL,
    '8: audit row action=feed_algo_weight_set, target_kind=system, target_id NULL');
  RETURN NEXT ok(
    v_audit.before->>'key' = 'W_TOPIC'
      AND abs((v_audit.before->>'value')::real - 1.0) < 1e-6
      AND v_audit.after->>'key' = 'W_TOPIC'
      AND abs((v_audit.after->>'value')::real - 1.5) < 1e-6,
    '9: audit before/after carry key + old/new value');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
