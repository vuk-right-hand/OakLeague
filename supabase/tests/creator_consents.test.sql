-- creator_consents + consent capture (FIVE_CREATOR_ONBOARDING_READINESS P0-3):
--   submit_creator_application consent gate (validation runs BEFORE the nonce
--   is consumed, so these need only an authenticated user):
--     1. NULL consents → consent_required
--     2. empty array → consent_required
--     3. missing 'likeness' → consent_required
--     4. empty version → bad_consent
--     5. unknown consent_type → bad_consent
--   admin_attest_creator_consent:
--     6. non-admin → forbidden
--     7. bad consent_type → bad_consent_type
--     8. missing creator → creator_not_found
--     9. happy path → consent row (source=admin_attestation, attested_by) + audit
--   admin_revoke_creator_consent:
--    10. revoke → row gets revoked_at + audit; gate-active count drops to 0
BEGIN;
SELECT plan(10);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_applicant uuid := tests.create_auth_user('cc-applicant@test');
  v_admin     uuid := tests.create_auth_user('cc-admin@test');
  v_other     uuid := tests.create_auth_user('cc-other@test');
  v_cuid      uuid := tests.create_auth_user('cc-creator@test');
  v_cid       uuid;
  v_consent   int;
  v_audit     int;
  v_attested  uuid;
  -- Reusable arg fragments for the submit validation calls. topics/proof are
  -- never reached (consent check raises first) but must be valid jsonb.
  v_call text := $q$SELECT public.submit_creator_application(
    'dummy-nonce','Name','handlex','bio','[]'::jsonb,'{}'::jsonb, %s)$q$;
BEGIN
  INSERT INTO public.admin_roles (user_id, email, role)
    VALUES (v_admin, 'cc-admin@test', 'superadmin');

  UPDATE public.profiles SET handle = 'ccc' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_cuid, 'CCC', 'ccc', 'training')
    RETURNING id INTO v_cid;

  -- ── submit_creator_application consent gate (authenticated applicant) ─────
  PERFORM tests.set_authenticated(v_applicant);

  -- 1. NULL consents.
  RETURN NEXT throws_like(
    format(v_call, 'NULL'),
    '%consent_required%', '1: null consents rejected');

  -- 2. empty array.
  RETURN NEXT throws_like(
    format(v_call, $$'[]'::jsonb$$),
    '%consent_required%', '2: empty consents rejected');

  -- 3. missing likeness.
  RETURN NEXT throws_like(
    format(v_call, $$'[{"type":"tos","version":"1"},{"type":"voice_clone","version":"1"}]'::jsonb$$),
    '%consent_required%', '3: missing likeness rejected');

  -- 4. empty version.
  RETURN NEXT throws_like(
    format(v_call, $$'[{"type":"tos","version":""},{"type":"voice_clone","version":"1"},{"type":"likeness","version":"1"}]'::jsonb$$),
    '%bad_consent%', '4: empty version rejected');

  -- 5. unknown type.
  RETURN NEXT throws_like(
    format(v_call, $$'[{"type":"bogus","version":"1"},{"type":"tos","version":"1"},{"type":"voice_clone","version":"1"},{"type":"likeness","version":"1"}]'::jsonb$$),
    '%bad_consent%', '5: unknown consent_type rejected');

  PERFORM tests.reset_role();

  -- ── admin_attest_creator_consent ─────────────────────────────────────────
  -- 6. non-admin.
  PERFORM tests.set_authenticated(v_other);
  RETURN NEXT throws_like(
    format('SELECT public.admin_attest_creator_consent(%L, %L, %L)', v_cid, 'voice_clone', '1.0'),
    '%forbidden%', '6: non-admin attestation rejected');
  PERFORM tests.reset_role();

  PERFORM tests.set_authenticated(v_admin);

  -- 7. bad type.
  RETURN NEXT throws_like(
    format('SELECT public.admin_attest_creator_consent(%L, %L, %L)', v_cid, 'nope', '1.0'),
    '%bad_consent_type%', '7: bad consent_type rejected');

  -- 8. missing creator.
  RETURN NEXT throws_like(
    format('SELECT public.admin_attest_creator_consent(%L, %L, %L)', gen_random_uuid(), 'voice_clone', '1.0'),
    '%creator_not_found%', '8: missing creator rejected');

  -- 9. happy path.
  SELECT public.admin_attest_creator_consent(v_cid, 'voice_clone', '1.0') INTO v_attested;
  PERFORM tests.reset_role();
  SELECT count(*) INTO v_consent
    FROM public.creator_consents
   WHERE user_id = v_cuid AND consent_type = 'voice_clone'
     AND source = 'admin_attestation' AND attested_by = v_admin;
  SELECT count(*) INTO v_audit
    FROM public.admin_audit_log
   WHERE target_id = v_cid AND action = 'creator_consent_attested';
  RETURN NEXT ok(
    v_attested IS NOT NULL AND v_consent = 1 AND v_audit = 1,
    '9: attestation writes consent row + audit row');

  -- 10. revoke the just-attested voice_clone consent.
  PERFORM tests.set_authenticated(v_admin);
  PERFORM public.admin_revoke_creator_consent(v_cid, 'voice_clone');
  PERFORM tests.reset_role();
  -- active (non-revoked) voice_clone rows for this user must now be 0,
  -- the revoked row carries revoked_at + revoked_by, and an audit row exists.
  SELECT count(*) INTO v_consent
    FROM public.creator_consents
   WHERE user_id = v_cuid AND consent_type = 'voice_clone' AND revoked_at IS NULL;
  SELECT count(*) INTO v_audit
    FROM public.admin_audit_log
   WHERE target_id = v_cid AND action = 'creator_consent_revoked';
  RETURN NEXT ok(
    v_consent = 0 AND v_audit = 1,
    '10: revoke marks consent revoked (active count 0) + audit row');
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
