-- ─────────────────────────────────────────────────────────────────────────
-- RAG SOTA Phase 2 — Day 8 MIG-3
-- semantic_query_cache (HASH-partitioned, btree-only, true-upsert)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Semantic cache for retrieval results. Same-query paraphrases (within a
-- cosine-similarity threshold of a prior query) skip the whole retrieval
-- pipeline (rewrite + Gemini Flash + vector + BM25 + RRF + rerank) and
-- return the cached parent_unit_ids directly.
--
-- Per Day-8 audit:
--   C2 — lookup is `ORDER BY <=> LIMIT 1` first, THEN outer-filter on
--        similarity threshold. Plan shape is HNSW-pushdown-friendly. The
--        lookup function sets `hnsw.iterative_scan = strict_order` so the
--        creator_id + corpus_version + expires_at filter pushes through
--        the index instead of post-filtering to <1 row.
--   C3 (plan-stage) — initially "no HNSW until 100K rows/partition" was
--        proposed as YAGNI for v1 scale. Day-8-final audit M3 reversed:
--        seq-scan over halfvec distances defeats the cache's sub-millisecond
--        purpose even at 1K entries. Per-partition HNSW added (m=16,
--        ef=64). Each upsert hits ONE partition's HNSW (HASH-determined)
--        so write-amp = single HNSW workload, not 16× anything.
--   M1 — pg_column_size is STABLE on PG15; CHECK constraints require
--        IMMUTABLE expressions. Replaced with a bounded-array constraint
--        (jsonb_array_length, IMMUTABLE) which gives the same protection.
--   M2 — UNIQUE (creator_id, corpus_version, query_text_hash) makes the
--        upsert RPC actually do ON CONFLICT, not silent N-entry-per-query.
--   M9 — depends on creators.current_corpus_version (MIG-1, already applied).
--
-- Payload is locked to {parent_unit_ids: uuid[], scores: float[]} ONLY.
-- No raw text is ever stored in the cache (audit C3 of earlier round).
-- Reading the cached IDs always re-fetches text via topk_v2 RPC, so a
-- stale cache row can never leak old chunk content into a future session.
--
-- corpus_version is caller-supplied (closure-captured at session-open
-- from creators.current_corpus_version, NOT read per-query). Upsert RPC
-- rejects writes where the caller's version differs from the live row
-- (FOR SHARE on the creators row in the same transaction). This makes
-- mid-session reprocess safe: the session keeps its captured version,
-- writes get rejected, lookups under the old version still hit cached
-- entries (which the next lookup will replace via the standard miss
-- path under the new version).

-- ── Parent table ────────────────────────────────────────────────────────
CREATE TABLE public.semantic_query_cache (
  id                uuid          NOT NULL DEFAULT gen_random_uuid(),
  creator_id        uuid          NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  corpus_version    int           NOT NULL CHECK (corpus_version >= 1),
  query_embedding   halfvec(768)  NOT NULL,
  query_text_hash   bytea         NOT NULL CHECK (octet_length(query_text_hash) BETWEEN 16 AND 64),
  -- Payload shape locked to {parent_unit_ids: uuid[], scores: float[]} only.
  -- No raw text ever stored. Bounded arrays (≤ 50 items) cap row size
  -- without needing a STABLE pg_column_size CHECK.
  payload_json      jsonb         NOT NULL CHECK (
                                    payload_json ? 'parent_unit_ids'
                                    AND payload_json ? 'scores'
                                    AND jsonb_typeof(payload_json -> 'parent_unit_ids') = 'array'
                                    AND jsonb_typeof(payload_json -> 'scores') = 'array'
                                    AND jsonb_array_length(payload_json -> 'parent_unit_ids')
                                      = jsonb_array_length(payload_json -> 'scores')
                                    AND jsonb_array_length(payload_json -> 'parent_unit_ids') <= 50
                                  ),
  hit_count         int           NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  last_hit_at       timestamptz   NOT NULL DEFAULT now(),
  created_at        timestamptz   NOT NULL DEFAULT now(),
  expires_at        timestamptz   NOT NULL,
  -- Sanity invariants
  CHECK (last_hit_at >= created_at),
  CHECK (expires_at  >  created_at),
  -- PK must contain the partition key; UNIQUE must too.
  PRIMARY KEY (creator_id, id),
  UNIQUE (creator_id, corpus_version, query_text_hash)
) PARTITION BY HASH (creator_id);

COMMENT ON TABLE public.semantic_query_cache IS
  '16-way HASH-partitioned semantic retrieval cache. Payload is parent_unit_ids + scores only (no raw text). Partitioned for per-creator-bounded HNSW retrofit at scale (~100K rows/partition trigger). Service-role only.';

