-- 0032 — waitlist IP + generic rate-limit RPC (R2-v1-miss, R5-M6).
-- Abuse signal for manual review; not used for automated blocking beyond the
-- rate-limit RPC below. rate_limit_hit() computes the window_start inside the
-- DB — serverless instances have different wall-clocks and would otherwise
-- fragment the bucket across cold-start replicas (R5-M6).

ALTER TABLE public.waitlist
  ADD COLUMN created_ip inet;

CREATE TABLE public.rate_limit_log (
  scope         text        NOT NULL,
  key           text        NOT NULL,
  window_start  timestamptz NOT NULL,
  count         int         NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key, window_start)
);

ALTER TABLE public.rate_limit_log ENABLE ROW LEVEL SECURITY;
-- Service-role only. Zero policies.

REVOKE ALL ON public.rate_limit_log FROM PUBLIC, authenticated, anon;

-- rate_limit_hit: returns TRUE if this hit is within the limit (caller may
-- proceed), FALSE if the bucket is exhausted.
CREATE FUNCTION public.rate_limit_hit(
  p_scope  text,
  p_key    text,
  p_window interval,
  p_limit  int
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_window_start timestamptz;
  v_count        int;
BEGIN
  -- Align to bucket boundary. Use date_trunc for hour/day/minute windows;
  -- fall back to floor-division of epoch seconds for arbitrary intervals.
  v_window_start := to_timestamp(
    (extract(epoch FROM now())::bigint
      / GREATEST(extract(epoch FROM p_window)::bigint, 1))
    * GREATEST(extract(epoch FROM p_window)::bigint, 1)
  );

  INSERT INTO public.rate_limit_log (scope, key, window_start, count)
  VALUES (p_scope, p_key, v_window_start, 1)
  ON CONFLICT (scope, key, window_start)
  DO UPDATE SET count = public.rate_limit_log.count + 1
  RETURNING count INTO v_count;

  RETURN v_count <= p_limit;
END;$$;

REVOKE EXECUTE ON FUNCTION public.rate_limit_hit(text, text, interval, int) FROM public;
GRANT  EXECUTE ON FUNCTION public.rate_limit_hit(text, text, interval, int) TO authenticated, anon;
