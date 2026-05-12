# pgvector RAG dogfood runbook

Step-by-step for the first vector-mode flip (Vuk's creator row). Every step
gates on its predecessor passing; do not skip.

## Pre-flight checklist (before any flip)

* [ ] All 11 migrations applied: `SELECT max(version) FROM supabase_migrations.schema_migrations` returns `20260512000011`.
* [ ] `creators.brain_mode` defaults to `'drawer'` on every existing row (run after deploy):
  ```sql
  SELECT brain_mode, count(*) FROM public.creators GROUP BY 1;
  -- expect: drawer | N
  ```
* [ ] `embed-worker.js` running in production. Tail Fly logs and confirm one of:
  - `[embed-worker] init tick failed` (bad config — fix before continuing), or
  - silent (the worker logs nothing when idle — that's correct).
* [ ] Spike #2 result green in `PGVECTOR_SPIKE_RESULTS.md` (resumption with the new ~716-char persona).
* [ ] Spike #4a result green (cosine pass threshold pinned).
* [ ] `EMBEDDING_USD_PER_TOKEN` set in Fly secrets (default `0.00000015` = $0.15/1M tokens; equivalent to the gemini-embedding-001 standard rate).
* [ ] `GEMINI_API_KEY` already in Fly (existing).

## Step 1: backfill existing sample_content for the creator

The enqueue trigger only fires on INSERT or UPDATE OF raw_text. Existing
`sample_content` rows do not enqueue automatically. Run this BEFORE flipping
the creator to vector mode, otherwise their first session will pull empty
retrieval results and the model will fall back to persona-only.

```sql
-- Replace <creator-uuid> with the target creator's id.
INSERT INTO public.sample_content_embedding_jobs (sample_id, status, attempts, enqueue_version)
SELECT id, 'pending', 0, 1
  FROM public.sample_content
 WHERE creator_id = '<creator-uuid>'
   AND raw_text IS NOT NULL
   AND fetch_status <> 'errored'
   AND NOT EXISTS (
     SELECT 1 FROM public.sample_content_embedding_jobs j WHERE j.sample_id = sample_content.id
   );
```

Verify enqueue:
```sql
SELECT status, count(*)
  FROM public.sample_content_embedding_jobs j
  JOIN public.sample_content s ON s.id = j.sample_id
 WHERE s.creator_id = '<creator-uuid>'
 GROUP BY status;
-- expect: pending | N initially; processing | 1 transiently; done | N after a few minutes
```

Worker processes one job per 5s tick. For Vuk's 13K-word doc this is ~26
chunks, one batch, done in <30s. For a 100K-word course, it's still one
job but the chunker produces ~200 chunks and the worker batches them in
two Gemini API calls (~10s total).

## Step 2: confirm chunks landed + embeddings non-null

```sql
SELECT count(*)                                    AS total_chunks,
       count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded
  FROM public.sample_content_chunks
 WHERE creator_id = '<creator-uuid>';
```

Both numbers should match. If `embedded` < `total_chunks`, the worker is
mid-batch — wait 30s and re-check. If they stay unequal after 5 min, check:

```sql
SELECT status, attempts, last_error, claimed_by, claimed_at
  FROM public.sample_content_embedding_jobs j
  JOIN public.sample_content s ON s.id = j.sample_id
 WHERE s.creator_id = '<creator-uuid>'
   AND j.status <> 'done';
```

`status='errored'` rows need manual investigation. `last_error` will indicate:
- `creator_daily_budget_blown_preflight` — creator's daily $5 cap. Wait until tomorrow OR raise via env temporarily.
- `embed_api_error:*` — Gemini API problem. Retry by setting `status='pending'`, `attempts=0`, `claimed_by=NULL`.
- `sample_raw_text_empty` — actual creator data issue; safe to ignore.

## Step 3: spot-check a retrieval against a known phrase

Pick a unique phrase from a chunk and try retrieval via psql:

```sql
-- Find a chunk you know about.
SELECT id, LEFT(text, 200) FROM public.sample_content_chunks
 WHERE creator_id = '<creator-uuid>' LIMIT 5;

-- Get a query embedding by sending the phrase to gemini-embedding-001
-- (server-side; or use the in-bridge log from a staged session).
-- Easier: run a staged session and tail Fly logs for the retrieval RPC.
```

The full retrieval path (embed → topk) is exercised by Spike #4
(mid-session-injection-spike). If that spike is green, this step is
informational only.

## Step 4: flip the creator's brain_mode

```sql
-- As an admin (run via Supabase Studio SQL with admin auth, OR via the
-- /admin/creators/[id] UI when the toggle ships):
SELECT public.admin_set_creator_brain_mode('<creator-uuid>'::uuid, 'vector');
```

This RPC:
1. Updates `creators.brain_mode = 'vector'`.
2. Recompiles the persona inside the SAME transaction so the next session
   sees the vector-mode-specific clarifier rule baked in.
3. Writes one row to `admin_audit_log` with `before.brain_mode='drawer'`
   and `after.brain_mode='vector'`.

Verify:
```sql
SELECT brain_mode, system_prompt FROM public.creators WHERE id = '<creator-uuid>';
-- expect: vector
-- system_prompt should contain "On substantive questions, ask one short clarifier first."
```

## Step 5: open a vector-mode session

Open `/s/[id]` for one of the creator's hooks. Ask a substantive question.
Expected behavior:

1. Avatar speaks a short clarifier (≤15 words, ends in ?). This is the
   persona's clarifier rule firing.
2. ~120–300ms of retrieval runs in the background.
3. When you answer the clarifier, the avatar's response should reference
   specific content from your knowledge corpus (use a phrase you KNOW is
   only in one chunk).
4. Tail Fly logs for the proxy:
   ```
   [ws <connId>] gemini.open ok in <ms>ms (... brain=vector)
   ```
   confirms vector-mode routing landed.

## Step 6: 48h dogfood window

Watch:
- Fly logs: any `audio-gate overflow` warnings (R3 M1 risk — increase
  `AUDIO_HOLD_MAX_BYTES` if frequent).
- PostHog events: `brain_mode_vector_session` should fire 1:1 per session
  open.
- Sentry: `embedding.creator_daily_budget_*` warnings (over-cap is a sign
  of paste-storm; rate-limit may need tightening).
- Supabase Studio → `creator_embedding_budget` table: daily $ spend per creator.

If anything looks bad, ROLLBACK via Step 7 immediately.

## Step 7: rollback (if needed)

```sql
SELECT public.admin_set_creator_brain_mode('<creator-uuid>'::uuid, 'drawer');
```

This:
1. Flips `creators.brain_mode = 'drawer'`.
2. Recompiles persona WITHOUT the clarifier rule.
3. Records the reverse transition in `admin_audit_log`.

Existing `sample_content_chunks` rows remain. Future sessions revert to
drawer-mode (hook tag overlap → buildBrainPrefix). No data lost.

**Drawer-rollback gap warning**: if this creator's `sample_content.topic_tags`
don't overlap with their `hooks.topic_tags`, the drawer prefix will be
empty and sessions fall through to persona-only. Verify before flip-back:

```sql
SELECT count(*)
  FROM public.sample_content sc
  JOIN public.hooks h ON h.topic_tags && sc.topic_tags
  JOIN public.videos v ON v.id = h.video_id
 WHERE sc.creator_id = '<creator-uuid>'
   AND v.creator_id  = sc.creator_id;
-- expect: > 0 for drawer mode to work
```

If this is 0, the creator's content was tagged for vector mode (where tags
don't matter) but not for drawer mode. Either re-tag sample_content rows
or accept persona-only fallback.
