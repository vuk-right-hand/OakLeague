-- pgTAP — locks in the 20260509000007 fix for the ambiguous-`session_id`
-- bug in public.session_close.
--
-- Pre-fix the function raised 42702 ('column reference "session_id" is
-- ambiguous') whenever a closed session had an open row in
-- public.session_pauses (HeyGen pause/resume flow generates these on
-- every test). Post-fix, `#variable_conflict use_column` directs the
-- planner to bind unqualified `session_id` to the column, eliminating
-- the OUT-variable collision.
--
-- Fixture: insert a sessions row, an open session_pauses row, then
-- call session_close as the row owner. Pre-fix this would 42702;
-- post-fix it returns one row with end_reason='user_ended'.

BEGIN;
SELECT plan(2);

-- Fixture user — bypass auth.uid() ownership check by using service path.
-- We can't easily set request.jwt.claims->>role='service_role' from
-- pgTAP, so we set v_caller = sessions.user_id by impersonating via
-- explicit ownership match. Easiest path: insert a fake auth user row,
-- then SET LOCAL request.jwt.claims to have sub=that uuid.

DO $$
DECLARE
  v_user uuid := gen_random_uuid();
  v_creator uuid := gen_random_uuid();
  v_session uuid := gen_random_uuid();
BEGIN
  -- Minimal auth user (other tests do this; relies on the pgTAP env
  -- having auth.users writable — Supabase local does).
  INSERT INTO auth.users (id, email, instance_id)
    VALUES (v_user, 'sessclose+'||v_user||'@test.local', '00000000-0000-0000-0000-000000000000');

  INSERT INTO public.profiles (id, timezone, tier)
    VALUES (v_user, 'UTC', 'free')
    ON CONFLICT (id) DO NOTHING;

  -- Minimal creator (FK target for sessions.creator_id).
  INSERT INTO public.creators (id, user_id, display_name, handle, creator_type)
    VALUES (v_creator, v_user, 'Test Creator', 'tc_'||substr(v_user::text,1,8), 'human');

  -- Live session row.
  INSERT INTO public.sessions (id, user_id, creator_id, tier_at_session, started_at, status, model_used)
    VALUES (v_session, v_user, v_creator, 'free', now() - interval '10 seconds', 'active', 'gemini_3_1_flash_live_preview');

  -- Open pause row — this is the trigger for the ambiguity bug.
  INSERT INTO public.session_pauses (session_id, paused_at)
    VALUES (v_session, now() - interval '5 seconds');

  -- Impersonate as that user for auth.uid() inside the SECURITY DEFINER
  -- function. session_close compares v_row.user_id <> v_caller, so this
  -- must match.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text,
    true
  );

  -- Stash for later asserts.
  PERFORM set_config('test.session_id', v_session::text, true);
END $$;

-- 1. CALL passes — pre-fix this raised 42702.
SELECT lives_ok(
  $$ SELECT * FROM public.session_close(
       (current_setting('test.session_id'))::uuid,
       'user_ended'
     ) $$,
  'session_close runs without ambiguous-session_id error when an open pause row exists'
);

-- 2. The pause row was actually closed (resumed_at set).
SELECT ok(
  (SELECT bool_and(resumed_at IS NOT NULL)
     FROM public.session_pauses
    WHERE session_id = (current_setting('test.session_id'))::uuid),
  'open pause row was defensively resumed by session_close'
);

SELECT * FROM finish();
ROLLBACK;
