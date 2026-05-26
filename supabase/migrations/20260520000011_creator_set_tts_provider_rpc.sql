-- HUME_TTS_PLAN §6 auditor M3 (2026-05-13) — atomic admin TTS provider
-- mutations via SECURITY DEFINER RPC.
--
-- The original /admin/creators/[id]/actions.ts pattern was:
--   1. assertAdminFromSession (auth)
--   2. assertNoActiveSessions (COUNT)
--   3. UPDATE creators
--
-- The window between (2) and (3) is unbounded (network RTT to Supabase
-- twice). A session_open call from a user during that window can land
-- AFTER the COUNT but BEFORE the UPDATE, leaving an in-flight session
-- whose proxy bridge was instantiated for the OLD provider but whose
-- creators row now says the NEW provider. The snapshot column on
-- sessions.tts_provider_at_session is the canonical defense, but for
-- mid-life dial changes (speed, trailing silence) the snapshot only
-- protects tts_provider — speed/silence still apply at session-open via
-- the ticket. So the active-session guard at the app layer is real.
--
-- Fix: do both reads inside one transaction with row-level lock.
--   * SELECT FOR UPDATE on creators (locks the row).
--   * COUNT sessions WHERE creator_id=p_id AND ended_at IS NULL.
--   * UPDATE creators if count=0.
--   * Concurrent session_open insertion would have to acquire the same
--     row lock — but session_open doesn't, so this isn't true mutual
--     exclusion with session opening. It IS mutual exclusion with itself
--     (concurrent admin flips).
--
-- This isn't perfect serializability with session_open — that would
-- require a row lock on creators inside session_open too. But it
-- collapses the read-update window to one DB call, eliminates the
-- network RTT race, and is the right primitive for an admin UI that
-- already has the snapshot column backstop.

