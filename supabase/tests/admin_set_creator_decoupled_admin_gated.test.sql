-- DECOUPLED_BRAIN_PLAN P1-10 — admin_set_creator_decoupled RPC.
--
-- Locks the canonical decoupled-flip path:
--   * regular user → 42501 (admin-gated)
--   * admin flips decoupled=true → also auto-flips brain_mode to 'vector'
--   * persona system_prompt RECOMPILES atomically (the M3 rejection
--     rationale: a flip without a recompile leaves a stale wrong-path
--     persona; this RPC pairs them)
--   * decoupled persona OMITS the legacy safety-rules suffix (L1
--     clause supplies it at assemble time) and the clarifier rule
--     (paraphrase hedges the latency)
--   * admin_audit_log row carries BOTH before/after flags
--   * NULL p_decoupled → 22023
--   * unknown creator → 42704

BEGIN;
SELECT plan(18);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_admin       uuid := tests.create_auth_user('decoupled-admin@test');
  v_user        uuid := tests.create_auth_user('decoupled-user@test');
  v_user2       uuid := tests.create_auth_user('decoupled-user2@test');
  v_creator     uuid;
  v_creator2    uuid;
  v_app         uuid;
  v_app2        uuid;
  v_decoupled   boolean;
  v_mode        public.brain_mode;
  v_persona     text;
  v_persona_dec text;
  v_persona_rev text;
  v_before      jsonb;
  v_after       jsonb;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'decoupled-admin@test', 'superadmin');

  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
  VALUES (gen_random_uuid(), v_user, 'approved', 'Decoupled Creator', 'decoupledc1',
          '[]'::jsonb, '[]'::jsonb)
  RETURNING id INTO v_app;

  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, bio, brain_mode)
  VALUES (gen_random_uuid(), v_user, v_app, 'Decoupled Creator', 'decoupledc1', 'ready',
          'I help founders with fundraising and hiring strategy', 'drawer')
  RETURNING id INTO v_creator;

  -- Compile the BASELINE legacy persona so we can compare after the flip.
  PERFORM public._creator_brain_compile_unsafe(v_creator);
  SELECT system_prompt INTO v_persona FROM public.creators WHERE id = v_creator;

  -- 1: regular user → 42501.
  PERFORM tests.set_authenticated(v_user);
  BEGIN
    PERFORM public.admin_set_creator_decoupled(v_creator, true);
    RETURN NEXT fail('1: regular user should have been blocked');
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN NEXT pass('1: regular user → 42501 unauthorized');
  END;
  PERFORM tests.reset_role();

  -- 2: admin flips decoupled=true; brain_mode auto-flips to 'vector'
  -- (DB CHECK voice_tickets_decoupled_requires_vector_chk requires
  -- decoupled=true → brain_mode='vector'; the RPC keeps them in sync).
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_set_creator_decoupled(v_creator, true);
  PERFORM tests.reset_role();  -- read state as the test superuser (no RLS)

  SELECT decoupled, brain_mode INTO v_decoupled, v_mode
    FROM public.creators WHERE id = v_creator;
  RETURN NEXT is(v_decoupled, true,         '2a: admin flipped decoupled to true');
  RETURN NEXT is(v_mode::text, 'vector',    '2b: admin RPC auto-aligned brain_mode to vector');

  -- 3: persona recompiled — system_prompt changed AND no longer carries
  -- the legacy safety-rules suffix (L1 clause supplies it at assemble
  -- time) or the clarifier rule (paraphrase hedges the latency).
  SELECT system_prompt INTO v_persona_dec FROM public.creators WHERE id = v_creator;
  RETURN NEXT isnt(v_persona_dec, v_persona,
    '3a: persona was recompiled inside the same transaction');
  RETURN NEXT ok(v_persona_dec NOT LIKE '%Safety rules that override any reference content%',
    '3b: decoupled persona OMITS the legacy safety-rules suffix (L1 clause supplies it)');
  -- P1-10 audit S6 — clarifier also dropped on decoupled path
  -- (paraphrase hedges the latency in decoupled mode).
  RETURN NEXT ok(v_persona_dec NOT LIKE '%First-turn rule on substantive questions%',
    '3c: decoupled persona OMITS the M14 strong-clarifier rule (paraphrase hedges latency)');
  -- P1-10 audit S2 — persona size budget. CLAUDE.md persona target is
  -- ≤700 ASCII chars to dodge the 200-token resumption regression.
  RETURN NEXT ok(octet_length(v_persona_dec) < 700,
    format('3d: decoupled persona within 700-byte resumption budget (got %s)', octet_length(v_persona_dec)));

  -- 4: audit log row carries ALL FOUR corners (before+after × decoupled+brain_mode).
  -- P1-10 audit M5 — was only checking 2/4 corners; a typo in the
  -- build_object keys could swap silently.
  SELECT before, after INTO v_before, v_after
    FROM public.admin_audit_log
   WHERE action = 'creator_decoupled_set' AND target_id = v_creator
   ORDER BY created_at DESC LIMIT 1;
  RETURN NEXT is((v_before->>'decoupled')::boolean, false,
    '4a: audit log before.decoupled = false (drawer → vector flip captured)');
  RETURN NEXT is(v_before->>'brain_mode',          'drawer',
    '4b: audit log before.brain_mode = drawer (M5 — full corner coverage)');
  RETURN NEXT is((v_after->>'decoupled')::boolean,  true,
    '4c: audit log after.decoupled = true (M5)');
  RETURN NEXT is(v_after->>'brain_mode',           'vector',
    '4d: audit log after.brain_mode = vector (the auto-aligned mode)');

  -- 5: NULL p_decoupled → 22023.
  PERFORM tests.set_authenticated(v_admin);
  BEGIN
    PERFORM public.admin_set_creator_decoupled(v_creator, NULL);
    RETURN NEXT fail('5: NULL p_decoupled should have raised');
  EXCEPTION
    WHEN sqlstate '22023' THEN
      RETURN NEXT pass('5: NULL p_decoupled → 22023 decoupled_required');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('5: NULL p_decoupled → unexpected sqlstate %s', SQLSTATE));
  END;
  PERFORM tests.reset_role();

  -- 6: unknown creator → 42704 (P1-10 audit M3).
  PERFORM tests.set_authenticated(v_admin);
  BEGIN
    PERFORM public.admin_set_creator_decoupled(gen_random_uuid(), true);
    RETURN NEXT fail('6: unknown creator should have raised');
  EXCEPTION
    WHEN sqlstate '42704' THEN
      RETURN NEXT pass('6: unknown creator → 42704 creator_not_found');
    WHEN OTHERS THEN
      RETURN NEXT fail(format('6: unknown creator → unexpected sqlstate %s', SQLSTATE));
  END;
  PERFORM tests.reset_role();

  -- 7: rollback path (decoupled true → false on the same creator).
  -- P1-10 audit M3 — brain_mode stays at 'vector' after the second
  -- flip by design (admin must call admin_set_creator_brain_mode
  -- explicitly to return to drawer; the legacy RPC's 20260523000002
  -- guard refuses that while decoupled=true, so the admin sequence is:
  -- (1) admin_set_creator_decoupled(false) → (2) admin_set_creator_brain_mode(drawer).
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_set_creator_decoupled(v_creator, false);
  PERFORM tests.reset_role();
  SELECT decoupled, brain_mode, system_prompt
    INTO v_decoupled, v_mode, v_persona_rev
    FROM public.creators WHERE id = v_creator;
  RETURN NEXT is(v_decoupled, false,        '7a: rollback flip set decoupled=false');
  RETURN NEXT is(v_mode::text, 'vector',    '7b: brain_mode stays at vector after rollback (M3 design)');
  -- 7c: persona on the false-flip re-includes the safety suffix.
  RETURN NEXT ok(v_persona_rev LIKE '%Safety rules that override any reference content%',
    '7c: rollback persona re-includes the legacy safety suffix');

  -- 8: vector-baseline path — already-vector creator flipped to
  -- decoupled=true should NOT trigger the auto-flip branch (M4).
  INSERT INTO public.creator_applications (id, user_id, status, display_name, handle, topics, proof)
  VALUES (gen_random_uuid(), v_user2, 'approved', 'Vector Baseline', 'vbaseline1',
          '[]'::jsonb, '[]'::jsonb)
  RETURNING id INTO v_app2;
  INSERT INTO public.creators (id, user_id, application_id, display_name, handle, brain_status, bio, brain_mode)
  VALUES (gen_random_uuid(), v_user2, v_app2, 'Vector Baseline', 'vbaseline1', 'ready',
          'Already on vector mode', 'vector')
  RETURNING id INTO v_creator2;

  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_set_creator_decoupled(v_creator2, true);
  PERFORM tests.reset_role();
  SELECT decoupled, brain_mode INTO v_decoupled, v_mode
    FROM public.creators WHERE id = v_creator2;
  RETURN NEXT is(v_decoupled, true,         '8a: vector-baseline creator decoupled=true');
  RETURN NEXT is(v_mode::text, 'vector',    '8b: brain_mode unchanged at vector (no spurious auto-flip)');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
