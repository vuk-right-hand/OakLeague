# pgvector RAG rollback runbook

Per-scenario unwind steps. Open this in production during an actual rollback;
don't SQL-by-vibes.

## Scenarios

### A) Single creator: vector mode broken, flip back to drawer

See `PGVECTOR_DOGFOOD_RUNBOOK.md` §Step 7. One RPC call. Chunks linger
(harmless — CASCADE on sample_content delete). Persona recompiles
automatically inside the flip transaction.

### B) Vector mode broken across all creators, no creators on vector yet

No production-visible impact — drawer is the default. Disable embed-worker
by removing the `makeEmbedWorker` spawn in `server/voice-proxy/index.js`
and redeploying. Chunks table accumulates nothing new; existing chunks
remain. Restore the spawn when fixed.

### C) Vector mode broken across multiple creators (>1 on vector)

```sql
-- Flip all vector-mode creators back to drawer at once. Records audit rows.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id FROM public.creators WHERE brain_mode = 'vector'
  LOOP
    PERFORM public.admin_set_creator_brain_mode(r.id, 'drawer');
  END LOOP;
END$$;
```

Run as admin (Supabase Studio with admin role). Each flip writes an
`admin_audit_log` row. Each persona recompiles inside its flip transaction.

### D) Embedding worker hung / spending out of control

1. Pause the worker by setting `EMBEDDING_USD_PER_TOKEN=0` in Fly secrets +
   redeploy. The worker still claims jobs but the post-spend accumulate
   records 0 — protects budget while you investigate.
2. Inspect `creator_embedding_budget`:
   ```sql
   SELECT creator_id, accumulated_usd, budget_date
     FROM public.creator_embedding_budget
    WHERE budget_date = current_date
    ORDER BY accumulated_usd DESC LIMIT 10;
   ```
3. If a specific creator is the source, mark all their pending jobs errored:
   ```sql
   UPDATE public.sample_content_embedding_jobs
      SET status = 'errored', last_error = 'manual_rollback',
          claimed_by = NULL, claimed_at = NULL
    WHERE sample_id IN (
      SELECT id FROM public.sample_content WHERE creator_id = '<creator-uuid>'
    )
      AND status IN ('pending', 'processing');
   ```
4. After investigation, restore `EMBEDDING_USD_PER_TOKEN` and redeploy.

### E) pgvector extension itself broken

Unlikely (pgvector 0.8.0 is stable), but if a Postgres patch upgrade
breaks the extension:

```sql
-- 1. Drop the HNSW index (rebuild after extension fix).
DROP INDEX IF EXISTS public.sample_content_chunks_embedding_hnsw_idx;
-- 2. Flip ALL creators to drawer (mode flag bypasses the topk RPC entirely).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.creators WHERE brain_mode = 'vector' LOOP
    PERFORM public.admin_set_creator_brain_mode(r.id, 'drawer');
  END LOOP;
END$$;
-- 3. Embed-worker idles (no new jobs claimed since drawer mode doesn't
--    enqueue new ones — but existing pending rows still get processed if
--    extension comes back). Optionally:
UPDATE public.sample_content_embedding_jobs SET status = 'errored',
       last_error = 'pgvector_rollback'
 WHERE status IN ('pending', 'processing');
```

### F) Full unwind (nuclear: revert the whole RAG branch)

Only do this if the migrations themselves are causing trouble (not the
runtime — which is fully rollback-able via mode flip).

```sql
-- Reverse migration order: M11 → M2 (M1 = pgvector extension; leave it
-- installed unless DBA confirms it's safe to drop).

DROP FUNCTION IF EXISTS public.finalize_embedding_job(uuid, uuid, jsonb, halfvec[], int);
-- M10 — restore the pre-pgvector compile body. The migration file is
-- CREATE OR REPLACE; reverting requires re-applying the prior version
-- 20260511000002. Easiest: just keep M10's compile (it's per-mode and
-- handles both states), but if you must revert exactly, source from
-- migrations/20260511000002_creator_brain_compile_rpc.sql.
DROP FUNCTION IF EXISTS public.creator_embedding_budget_accumulate_and_check(uuid, numeric, numeric);
DROP FUNCTION IF EXISTS public.creator_embedding_budget_peek(uuid);
DROP TABLE IF EXISTS public.creator_embedding_budget;
DROP FUNCTION IF EXISTS public.voice_retrieval_budget_check_and_increment(uuid, int);
DROP TABLE IF EXISTS public.voice_retrieval_budget;
DROP FUNCTION IF EXISTS public.admin_set_creator_brain_mode(uuid, public.brain_mode);
ALTER TABLE public.voice_tickets
  DROP CONSTRAINT IF EXISTS voice_tickets_brain_mode_prefix_chk;
ALTER TABLE public.voice_tickets DROP COLUMN IF EXISTS brain_mode;
DROP FUNCTION IF EXISTS public.creator_knowledge_topk(uuid, halfvec, int, numeric);
DO $$ BEGIN PERFORM cron.unschedule('reap_stuck_embedding_jobs'); EXCEPTION WHEN OTHERS THEN NULL; END$$;
DROP FUNCTION IF EXISTS public.reap_stuck_embedding_jobs();
DROP TRIGGER IF EXISTS enqueue_sample_embedding_job ON public.sample_content;
DROP FUNCTION IF EXISTS public.enqueue_sample_embedding_job();
DROP TABLE IF EXISTS public.sample_content_embedding_jobs;
DROP TABLE IF EXISTS public.sample_content_chunks;
ALTER TABLE public.creators DROP COLUMN IF EXISTS brain_mode;
DROP TYPE IF EXISTS public.brain_mode;
-- Leave the `vector` extension installed; it has no side effect when no
-- objects reference it.
```

Worker spawn in `server/voice-proxy/index.js` must be removed and proxy
redeployed before running these DROPs (otherwise the worker hits "table
does not exist" loops).
