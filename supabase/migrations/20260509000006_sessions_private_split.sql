-- 20260509000006 — sessions_private: service-role-only sibling for privileged tokens
--
-- Final post-fix audit C1: the prior migration 20260509000005 added
-- `heygen_session_token` directly to `public.sessions`, which has the
-- existing RLS policy "sessions own read" (USING user_id = auth.uid()).
-- Postgres RLS is row-level, NOT column-level — so an authenticated user
-- can call:
--     supabase.from('sessions').select('heygen_session_token')
--             .eq('id', mySessionId).single()
-- from the browser and exfiltrate the privileged HeyGen JWT. That JWT
-- authorizes /v1/sessions/keep-alive and /v1/sessions/stop and survives
-- the entire max_session_duration window.
--
-- Fix: move heygen_session_id + heygen_session_token to a sibling table
-- with RLS enabled and zero policies — matches CLAUDE.md "service-role
-- only tables = RLS enabled, zero policies." `sessions.avatar_provider`
-- stays on the public table (not sensitive — useful for analytics).
--
-- This migration:
--   1. CREATE TABLE public.sessions_private (PK = sessions.id FK CASCADE)
--   2. Backfill any rows that 20260509000005 already wrote (handles the
--      case where this migration applies AFTER some heygen sessions
--      already minted — local dev / partial deploys).
--   3. DROP the leak-prone columns from public.sessions.
--   4. ENABLE RLS, NO policies.

CREATE TABLE public.sessions_private (
  session_id           uuid          PRIMARY KEY REFERENCES public.sessions(id) ON DELETE CASCADE,
  heygen_session_id    text,
  heygen_session_token text,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sessions_private IS
  'Service-role-only sibling of public.sessions for privileged provider tokens. RLS enabled with zero policies — only the service-role bypass can read or write. Voice-proxy reads heygen_session_token here for the /v1/sessions/keep-alive heartbeat.';

-- Backfill from sessions if 20260509000005 wrote any rows (idempotent —
-- INSERT … SELECT … WHERE NOT EXISTS so re-applying is safe).
INSERT INTO public.sessions_private (session_id, heygen_session_id, heygen_session_token)
SELECT s.id, s.heygen_session_id, s.heygen_session_token
  FROM public.sessions s
 WHERE (s.heygen_session_id IS NOT NULL OR s.heygen_session_token IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM public.sessions_private p WHERE p.session_id = s.id);

-- Drop the leaky columns. avatar_provider stays — it's not sensitive
-- and the existing snapshot/heartbeat code reads it.
ALTER TABLE public.sessions
  DROP COLUMN heygen_session_id,
  DROP COLUMN heygen_session_token;

-- Drop the index that referenced the dropped column. The replacement
-- index lives on public.sessions for the (avatar_provider, started_at)
-- "live heygen sessions" query path — which still works because
-- avatar_provider stays on the public table.
-- (Index from 20260509000005 referenced avatar_provider only, so it's
-- already untouched — just ensuring no FK / index reference broke.)

ALTER TABLE public.sessions_private ENABLE ROW LEVEL SECURITY;
-- INTENTIONAL: zero policies. Only service-role bypass reads/writes.

-- Trigger: keep updated_at fresh on UPDATE.
CREATE OR REPLACE FUNCTION public.sessions_private_set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;$$;

CREATE TRIGGER sessions_private_set_updated_at_trg
  BEFORE UPDATE ON public.sessions_private
  FOR EACH ROW EXECUTE FUNCTION public.sessions_private_set_updated_at();
