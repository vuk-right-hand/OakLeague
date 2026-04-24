-- Audit M1: security contract for feed_events_raw is 4-sided.
-- SELECT denial is covered in algo_feed_events_raw_cross_user_read_denied.
-- Here we lock down INSERT (no WITH CHECK policy → explicit deny),
-- UPDATE (silent no-op under RLS + raise_append_only fires for superuser
-- writes that DO touch rows), and DELETE (silent no-op under RLS).
BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user uuid := tests.create_auth_user('algo-raw-write@test');
  v_id   bigint;
  v_before jsonb;
  v_after  jsonb;
BEGIN
  -- Seed one row as superuser so UPDATE / DELETE have a target.
  INSERT INTO public.feed_events_raw
    (user_id, event_name, idempotency_key, payload)
  VALUES (v_user, 'hook_impression', gen_random_uuid(), '{"seed": 1}'::jsonb)
  RETURNING id, payload INTO v_id, v_before;

  PERFORM tests.set_authenticated(v_user);

  -- 1. INSERT by authenticated role is denied: no WITH CHECK policy exists,
  -- so the row violates RLS and raises 42501.
  RETURN NEXT throws_ok(
    format($q$
      INSERT INTO public.feed_events_raw
        (user_id, event_name, idempotency_key, payload)
      VALUES (%L, 'hook_impression', gen_random_uuid(), '{}'::jsonb)
    $q$, v_user),
    '42501',
    NULL,
    '1: authenticated INSERT denied (no WITH CHECK policy)'
  );

  -- 2. UPDATE by authenticated role is a silent no-op under RLS: no FOR
  -- UPDATE policy means zero rows are visible to update, trigger never
  -- fires, payload is unchanged.
  UPDATE public.feed_events_raw SET payload = '{"mutated": true}'::jsonb
   WHERE id = v_id;
  SELECT payload INTO v_after FROM public.feed_events_raw WHERE id = v_id;
  RETURN NEXT is(
    v_after, v_before,
    '2: authenticated UPDATE is a silent no-op (row unchanged under RLS)'
  );

  -- 3. DELETE by authenticated role is also a silent no-op.
  DELETE FROM public.feed_events_raw WHERE id = v_id;
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.feed_events_raw WHERE id = v_id),
    1,
    '3: authenticated DELETE is a silent no-op (row still present)'
  );

  PERFORM tests.reset_role();

  -- 4. The append-only trigger itself works: a superuser UPDATE that
  -- DOES touch the row is rejected by raise_append_only. This asserts
  -- that a future policy addition can't accidentally open the write path
  -- without the trigger still guarding mutation.
  RETURN NEXT throws_like(
    format('UPDATE public.feed_events_raw SET payload = ''{}''::jsonb WHERE id = %s', v_id),
    '%append-only%',
    '4: superuser UPDATE blocked by raise_append_only trigger'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
