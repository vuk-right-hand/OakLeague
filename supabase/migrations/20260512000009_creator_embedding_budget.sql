-- 20260512000009 — creator_embedding_budget.
--
-- M9 of pgvector RAG plan (R2 C3 + R3 M4 fixes).
--
-- Per-creator-per-day embedding spend cap. Two RPCs:
--
--   * creator_embedding_budget_peek(creator_id) — cheap SELECT, no lock.
--     Worker calls this BEFORE paying for an embedding batch. Skip the
--     job (mark errored) if (current + estimated) would blow the cap.
--   * creator_embedding_budget_accumulate_and_check(creator_id, add_usd,
--     cap_usd) — atomic UPSERT-and-check. Worker calls this AFTER a
--     successful embed batch.
--
-- Worst case under contention: ONE over-cap job (the one mid-flight at
-- the instant cap is crossed), not N parallel over-cap jobs. The previous
-- post-spend-only design (R2 C3) allowed N parallel paste-storm batches
-- to all clear the check before any one wrote.
--
-- Cap default $5/creator/day = ~33M tokens at $0.15/1M = ~165K chunks
-- of paste. Generous but bounds the failure surface (e.g., a creator
-- accidentally pasting their entire Discord chat history).

CREATE TABLE public.creator_embedding_budget (
  creator_id      uuid          NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  budget_date     date          NOT NULL,
  accumulated_usd numeric(10,6) NOT NULL DEFAULT 0 CHECK (accumulated_usd >= 0),
  PRIMARY KEY (creator_id, budget_date)
);

ALTER TABLE public.creator_embedding_budget ENABLE ROW LEVEL SECURITY;
-- Service-role only, zero policies.

-- ── Pre-spend peek (R3 M4) ────────────────────────────────────────────────
-- Stable SELECT; no lock; cheap. Race with post-spend writers is acceptable
-- because the post-spend accumulate is the truth. Used by the worker to skip
-- jobs whose creator's daily cap is visibly already blown.
CREATE FUNCTION public.creator_embedding_budget_peek(
  p_creator_id uuid
) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT accumulated_usd
       FROM public.creator_embedding_budget
      WHERE creator_id = p_creator_id AND budget_date = current_date),
    0
  );
$$;

-- ── Post-spend atomic accumulate (R2 C3) ──────────────────────────────────
-- ON CONFLICT DO UPDATE ... RETURNING acquires a row-level lock; concurrent
-- workers serialize through it. Returns whether the post-accumulate total
-- is still within cap so the caller can alert / Sentry-flag if it overshot.
CREATE FUNCTION public.creator_embedding_budget_accumulate_and_check(
  p_creator_id uuid,
  p_add_usd    numeric,
  p_cap_usd    numeric DEFAULT 5
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

REVOKE ALL ON FUNCTION public.creator_embedding_budget_peek(uuid)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.creator_embedding_budget_peek(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.creator_embedding_budget_accumulate_and_check(uuid, numeric, numeric)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.creator_embedding_budget_accumulate_and_check(uuid, numeric, numeric)
  TO service_role;
