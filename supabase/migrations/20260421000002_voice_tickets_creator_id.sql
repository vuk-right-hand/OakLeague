-- 0041 — voice_tickets.creator_id
--
-- Post-Spike-A audit fix: the proxy was picking the first creator by created_at
-- (pickSpikeCreatorId), which is the exact "hardcoded founder" anti-pattern
-- CLAUDE.md forbids. The ticket now carries the creator_id chosen at mint time
-- by the authenticated user, and the proxy reads it on consume instead of
-- guessing. One-active-session-per-user index stays untouched.
--
-- Nullable on existing rows (there are no existing rows in production; spike
-- harness rows are ephemeral) but NOT NULL for new inserts via CHECK — the
-- column is enforced NOT NULL once old rows expire (30s TTL).

ALTER TABLE public.voice_tickets
  ADD COLUMN creator_id uuid REFERENCES public.creators(id) ON DELETE CASCADE;

-- Immediately tighten: any new ticket must carry a creator_id. Existing rows
-- (pre-migration, all will be expired within 30s) remain NULL and get reaped
-- by the probabilistic GC in /api/voice/spike-a/ticket + by consumer filter.
ALTER TABLE public.voice_tickets
  ADD CONSTRAINT voice_tickets_creator_id_not_null
  CHECK (creator_id IS NOT NULL) NOT VALID;

-- Helper index for the mint-route rate-limit count (user_id + unconsumed + unexpired).
CREATE INDEX voice_tickets_user_live_idx
  ON public.voice_tickets (user_id)
  WHERE consumed_at IS NULL;
