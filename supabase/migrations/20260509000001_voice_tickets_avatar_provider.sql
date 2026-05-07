-- 20260509000001 — voice_tickets.avatar_provider
--
-- HeyGen wireup, migration 1 of 4. Plumbs the resolved avatar provider
-- into the voice ticket so the proxy can pick the correct Cartesia
-- output sample rate (16k Simli, 24k HeyGen) at WS-init time. Without
-- this, the proxy keys on `isAttachPath` and ships 16k PCM to every
-- /s/[id] session — HeyGen would receive 16k labeled as 24k and reject
-- or chipmunk-pitch the audio.
--
-- Audit round 2 / C1 — explicit `avatar_provider` on the ticket replaces
-- the inferred-from-path rate selection at server/voice-proxy/index.js
-- L564 (`const cartesiaSampleRate = isAttachPath ? 16000 : 24000`).
--
-- Reuses the pre-existing `public.face_vendor` enum (migration
-- 20260508000001:23) which already carries the three values we need
-- (simli | tavus | heygen). No new enum type. NOT adding a column-level
-- DEFAULT — mint-voice-ticket.ts MUST pass an explicit provider so a
-- forgotten arg fails loud against the CHECK rather than silently
-- routing to a stale default.
--
-- voice_clone purpose tickets do NOT carry an avatar_provider — they
-- only mint a Cartesia voice fingerprint and never open an avatar
-- session. Constraint enforces the purpose-discriminated invariant.

-- 1. Add column nullable.
ALTER TABLE public.voice_tickets
  ADD COLUMN avatar_provider public.face_vendor;

-- 2. Backfill historical rows. Every voice_session ticket pre-dating
--    HeyGen routed to Simli (the only wired provider). voice_clone
--    rows stay NULL — they don't open avatar sessions.
UPDATE public.voice_tickets
   SET avatar_provider = 'simli'
 WHERE purpose = 'voice_session';

-- 3. Purpose-discriminated invariant. voice_session MUST carry a
--    provider; voice_clone MUST NOT. Same shape as other discriminated
--    constraints elsewhere in the schema. NO column-level default —
--    callers explicitly supply the resolved provider.
ALTER TABLE public.voice_tickets
  ADD CONSTRAINT voice_tickets_avatar_provider_purpose_match
  CHECK (
    (purpose = 'voice_session' AND avatar_provider IS NOT NULL)
    OR
    (purpose = 'voice_clone' AND avatar_provider IS NULL)
  );

-- 4. Helper index for live-tickets-by-provider analytics. Partial on
--    consumed_at IS NULL keeps it tiny (5-ticket-per-user cap means a
--    typical row count well under 100).
CREATE INDEX voice_tickets_avatar_provider_live_idx
  ON public.voice_tickets (avatar_provider)
  WHERE consumed_at IS NULL AND purpose = 'voice_session';
