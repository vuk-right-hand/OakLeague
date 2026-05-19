-- 20260522000102 — decoupled-brain fail-safe flag.
--
-- P1-2 of DECOUPLED_BRAIN_PLAN (§13). Adds an ORTHOGONAL per-creator
-- boolean that selects the decoupled brain path (paraphrase → off-Live
-- RAG `generateContent` → Hume) instead of the vector mid-session
-- `sendRealtimeInput` injection mechanism (the proven Bug-1 cause).
--
-- WHY A BOOLEAN, NOT A THIRD brain_mode ENUM VALUE (plan P0-3 / D7):
--   * D7 fail-safe REQUIRES absent/unparseable → legacy. A boolean
--     NOT NULL DEFAULT false is the most obviously fail-safe shape:
--     every existing + new creator/ticket is `false` = unchanged path.
--   * A 3rd enum value would force every `brain_mode='vector'` guard in
--     index.js to become `IN ('vector','decoupled')` (6+ scattered
--     sites — plan §13) AND hit the ALTER TYPE ADD VALUE transactional
--     forbidden-interleaving caveat (cf. 20260509000002 / 20260522000101).
--     Orthogonal boolean keeps every legacy guard byte-identical: the
--     decoupled change is an ADDED conjunct that is false in legacy.
--
-- Mirrors the brain_mode lineage exactly:
--   creators column  ← 20260512000002 (brain_mode enum + creators col)
--   voice_tickets col ← 20260512000006 (brain_mode + invariant CHECK)
-- Snapshot-at-session-open contract (CLAUDE.md "tier routing at
-- session-open only"): mint-voice-ticket.ts writes the ticket column
-- from the creators column; the proxy reads ONLY the ticket snapshot,
-- never the live creators column mid-session (R3-M4 trust chain).
--
-- ADMIN FLIP RPC IS DELIBERATELY NOT IN THIS MIGRATION. The brain_mode
-- setter (20260512000007 admin_set_creator_brain_mode) recompiles the
-- persona IN THE SAME TRANSACTION because per-mode personas differ. The
-- decoupled deep-answer persona (L1 instruction-hierarchy clause, P0-5)
-- is a DIFFERENT shape too — so the decoupled admin setter MUST likewise
-- pair the flip with a recompile. That recompile depends on the
-- not-yet-built decoupled persona compiler (plan D12). Shipping a setter
-- now without the paired recompile would let a flipped creator open the
-- next session with a stale wrong-path persona. The admin
-- `admin_set_creator_decoupled` RPC therefore lands in a LATER P1
-- migration, coupled with the decoupled persona compiler. Until then the
-- staging-creator flip is done by a direct admin UPDATE under explicit
-- sign-off (one creator, plan §8).

ALTER TABLE public.creators
  ADD COLUMN decoupled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.creators.decoupled IS
  'Decoupled-brain path selector (DECOUPLED_BRAIN_PLAN). false = legacy (drawer or vector mid-session injection). true = paraphrase → off-Live RAG generateContent → Hume; REQUIRES brain_mode=''vector'' (decoupled is vector-class retrieval generated off the Live session). Fail-safe default false (D7). Flip is admin-only and MUST be paired with a decoupled-persona recompile (later P1 RPC); until that RPC ships, flip via direct admin UPDATE with explicit sign-off (one staging creator).';

ALTER TABLE public.voice_tickets
  ADD COLUMN decoupled boolean NOT NULL DEFAULT false;

-- Invariant CHECK — defense-in-depth, same rationale as
-- voice_tickets_brain_mode_prefix_chk (20260512000006): the route's
-- pre-DB guard is the first line; this CHECK fires if mint logic drifts
-- and snapshots a nonsensical drawer+decoupled ticket (decoupled has no
-- retrieval to generate from without vector-class retrieval).
ALTER TABLE public.voice_tickets
  ADD CONSTRAINT voice_tickets_decoupled_requires_vector_chk
    CHECK (
      decoupled = false
      OR (decoupled = true AND brain_mode = 'vector')
    );

COMMENT ON COLUMN public.voice_tickets.decoupled IS
  'Snapshot of creators.decoupled at session-open. Locked for the session''s duration, parallel to brain_mode / tier_at_session. true ⇒ brain_mode=''vector'' (enforced by voice_tickets_decoupled_requires_vector_chk). Proxy reads ONLY this snapshot, never the live creators column (R3-M4 trust chain).';
