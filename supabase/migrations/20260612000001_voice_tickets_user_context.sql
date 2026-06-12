-- 20260612000001 — MEMORY_BREADTH_PLAN Unit 1a: voice_tickets.user_context.
--
-- A sanitized, session-open-built string (profiles.goals/obstacles + the
-- user_creator_memory summary + optional [OPEN THREAD] line) that rides the
-- ticket to the Fly proxy and is folded into the decoupled deep-answer's
-- QUESTION user turn as a DATA block (audit R1-C4: user-derived text never
-- enters a systemInstruction).
--
-- Caps (R1-S2): the open ROUTE owns the build and truncates within the cap
-- (it composes the string); mint passes it through opaquely; this DB CHECK
-- is defense-in-depth. 2400 octets = goals/obstacles (~800) + memory summary
-- (1500) + open-loop framing line.
--
-- PII: rides the existing voice_tickets >7d purge (voice_tickets_purge_
-- consumed) — same retention as system_prompt. Privacy-surface inventory
-- (R2-S3): this column AND public.user_creator_memory are both user-derived
-- PII surfaces.
--
-- No new GRANTs needed: column on an existing table; voice_tickets is
-- service-role-only (RLS enabled, zero policies) and the proxy reads via
-- service role.

ALTER TABLE public.voice_tickets
  ADD COLUMN IF NOT EXISTS user_context text;

ALTER TABLE public.voice_tickets
  DROP CONSTRAINT IF EXISTS voice_tickets_user_context_len_chk;
ALTER TABLE public.voice_tickets
  ADD CONSTRAINT voice_tickets_user_context_len_chk
  CHECK (user_context IS NULL OR octet_length(user_context) <= 2400);
