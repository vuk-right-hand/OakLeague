-- 20260522000101 — Day-13 audit-2 C1: add 'voyage' to cogs_service enum.
--
-- CLAUDE.md hard rule: "Every paid API call writes to cogs_log with
-- kill-switch at 150% of user quota." The Day-11 RAG v2 orchestrator's
-- rerank leg (`src/lib/voice/rag-telemetry.ts` toCogsLogRows) emits rows
-- with `service: 'voyage'` for the Voyage rerank-2.5 spend. But the
-- cogs_service enum (defined in 20260420000001, later extended with
-- 'heygen' 20260509000002, 'anthropic' 20260517000002, 'hume'
-- 20260520000001) was NEVER given a 'voyage' value.
--
-- Consequence (verified, audit-2 C1): every rerank cogs_log INSERT fails
-- `invalid input value for enum cogs_service: "voyage"`. Because the
-- writer batched all legs into one INSERT, the enum-invalid voyage row
-- took the valid gemini/rewrite + gemini/embedding rows down with it
-- (a single multi-VALUES INSERT is atomic), and the failure was swallowed
-- as console.warn — so ALL Day-11 RAG v2 retrieval COGS were silently
-- dropped whenever the v2 orchestrator ran. Latent in prod today (v2 is
-- gated off) but live the moment any creator is on retrieval_version=2.
--
-- Companion code change (20260522000101 ships with it): flushCogsLogRows
-- now inserts per-row on batch failure so one bad row can never again
-- drop valid rows, and escalates the failure to Sentry (not console.warn)
-- so a swallowed cogs failure can never again stay invisible.
--
-- ALTER TYPE ... ADD VALUE is transactional in PG14+. Supabase is on
-- PG15 — safe inside a migration (this migration only ADDS the value, it
-- does not USE it in the same transaction). IF NOT EXISTS makes it
-- idempotent (re-apply / snapshot restore safe).
--
-- FORBIDDEN INTERLEAVING (same warning as 20260509000002 / 20260520000001):
-- a NEW enum value cannot be referenced as a literal in the SAME
-- transaction that adds it. Any later migration that references 'voyage'
-- in a CHECK, RPC body, default, or data backfill MUST be its own
-- separate migration file ordered strictly AFTER this one — never squash
-- or reorder it ahead of this commit, or the reference fails with
-- "unsafe use of new value of enum type". This file is highest-numbered
-- today so nothing references it yet; this warning protects 000102+.

ALTER TYPE public.cogs_service ADD VALUE IF NOT EXISTS 'voyage';

-- NOTE: COMMENT ON TYPE replaces (not appends) the whole type comment;
-- prior additions (heygen 20260509000002, anthropic 20260517000002,
-- hume 20260520000001) are part of the enum's migration history, not
-- lost — see those files. This comment reflects the latest addition.
COMMENT ON TYPE public.cogs_service IS
  'Service enum for cogs_log. Extended over time: heygen (20260509000002), anthropic (20260517000002), hume (20260520000001), voyage (20260522000101 — Day-11 RAG v2 Voyage rerank-2.5 spend; audit-2 C1, previously silently dropped).';
