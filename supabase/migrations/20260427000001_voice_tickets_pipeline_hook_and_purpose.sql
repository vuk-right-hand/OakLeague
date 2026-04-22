-- 0045 — voice_tickets: pipeline_kind + expected_tier + hook_id + purpose
--
-- Days 8–12 plan REV 5, migration 1 of 11.
-- Promotes `voice_tickets` from the admin spike harness to the user-facing
-- session ticket. Two pipelines (native_audio vs Pro stack) are picked at
-- mint time and locked; the proxy re-verifies `expected_tier` against
-- `sessions.tier_at_session` post-insert (D7 TOCTOU defense).
--
-- D8 sequencing: ADD columns nullable → backfill consumed rows → DELETE
-- unconsumed rows (silent downgrade guard) → SET NOT NULL → defaults last.
-- Same transaction; unconsumed in-flight tickets die with the deploy so
-- nobody gets silently routed through the wrong pipeline.
--
-- N2-M3: voice-clone uploads reuse this table under a new `purpose` enum;
-- default preserves existing rows as 'voice_session'. Clone ticket TTL is
-- set by the mint route (not here), giving it a tighter 60s window.

-- 1. Enum types ----------------------------------------------------------------

CREATE TYPE voice_pipeline_kind AS ENUM (
  'native_audio',           -- Gemini 3.1 Flash Live, PCM in/out (free tier)
  'pro_gemini25_cartesia'   -- 2.5 STT → 2.5-flash text → Cartesia TTS (premium/boardroom)
);

CREATE TYPE voice_ticket_purpose AS ENUM (
  'voice_session',
  'voice_clone'
);

-- 2. Columns (nullable first) --------------------------------------------------

ALTER TABLE public.voice_tickets
  ADD COLUMN pipeline_kind voice_pipeline_kind,
  ADD COLUMN expected_tier profile_tier,
  ADD COLUMN hook_id       uuid REFERENCES public.hooks(id) ON DELETE SET NULL,
  ADD COLUMN purpose       voice_ticket_purpose NOT NULL DEFAULT 'voice_session';

-- 3a. Purge pre-0041 orphan rows that have creator_id = NULL.
--
-- Migration 0041 added voice_tickets.creator_id with a NOT VALID CHECK
-- constraint (voice_tickets_creator_id_not_null). NOT VALID means "don't scan
-- existing rows at ADD time" — but the constraint IS enforced on every
-- subsequent UPDATE. Any Spike-A ticket row that pre-dates 0041 therefore
-- fails step 3b's UPDATE with SQLSTATE 23514. Those rows are always
-- consumed_at IS NOT NULL historical trash (Spike-A harness rows have 30s
-- TTL and auto-reap). Delete them so the backfill UPDATE has only compliant
-- rows to touch. Re-applying this migration later is a no-op (nothing left
-- to delete).

DELETE FROM public.voice_tickets
 WHERE creator_id IS NULL;

-- 3b. Backfill already-consumed rows with plausible historical values so the
--    NOT NULL step doesn't fail on audit history.

UPDATE public.voice_tickets
   SET pipeline_kind = 'native_audio',
       expected_tier = 'free'
 WHERE consumed_at IS NOT NULL
   AND (pipeline_kind IS NULL OR expected_tier IS NULL);

-- 4. Kill unconsumed rows (D8, auditor C3). Every in-flight ticket from the
--    pre-migration deploy is invalidated atomically; proxy bounces them with
--    4001 and the client re-mints against the new pipeline_kind contract.

DELETE FROM public.voice_tickets
 WHERE consumed_at IS NULL;

-- 5. Lock in NOT NULL + final defaults ----------------------------------------

ALTER TABLE public.voice_tickets
  ALTER COLUMN pipeline_kind SET NOT NULL,
  ALTER COLUMN expected_tier SET NOT NULL,
  ALTER COLUMN pipeline_kind SET DEFAULT 'native_audio',
  ALTER COLUMN expected_tier SET DEFAULT 'free';

-- 6. Indexes -------------------------------------------------------------------

-- Admin clone-rate lookup: "how many voice_clone tickets has this user minted
-- today?" (N2-M3, 3/day/admin rate limit). Partial on purpose to keep it tiny.
CREATE INDEX voice_tickets_clone_mint_idx
  ON public.voice_tickets (user_id, created_at DESC)
  WHERE purpose = 'voice_clone';

-- Pipeline-kind lookup for ticket-state analytics + resume-conflict queries.
CREATE INDEX voice_tickets_pipeline_live_idx
  ON public.voice_tickets (user_id, pipeline_kind)
  WHERE consumed_at IS NULL;
