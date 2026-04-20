-- R4-M3 Option B: applicant's profile-held handle is promoted to creator
-- ownership atomically on creator insert. Profile's handle becomes NULL.
BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('alice@test');
  v_cid uuid;
BEGIN
  UPDATE public.profiles SET handle = 'alice' WHERE id = v_uid;

  RETURN NEXT is(
    (SELECT owner_kind FROM public.handles_registry WHERE handle = 'alice'),
    'profile'::handle_owner_kind,
    'registry initially owned by profile'
  );

  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_uid, 'Alice', 'alice', 'pending')
    RETURNING id INTO v_cid;

  RETURN NEXT is(
    (SELECT owner_kind FROM public.handles_registry WHERE handle = 'alice'),
    'creator'::handle_owner_kind,
    'registry promoted to creator'
  );
  RETURN NEXT is(
    (SELECT owner_id FROM public.handles_registry WHERE handle = 'alice'),
    v_cid,
    'registry owner_id = new creator id'
  );
  RETURN NEXT is(
    (SELECT handle::text FROM public.profiles WHERE id = v_uid),
    NULL::text,
    'profile handle nulled post-promotion'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
