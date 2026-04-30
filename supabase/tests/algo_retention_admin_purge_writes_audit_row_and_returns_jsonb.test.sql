-- T-D7-9: admin_purge_feed_events_raw, called by an admin, writes an
-- admin_audit_log row (target_kind='system') and returns jsonb with both
-- rows_deleted and hit_cap keys.
--
-- Round-4 M1: jsonb return (not int) is required because Supabase JS does
-- not surface PostgreSQL RAISE WARNING — the wrapper must materialize
-- hit_cap into the return value so the admin UI can render a cap-hit banner.
BEGIN;
SELECT plan(7);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin uuid := tests.create_auth_user('d7-admin-purge@test');
  v_user  uuid := tests.create_auth_user('d7-target@test');
  v_resp  jsonb;
  v_audit_count int;
  v_audit_after jsonb;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'd7-admin-purge@test', 'superadmin');

  -- 91d-old event so the purge has something to count.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, idempotency_key, payload, skipped_reason, created_at)
    VALUES (v_user, 'hook_impression', gen_random_uuid(),
            '{}'::jsonb, 'test_fixture',
            now() - interval '91 days');

  PERFORM tests.set_authenticated(v_admin);

  v_resp := public.admin_purge_feed_events_raw();

  RETURN NEXT ok(
    jsonb_typeof(v_resp) = 'object',
    '1: return value is a jsonb object'
  );
  RETURN NEXT is(
    (v_resp->>'rows_deleted')::int, 1,
    '2: jsonb contains rows_deleted=1'
  );
  RETURN NEXT ok(
    v_resp ? 'hit_cap' AND jsonb_typeof(v_resp->'hit_cap') = 'boolean',
    '3: jsonb contains hit_cap as boolean'
  );
  RETURN NEXT is(
    (v_resp->>'hit_cap')::boolean, false,
    '4: hit_cap is false on small data'
  );

  PERFORM tests.reset_role();

  -- Audit row written.
  SELECT count(*)::int INTO v_audit_count
    FROM public.admin_audit_log
   WHERE admin_user_id = v_admin
     AND action = 'admin_purge_feed_events_raw'
     AND target_kind = 'system';
  RETURN NEXT is(v_audit_count, 1, '5: exactly one admin_audit_log row written');

  SELECT after INTO v_audit_after
    FROM public.admin_audit_log
   WHERE admin_user_id = v_admin
     AND action = 'admin_purge_feed_events_raw'
   ORDER BY created_at DESC
   LIMIT 1;
  RETURN NEXT is(
    (v_audit_after->>'rows_deleted')::int, 1,
    '6: audit after->>rows_deleted = 1'
  );
  RETURN NEXT ok(
    v_audit_after ? 'hit_cap',
    '7: audit after row carries hit_cap key'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
