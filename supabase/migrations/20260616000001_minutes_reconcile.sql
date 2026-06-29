-- 20260616000001 — Growth & Minutes Economy, Phase 7: COGS reconciliation
--
-- Plan: docs/_planning/GROWTH_MINUTES_ECONOMY_PLAN.md §9.
--
-- "Grants/allowances are money — the ledger must reconcile against cogs_log."
-- Two READ-ONLY, service-role-only reporting functions powering the admin viewer
-- (/admin/minutes), the reconcile CLI (scripts/minutes-reconcile.mjs), and a
-- future periodic cron alert:
--
--   minutes_reconcile_summary(from, to, welcome_floor)
--     → one row: range-bounded FLOWS (granted / consumed / billed voice COGS)
--       + point-in-time STOCKS (wallet totals) + invariant VIOLATION counts.
--   minutes_reconcile_violations(limit, welcome_floor)
--     → the actual offending users (wallet_mismatch | overspent | welcome_gap).
--
-- Invariants asserted (Phase-1 M4 + Phase-4 M6):
--   * wallet_active_seconds == Σ minute_grants.seconds   (materialised-column
--       integrity — a manual DELETE, or a direct INSERT bypassing
--       minute_grant_insert, desyncs it; minute_grants is append-only so the
--       only legit desync vector is hand-editing, which this catches).
--   * wallet_spent_seconds <= wallet_active_seconds       (no over-draw ⇒
--       effective_remaining ≥ 0 on the wallet side).
--   * onboarded users have a signup_bonus grant (the welcome actually landed) —
--       counted ONLY for onboarded_at >= p_welcome_floor, so pre-launch users
--       (who legitimately never ran the welcome — the grant feature was off) are
--       NOT flagged. p_welcome_floor NULL ⇒ ZERO welcome gaps (safe default).
--       Set it to the Growth go-live timestamp post-launch (env-driven, app side).
--
-- The blended COGS rate ($/min) is deliberately NOT in SQL — it is a pinned env
-- (MINUTES_BLENDED_COGS_USD_PER_MIN + _QUOTED_AT) read by the viewer + script
-- (plan R3-#5: "config flip with an audit trail, never a hardcoded literal").
-- SQL returns SECONDS + the actual billed voice USD; the app multiplies
-- seconds × env-rate for the "implied" figure.
--
-- The voice-COGS filter is OPERATION-based (not service-based) so it survives a
-- TTS/avatar provider swap (cartesia → fish → hume; simli → x): the operation
-- names are the stable Pipeline-α' contract. Source of truth for the list:
-- src/lib/admin/cogs-operations.ts (ALLOWED_COGS_OPERATIONS, voice legs + avatar).
--
-- COGS scope + comparison semantics (audit C1/C2/M6 — read before trusting $):
--   * actual voice COGS is PRODUCTION-ONLY (environment='production'). cogs_log
--     also holds spike_a/spike_b/dev rows that carried real cost_usd during the
--     spikes; folding them in would inflate the one number labelled "actual".
--   * implied($) = minutes × blended rate is a LIABILITY/SANITY estimate, NOT an
--     equality with actual. Read it as a ratio — a stale rate or a billing leak
--     shows as a LARGE divergence; small offsets are expected and meaningless.
--   * actual sums per-MINUTE legs (gemini in/out, tts chars) AND the per-SESSION
--     avatar mint + the cost=0 tts-audio meter, while implied is a smooth per-
--     minute line — so over SHORT windows with few long sessions the per-session
--     mint makes actual lumpy. Read longer windows / all-time.
--   * consumed seconds come from voice_usage_daily (the economy's authoritative
--     meter, prod-only) bucketed by the user-LOCAL day; actual is bucketed by
--     cogs_log.created_at (UTC). Over a windowed range they can differ by up to
--     ~1 day at each edge. ALL-TIME (NULL bounds — the CLI default) is edge-
--     noise-free and is the CANONICAL reconcile; the 30d viewer is a dashboard.
--
-- PAID-TIER SEAM (R4-M3): paid monthly-allowance consumption has NO minute_grants
-- row (the entitlement is the tier cap, not a wallet grant), so it is invisible
-- to the wallet invariants here — BY DESIGN. Paid reconciliation (consumption vs
-- stripe_customers period × cap) ships with Phase 6, when stripe_customers exists.
-- This migration reconciles the wallet + free tier, which is what is live today.
--
-- Read-only: no INSERT/UPDATE/DELETE. Safe to run on prod at any time.

BEGIN;

-- ── 1. minutes_reconcile_summary — one-row rollup ──────────────────────────
CREATE FUNCTION public.minutes_reconcile_summary(
  p_from          timestamptz DEFAULT NULL,  -- inclusive lower bound on FLOWS (NULL ⇒ unbounded)
  p_to            timestamptz DEFAULT NULL,  -- exclusive upper bound on FLOWS (NULL ⇒ unbounded)
  p_welcome_floor timestamptz DEFAULT NULL   -- welcome-gap floor (NULL ⇒ 0 gaps; see header)
) RETURNS TABLE (
  granted_seconds_total   bigint,
  granted_by_type         jsonb,
  wallet_active_total     bigint,
  wallet_spent_total      bigint,
  consumed_seconds_total  numeric,
  voice_cogs_usd          numeric,
  wallet_mismatch_count   int,
  overspent_count         int,
  welcome_gap_count       int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'minutes_reconcile_summary is service-role only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    -- FLOWS — granted seconds in range (granted_at is timestamptz).
    COALESCE((SELECT SUM(g.seconds)::bigint FROM public.minute_grants g
               WHERE (p_from IS NULL OR g.granted_at >= p_from)
                 AND (p_to   IS NULL OR g.granted_at <  p_to)), 0),
    -- granted seconds grouped by type ({} when none).
    COALESCE((SELECT jsonb_object_agg(t.grant_type, t.s)
                FROM (SELECT g.grant_type, SUM(g.seconds)::bigint AS s
                        FROM public.minute_grants g
                       WHERE (p_from IS NULL OR g.granted_at >= p_from)
                         AND (p_to   IS NULL OR g.granted_at <  p_to)
                       GROUP BY g.grant_type) t), '{}'::jsonb),
    -- STOCKS — point-in-time wallet totals (NOT range-bounded; the wallet is a
    -- running balance, not a flow).
    COALESCE((SELECT SUM(p.wallet_active_seconds)::bigint FROM public.profiles p), 0),
    COALESCE((SELECT SUM(p.wallet_spent_seconds)::bigint  FROM public.profiles p), 0),
    -- FLOWS — consumed voice seconds (voice_usage_daily.day is the user-local
    -- calendar date; the range filter uses the UTC date of the bounds, which is
    -- a close-enough aggregate boundary for a $ rollup — not a per-turn gate).
    COALESCE((SELECT SUM(d.seconds_used) FROM public.voice_usage_daily d
               WHERE (p_from IS NULL OR d.day >= (p_from AT TIME ZONE 'UTC')::date)
                 AND (p_to   IS NULL OR d.day <  (p_to   AT TIME ZONE 'UTC')::date)), 0),
    -- FLOWS — actual billed voice COGS (operation-based; swap-proof). C1:
    -- PRODUCTION ONLY — spike_a/spike_b/dev rows carried real cost_usd and must
    -- not inflate the figure the viewer labels "actual".
    COALESCE((SELECT SUM(c.cost_usd) FROM public.cogs_log c
               WHERE c.environment = 'production'
                 AND c.operation IN (
                       'voice_audio_input_seconds','voice_audio_out_tokens',
                       'voice_tts_characters','voice_tts_audio_seconds',
                       'avatar_session_token_mint')
                 AND (p_from IS NULL OR c.created_at >= p_from)
                 AND (p_to   IS NULL OR c.created_at <  p_to)), 0),
    -- VIOLATION COUNTS — point-in-time integrity (see header).
    -- SCALE CEILING (audit C3): these counts seq-scan public.profiles with a
    -- correlated grant subquery — fine for an admin/cron tool at v1..low-tens-of-
    -- thousands of users (the zero-wallet/zero-grant majority is skipped below).
    -- It is point-in-time so it cannot be windowed; beyond ~50K users move this
    -- to a periodic cron that writes a small `minutes_reconcile_snapshot` row the
    -- viewer reads (don't keep firing the full scan on every /admin/minutes load).
    -- wallet_active_seconds <> Σ grants. Skip the consistent zero-wallet/zero-grant
    -- majority (a user with no wallet and no grants is correct, not a violation).
    (SELECT count(*)::int FROM public.profiles p
       WHERE (p.wallet_active_seconds > 0
              OR EXISTS (SELECT 1 FROM public.minute_grants g WHERE g.user_id = p.id))
         AND p.wallet_active_seconds
             <> COALESCE((SELECT SUM(g.seconds) FROM public.minute_grants g WHERE g.user_id = p.id), 0)),
    -- wallet_spent > wallet_active (over-draw / negative effective remaining).
    (SELECT count(*)::int FROM public.profiles p
       WHERE p.wallet_spent_seconds > p.wallet_active_seconds),
    -- onboarded post-floor but no signup_bonus grant (welcome never landed).
    (SELECT count(*)::int FROM public.profiles p
       WHERE p_welcome_floor IS NOT NULL
         AND p.onboarded_at IS NOT NULL AND p.onboarded_at >= p_welcome_floor
         AND NOT EXISTS (SELECT 1 FROM public.minute_grants g
                          WHERE g.user_id = p.id AND g.grant_type = 'signup_bonus'));
END;$$;

REVOKE EXECUTE ON FUNCTION public.minutes_reconcile_summary(timestamptz, timestamptz, timestamptz)
  FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.minutes_reconcile_summary(timestamptz, timestamptz, timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.minutes_reconcile_summary(timestamptz, timestamptz, timestamptz) IS
  'Phase-7 reconcile rollup (read-only, service-role only). Range-bounded flows '
  '(granted/consumed/billed-voice-COGS) + point-in-time wallet stocks + invariant '
  'violation counts (wallet_active=Σgrants, no over-draw, post-floor signup_bonus). '
  'Blended $/min rate is an app-side env, not here. Paid-tier (no grant row) is a Phase-6 seam.';

-- ── 2. minutes_reconcile_violations — the offending rows ───────────────────
CREATE FUNCTION public.minutes_reconcile_violations(
  p_limit         int         DEFAULT 100,
  p_welcome_floor timestamptz DEFAULT NULL
) RETURNS TABLE (
  user_id               uuid,
  violation             text,
  wallet_active_seconds bigint,
  wallet_spent_seconds  bigint,
  grants_sum            bigint,
  onboarded_at          timestamptz,
  detail                text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
  v_limit    int;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'minutes_reconcile_violations is service-role only' USING ERRCODE = '42501';
  END IF;
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000);

  RETURN QUERY
  WITH g AS (
    SELECT mg.user_id AS uid, SUM(mg.seconds)::bigint AS s
      FROM public.minute_grants mg GROUP BY mg.user_id
  ),
  v AS (
    -- wallet_active != Σ grants
    SELECT p.id AS uid, 'wallet_mismatch'::text AS vio,
           p.wallet_active_seconds AS wa, p.wallet_spent_seconds AS ws,
           COALESCE(g.s, 0) AS gs, p.onboarded_at AS ob,
           format('wallet_active=%s but Σgrants=%s (Δ=%s)',
                  p.wallet_active_seconds, COALESCE(g.s, 0),
                  p.wallet_active_seconds - COALESCE(g.s, 0)) AS det
      FROM public.profiles p LEFT JOIN g ON g.uid = p.id
     WHERE (p.wallet_active_seconds > 0 OR g.s IS NOT NULL)
       AND p.wallet_active_seconds <> COALESCE(g.s, 0)
    UNION ALL
    -- wallet_spent > wallet_active
    SELECT p.id, 'overspent', p.wallet_active_seconds, p.wallet_spent_seconds,
           COALESCE(g.s, 0), p.onboarded_at,
           format('wallet_spent=%s > wallet_active=%s',
                  p.wallet_spent_seconds, p.wallet_active_seconds)
      FROM public.profiles p LEFT JOIN g ON g.uid = p.id
     WHERE p.wallet_spent_seconds > p.wallet_active_seconds
    UNION ALL
    -- onboarded post-floor, no signup_bonus
    SELECT p.id, 'welcome_gap', p.wallet_active_seconds, p.wallet_spent_seconds,
           COALESCE(g.s, 0), p.onboarded_at,
           format('onboarded %s, no signup_bonus grant', p.onboarded_at)
      FROM public.profiles p LEFT JOIN g ON g.uid = p.id
     WHERE p_welcome_floor IS NOT NULL
       AND p.onboarded_at IS NOT NULL AND p.onboarded_at >= p_welcome_floor
       AND NOT EXISTS (SELECT 1 FROM public.minute_grants mg
                        WHERE mg.user_id = p.id AND mg.grant_type = 'signup_bonus')
  )
  SELECT v.uid, v.vio, v.wa, v.ws, v.gs, v.ob, v.det
    FROM v
   ORDER BY v.vio, v.uid
   LIMIT v_limit;
END;$$;

REVOKE EXECUTE ON FUNCTION public.minutes_reconcile_violations(int, timestamptz)
  FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.minutes_reconcile_violations(int, timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.minutes_reconcile_violations(int, timestamptz) IS
  'Phase-7 reconcile offenders (read-only, service-role only). Up to p_limit rows '
  '(clamped 1..1000) across wallet_mismatch | overspent | welcome_gap. welcome_gap '
  'is suppressed unless p_welcome_floor is set (pre-launch users are not gaps).';

COMMIT;