CREATE OR REPLACE FUNCTION public.creator_set_tts_provider(
  p_creator_id uuid,
  p_value      public.tts_provider  -- NULL allowed via overload below
) RETURNS TABLE (active_sessions bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role  text;
  v_count     bigint;
  v_creator_id uuid;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'creator_set_tts_provider: service_role only'
      USING ERRCODE = '42501';
  END IF;

  -- Row lock the creator. Concurrent admin flips serialize on this.
  SELECT id INTO v_creator_id
    FROM public.creators
   WHERE id = p_creator_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'creator % not found', p_creator_id USING ERRCODE = '23503';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.sessions
   WHERE creator_id = p_creator_id
     AND ended_at IS NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'creator has % active sessions', v_count USING ERRCODE = '55006';
  END IF;

  UPDATE public.creators
     SET tts_provider = p_value
   WHERE id = p_creator_id;

  RETURN QUERY SELECT v_count;
END;$$;

REVOKE EXECUTE ON FUNCTION public.creator_set_tts_provider(uuid, public.tts_provider)
  FROM public, anon, authenticated;

-- Companion RPC for Hume voice (id + name pair, audit M3+M6 paired-write).
-- Same lock semantics. CHECK creators_hume_voice_paired_chk gates the
-- DB-level pairing; this RPC adds the active-sessions defense.
CREATE OR REPLACE FUNCTION public.creator_set_hume_voice(
  p_creator_id uuid,
  p_env        text,   -- 'production' | 'preview' | 'development'
  p_voice_id   text,   -- NULL = clear (both args null required)
  p_voice_name text
) RETURNS TABLE (active_sessions bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role  text;
  v_count     bigint;
  v_creator_id uuid;
  v_id_col   text;
  v_name_col text;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'creator_set_hume_voice: service_role only'
      USING ERRCODE = '42501';
  END IF;

  IF p_env NOT IN ('production', 'preview', 'development') THEN
    RAISE EXCEPTION 'creator_set_hume_voice: bad env %', p_env USING ERRCODE = '22023';
  END IF;
  -- Paired: both null OR both non-null. App layer already validates,
  -- but defense-in-depth.
  IF (p_voice_id IS NULL) <> (p_voice_name IS NULL) THEN
    RAISE EXCEPTION 'creator_set_hume_voice: id + name must both be null or both set'
      USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_creator_id FROM public.creators WHERE id = p_creator_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'creator % not found', p_creator_id USING ERRCODE = '23503';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.sessions WHERE creator_id = p_creator_id AND ended_at IS NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'creator has % active sessions', v_count USING ERRCODE = '55006';
  END IF;

  v_id_col   := CASE p_env
                  WHEN 'production'  THEN 'hume_voice_id'
                  WHEN 'preview'     THEN 'hume_voice_id_preview'
                  ELSE                    'hume_voice_id_dev'
                END;
  v_name_col := CASE p_env
                  WHEN 'production'  THEN 'hume_voice_name'
                  WHEN 'preview'     THEN 'hume_voice_name_preview'
                  ELSE                    'hume_voice_name_dev'
                END;

  EXECUTE format(
    'UPDATE public.creators SET %I = $1, %I = $2 WHERE id = $3',
    v_id_col, v_name_col
  ) USING p_voice_id, p_voice_name, p_creator_id;

  RETURN QUERY SELECT v_count;
END;$$;

REVOKE EXECUTE ON FUNCTION public.creator_set_hume_voice(uuid, text, text, text)
  FROM public, anon, authenticated;

-- Bulk Hume prosody RPC — speed / trailing_silence / description / model_version
-- under the same lock + active-sessions guard.
--
-- Audit S16 (unit-wide, 2026-05-13) — coalesced into ONE dynamic UPDATE
-- with COALESCE() per field. Prior version ran up to 4 separate UPDATEs
-- (one per flag), each re-acquiring the (already-held) row lock and
-- writing the row 4 times. The COALESCE pattern keeps the column at its
-- existing value when `p_set_*` is false, sets to the new value otherwise.
CREATE OR REPLACE FUNCTION public.creator_set_hume_prosody(
  p_creator_id uuid,
  p_env        text,
  p_tts_speed         numeric,
  p_set_speed         boolean,
  p_trailing_silence  numeric,
  p_set_silence       boolean,
  p_voice_description text,
  p_set_description   boolean,
  p_model_version     text,
  p_set_model         boolean
) RETURNS TABLE (active_sessions bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role  text;
  v_count     bigint;
  v_creator_id uuid;
  v_sfx        text;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'creator_set_hume_prosody: service_role only'
      USING ERRCODE = '42501';
  END IF;

  IF p_env NOT IN ('production', 'preview', 'development') THEN
    RAISE EXCEPTION 'creator_set_hume_prosody: bad env %', p_env USING ERRCODE = '22023';
  END IF;
  v_sfx := CASE p_env WHEN 'production' THEN '' WHEN 'preview' THEN '_preview' ELSE '_dev' END;

  SELECT id INTO v_creator_id FROM public.creators WHERE id = p_creator_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'creator % not found', p_creator_id USING ERRCODE = '23503';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.sessions WHERE creator_id = p_creator_id AND ended_at IS NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'creator has % active sessions', v_count USING ERRCODE = '55006';
  END IF;

  -- Single coalesced UPDATE. Each column is set to the new value when its
  -- `p_set_*` flag is true, OR left untouched (re-assigned to itself) when
  -- the flag is false. `$5::numeric` etc. is cast-typed since EXECUTE+USING
  -- requires explicit casts on dynamic SQL with format() identifiers.
  EXECUTE format($fmt$
    UPDATE public.creators
       SET hume_tts_speed%1$s         = CASE WHEN $2 THEN $1 ELSE hume_tts_speed%1$s         END,
           hume_trailing_silence%1$s  = CASE WHEN $4 THEN $3 ELSE hume_trailing_silence%1$s  END,
           hume_voice_description%1$s = CASE WHEN $6 THEN $5 ELSE hume_voice_description%1$s END,
           hume_model_version%1$s     = CASE WHEN $8 THEN $7 ELSE hume_model_version%1$s     END
     WHERE id = $9
  $fmt$, v_sfx)
  USING p_tts_speed, p_set_speed,
        p_trailing_silence, p_set_silence,
        p_voice_description, p_set_description,
        p_model_version, p_set_model,
        p_creator_id;

  RETURN QUERY SELECT v_count;
END;$$;

REVOKE EXECUTE ON FUNCTION public.creator_set_hume_prosody(
  uuid, text,
  numeric, boolean,
  numeric, boolean,
  text, boolean,
  text, boolean
) FROM public, anon, authenticated;

NOTIFY pgrst, 'reload schema';
