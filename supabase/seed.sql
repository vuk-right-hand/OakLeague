-- Local-only seed. Applied by `supabase db reset` after migrations; NOT pushed
-- to remote/prod (supabase push ignores seed.sql). Exists solely to persist
-- pgTAP helpers so every test file sees the `tests` schema without needing
-- its own \i include.

CREATE SCHEMA IF NOT EXISTS tests;
CREATE EXTENSION IF NOT EXISTS pgtap;

-- Tests occasionally SET LOCAL role authenticated / service_role and need to
-- call tests.reset_role() or other helpers. Grant schema usage + execute.
GRANT USAGE ON SCHEMA tests TO authenticated, service_role, anon;

CREATE OR REPLACE FUNCTION tests.create_auth_user(p_email text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (
    id, instance_id, email, encrypted_password, email_confirmed_at,
    aud, role, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data, is_sso_user
  )
  VALUES (
    v_id, '00000000-0000-0000-0000-000000000000', p_email,
    'not-a-real-hash', now(),
    'authenticated', 'authenticated', now(), now(),
    '{}'::jsonb, '{}'::jsonb, false
  );
  RETURN v_id;
END;$$;

CREATE OR REPLACE FUNCTION tests.set_authenticated(p_user_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
END;$$;

CREATE OR REPLACE FUNCTION tests.reset_role()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
END;$$;

GRANT EXECUTE ON FUNCTION tests.create_auth_user(text),
                         tests.set_authenticated(uuid),
                         tests.reset_role()
  TO authenticated, service_role, anon;
