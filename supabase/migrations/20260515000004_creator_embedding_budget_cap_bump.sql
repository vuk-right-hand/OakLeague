-- 20260515000004 — bump creator_embedding_budget default cap $5 → $10/day.
--
-- M8 of RAG SOTA plan (docs/_planning/RAG_SOTA_PLAN.md §3 + §13, audit-3 C2 driver).
--
-- The original $5/creator/day cap (20260512000009) was sized for v1 RAG:
-- embedding-only spend, ~33M tokens/day = ~165K chunks of paste. Sufficient
-- for paste-storms but too tight once Phase 1 reprocess adds Anthropic
-- contextual-gen + LLM narrative chunking to the index-time cost.
--
-- Audit-3 C2 corrected pricing (1-hour-TTL cache, Haiku 4.5):
--   * Vuk's 71KB corpus reprocess: ~$0.41 one-time (was projected $0.12 — 3.4x higher)
--   * 500KB corpus worst case:     ~$3 one-time, borderline against $5 cap
--
-- $10/day leaves 3x headroom for the largest realistic single-creator corpus
-- reprocess. Worst-case attacker spend stays bounded (one creator can burn
-- at most $10/day, not $100). Re-run COMMENT on the function with the new
-- math so future readers see the audit trail.
--
-- ─── Audit-5 C1 runbook (load-bearing) ───────────────────────────────────────
-- This migration ALONE has zero runtime effect. The embed-worker reads its
-- cap from env `CREATOR_EMBEDDING_DAILY_CAP_USD` and passes it EXPLICITLY as
-- `p_cap_usd` on every RPC call. The pre-spend peek (worker line 268) also
-- compares against the env constant — not the RPC default.
--
-- The companion code change is in server/voice-proxy/embed-worker.js — the
-- env default is bumped from '5' to '10' in the same PR as this migration.
-- Before deploy, ALSO verify (or unset) any `CREATOR_EMBEDDING_DAILY_CAP_USD`
-- Fly secret that may pin the value to '5'. If Fly secret is unset, the new
-- code default '10' takes effect.
--
-- pgTAP test creator_embedding_budget_cap_bump.test.sql case 1 verifies the
-- RPC default. The pre-spend peek's behavior under the new cap is not
-- SQL-testable from pgTAP (lives in worker JS); covered by the integration
-- test in Day 6 (Vuk's staging reprocess).

CREATE OR REPLACE FUNCTION public.creator_embedding_budget_accumulate_and_check(
  p_creator_id uuid,
  p_add_usd    numeric,
  p_cap_usd    numeric DEFAULT 10
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_total numeric;
BEGIN
  IF p_add_usd < 0 THEN
    RAISE EXCEPTION USING errcode='22023', message='negative_amount';
  END IF;
  INSERT INTO public.creator_embedding_budget (creator_id, budget_date, accumulated_usd)
  VALUES (p_creator_id, current_date, p_add_usd)
  ON CONFLICT (creator_id, budget_date) DO UPDATE
    SET accumulated_usd = public.creator_embedding_budget.accumulated_usd + EXCLUDED.accumulated_usd
  RETURNING accumulated_usd INTO v_total;
  RETURN v_total <= p_cap_usd;
END;$$;

COMMENT ON FUNCTION public.creator_embedding_budget_accumulate_and_check(uuid, numeric, numeric) IS
  'Atomic post-spend accumulate + cap check. Default cap $10/day (audit-3 C2: bumped from $5 to cover Phase 1 reprocess cost — Anthropic contextual-gen at 1h-TTL cache + LLM chunking + embedding lands ~$0.41 per 71KB corpus, ~$3 per 500KB worst case). Cap is INCLUSIVE: returns true when post-accumulate total is exactly at cap. 3x headroom against largest realistic single-creator corpus. ON CONFLICT row-lock serializes concurrent workers; worst-case one over-cap job (the one mid-flight at cap-crossing). Audit-5 C1 note: callers (server/voice-proxy/embed-worker.js) pass p_cap_usd EXPLICITLY from env CREATOR_EMBEDDING_DAILY_CAP_USD; the function default only takes effect when caller omits the arg.';

-- Grants preserved by CREATE OR REPLACE; no need to re-emit.
