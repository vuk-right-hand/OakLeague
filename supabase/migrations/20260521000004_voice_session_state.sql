-- ─────────────────────────────────────────────────────────────────────────
-- RAG SOTA Phase 2 — Day 8 MIG-4
-- voice_session_state — per-session conversation memory
-- ─────────────────────────────────────────────────────────────────────────
--
-- Audit-3 M2 fix. The brain bridge buffers `_currentTurnOutputTranscript`
-- in a closure and uses it for the next user turn's query-rewrite step
-- (so "tell me more about that" embeds against the actual prior topic
-- instead of the literal four words). The closure is per-WS-connection.
--
-- Gemini Live's 15-minute audio session cap forces a reopen on long
-- mentorship sessions. The reopen creates a NEW WS → NEW closure → the
-- closure-buffered lastAssistantResponse is lost. Without persistence,
-- every follow-up question after a resumption point dies — which
-- audit-3 identified as load-bearing for the "tell me more" / "HOLY
-- FUCK" value prop.
--
-- This table is the persistence layer:
--   - On turn_complete: proxy fire-and-forget UPSERTs the closure state.
--   - On reopen: proxy SELECTs once and re-seeds the closure.
--   - Closure-first read in the hot path → zero DB roundtrip per turn
--     when no reopen has happened.
--
-- LOAD-BEARING CONTRACT (Day-8-final audit C4):
-- Gemini Live's 15-min cap forces a reopen on long sessions. The proxy
-- worker MUST reuse the SAME `sessions.id` across reopen — only the WS
-- connection cycles, not the sessions row. (The `sessions.gemini_resumption_handle`
-- column exists for this; reopen is a new WS using the stored handle on
-- the existing sessions row.) Without this contract, a new sessions row
-- on reopen leaves the prior session_id's state orphaned and lookup
-- under the new session_id returns NULL → "tell me more" follow-up dies.
-- Day-9 worker code: every code path that ends or rotates a session MUST
-- write voice_session_state before the sessions.id changes, or this
-- table's whole purpose breaks. Day-12 integration test SHOULD assert
-- the same sessions.id is used pre- and post-reopen.
--
-- Per audit Day-8 review:
--   M3 — PII retention. last_assistant_response can carry sensitive
--        conversation content. Daily pg_cron purges rows where
--        updated_at < now() - interval '7 days' (covers the unbounded
--        "session row stays forever for analytics" scenario without
--        leaking memory state).
--   Small — bumped last_user_query cap 1000 → 2000 chars to match the
--           assistant side (voice transcripts can run long).
--   Small — explicit REVOKE ALL alongside RLS-no-policies for
--           defense-in-depth.

CREATE TABLE public.voice_session_state (
  session_id              uuid        PRIMARY KEY
                                       REFERENCES public.sessions(id) ON DELETE CASCADE,
  last_assistant_response text        CHECK (
                                        last_assistant_response IS NULL
                                        OR char_length(last_assistant_response) <= 2000
                                      ),
  last_user_query         text        CHECK (
                                        last_user_query IS NULL
                                        OR char_length(last_user_query) <= 2000
                                      ),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.voice_session_state IS
  'Per-session conversation memory for the brain bridge. last_assistant_response + last_user_query are written on turn_complete and read on session reopen to survive the 15-min Gemini Live audio session cap. Service-role only. 7-day inactivity purge.';

COMMENT ON COLUMN public.voice_session_state.last_assistant_response IS
  'Bounded snapshot of the most recent assistant turn transcript, used by query-rewrite to ground follow-up questions ("tell me more about that").';

COMMENT ON COLUMN public.voice_session_state.last_user_query IS
  'Bounded snapshot of the most recent user turn transcript. Reserved for future telemetry / debug; not currently read by retrieval.';

-- RLS deny-all (service-role only).
ALTER TABLE public.voice_session_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.voice_session_state FROM public, anon, authenticated;
GRANT ALL ON TABLE public.voice_session_state TO service_role;

-- ── 7-day inactivity purge ──────────────────────────────────────────────
CREATE FUNCTION public.voice_session_state_purge_stale() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_deleted int;
BEGIN
  -- Rows inactive for 7+ days: conversation memory has rotted past
  -- usefulness, and PII retention is bounded.
  DELETE FROM public.voice_session_state
   WHERE updated_at < now() - interval '7 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.voice_session_state_purge_stale() IS
  'Purges voice_session_state rows inactive for 7+ days. Called daily by pg_cron; harmless to run ad-hoc. PII retention guard.';

REVOKE ALL ON FUNCTION public.voice_session_state_purge_stale()
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_session_state_purge_stale()
  TO service_role;

-- Idempotent schedule (Day-8-final audit C3).
DO $$
BEGIN
  PERFORM cron.unschedule('voice_session_state_purge_stale');
EXCEPTION
  WHEN undefined_function THEN NULL;
  WHEN OTHERS THEN NULL;
END
$$;

DO $$
BEGIN
  PERFORM cron.schedule(
    'voice_session_state_purge_stale',
    '17 4 * * *',  -- 04:17 UTC daily — offset from cache purge
    $sched$SELECT public.voice_session_state_purge_stale();$sched$
  );
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'pg_cron not installed; skipping voice_session_state_purge_stale schedule.';
END
$$;

-- updated_at maintenance trigger so the purge is accurate.
CREATE FUNCTION public.voice_session_state_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER voice_session_state_set_updated_at
  BEFORE UPDATE ON public.voice_session_state
  FOR EACH ROW EXECUTE FUNCTION public.voice_session_state_touch_updated_at();