-- 16 hash partitions. Per-partition btree on (corpus_version, expires_at)
-- supports the lookup filter chain; per-partition expires_at btree supports
-- the daily purge with partition pruning.
--
-- Per-partition HNSW on query_embedding: Day-8-final audit M3 reversed an
-- earlier "v1 scale doesn't need HNSW" decision. The cache's whole purpose
-- is sub-millisecond lookup, which requires an embedding index from row 1.
-- Without it, lookup is a seq-scan over halfvec distances — at 1K entries
-- already 10-50ms, which defeats the cache. Per-partition HNSW means each
-- upsert writes to exactly one partition's index (HASH-determined),
-- bounded to ~440K rows steady-state at 10K DAU. m=16/ef=64 is the standard
-- pgvector default for halfvec.
DO $$
DECLARE i int;
BEGIN
  FOR i IN 0..15 LOOP
    EXECUTE format(
      $sql$
      CREATE TABLE public.semantic_query_cache_p%1$s
        PARTITION OF public.semantic_query_cache
        FOR VALUES WITH (MODULUS 16, REMAINDER %1$s)
      $sql$,
      i
    );
    EXECUTE format(
      'CREATE INDEX semantic_query_cache_p%1$s_lookup_idx
         ON public.semantic_query_cache_p%1$s (corpus_version, expires_at)',
      i
    );
    EXECUTE format(
      'CREATE INDEX semantic_query_cache_p%1$s_expiry_idx
         ON public.semantic_query_cache_p%1$s (expires_at)',
      i
    );
    EXECUTE format(
      'CREATE INDEX semantic_query_cache_p%1$s_embed_hnsw_idx
         ON public.semantic_query_cache_p%1$s
         USING hnsw (query_embedding halfvec_cosine_ops)
         WITH (m = 16, ef_construction = 64)',
      i
    );
    EXECUTE format(
      'ALTER TABLE public.semantic_query_cache_p%1$s ENABLE ROW LEVEL SECURITY',
      i
    );
  END LOOP;
END
$$;

-- RLS: service-role only. No policies = deny-all for anon, authenticated.
ALTER TABLE public.semantic_query_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.semantic_query_cache FROM public, anon, authenticated;
GRANT ALL ON TABLE public.semantic_query_cache TO service_role;

