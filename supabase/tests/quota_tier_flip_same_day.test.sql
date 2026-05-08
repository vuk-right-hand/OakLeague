-- Same-day cap change propagates to daily_quotas.daily_limit_s via the next
-- session-open upsert (when not latched).
--
-- Post-2026-05-10 unification: the trigger reads profiles.voice_daily_cap_seconds,
-- not a hardcoded tier CASE. Bare UPDATE of profiles.tier no longer changes
-- daily_limit_s — only the profile cap column does. Tier flips that should
-- also bump caps go through admin_set_profile_tier (covered separately by
-- admin_tier_flip_invariants).
BEGIN;
SELECT plan(2);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_uid uuid := tests.create_auth_user('flip@test');
  v_cuid uuid := tests.create_auth_user('cflip@test');
  v_cid uuid;
  v_sid uuid;
BEGIN
  UPDATE public.profiles SET handle = 'cflip' WHERE id = v_cuid;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_cuid, 'CF', 'cflip', 'ready', now())
    RETURNING id INTO v_cid;

  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_uid, v_cid, 'gemini_3_1_flash_live_preview', 'free')
    RETURNING id INTO v_sid;

  RETURN NEXT is(
    (SELECT daily_limit_s FROM public.daily_quotas WHERE user_id = v_uid),
    300,
    'initial free-tier limit mirrors profiles.voice_daily_cap_seconds default = 300s'
  );

  -- Close session 1 before opening session 2: sessions_one_active_per_user
  -- is a partial unique index on user_id WHERE ended_at IS NULL.
  UPDATE public.sessions SET ended_at = now(), status = 'ended' WHERE id = v_sid;

  -- Bump the user's daily cap directly via the profile column. After the
  -- 2026-05-10 unification this is the canonical knob; bare UPDATE of tier
  -- no longer changes daily_limit_s.
  UPDATE public.profiles SET voice_daily_cap_seconds = 3600 WHERE id = v_uid;
  -- Pipeline α': all tiers share the same model_used value; the tier is the
  -- dial, not the model. Was 'gemini_pro_audio_v2' before migration
  -- 20260420000034 dropped that enum variant.
  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_uid, v_cid, 'gemini_3_1_flash_live_preview', 'free');

  RETURN NEXT is(
    (SELECT daily_limit_s FROM public.daily_quotas WHERE user_id = v_uid),
    3600,
    'next session-open upsert mirrors the bumped profile cap to daily_limit_s'
  );
END;
$fn$;

SELECT * FROM pg_temp.run();

SELECT * FROM finish();
ROLLBACK;
