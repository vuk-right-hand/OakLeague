-- RAG SOTA plan M8 — creator_embedding_budget default cap bump $5 → $10
-- (post-audit-5 M3 isolation + S6 boundary).
--
-- 1. Default cap is now 10 — $7 under default → true.
-- 2. Explicit p_cap_usd=5 still works — $4 under explicit $5 → true.
-- 3. Explicit p_cap_usd=5 boundary — $6 over explicit $5 → false (audit-5 S6).
-- 4. Negative add raises 22023.
-- 5. ACLs preserved through CREATE OR REPLACE.
-- 6. Default cap inclusive boundary — exactly $10 → true (audit-6 small).

BEGIN;
SELECT plan(6);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  -- Audit-5 M3 fix: declare distinct vars for each test creator so cases
  -- don't bleed budget state through a mutated v_creator.
  v_user1     uuid := tests.create_auth_user('ceb-creator1@test');
  v_user2     uuid := tests.create_auth_user('ceb-creator2@test');
  v_user3     uuid := tests.create_auth_user('ceb-creator3@test');
  v_user4     uuid := tests.create_auth_user('ceb-creator4@test');
  v_user5     uuid := tests.create_auth_user('ceb-creator5@test');
  v_creator1  uuid;
  v_creator2  uuid;
  v_creator3  uuid;
  v_creator4  uuid;
  v_creator5  uuid;
  v_app       uuid;
  v_ok        boolean;
BEGIN
  -- Helper: each creator gets its own fresh row via inline INSERT.
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user1, 'approved', 'CEB Creator1', 'cebcreator1', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user1, v_app, 'CEB Creator1', 'cebcreator1', 'ready')
    RETURNING id INTO v_creator1;

  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user2, 'approved', 'CEB Creator2', 'cebcreator2', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user2, v_app, 'CEB Creator2', 'cebcreator2', 'ready')
    RETURNING id INTO v_creator2;

  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user3, 'approved', 'CEB Creator3', 'cebcreator3', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user3, v_app, 'CEB Creator3', 'cebcreator3', 'ready')
    RETURNING id INTO v_creator3;

  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user4, 'approved', 'CEB Creator4', 'cebcreator4', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user4, v_app, 'CEB Creator4', 'cebcreator4', 'ready')
    RETURNING id INTO v_creator4;

  -- 1: $7 under new $10 default cap → true. Default arg.
  SELECT public.creator_embedding_budget_accumulate_and_check(v_creator1, 7.00) INTO v_ok;
  RETURN NEXT ok(v_ok, '1: $7 under new $10 default cap → true');

  -- 2: explicit p_cap_usd=5 still honored — $4 under explicit $5 → true.
  SELECT public.creator_embedding_budget_accumulate_and_check(v_creator2, 4.00, 5.00) INTO v_ok;
  RETURN NEXT ok(v_ok, '2: explicit p_cap_usd=5 still honored — $4 under $5 → true');

  -- 3: BOUNDARY (audit-5 S6) — $6 over explicit $5 cap → false.
  -- Fresh creator so case 2's $4 doesn't bleed.
  SELECT public.creator_embedding_budget_accumulate_and_check(v_creator3, 6.00, 5.00) INTO v_ok;
  RETURN NEXT ok(NOT v_ok, '3: $6 over explicit $5 cap → false (boundary, audit-5 S6)');

  -- 4: negative add raises 22023. Fresh creator.
  BEGIN
    PERFORM public.creator_embedding_budget_accumulate_and_check(v_creator4, -0.01);
    RETURN NEXT fail('4: negative add should have raised 22023');
  EXCEPTION
    WHEN sqlstate '22023' THEN
      RETURN NEXT pass('4: negative add → 22023 negative_amount');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('4: negative add → unexpected sqlstate %s', SQLSTATE));
  END;

  -- 5: ACLs preserved through CREATE OR REPLACE.
  RETURN NEXT ok(
    NOT has_function_privilege('authenticated'::regrole,
      'public.creator_embedding_budget_accumulate_and_check(uuid, numeric, numeric)', 'EXECUTE')
    AND has_function_privilege('service_role'::regrole,
      'public.creator_embedding_budget_accumulate_and_check(uuid, numeric, numeric)', 'EXECUTE'),
    '5: creator_embedding_budget_accumulate_and_check ACLs unchanged after cap bump'
  );

  -- 6: Default cap inclusive boundary — exactly $10 → true (audit-6 small).
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
    VALUES (gen_random_uuid(), v_user5, 'approved', 'CEB Creator5', 'cebcreator5', '[]'::jsonb, '{}'::jsonb)
    RETURNING id INTO v_app;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status)
    VALUES (gen_random_uuid(), v_user5, v_app, 'CEB Creator5', 'cebcreator5', 'ready')
    RETURNING id INTO v_creator5;
  SELECT public.creator_embedding_budget_accumulate_and_check(v_creator5, 10.00) INTO v_ok;
  RETURN NEXT ok(v_ok, '6: default cap inclusive — exactly $10 → true (audit-6 small)');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
