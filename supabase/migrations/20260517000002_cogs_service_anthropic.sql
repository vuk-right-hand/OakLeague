-- 20260517000002 — Day-5 audit C1+C2: add 'anthropic' to cogs_service enum.
--
-- CLAUDE.md hard rule: "Every paid API call writes to cogs_log with
-- kill-switch at 150% of user quota." Before this migration, the
-- cogs_service enum (defined in 20260420000001) only listed Gemini,
-- Cartesia, Simli, Tavus, Mux, Supabase, LiveKit, Resend, Heygen, Hume —
-- no entry for Anthropic. Day 5's reprocess worker calls Haiku 4.5 via
-- the Day-4 contextual-gen route (and Gemini Flash via narrative-chunk),
-- but the worker was discarding all returned `usage` data because there
-- was no enum value to write under.
--
-- Two enum values added in one migration:
--   * 'anthropic'   — Haiku contextual-gen
--   * (Flash narrative-chunk writes under existing 'gemini' service,
--     same as embeddings — just a different operation field.)
--
-- ALTER TYPE ... ADD VALUE is non-transactional in older Postgres but is
-- transactional in PG14+. Supabase is on PG15 — safe inside a migration.
-- The IF NOT EXISTS guard makes the migration idempotent (re-apply, snapshot
-- restore, etc.).

ALTER TYPE public.cogs_service ADD VALUE IF NOT EXISTS 'anthropic';

COMMENT ON TYPE public.cogs_service IS
  'Service enum for cogs_log. 2026-05-17: added ''anthropic'' for the Day-5 reprocess pipeline''s Haiku contextual-gen spend (audit-Day-5 C1).';
