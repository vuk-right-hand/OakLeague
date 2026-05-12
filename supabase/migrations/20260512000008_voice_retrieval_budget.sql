-- 20260512000008 — voice_retrieval_budget.
--
-- M8 of pgvector RAG plan (R1 C5 fix). Per-user-per-day retrieval call cap.
--
-- Why this exists separately from voice_check_quota (audio seconds):
--   * voice_check_quota currency is seconds-of-audio. Embeddings cost no audio
--     time but DO cost embedding API budget. Without an independent cap, a
--     user opening N back-to-back sessions and firing M turns each would
--     bypass the per-session retrieval cap entirely.
--
-- Sizing: 200 calls/day = ~20 sessions × ~10 turns = aggressive normal use.
-- Caps embedding spend per attacker at 200 × $0.000002 = $0.0004/day. Storage
-- = one int row per user per day.
--
-- Atomicity: INSERT ... ON CONFLICT DO UPDATE ... RETURNING acquires a
-- row-level lock on the conflicting row under READ COMMITTED. Concurrent
-- callers serialize through the lock; no overflow possible.
--
-- R3 S1 note: this RPC increments unconditionally and returns
-- (post_count <= cap). A buggy caller in a retry loop will grow call_count
-- unbounded inside the same day-bucket (storage = 1 int/row/day, fine).
-- retrieve-knowledge lib enforces "stop on first false"; Sentry alerts if
-- one user produces >250 false returns/day (caller drift signal).

CREATE TABLE public.voice_retrieval_budget (
  user_id     uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  budget_date date        NOT NULL,
  call_count  int         NOT NULL DEFAULT 0 CHECK (call_count >= 0),
  PRIMARY KEY (user_id, budget_date)
);

ALTER TABLE public.voice_retrieval_budget ENABLE ROW LEVEL SECURITY;
-- Service-role only, zero policies.

CREATE FUNCTION public.voice_retrieval_budget_check_and_increment(
  p_user_id uuid,
  p_limit   int DEFAULT 200
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_count int;
BEGIN
  INSERT INTO public.voice_retrieval_budget (user_id, budget_date, call_count)
  VALUES (p_user_id, current_date, 1)
  ON CONFLICT (user_id, budget_date) DO UPDATE
    SET call_count = public.voice_retrieval_budget.call_count + 1
  RETURNING call_count INTO v_count;
  RETURN v_count <= p_limit;
END;$$;

REVOKE ALL ON FUNCTION public.voice_retrieval_budget_check_and_increment(uuid, int)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_retrieval_budget_check_and_increment(uuid, int)
  TO service_role;
