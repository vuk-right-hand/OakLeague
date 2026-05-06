-- SIMLI_WIREUP §12a.3 / R3-Missing-3 / R4-C3 — Simli face delete queue +
-- admin force-retrain RPC.
--
-- Mirrors the existing voice_delete_queue (0073) pattern for Cartesia
-- voice deletion — same 60s defer, same service-role-only model, same
-- claim/complete/record_failure trio (0074).
--
-- creator_delete RPC (when added) enqueues to BOTH queues so a deleted
-- creator's data is fully erased from both vendors per GDPR Art. 17.
--
-- R4-C3 — race vs in-flight session. simli_face_delete_queue_claim
-- skips rows whose creator has an active session (NOT EXISTS guard).
-- admin_force_retrain_creator takes pg_advisory_xact_lock + raises if
-- active session.

-- 1. simli_face_delete_queue ---------------------------------------------------

CREATE TABLE IF NOT EXISTS public.simli_face_delete_queue (
  face_id       text        PRIMARY KEY CHECK (char_length(face_id) BETWEEN 1 AND 128),
  creator_id    uuid        REFERENCES public.creators(id) ON DELETE SET NULL,
  enqueued_by   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  due_at        timestamptz NOT NULL,
  attempts      int         NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 10),
  last_error    text        CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS simli_face_delete_queue_due_at_idx
  ON public.simli_face_delete_queue (due_at)
  WHERE attempts < 10;

DROP TRIGGER IF EXISTS simli_face_delete_queue_touch_updated_at ON public.simli_face_delete_queue;
CREATE TRIGGER simli_face_delete_queue_touch_updated_at
  BEFORE UPDATE ON public.simli_face_delete_queue
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.simli_face_delete_queue ENABLE ROW LEVEL SECURITY;
-- Zero policies — service-role only.

-- 2. claim/complete/record_failure trio (mirrors voice_delete_queue 0074) -----

CREATE OR REPLACE FUNCTION public.simli_face_delete_queue_claim(p_limit int DEFAULT 5)
RETURNS TABLE (face_id text, creator_id uuid, attempts int, due_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'simli_face_delete_queue_claim: service_role only'
      USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'p_limit out of range' USING ERRCODE = '22023';
  END IF;

  -- R4-C3: skip rows whose creator has an active session. Worker retries
  -- 60s later automatically (queue scan resumes after due_at slips).
  RETURN QUERY
    UPDATE public.simli_face_delete_queue q
       SET attempts = q.attempts + 1, updated_at = now()
     WHERE q.face_id IN (
       SELECT inner_q.face_id
         FROM public.simli_face_delete_queue inner_q
        WHERE inner_q.due_at <= now()
          AND inner_q.attempts < 10
          AND NOT EXISTS (
            SELECT 1 FROM public.sessions s
             WHERE s.creator_id = inner_q.creator_id
               AND s.ended_at IS NULL
          )
        ORDER BY inner_q.due_at ASC
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
     )
    RETURNING q.face_id, q.creator_id, q.attempts, q.due_at;
END;$$;

REVOKE EXECUTE ON FUNCTION public.simli_face_delete_queue_claim(int)
  FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.simli_face_delete_queue_complete(p_face_id text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'simli_face_delete_queue_complete: service_role only'
      USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.simli_face_delete_queue WHERE face_id = p_face_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.simli_face_delete_queue_complete(text)
  FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.simli_face_delete_queue_record_failure(
  p_face_id text, p_last_error text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'simli_face_delete_queue_record_failure: service_role only'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.simli_face_delete_queue
     SET last_error = LEFT(coalesce(p_last_error, 'unknown'), 500),
         updated_at = now()
   WHERE face_id = p_face_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.simli_face_delete_queue_record_failure(text, text)
  FROM public, anon, authenticated;

-- 3. admin_force_retrain_creator RPC ------------------------------------------
-- Called from /admin/creators/[id]/health (R3-Missing-2). Race-safe per R4-C3:
--   * pg_advisory_xact_lock(hashtext('creator_retrain:' || creator_id))
--     prevents concurrent retrain admin clicks.
--   * RAISE 'creator_has_active_session' if any open sessions — admin UI
--     surfaces this and offers "kick active sessions" via existing
--     admin_force_close_session RPC.
--
-- The RPC clears creators.simli_face_id and enqueues the OLD face for
-- 60s-deferred delete. Actual retrain (call to Simli's create-face
-- endpoint) is admin-handled out-of-band; the next session-open against
-- the cleared creator returns 409 creator_face_not_trained until the
-- admin uploads a new face.

CREATE OR REPLACE FUNCTION public.admin_force_retrain_creator(
  p_creator_id uuid
) RETURNS TABLE (prior_face_id text, cleared boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_caller       uuid := auth.uid();
  v_is_admin     boolean;
  v_active_count int;
  v_prior        text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.admin_roles WHERE user_id = v_caller) INTO v_is_admin;
  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('creator_retrain:' || p_creator_id::text));

  SELECT count(*) INTO v_active_count
    FROM public.sessions
   WHERE creator_id = p_creator_id AND ended_at IS NULL;
  IF v_active_count > 0 THEN
    RAISE EXCEPTION 'creator_has_active_session: % open', v_active_count
      USING ERRCODE = 'P0001';
  END IF;

  SELECT simli_face_id INTO v_prior FROM public.creators WHERE id = p_creator_id FOR UPDATE;
  UPDATE public.creators
     SET simli_face_id = NULL, updated_at = now()
   WHERE id = p_creator_id;

  IF v_prior IS NOT NULL THEN
    INSERT INTO public.simli_face_delete_queue (face_id, creator_id, enqueued_by, due_at)
    VALUES (v_prior, p_creator_id, v_caller, now() + interval '60 seconds')
    ON CONFLICT (face_id) DO UPDATE
      SET due_at = EXCLUDED.due_at,
          attempts = 0,
          last_error = NULL,
          enqueued_by = EXCLUDED.enqueued_by,
          updated_at = now();
  END IF;

  -- Audit row in cogs_log (cost = 0).
  INSERT INTO public.cogs_log (
    user_id, session_id, service, operation, units, unit_label, cost_usd,
    environment, metadata
  ) VALUES (
    v_caller, NULL, 'simli', 'admin_force_retrain', 1, 'action', 0,
    'production',
    jsonb_build_object('creator_id', p_creator_id, 'prior_face_id', v_prior)
  );

  RETURN QUERY SELECT v_prior, (v_prior IS NOT NULL);
END;$$;

REVOKE EXECUTE ON FUNCTION public.admin_force_retrain_creator(uuid) FROM public;

COMMENT ON FUNCTION public.admin_force_retrain_creator(uuid) IS
  'Admin-only. Clears creators.simli_face_id, enqueues the prior face for '
  'deferred delete (60s), audits to cogs_log. Raises P0001 '
  'creator_has_active_session if any open sessions exist (R4-C3 race-guard).';
