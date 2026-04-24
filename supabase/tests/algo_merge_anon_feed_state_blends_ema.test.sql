-- §9.6 + audit C2: merge_anon_feed_state blends anon EMA into user affinity.
-- First-touch (no existing row) → INSERT with EXCLUDED value as-is.
-- Existing row → additive × 0.3: existing + anon * 0.3. Protects returning
-- users from losing months of signal to one Incognito session.
BEGIN;
SELECT plan(4);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user       uuid := tests.create_auth_user('algo-merge@test');
  v_creator_u  uuid := tests.create_auth_user('algo-merge-c@test');
  v_creator_id uuid;
  v_anon_id    uuid := gen_random_uuid();
  v_blended_topic   real;
  v_blended_creator real;
BEGIN
  UPDATE public.profiles SET handle = 'mergetarget' WHERE id = v_creator_u;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status)
    VALUES (v_creator_u, 'Merge Target', 'mergetarget', 'pending')
    RETURNING id INTO v_creator_id;

  -- Seed anon state directly (simulates /feed-batch writes before signup).
  INSERT INTO public.anon_feed_sessions (anon_id, topic_affinity, creator_affinity)
    VALUES (
      v_anon_id,
      jsonb_build_object('cold_outreach', 1.8),
      jsonb_build_object(v_creator_id::text, 2.2)
    );

  -- Seed pre-existing user affinity (simulates returning user signing in again).
  INSERT INTO public.user_topic_affinity
    (user_id, topic_slug, affinity_score)
    VALUES (v_user, 'cold_outreach', 0.4);
  INSERT INTO public.user_creator_affinity
    (user_id, creator_id, affinity_score)
    VALUES (v_user, v_creator_id, 1.0);

  PERFORM public.merge_anon_feed_state(v_anon_id, v_user);

  SELECT affinity_score INTO v_blended_topic
    FROM public.user_topic_affinity
   WHERE user_id = v_user AND topic_slug = 'cold_outreach';
  SELECT affinity_score INTO v_blended_creator
    FROM public.user_creator_affinity
   WHERE user_id = v_user AND creator_id = v_creator_id;

  -- C2: 0.4 + 1.8 * 0.3 = 0.94
  RETURN NEXT ok(
    abs(v_blended_topic - 0.94) < 0.001,
    format('1: topic blend 0.4 + 1.8 * 0.3 = 0.94 (got %s)', v_blended_topic)
  );
  -- C2: 1.0 + 2.2 * 0.3 = 1.66
  RETURN NEXT ok(
    abs(v_blended_creator - 1.66) < 0.001,
    format('2: creator blend 1.0 + 2.2 * 0.3 = 1.66 (got %s)', v_blended_creator)
  );

  -- Anon row is gone after merge.
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.anon_feed_sessions WHERE anon_id = v_anon_id),
    0,
    '3: anon session deleted after merge'
  );

  -- Second call with same anon_id is a no-op.
  PERFORM public.merge_anon_feed_state(v_anon_id, v_user);
  SELECT affinity_score INTO v_blended_topic
    FROM public.user_topic_affinity
   WHERE user_id = v_user AND topic_slug = 'cold_outreach';
  RETURN NEXT ok(
    abs(v_blended_topic - 0.94) < 0.001,
    '4: re-call with deleted anon_id is a no-op (no double-blend)'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
