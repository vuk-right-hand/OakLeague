-- 0043 — cogs_insert_turn caller guard + REVOKE fixups on 0040 + 0042 RPCs
--
-- Post-Spike-A audit Round 2, C1 + C2.
--
-- Problem 1 (C1): Supabase auto-GRANTs EXECUTE on every new function to
--   {public, anon, authenticated, service_role}. Migrations 0040 and 0042
--   only REVOKEd from `public`, leaving `anon` and `authenticated` with
--   explicit EXECUTE. Because these functions are SECURITY DEFINER and
--   bypass RLS, any logged-in Supabase user could call them directly and
--   (a) latch another user's quota via voice_accumulate_seconds or
--   (b) pollute cogs_log via cogs_insert_turn under their own user_id.
--
-- Problem 2 (C2): The caller-identity guard in cogs_insert_turn was drafted
--   as an in-place edit to migration 0040, which was already applied. That
--   edit never reached the database. CREATE OR REPLACE here lands it for real.
--
-- Policy: never edit an applied migration file in place. Add a new migration.

-- ── cogs_insert_turn: rebuild with caller guard ────────────────────────────

CREATE OR REPLACE FUNCTION public.cogs_insert_turn(
  p_user_id        uuid,
  p_session_id     uuid,
  p_service        cogs_service,
  p_model          text,
  p_input_seconds  numeric,
  p_output_seconds numeric,
  p_input_cost     numeric,
  p_output_cost    numeric,
  p_environment    text,
  p_metadata       jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (input_row_id bigint, output_row_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_input_id  bigint;
  v_output_id bigint;
  v_jwt_role  text;
BEGIN
  -- Caller identity guard. Two layers:
  --   1. If the caller is an authenticated end-user (JWT role = 'authenticated'),
  --      they may only insert rows under their own user_id. Blocks cross-user
  --      forgery if EXECUTE ever leaks to `authenticated`.
  --   2. If the caller is not the service_role, reject entirely when the
  --      p_user_id doesn't match auth.uid(). Defense-in-depth on top of the
  --      REVOKEs below — a stray GRANT can't cause damage beyond self-pollution.
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
      RAISE EXCEPTION 'caller cannot insert turn for another user'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_environment NOT IN ('production', 'spike_a', 'spike_b', 'dev') THEN
    RAISE EXCEPTION 'invalid environment: %', p_environment USING ERRCODE = '22023';
  END IF;
  IF p_input_seconds < 0 OR p_output_seconds < 0 THEN
    RAISE EXCEPTION 'negative seconds' USING ERRCODE = '22003';
  END IF;
  IF p_input_seconds > 3600 OR p_output_seconds > 3600 THEN
    RAISE EXCEPTION 'seconds exceed per-turn cap (3600)' USING ERRCODE = '22003';
  END IF;

  INSERT INTO public.cogs_log (user_id, session_id, service, operation, units, unit_label, cost_usd, environment, metadata)
  VALUES (p_user_id, p_session_id, p_service, 'voice_audio_input_seconds',
          p_input_seconds, 'seconds', p_input_cost, p_environment,
          p_metadata || jsonb_build_object('model', p_model, 'direction', 'input'))
  RETURNING id INTO v_input_id;

  INSERT INTO public.cogs_log (user_id, session_id, service, operation, units, unit_label, cost_usd, environment, metadata)
  VALUES (p_user_id, p_session_id, p_service, 'voice_audio_output_seconds',
          p_output_seconds, 'seconds', p_output_cost, p_environment,
          p_metadata || jsonb_build_object('model', p_model, 'direction', 'output'))
  RETURNING id INTO v_output_id;

  RETURN QUERY SELECT v_input_id, v_output_id;
END;$$;

-- ── REVOKE EXECUTE from non-service roles ──────────────────────────────────
-- Covers: (a) functions created in 0040 whose REVOKE was too narrow, and
-- (b) voice_check_quota / voice_accumulate_seconds from 0042 (already fixed
-- in that file's source, but applying here too is idempotent and ensures
-- production state is correct if 0042 is applied before this migration lands).

REVOKE EXECUTE ON FUNCTION public.cogs_insert_turn(uuid, uuid, cogs_service, text, numeric, numeric, numeric, numeric, text, jsonb)
  FROM public, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.reap_stale_sessions(int)
  FROM public, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.voice_check_quota(uuid)
  FROM public, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.voice_accumulate_seconds(uuid, numeric)
  FROM public, anon, authenticated;
