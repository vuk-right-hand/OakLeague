-- public_profiles view + resolvers (PROFILE_SYSTEM_PLAN U1 / §3.2):
--   1.  EXACT column allowlist — FAILS THE BUILD on any added column (audit C1)
--   2.  No PII columns (email/tier/goals/obstacles/timezone/id) ever exposed
--   3.  anon HAS EXECUTE on resolve_public_profile (logged-out views, audit C2)
--   4.  anon has NO EXECUTE on handle_available (authenticated-only, M5 hardening)
--   5.  plain user resolves, is_creator = false
--   6.  published creator resolves by creator handle, is_creator = true, creator face
--   7.  unpublished creator → no public row (in-review has no public page)
--   8.  NULL-handle profile → not in the view at all
--   9.  handle_available: taken handle → false
--   10. handle_available: free valid handle → true
--   11. handle_available: reserved handle → false
--   12. handle_available: too-short handle → false
--   13. viewer_handshake_state is false before a handshake
--   14. viewer_handshake_state is true after a handshake
BEGIN;
SELECT plan(14);

-- 1. Exact column allowlist (static — drift = PII leak).
SELECT is(
  (SELECT array_agg(column_name::text ORDER BY column_name)
     FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'public_profiles'),
  ARRAY['avatar_url','bio','created_at','creator_id','display_name','handle',
        'handshake_count','handshakes_given_count','is_creator'],
  '1: public_profiles exposes exactly the allowlist (build fails on drift)');

-- 2. No PII columns.
SELECT is(
  (SELECT count(*)::int FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'public_profiles'
      AND column_name IN ('email','tier','goals','obstacles','timezone','id')),
  0, '2: no PII columns (email/tier/goals/obstacles/timezone/id) exposed');

-- 3. anon can read public profiles (logged-out views). 4. handle_available is
-- authenticated-only (M5: closed the anon handle-namespace enumeration oracle).
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'resolve_public_profile'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  1, '3: anon HAS EXECUTE on resolve_public_profile');
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE proname = 'handle_available'
      AND has_function_privilege('anon', oid, 'EXECUTE')),
  0, '4: anon has NO EXECUTE on handle_available (authenticated-only, M5)');

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user    uuid := tests.create_auth_user('pp-user@test');
  v_cre     uuid := tests.create_auth_user('pp-creator@test');
  v_unpub   uuid := tests.create_auth_user('pp-pending@test');
  v_nohnd   uuid := tests.create_auth_user('pp-nohandle@test');
  v_iscre   boolean;
  v_name    text;
  v_cnt     int;
  v_state   boolean;
BEGIN
  PERFORM tests.reset_role();
  UPDATE public.profiles SET handle = 'plainuser' WHERE id = v_user;
  -- v_nohnd keeps handle = NULL; mark it so we can assert its absence from the view.
  UPDATE public.profiles SET display_name = 'NoHandleMarker' WHERE id = v_nohnd;

  -- Published creator (own handle; profile handle stays NULL → COALESCE picks creator).
  INSERT INTO public.creators
    (user_id, display_name, handle, brain_status, voice_id, simli_face_id, system_prompt, published_at)
  VALUES
    (v_cre, 'Creator X', 'creatorx', 'ready', 'voice-x', 'face-x', 'You are X.', now());

  -- Unpublished creator.
  INSERT INTO public.creators
    (user_id, display_name, handle, brain_status, system_prompt)
  VALUES
    (v_unpub, 'Pending X', 'pendingx', 'training', 'You are pending.');

  -- 5. Plain user.
  SELECT is_creator INTO v_iscre FROM public.resolve_public_profile('plainuser'::citext);
  RETURN NEXT is(v_iscre, false, '5: plain user resolves, is_creator = false');

  -- 6. Published creator → creator face.
  SELECT is_creator, display_name INTO v_iscre, v_name
    FROM public.resolve_public_profile('creatorx'::citext);
  RETURN NEXT ok(v_iscre = true AND v_name = 'Creator X',
    '6: published creator resolves by creator handle with creator face');

  -- 7. Unpublished creator → no public row.
  SELECT count(*)::int INTO v_cnt FROM public.resolve_public_profile('pendingx'::citext);
  RETURN NEXT is(v_cnt, 0, '7: unpublished creator has no public profile row');

  -- 8. NULL-handle profile not in the view.
  SELECT count(*)::int INTO v_cnt FROM public.public_profiles
    WHERE display_name = 'NoHandleMarker';
  RETURN NEXT is(v_cnt, 0, '8: NULL-handle profile absent from the view');

  -- 9–12. handle_available — now authenticated-only (M5), so call it as a user.
  PERFORM tests.set_authenticated(v_user);
  RETURN NEXT is(public.handle_available('plainuser'::citext), false, '9: taken handle unavailable');
  RETURN NEXT is(public.handle_available('freenew'::citext),   true,  '10: free valid handle available');
  RETURN NEXT is(public.handle_available('apply'::citext),     false, '11: reserved handle unavailable');
  RETURN NEXT is(public.handle_available('ab'::citext),        false, '12: too-short handle unavailable');

  -- 13. viewer_handshake_state.
  PERFORM tests.set_authenticated(v_user);
  RETURN NEXT is(public.viewer_handshake_state('creatorx'::citext), false,
    '13: viewer_handshake_state false before handshake');
  PERFORM public.handshake('creatorx'::citext);
  SELECT public.viewer_handshake_state('creatorx'::citext) INTO v_state;
  RETURN NEXT is(v_state, true, '14: viewer_handshake_state true after handshake');
  PERFORM tests.reset_role();
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
