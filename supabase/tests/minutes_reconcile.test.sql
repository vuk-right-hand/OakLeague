-- Phase-7 COGS reconciliation: minutes_reconcile_summary + _violations.
-- Delta-based assertions (robust against any seed data already in the DB).
-- Growth & Minutes Economy Phase 7 (migration 20260616000001).
BEGIN;
SELECT plan(16);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_a uuid := tests.create_auth_user('recon_a@test');
  v_b uuid := tests.create_auth_user('recon_b@test');
  v_c uuid := tests.create_auth_user('recon_c@test');
  r record;
  base_granted   bigint;
  base_wa        bigint;
  base_cogs      numeric;
  base_consumed  numeric;
  base_mismatch  int;
  base_overspent int;
  wg_null  int;
  wg_floor int;
  v_byt    jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Baseline (whatever seed data exists) so every assertion is a delta.
  SELECT * INTO r FROM public.minutes_reconcile_summary(NULL, NULL, NULL);
  base_granted   := r.granted_seconds_total;
  base_wa        := r.wallet_active_total;
  base_cogs      := r.voice_cogs_usd;
  base_consumed  := r.consumed_seconds_total;
  base_mismatch  := r.wallet_mismatch_count;
  base_overspent := r.overspent_count;

  -- Consistent grants for A (wallet bumped through the sole write path).
  PERFORM public.minute_grant_insert(v_a, 'referral_verified', 900, 'referral_token', 'recon_tok', NULL, NULL);
  PERFORM public.minute_grant_insert(v_a, 'admin_adjustment',    60, 'admin',          NULL,        NULL, NULL);

  SELECT * INTO r FROM public.minutes_reconcile_summary(NULL, NULL, NULL);
  RETURN NEXT is(r.granted_seconds_total - base_granted, 960::bigint, '1: granted_seconds delta = 960');
  RETURN NEXT ok((r.granted_by_type->>'referral_verified')::bigint >= 900, '2: granted_by_type carries referral_verified');
  RETURN NEXT is(r.wallet_active_total - base_wa, 960::bigint, '3: wallet_active_total delta = 960');

  -- Voice COGS counts the production voice leg, ignores a non-voice op
  -- (operation filter) AND a spike_a voice leg (C1 environment filter).
  INSERT INTO public.cogs_log (user_id, service, operation, units, unit_label, cost_usd)
    VALUES (v_a, 'gemini', 'voice_audio_input_seconds', 10, 'seconds', 0.05);          -- env default 'production' → counted
  INSERT INTO public.cogs_log (user_id, service, operation, units, unit_label, cost_usd)
    VALUES (v_a, 'mux', 'video_asset_create', 1, 'asset', 99.0);                       -- non-voice op → ignored
  INSERT INTO public.cogs_log (user_id, service, operation, units, unit_label, cost_usd, environment)
    VALUES (v_a, 'gemini', 'voice_audio_input_seconds', 10, 'seconds', 88.0, 'spike_a'); -- spike voice leg → ignored (C1)
  SELECT * INTO r FROM public.minutes_reconcile_summary(NULL, NULL, NULL);
  RETURN NEXT is(r.voice_cogs_usd - base_cogs, 0.05::numeric,
                '4: voice_cogs sums prod voice leg, ignores video_asset_create + spike_a');

  -- Consumed seconds from voice_usage_daily.
  INSERT INTO public.voice_usage_daily (user_id, day, seconds_used)
    VALUES (v_a, (now() AT TIME ZONE 'UTC')::date, 120);
  SELECT * INTO r FROM public.minutes_reconcile_summary(NULL, NULL, NULL);
  RETURN NEXT is(r.consumed_seconds_total - base_consumed, 120::numeric, '5: consumed_seconds delta = 120');

  -- wallet_mismatch: a DIRECT insert bypassing minute_grant_insert (no wallet bump).
  INSERT INTO public.minute_grants (user_id, grant_type, seconds, source_kind, source_key)
    VALUES (v_a, 'admin_adjustment', 100, 'admin', NULL);
  SELECT * INTO r FROM public.minutes_reconcile_summary(NULL, NULL, NULL);
  RETURN NEXT is(r.wallet_mismatch_count - base_mismatch, 1, '6: wallet_mismatch_count +1 after bypass insert');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.minutes_reconcile_violations(1000, NULL) x
                          WHERE x.user_id = v_a AND x.violation = 'wallet_mismatch'),
                 '7: violations lists A as wallet_mismatch');

  -- overspent: B granted 100 but wallet_spent forced to 200.
  PERFORM public.minute_grant_insert(v_b, 'referral_verified', 100, 'referral_token', 'recon_tok_b', NULL, NULL);
  UPDATE public.profiles SET wallet_spent_seconds = 200 WHERE id = v_b;
  SELECT * INTO r FROM public.minutes_reconcile_summary(NULL, NULL, NULL);
  RETURN NEXT ok(r.overspent_count - base_overspent >= 1, '8: overspent_count rose for B');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.minutes_reconcile_violations(1000, NULL) x
                          WHERE x.user_id = v_b AND x.violation = 'overspent'),
                 '9: violations lists B as overspent');

  -- welcome_gap: C onboarded but no signup_bonus — counted ONLY with a floor.
  UPDATE public.profiles SET onboarded_at = now() - interval '1 day' WHERE id = v_c;
  SELECT welcome_gap_count INTO wg_null  FROM public.minutes_reconcile_summary(NULL, NULL, NULL);
  SELECT welcome_gap_count INTO wg_floor FROM public.minutes_reconcile_summary(NULL, NULL, now() - interval '7 days');
  RETURN NEXT ok(wg_floor > wg_null, '10: welcome_gap counted only with a floor (floor > null)');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM public.minutes_reconcile_violations(1000, now() - interval '7 days') x
                          WHERE x.user_id = v_c AND x.violation = 'welcome_gap'),
                 '11: violations lists C as welcome_gap (with floor)');
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM public.minutes_reconcile_violations(1000, NULL) x
                              WHERE x.user_id = v_c AND x.violation = 'welcome_gap'),
                 '12: C NOT flagged without floor (pre-launch safe)');

  -- Granting the signup_bonus clears the gap.
  PERFORM public.minute_grant_insert(v_c, 'signup_bonus', 900, 'signup', 'signup:' || v_c::text, NULL, NULL);
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM public.minutes_reconcile_violations(1000, now() - interval '7 days') x
                              WHERE x.user_id = v_c AND x.violation = 'welcome_gap'),
                 '13: welcome_gap clears once signup_bonus granted');

  -- Service-role guard: a non-service JWT is rejected (42501). We only change the
  -- JWT claim (NOT SET ROLE) so the backend never segfaults (project_pg17_secdef_role_segfault).
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  RETURN NEXT throws_ok($q$ SELECT * FROM public.minutes_reconcile_summary() $q$, '42501', NULL,
                        '14: summary rejects non-service caller (42501)');
  RETURN NEXT throws_ok($q$ SELECT * FROM public.minutes_reconcile_violations() $q$, '42501', NULL,
                        '15: violations rejects non-service caller (42501)');
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- 16: an empty grant range returns '{}' (the jsonb_object_agg empty path, not NULL).
  SELECT granted_by_type INTO v_byt
    FROM public.minutes_reconcile_summary(now() + interval '1 day', NULL, NULL);
  RETURN NEXT is(v_byt, '{}'::jsonb, '16: empty-range granted_by_type = {}');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
