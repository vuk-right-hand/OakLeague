-- 0048 — voice_tickets.resume_from_session_id
--
-- Days 8–12 plan REV 5, migration 4 of 11.
-- Ticket-bound resume target (auditor N-C1, REV 5 N3-C1). Set server-side
-- at mint time; proxy ignores any sessionId on the WS URL query string.
-- Kills cross-session-ride attacks entirely.
--
-- Resume-mint route (RSC) is the only writer; it runs four checks in
-- order (N3-C1 locked contract) before setting this column:
--   1. ownership (sessions.user_id = caller) → 403 on miss
--   2. live-conflict (ended_at IS NULL AND status IN ('starting','active')) → 409
--   3. expired (ended_at < now() - interval '2 hours') → 200 {expired:true}
--   4. ok → insert ticket with resume_from_session_id set
--
-- Note the expired-predicate direction (N3-C1): the REV 4 draft had it
-- backwards; correct shape is `ended_at < now() - interval '2 hours'`.
-- Copy verbatim into the RSC route.

ALTER TABLE public.voice_tickets
  ADD COLUMN resume_from_session_id uuid
    REFERENCES public.sessions(id) ON DELETE SET NULL;

-- Partial index: "find the live resume ticket for this prior session" is the
-- hot query on reconnect. Trivial in size since most tickets don't resume.
CREATE INDEX voice_tickets_resume_from_idx
  ON public.voice_tickets (resume_from_session_id)
  WHERE resume_from_session_id IS NOT NULL;
