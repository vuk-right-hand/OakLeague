-- RAG SOTA plan M1 — creators.retrieval_version + admin_set_creator_retrieval_version.
--
-- 1. Column exists with DEFAULT 1 and CHECK (1, 2). New creator gets 1.
-- 2. Non-admin caller → 42501 unauthorized.
-- 3. Admin flip from 1 → 2 succeeds + system_prompt recompiles in-txn.
-- 4. admin_audit_log row written with action='creator_retrieval_version_set'
--    + before/after carrying previous & new version.
-- 5. NULL p_version → 22023 version_invalid.
-- 6. Out-of-range p_version (e.g. 3) → 22023 version_invalid.
-- 7. CHECK constraint rejects UPDATE creators SET retrieval_version=3 directly.

BEGIN;
SELECT plan(7);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin              uuid := tests.create_auth_user('rv-admin@test');
  v_user               uuid := tests.create_auth_user('rv-user@test');
  v_creator            uuid;
  v_app                uuid;
  v_default            smallint;
  v_after              smallint;
  v_audit_v1           text;
  v_audit_v2           text;
  v_sentinel_prompt    text := '<<sentinel-pre-flip-marker>>';
  v_sys_post           text;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'rv-admin@test', 'superadmin');

  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle)
  VALUES (gen_random_uuid(), v_user, 'approved', 'RV Creator', 'rvcreator1')
  RETURNING id INTO v_app;

  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, brain_mode)
  VALUES (gen_random_uuid(), v_user, v_app, 'RV Creator', 'rvcreator1', 'ready', 'vector')
  RETURNING id INTO v_creator;

  -- 1: column default 1.
  SELECT retrieval_version INTO v_default FROM public.creators WHERE id = v_creator;
  RETURN NEXT is(v_default::int, 1, '1: new creator gets retrieval_version=1 by default');

  -- 2: non-admin caller blocked.
  PERFORM tests.set_authenticated(v_user);
  BEGIN
    PERFORM public.admin_set_creator_retrieval_version(v_creator, 2::smallint);
    RETURN NEXT fail('2: regular user should have been blocked');
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN NEXT pass('2: regular user → 42501 unauthorized');
  END;
  PERFORM tests.reset_role();

  -- 3: admin flips 1 → 2 AND recompile actually fires.
  -- Audit-4 C3 fix: prior assertion only checked `system_prompt IS NOT NULL`,
  -- which would pass even if admin_set_creator_retrieval_version skipped the
  -- recompile entirely. Real assertion: stamp a sentinel BEFORE the flip; the
  -- recompile must OVERWRITE it. If the function ever stops PERFORMing the
  -- recompile, the sentinel survives and the test fails loudly.
  UPDATE public.creators SET system_prompt = v_sentinel_prompt WHERE id = v_creator;

  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_set_creator_retrieval_version(v_creator, 2::smallint);
  SELECT retrieval_version, system_prompt INTO v_after, v_sys_post
    FROM public.creators WHERE id = v_creator;
  RETURN NEXT is(v_after::int, 2, '3a: admin flipped retrieval_version to 2');
  RETURN NEXT ok(
    v_sys_post IS NOT NULL AND v_sys_post <> v_sentinel_prompt,
    '3b: recompile actually fired (sentinel overwritten — audit-4 C3)'
  );

  -- 4: admin_audit_log row carries before/after.
  PERFORM tests.reset_role();
  SELECT before->>'retrieval_version', after->>'retrieval_version'
    INTO v_audit_v1, v_audit_v2
    FROM public.admin_audit_log
   WHERE action = 'creator_retrieval_version_set' AND target_id = v_creator
   ORDER BY created_at DESC LIMIT 1;
  RETURN NEXT is(v_audit_v1 || '→' || v_audit_v2, '1→2',
    '4: admin_audit_log carries before=1, after=2');

  -- 5: NULL p_version → 22023.
  PERFORM tests.set_authenticated(v_admin);
  BEGIN
    PERFORM public.admin_set_creator_retrieval_version(v_creator, NULL::smallint);
    RETURN NEXT fail('5: NULL p_version should have raised');
  EXCEPTION
    WHEN sqlstate '22023' THEN
      RETURN NEXT pass('5: NULL p_version → 22023 version_invalid');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('5: NULL p_version → unexpected sqlstate %s', SQLSTATE));
  END;

  -- 6: out-of-range (3) → 22023.
  BEGIN
    PERFORM public.admin_set_creator_retrieval_version(v_creator, 3::smallint);
    RETURN NEXT fail('6: p_version=3 should have raised');
  EXCEPTION
    WHEN sqlstate '22023' THEN
      RETURN NEXT pass('6: p_version=3 → 22023 version_invalid');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('6: p_version=3 → unexpected sqlstate %s', SQLSTATE));
  END;
  PERFORM tests.reset_role();

  -- 7: CHECK constraint on the column itself rejects direct UPDATE to 3.
  BEGIN
    UPDATE public.creators SET retrieval_version = 3 WHERE id = v_creator;
    RETURN NEXT fail('7: direct UPDATE to 3 should have raised check_violation');
  EXCEPTION
    WHEN check_violation THEN
      RETURN NEXT pass('7: CHECK rejects direct UPDATE retrieval_version=3');
  END;
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
