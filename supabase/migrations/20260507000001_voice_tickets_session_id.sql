-- SIMLI_WIREUP §2 / R2-C2 / R3-M5 / R4-C2 — voice_tickets.session_id
--
-- Today the Fly proxy (server/voice-proxy/index.js openSession) INSERTs a
-- new sessions row at WS open. /api/sessions/open ALSO inserts via the
-- session_open RPC. Cutover that has /s/[id] talk to the proxy would
-- collide on sessions_one_active_per_user (23505).
--
-- Fix: ticket carries session_id; proxy attaches to the pre-opened row
-- instead of inserting. Backward-compatible — column is nullable, so the
-- admin spike-a path (which still mints openSession-style tickets) keeps
-- working with session_id IS NULL.
--
-- Idempotent / replay-safe (R4-C2): every step guarded.
-- voice_tickets are 60s-TTL single-use, so blanket-DELETE is cheaper than
-- backfill (at most one re-tap per affected user, no historical loss).

-- 1. Column (nullable; admin spike-a stays NULL, /s/[id] cutover sets it)
ALTER TABLE public.voice_tickets
  ADD COLUMN IF NOT EXISTS session_id uuid;

-- 2. Nuke any in-flight tickets so the new column is well-defined for
--    every row consumed post-deploy. Safe: TTL is 30-60s, single-use.
DELETE FROM public.voice_tickets WHERE consumed_at IS NULL;

-- 3. FK to sessions (idempotent via pg_constraint lookup)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'voice_tickets_session_id_fkey'
  ) THEN
    ALTER TABLE public.voice_tickets
      ADD CONSTRAINT voice_tickets_session_id_fkey
      FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 4. CHECK belongs-to-user: when session_id is set, sessions.user_id MUST
--    match voice_tickets.user_id. Implemented as a trigger because CHECK
--    can't subquery in PG.
CREATE OR REPLACE FUNCTION public.voice_tickets_session_user_match() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_session_user uuid;
BEGIN
  IF NEW.session_id IS NULL THEN RETURN NEW; END IF;
  SELECT user_id INTO v_session_user FROM public.sessions WHERE id = NEW.session_id;
  IF v_session_user IS NULL THEN
    RAISE EXCEPTION 'voice_tickets.session_id % not found', NEW.session_id
      USING ERRCODE = '23503';
  END IF;
  IF v_session_user <> NEW.user_id THEN
    RAISE EXCEPTION 'voice_tickets.session_id user mismatch (ticket=% session=%)',
      NEW.user_id, v_session_user
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_tickets_session_user_match() FROM public;

DROP TRIGGER IF EXISTS voice_tickets_session_user_match_trg ON public.voice_tickets;
CREATE TRIGGER voice_tickets_session_user_match_trg
  BEFORE INSERT OR UPDATE OF session_id, user_id ON public.voice_tickets
  FOR EACH ROW EXECUTE FUNCTION public.voice_tickets_session_user_match();

-- 5. Lookup index for proxy attach-on-consume (covers the consume SELECT).
CREATE INDEX IF NOT EXISTS voice_tickets_session_idx
  ON public.voice_tickets (session_id)
  WHERE session_id IS NOT NULL AND consumed_at IS NULL;

COMMENT ON COLUMN public.voice_tickets.session_id IS
  'When set, proxy attaches to this pre-opened sessions row (cutover path). '
  'When NULL, proxy creates its own sessions row (legacy admin spike-a path).';
