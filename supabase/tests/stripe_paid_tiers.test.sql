-- Phase 6 paid tiers: tier_default_voice_caps monthly model, the webhook tier-flip
-- RPC (flips caps, does NOT block on an active session, service-role only),
-- billing-period monthly_window_start, stripe_events dedup + stripe_customers
-- upsert, and the lapse-reconcile. Growth & Minutes Economy Phase 6 (migration
-- 20260616000002).
BEGIN;
SELECT plan(23);

CREATE FUNCTION pg_temp.run() RETURNS SETOF text LANGUAGE plpgsql AS $fn$
DECLARE
  v_user    uuid := tests.create_auth_user('paid-user@test');
  v_user2   uuid := tests.create_auth_user('paid-user2@test');
  v_user3   uuid := tests.create_auth_user('paid-user3@test');
  v_user4   uuid := tests.create_auth_user('paid-user4@test');
  v_user5   uuid := tests.create_auth_user('paid-user5@test');
  v_creator uuid := tests.create_auth_user('paid-creator@test');
  v_cid     uuid;
  v_n       int;
BEGIN
  -- ── tier_default_voice_caps monthly model ─────────────────────────────────
  RETURN NEXT ok((SELECT daily = 300   AND weekly = 900    AND monthly IS NULL FROM public.tier_default_voice_caps('free')),      '1: free caps 300/900/NULL (unchanged this migration)');
  RETURN NEXT ok((SELECT daily = 6600  AND weekly IS NULL AND monthly = 6600  FROM public.tier_default_voice_caps('premium')),   '2: premium caps 6600/NULL/6600');
  RETURN NEXT ok((SELECT daily = 48000 AND weekly IS NULL AND monthly = 48000 FROM public.tier_default_voice_caps('boardroom')), '3: boardroom caps 48000/NULL/48000');

  -- ── set_profile_tier_from_subscription flips tier + caps ──────────────────
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM public.set_profile_tier_from_subscription(v_user, 'premium');
  RETURN NEXT ok((SELECT tier = 'premium' AND voice_daily_cap_seconds = 6600 AND voice_monthly_cap_seconds = 6600 AND voice_weekly_cap_seconds IS NULL
                    FROM public.profiles WHERE id = v_user), '4: flip → premium sets tier + caps');
  PERFORM public.set_profile_tier_from_subscription(v_user, 'free');
  RETURN NEXT ok((SELECT tier = 'free' AND voice_daily_cap_seconds = 300 AND voice_weekly_cap_seconds = 900 AND voice_monthly_cap_seconds IS NULL
                    FROM public.profiles WHERE id = v_user), '5: flip → free resets tier + caps');

  -- ── does NOT block on an active session (unlike admin_set_profile_tier) ────
  UPDATE public.profiles SET handle = 'paidc' WHERE id = v_creator;
  INSERT INTO public.creators (user_id, display_name, handle, brain_status, published_at)
    VALUES (v_creator, 'PaidC', 'paidc', 'ready', now()) RETURNING id INTO v_cid;
  INSERT INTO public.sessions (user_id, creator_id, model_used, tier_at_session)
    VALUES (v_user2, v_cid, 'gemini_3_1_flash_live_preview', 'free');  -- ended_at NULL = active
  RETURN NEXT lives_ok(
    format($q$ SELECT public.set_profile_tier_from_subscription(%L, 'premium') $q$, v_user2),
    '6: tier flip does NOT block on an active session');
  RETURN NEXT is((SELECT tier FROM public.profiles WHERE id = v_user2), 'premium'::profile_tier,
                 '7: ...and the tier actually flipped');

  -- ── service-role guard ────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  RETURN NEXT throws_ok(
    format($q$ SELECT public.set_profile_tier_from_subscription(%L, 'premium') $q$, v_user),
    '42501', NULL, '8: set_profile_tier_from_subscription is service-role only');
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- ── monthly_window_start: calendar month vs active billing period ─────────
  RETURN NEXT is(public.monthly_window_start(v_user),
                 date_trunc('month', (now() AT TIME ZONE 'UTC'))::date,
                 '9: monthly_window_start free → calendar month');
  INSERT INTO public.stripe_customers (user_id, stripe_customer_id, status, current_period_start, current_period_end)
    VALUES (v_user, 'cus_v', 'active', now() - interval '10 days', now() + interval '20 days');
  RETURN NEXT is(public.monthly_window_start(v_user),
                 ((now() - interval '10 days') AT TIME ZONE 'UTC')::date,
                 '10: monthly_window_start active sub → billing-period start');

  -- ── stripe_customers upsert (no duplicate on conflict) ────────────────────
  INSERT INTO public.stripe_customers (user_id, stripe_customer_id, status)
    VALUES (v_user, 'cus_v', 'past_due')
    ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status;
  RETURN NEXT is((SELECT count(*)::int FROM public.stripe_customers WHERE user_id = v_user), 1, '11: upsert updates, no duplicate');
  RETURN NEXT is((SELECT status FROM public.stripe_customers WHERE user_id = v_user), 'past_due', '12: upsert applied the new status');

  -- ── stripe_events PK dedup ────────────────────────────────────────────────
  INSERT INTO public.stripe_events (event_id, type) VALUES ('evt_x', 'invoice.paid');
  RETURN NEXT throws_ok(
    $q$ INSERT INTO public.stripe_events (event_id, type) VALUES ('evt_x', 'invoice.paid') $q$,
    '23505', NULL, '13: stripe_events PK dedup (duplicate event_id rejected)');

  -- ── lapse reconcile: canceled+expired → free; active+expired stays ────────
  PERFORM public.set_profile_tier_from_subscription(v_user3, 'premium');
  PERFORM public.set_profile_tier_from_subscription(v_user4, 'premium');
  INSERT INTO public.stripe_customers (user_id, stripe_customer_id, status, current_period_end)
    VALUES (v_user3, 'cus3', 'canceled', now() - interval '1 day');
  INSERT INTO public.stripe_customers (user_id, stripe_customer_id, status, current_period_end)
    VALUES (v_user4, 'cus4', 'active',   now() - interval '1 day');  -- ended but still active → Stripe renews
  SELECT public.stripe_subscription_reconcile() INTO v_n;
  RETURN NEXT ok(v_n >= 1, '14: reconcile lapsed >= 1 user');
  RETURN NEXT is((SELECT tier FROM public.profiles WHERE id = v_user3), 'free'::profile_tier,      '15: canceled+expired user lapsed to free');
  RETURN NEXT is((SELECT tier FROM public.profiles WHERE id = v_user4), 'premium'::profile_tier,   '16: active+expired user NOT lapsed');

  -- ── stripe_events_purge floors retention at 3 days ────────────────────────
  RETURN NEXT is(public.stripe_events_purge(0), 0, '17: purge(0) floored to 3d retention keeps the fresh evt_x');

  -- ── service-role-only grants (has_function_privilege; never SET ROLE) ─────
  RETURN NEXT is((SELECT count(*)::int FROM pg_proc WHERE proname = 'set_profile_tier_from_subscription'
    AND has_function_privilege('authenticated', oid, 'EXECUTE')), 0, '18: authenticated denied set_profile_tier_from_subscription');
  RETURN NEXT is((SELECT count(*)::int FROM pg_proc WHERE proname = 'stripe_subscription_reconcile'
    AND has_function_privilege('anon', oid, 'EXECUTE')), 0, '19: anon denied stripe_subscription_reconcile');
  RETURN NEXT is((SELECT count(*)::int FROM pg_proc WHERE proname = 'stripe_events_purge'
    AND has_function_privilege('authenticated', oid, 'EXECUTE')), 0, '20: authenticated denied stripe_events_purge');

  -- ── C3: active sub whose period JUST ended (renewal lag) still meters to the ──
  -- billing-period start — no calendar-month fallback / re-grant. (v_user's
  -- current_period_start is now()-10d from assertion 10.)
  UPDATE public.stripe_customers SET status = 'active', current_period_end = now() - interval '1 day' WHERE user_id = v_user;
  RETURN NEXT is(public.monthly_window_start(v_user),
                 ((now() - interval '10 days') AT TIME ZONE 'UTC')::date,
                 '21: active+lagging period still meters to billing-period (C3, no re-grant)');

  -- past_due is entitled (dunning grace): still meters to the billing period.
  UPDATE public.stripe_customers SET status = 'past_due', current_period_end = now() + interval '5 days' WHERE user_id = v_user;
  RETURN NEXT is(public.monthly_window_start(v_user),
                 ((now() - interval '10 days') AT TIME ZONE 'UTC')::date,
                 '22: past_due (grace) still meters to billing-period');

  -- RE-ASSERT: a paid+active customer whose profiles.tier drifted to free is repaired.
  INSERT INTO public.stripe_customers (user_id, stripe_customer_id, status, tier, current_period_end)
    VALUES (v_user5, 'cus5', 'active', 'premium', now() + interval '20 days');
  PERFORM public.stripe_subscription_reconcile();
  RETURN NEXT is((SELECT tier FROM public.profiles WHERE id = v_user5), 'premium'::profile_tier,
                 '23: reconcile re-asserts a drifted paid tier (free → premium)');
END;
$fn$;

SELECT * FROM pg_temp.run();
SELECT * FROM finish();
ROLLBACK;
