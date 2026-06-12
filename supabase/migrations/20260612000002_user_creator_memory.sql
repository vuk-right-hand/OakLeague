-- 20260612000002 — MEMORY_BREADTH_PLAN Unit 1b: durable per-(user, creator)
-- memory with open loops.
--
-- One bounded row per pair (PK), merged-overwritten by a post-session
-- extraction (proxy teardown, fire-and-forget). Durable BY DESIGN (R1-M5):
-- no inactivity TTL; ON DELETE CASCADE covers account deletion; users can
-- SELECT and DELETE their own rows (the "Forget our conversations" path).
-- Service-role owns all writes via the SECURITY DEFINER RPC below.
--
-- R1-M3 concurrency: the RPC is idempotent per session
-- (last_extract_session_id) and ordered (an older concurrent session's
-- extract cannot clobber a newer summary — p_session_started_at guard).

CREATE TABLE public.user_creator_memory (
  user_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  creator_id              uuid NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  -- Third-person neutral facts about the user's situation/goals/progress.
  -- Bounded forever: the extraction MERGES old+new into one capped summary.
  summary                 text NOT NULL CHECK (octet_length(summary) <= 1500),
  -- The single open thread to check in about next session ("said he'd ship
  -- the landing page this week"). NULL = no open loop (resolved/none).
  open_loop               text CHECK (open_loop IS NULL OR octet_length(open_loop) <= 300),
  sessions_count          int NOT NULL DEFAULT 1 CHECK (sessions_count > 0),
  -- R1-M3 — idempotency + ordering guards for concurrent sessions.
  last_extract_session_id uuid,
  session_started_at      timestamptz,
  last_session_at         timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, creator_id)
);

ALTER TABLE public.user_creator_memory ENABLE ROW LEVEL SECURITY;

-- R1-M5: BOTH the policy AND the grant are required (a grant without a
-- policy is deny-all; a policy without a grant is permission-denied).
CREATE POLICY user_creator_memory_select_own ON public.user_creator_memory
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY user_creator_memory_delete_own ON public.user_creator_memory
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE policies for authenticated — writes are service-role-only
-- via the RPC below.

-- Explicit GRANTs (Supabase removed default grants for new tables 2026-10-30
-- on hosted; the LOCAL dev image still applies legacy ALTER DEFAULT PRIVILEGES
-- which would additively hand authenticated INSERT/UPDATE). REVOKE first so
-- the grant set is DETERMINISTIC in both environments: authenticated =
-- SELECT + DELETE only; anon = nothing; service_role = full.
REVOKE ALL ON TABLE public.user_creator_memory FROM public, anon, authenticated;
GRANT ALL ON TABLE public.user_creator_memory TO service_role;
GRANT SELECT, DELETE ON TABLE public.user_creator_memory TO authenticated;

-- ────────────────────────────────────────────────────────────────────────
-- Write RPC — service-role only (secdef footer per the 2026-06-01
-- grant-leak incident rule).
-- ────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.memory_upsert_from_session(
  p_user_id            uuid,
  p_creator_id         uuid,
  p_session_id         uuid,
  p_session_started_at timestamptz,
  p_summary            text,
  p_open_loop          text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_existing public.user_creator_memory%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_creator_id IS NULL OR p_session_id IS NULL THEN
    RAISE EXCEPTION 'user_id, creator_id, session_id are required' USING ERRCODE = '22023';
  END IF;
  IF p_summary IS NULL OR length(trim(p_summary)) = 0 THEN
    RAISE EXCEPTION 'summary must be non-empty' USING ERRCODE = '22023';
  END IF;
  -- Re-validate caps server-side (the JS extraction also caps — defense
  -- in depth; the table CHECKs are the last line).
  IF octet_length(p_summary) > 1500 THEN
    RAISE EXCEPTION 'summary exceeds 1500 octets' USING ERRCODE = '22001';
  END IF;
  IF p_open_loop IS NOT NULL AND octet_length(p_open_loop) > 300 THEN
    RAISE EXCEPTION 'open_loop exceeds 300 octets' USING ERRCODE = '22001';
  END IF;

  SELECT * INTO v_existing
    FROM public.user_creator_memory
   WHERE user_id = p_user_id AND creator_id = p_creator_id
   FOR UPDATE;

  IF FOUND THEN
    -- R1-M3 idempotency: a re-fired extract for the same session is a no-op.
    IF v_existing.last_extract_session_id = p_session_id THEN
      RETURN;
    END IF;
    -- R1-M3 ordering: an OLDER concurrent session must not clobber a newer
    -- summary (compare session start times; NULL existing = legacy row, allow).
    IF v_existing.session_started_at IS NOT NULL
       AND p_session_started_at IS NOT NULL
       AND p_session_started_at < v_existing.session_started_at THEN
      RETURN;
    END IF;
    UPDATE public.user_creator_memory
       SET summary                 = p_summary,
           -- R1-S3: parsed-null CLEARS the loop (resolved). A parse-FAILED
           -- extraction never calls this RPC at all (row untouched).
           open_loop               = p_open_loop,
           sessions_count          = v_existing.sessions_count + 1,
           last_extract_session_id = p_session_id,
           session_started_at      = p_session_started_at,
           last_session_at         = now(),
           updated_at              = now()
     WHERE user_id = p_user_id AND creator_id = p_creator_id;
  ELSE
    INSERT INTO public.user_creator_memory
      (user_id, creator_id, summary, open_loop, sessions_count,
       last_extract_session_id, session_started_at)
    VALUES
      (p_user_id, p_creator_id, p_summary, p_open_loop, 1,
       p_session_id, p_session_started_at);
  END IF;
END;$$;

-- secdef footer (grant-leak incident rule): never callable by client roles.
REVOKE EXECUTE ON FUNCTION public.memory_upsert_from_session(
  uuid, uuid, uuid, timestamptz, text, text
) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.memory_upsert_from_session(
  uuid, uuid, uuid, timestamptz, text, text
) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- R2-M2 — covering index for the open-route 20h check-in gate:
-- MAX(sessions.ended_at) WHERE user_id = ? AND creator_id = ?.
-- ────────────────────────────────────────────────────────────────────────
-- Partial (diff-audit S4): the gate query filters ended_at IS NOT NULL, so
-- excluding active/abandoned NULL-ended rows keeps the index minimal.
CREATE INDEX IF NOT EXISTS sessions_user_creator_ended_idx
  ON public.sessions (user_id, creator_id, ended_at DESC)
  WHERE ended_at IS NOT NULL;

NOTIFY pgrst, 'reload schema';
