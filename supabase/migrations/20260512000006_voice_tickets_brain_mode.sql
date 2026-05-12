-- 20260512000006 — voice_tickets.brain_mode + invariant CHECK.
--
-- M6 of pgvector RAG plan (R1 M2 fix). Snapshots creators.brain_mode at
-- session-open so the proxy reads which retrieval path to use during the
-- session's WS lifetime. Parallel to the existing tier_at_session snapshot
-- pattern (CLAUDE.md "tier routing at session-open only").
--
-- Invariant CHECK prevents the confused-deputy bug where a drawer-mode
-- ticket gets vectorized chunks injected, or a vector-mode ticket carries
-- a stale prefix_turns array. Defense-in-depth — the route's pre-DB guard
-- (sessions/open/route.ts: gates buildBrainPrefix on brain_mode='drawer')
-- is the first line; this CHECK fires if route logic drifts.

ALTER TABLE public.voice_tickets
  ADD COLUMN brain_mode public.brain_mode NOT NULL DEFAULT 'drawer';

ALTER TABLE public.voice_tickets
  ADD CONSTRAINT voice_tickets_brain_mode_prefix_chk
    CHECK (
      (brain_mode = 'vector' AND prefix_turns IS NULL)
      OR brain_mode = 'drawer'
    );

COMMENT ON COLUMN public.voice_tickets.brain_mode IS
  'Snapshot of creators.brain_mode at session-open. Locked for the session''s duration, parallel to tier_at_session. Vector mode tickets carry no prefix_turns (enforced by voice_tickets_brain_mode_prefix_chk).';