-- ── Lookup RPC (C2: LIMIT 1 first, threshold filter outer) ──────────────
CREATE FUNCTION public.semantic_query_cache_lookup(
  p_creator_id     uuid,
  p_corpus_version int,
  p_query_vec      halfvec(768),
  p_threshold      float DEFAULT 0.92
) RETURNS TABLE (
  parent_unit_ids  uuid[],
  scores           float[],
  age_seconds      int,
  cached_row_id    uuid
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
SET hnsw.iterative_scan = 'strict_order'
AS $$
  -- Pull the single closest row first. If we later add per-partition HNSW,
  -- this ORDER BY + LIMIT 1 plan picks up the index; threshold filter on
  -- the outer query does NOT block index use (C2 fix).
  WITH closest AS (
    SELECT cqc.id,
           cqc.payload_json,
           cqc.created_at,
           1 - (cqc.query_embedding <=> p_query_vec)::float AS sim
      FROM public.semantic_query_cache cqc
     WHERE cqc.creator_id     = p_creator_id
       AND cqc.corpus_version = p_corpus_version
       AND cqc.expires_at     > now()
     ORDER BY cqc.query_embedding <=> p_query_vec
     LIMIT 1
  )
  SELECT
    ARRAY(SELECT (jsonb_array_elements_text(c.payload_json -> 'parent_unit_ids'))::uuid),
    ARRAY(SELECT (jsonb_array_elements_text(c.payload_json -> 'scores'))::float),
    GREATEST(0, EXTRACT(EPOCH FROM (now() - c.created_at))::int),
    c.id
    FROM closest c
   WHERE c.sim >= GREATEST(0::float, LEAST(p_threshold, 1.0::float));
$$;

COMMENT ON FUNCTION public.semantic_query_cache_lookup(uuid, int, halfvec, float) IS
  'Semantic cache lookup. Returns the single closest cached entry under (creator_id, corpus_version) if its cosine similarity to p_query_vec ≥ p_threshold AND it has not expired. Returns ZERO ROWS on miss. C2: ORDER BY <=> LIMIT 1 first, threshold filter applied outer so HNSW (when retrofitted) pushes down. Service-role only.';

GRANT EXECUTE ON FUNCTION public.semantic_query_cache_lookup(uuid, int, halfvec, float)
  TO service_role;

-- ── Upsert RPC (M2 true upsert + atomic corpus_version check) ───────────
CREATE FUNCTION public.semantic_query_cache_upsert(
  p_creator_id      uuid,
  p_corpus_version  int,
  p_query_vec       halfvec(768),
  p_query_text_hash bytea,
  p_parent_unit_ids uuid[],
  p_scores          float[],
  p_ttl_seconds     int DEFAULT 604800
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_current_version int;
  v_n_ids           int;
  v_n_scores        int;
  v_payload         jsonb;
  v_ttl             int;
  v_id              uuid;
BEGIN
  -- Input validation. Reject (return NULL) instead of raising so the
  -- caller's retrieval path is never blocked by a malformed write.
  IF p_creator_id IS NULL OR p_corpus_version IS NULL
     OR p_query_vec IS NULL OR p_query_text_hash IS NULL
     OR p_parent_unit_ids IS NULL OR p_scores IS NULL THEN
    RETURN NULL;
  END IF;

  v_n_ids    := COALESCE(array_length(p_parent_unit_ids, 1), 0);
  v_n_scores := COALESCE(array_length(p_scores, 1), 0);
  IF v_n_ids <> v_n_scores OR v_n_ids = 0 OR v_n_ids > 50 THEN
    RETURN NULL;
  END IF;

  IF octet_length(p_query_text_hash) NOT BETWEEN 16 AND 64 THEN
    RETURN NULL;
  END IF;

  -- Atomic corpus_version check. FOR SHARE locks the creator row against
  -- concurrent updates from finalize while we decide whether to write.
  SELECT current_corpus_version INTO v_current_version
    FROM public.creators
   WHERE id = p_creator_id
   FOR SHARE;

  IF v_current_version IS NULL OR v_current_version <> p_corpus_version THEN
    -- Caller has a stale corpus_version (or creator doesn't exist).
    -- Do NOT cache — would leak parent_unit_ids that may not exist
    -- after the next reprocess finalize.
    RETURN NULL;
  END IF;

  -- Clamp TTL to [60s, 30 days].
  v_ttl := GREATEST(60, LEAST(p_ttl_seconds, 2592000));

  v_payload := jsonb_build_object(
    'parent_unit_ids', to_jsonb(p_parent_unit_ids),
    'scores',          to_jsonb(p_scores)
  );

  -- True upsert on (creator_id, corpus_version, query_text_hash).
  -- On conflict: refresh embedding (paraphrase may have new vec), payload,
  -- last_hit_at, expires_at; bump hit_count. created_at stays at original.
  INSERT INTO public.semantic_query_cache
    (creator_id, corpus_version, query_embedding, query_text_hash, payload_json,
     hit_count, last_hit_at, expires_at)
  VALUES
    (p_creator_id, p_corpus_version, p_query_vec, p_query_text_hash, v_payload,
     0, now(), now() + make_interval(secs => v_ttl))
  ON CONFLICT (creator_id, corpus_version, query_text_hash) DO UPDATE
     SET query_embedding = EXCLUDED.query_embedding,
         payload_json    = EXCLUDED.payload_json,
         created_at      = now(),
         last_hit_at     = now(),
         expires_at      = EXCLUDED.expires_at,
         hit_count       = semantic_query_cache.hit_count + 1
  RETURNING id INTO v_id;
  -- created_at refreshed alongside expires_at so lookup-side age_seconds
  -- reflects payload freshness (Day-8-final audit C1). Without this,
  -- age_seconds returns the wall-clock age of the cache row's identity,
  -- not the payload — making telemetry and any "stale-vs-fresh" logic lie.

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.semantic_query_cache_upsert(uuid, int, halfvec, bytea, uuid[], float[], int) IS
  'Atomic semantic cache upsert. Rejects (returns NULL) on: NULL inputs, array-length mismatch, oversized payload (>50), short/long query_text_hash, stale corpus_version (FOR SHARE on creators row). True upsert via ON CONFLICT (creator_id, corpus_version, query_text_hash). TTL clamped to [60s, 30d]. Service-role only.';

GRANT EXECUTE ON FUNCTION public.semantic_query_cache_upsert(uuid, int, halfvec, bytea, uuid[], float[], int)
  TO service_role;

-- ── Daily purge (pg_cron, optional) ─────────────────────────────────────
-- DELETE WHERE expires_at < now() prunes per-partition. The expiry_idx
-- on each partition + partition pruning on creator_id-hash gives a fast
-- targeted plan.
CREATE FUNCTION public.semantic_query_cache_purge_expired() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_deleted int;
BEGIN
  DELETE FROM public.semantic_query_cache WHERE expires_at < now();
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.semantic_query_cache_purge_expired() IS
  'Purges expired semantic_query_cache rows. Called daily by pg_cron when available; harmless to run ad-hoc. Returns number of rows deleted.';

REVOKE ALL ON FUNCTION public.semantic_query_cache_purge_expired()
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.semantic_query_cache_purge_expired()
  TO service_role;

-- Idempotent schedule. unschedule first (no-op if not present), then
-- schedule. Both wrapped in their own EXCEPTION block so a re-run of
-- this migration on an already-cron-installed DB doesn't abort
-- (Day-8-final audit C3).
DO $$
BEGIN
  PERFORM cron.unschedule('semantic_query_cache_purge_expired');
EXCEPTION
  WHEN undefined_function THEN
    NULL;  -- pg_cron not installed; nothing to unschedule
  WHEN OTHERS THEN
    NULL;  -- job didn't exist; harmless
END
$$;

DO $$
BEGIN
  PERFORM cron.schedule(
    'semantic_query_cache_purge_expired',
    '7 4 * * *',  -- 04:07 UTC daily — offset from other jobs
    $sched$SELECT public.semantic_query_cache_purge_expired();$sched$
  );
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'pg_cron not installed; skipping semantic_query_cache_purge_expired schedule.';
END
$$;
