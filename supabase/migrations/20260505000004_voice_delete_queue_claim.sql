-- L-C1 / S-M1 — atomic claim RPC for voice_delete_queue.
--
-- Multi-VM Fly + naive SELECT-then-iterate caused two distinct bugs:
--   1. Same row picked by N machines → N redundant Cartesia DELETE calls
--      (idempotent at Cartesia, but burns rate-limit on the API key).
--   2. After one machine succeeds + dequeues, the other's UPDATE attempts++
--      affects 0 rows silently — no Sentry signal — and on transient 5xx
--      both machines bump the same row's attempts independently → false
--      orphan alarm at attempt 5/10.
--
-- Fix: a SECURITY DEFINER claim RPC selects with FOR UPDATE SKIP LOCKED,
-- bumps attempts pre-DELETE so the row stays locked until the worker's
-- transaction commits, and returns only the rows this caller owns.
--
-- The worker then calls Cartesia DELETE; on success it calls
-- voice_delete_queue_complete (also new) which deletes the row by PK; on
-- failure it calls voice_delete_queue_record_failure to store last_error.
--
-- This trio replaces the SELECT/UPDATE pattern in voice-delete-worker.js.

CREATE FUNCTION public.voice_delete_queue_claim(p_limit int DEFAULT 5)
RETURNS TABLE (voice_id text, attempts int, due_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'voice_delete_queue_claim: service_role only'
      USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'p_limit out of range' USING ERRCODE = '22023';
  END IF;

  -- Bump attempts inside the same statement that locks the row. Any
  -- concurrent worker hits SKIP LOCKED → silently moves on. The bumped
  -- attempts is returned to the caller so failure-thresholding doesn't
  -- need a second SELECT.
  RETURN QUERY
    UPDATE public.voice_delete_queue q
       SET attempts = q.attempts + 1, updated_at = now()
     WHERE q.voice_id IN (
       SELECT inner_q.voice_id
         FROM public.voice_delete_queue inner_q
        WHERE inner_q.due_at <= now()
          AND inner_q.attempts < 10
        ORDER BY inner_q.due_at ASC
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
     )
    RETURNING q.voice_id, q.attempts, q.due_at;
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_delete_queue_claim(int)
  FROM public, anon, authenticated;

-- Marks a successful Cartesia DELETE: removes the row from the queue.
-- Idempotent — DELETE on a missing row is a no-op.
CREATE FUNCTION public.voice_delete_queue_complete(p_voice_id text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'voice_delete_queue_complete: service_role only'
      USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.voice_delete_queue WHERE voice_id = p_voice_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_delete_queue_complete(text)
  FROM public, anon, authenticated;

-- Records a failure (Cartesia 5xx, network, etc.). Updates last_error
-- without bumping attempts (already bumped at claim time).
CREATE FUNCTION public.voice_delete_queue_record_failure(p_voice_id text, p_last_error text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_jwt_role text;
BEGIN
  v_jwt_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'voice_delete_queue_record_failure: service_role only'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.voice_delete_queue
     SET last_error = LEFT(coalesce(p_last_error, 'unknown'), 500),
         updated_at = now()
   WHERE voice_id = p_voice_id;
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_delete_queue_record_failure(text, text)
  FROM public, anon, authenticated;
