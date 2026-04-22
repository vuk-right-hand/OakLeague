-- 0050 — voice_ip_counters + rate-limit RPC
--
-- Days 8–12 plan REV 5, migration 6 of 11.
-- Postgres-global sliding-window IP rate limit for the Fly proxy upgrade
-- path. REV 3 N-C3: a Fly single-machine in-memory map can't cover a
-- multi-worker deploy, and we already plan to increase machine count for
-- demo headroom. N2-M2: write-hot hot-row; wrap UPSERT in advisory lock to
-- serialize per-IP without deadlock risk (one lock per call, transaction-
-- scoped).
--
-- Fly rate-limit policy (REV 5 final):
--   - Hot path (this RPC): 120/min/IP sliding-window → accommodates corporate
--     NAT + YC demo room. Primary defense is per-user ticket rate (2/min/user
--     at the RSC mint route).
--   - pg_cron purges windows older than 2 minutes every 1 minute (N2-M2).
--
-- IP identity is hashed upstream (SHA-256 of `X-Forwarded-For[0]` + the
-- Fly internal addr when XFF is missing). We store only the hash so leakage
-- of this table doesn't expose IPs.

CREATE TABLE public.voice_ip_counters (
  ip_hash       text        PRIMARY KEY CHECK (char_length(ip_hash) = 64),
  window_start  timestamptz NOT NULL,
  count         int         NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX voice_ip_counters_window_idx
  ON public.voice_ip_counters (window_start);

ALTER TABLE public.voice_ip_counters ENABLE ROW LEVEL SECURITY;
-- Service-role only. Zero policies.

-- RPC: atomic increment + over-cap check.
-- Returns the post-increment count and the cap. Caller (proxy) decides
-- whether to accept or 429 based on `count > p_max_count`.
--
-- pg_advisory_xact_lock: serializes per-IP writes to avoid MVCC bloat from
-- concurrent UPSERTs on the same hot row. Transaction-scoped → auto-released
-- on commit; cheap (no on-disk state); no deadlock risk (single lock per
-- call, taken before any row touch).

CREATE FUNCTION public.voice_rate_limit_check(
  p_ip_hash    text,
  p_window_s   int,
  p_max_count  int
) RETURNS TABLE (
  count      int,
  over_limit boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_lock_key  bigint;
  v_now       timestamptz := now();
  v_cutoff    timestamptz;
  v_row       record;
  v_new_count int;
BEGIN
  IF char_length(p_ip_hash) <> 64 THEN
    RAISE EXCEPTION 'ip_hash must be 64-char hex (sha256)' USING ERRCODE = '22023';
  END IF;
  IF p_window_s NOT BETWEEN 10 AND 3600 THEN
    RAISE EXCEPTION 'window_s out of range [10, 3600]' USING ERRCODE = '22003';
  END IF;
  IF p_max_count NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'max_count out of range [1, 100000]' USING ERRCODE = '22003';
  END IF;

  v_cutoff := v_now - make_interval(secs => p_window_s);

  -- Serialize per-IP: hashtext lossy-maps sha256 → int; collisions are fine
  -- (only serialize a few unrelated IPs occasionally, no correctness impact).
  v_lock_key := hashtext(p_ip_hash);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT c.window_start, c.count
    INTO v_row
    FROM public.voice_ip_counters c
   WHERE c.ip_hash = p_ip_hash;

  IF NOT FOUND OR v_row.window_start < v_cutoff THEN
    -- First hit in a fresh window.
    INSERT INTO public.voice_ip_counters (ip_hash, window_start, count, updated_at)
    VALUES (p_ip_hash, v_now, 1, v_now)
    ON CONFLICT (ip_hash) DO UPDATE
      SET window_start = v_now,
          count        = 1,
          updated_at   = v_now;
    v_new_count := 1;
  ELSE
    UPDATE public.voice_ip_counters
       SET count = count + 1,
           updated_at = v_now
     WHERE ip_hash = p_ip_hash
    RETURNING count INTO v_new_count;
  END IF;

  RETURN QUERY SELECT v_new_count, (v_new_count > p_max_count);
END;$$;

REVOKE EXECUTE ON FUNCTION public.voice_rate_limit_check(text, int, int)
  FROM public, anon, authenticated;

-- pg_cron purge — matches 20260425000003 style (cron schema, DO-block around
-- unschedule for idempotent re-run). Schedule is also DO-wrapped so local
-- dev reset (pg_cron not enabled in default Supabase Docker image) doesn't
-- abort the whole migration chain.

DO $guard$
BEGIN
  PERFORM cron.unschedule('voice_ip_counters_purge');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$guard$;

DO $guard$
BEGIN
  PERFORM cron.schedule(
    'voice_ip_counters_purge',
    '* * * * *',  -- every minute; matches sliding-window cadence
    $job$ DELETE FROM public.voice_ip_counters
           WHERE window_start < now() - interval '2 minutes' $job$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available; voice_ip_counters_purge not scheduled. Enable pg_cron in Supabase → Database → Extensions and re-run this migration.';
END;
$guard$;
