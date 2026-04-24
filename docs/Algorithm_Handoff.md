# Algorithm & Behavior-Tracking Handoff

> **What this is:** a blueprint of every personalization, ranking, tracking, and content-DNA system we built in Veritas (a YouTube-curation web app). Written for an agent picking these patterns up for a different app — vertical-swipe short-form video, 60–90s, TikTok-style.
>
> **How to use it:** read top-to-bottom once. Each section ends with **"Take if applicable"** — that's the part to translate into your stack. Code paths are cited from this repo (`src/...`, `supabase/migrations/...`) so you can pull originals if you want.
>
> **Stack assumed here:** Next.js App Router + Supabase Postgres (with `pgvector >= 0.7`) + Gemini for analysis & embeddings. None of that is required to lift the model.

---

## 0. The shape of the problem

We track three things, in this order of importance:

1. **Content DNA** — every video, on ingest, gets reduced to (a) a 1536-dim semantic vector, (b) 3 weighted tags with timestamp segments, (c) a free-text category, (d) a feed-bucket label.
2. **Behavior** — every meaningful watch updates two things: a per-user **taste vector** (the ranking signal) and a per-user **creator affinity counter** (the super-fan signal). Watch events also write to a raw `watch_history` ledger and to `analytics_events` for audit/debug.
3. **Output** — two ranking surfaces: (a) the scrolling **feed** (cosine similarity over taste vector, partial HNSW per category) and (b) **search** (FTS ∪ vector, blended, then re-ranked by viewer taste).

Everything else (quizzes, content gaps, in-memory next-up, creator follows) plugs into those three.

---

## 1. Identity resolution — the load-bearing cascade

**The single most important thing in the whole system.** If reads and writes resolve a user's id differently, every personalization signal silently drops on the floor. We learned this the hard way.

### The cascade (file: `src/lib/viewer-identity.ts`)

Resolve in this order, and **never reorder**:

1. **Mission cookie** (`veritas_user`) → look up `user_missions.user_id`, fall back to mission_id itself.
2. **Supabase auth JWT** (`sb-<ref>-auth-token`) → decode `sub` claim.
3. **Persistent anon cookie** (`veritas_anon`) — minted on first write, 1-year `httpOnly` `sameSite=lax`.

Two surface functions:

- `resolveViewerIdReadOnly()` — used by SSR feed reads. **Never mints.** Returns `null` for fresh anons (they fall through to chronological).
- `resolveOrMintViewerId(response)` — used by writes. Mints and sets the anon cookie on the **same response object** as the DB write. Critical: in Next 16, `NextResponse.cookies.set()` must be called on the response that gets returned. We mint on a throwaway response, do the write, then copy cookies via `response.cookies.getAll() → set()` (NOT `headers.get('Set-Cookie')` — undici joins values and loses attributes).

### Why this matters more than it looks

A creator who logs in with email but historically had a `veritas_user` cookie from onboarding will resolve to **different ids** under different cascades. Their taste vector and watch history split between two keys and nothing personalizes.

### Take if applicable

- **For TikTok-style apps you almost certainly want a persistent anon id for fresh users.** People will swipe 50 videos before they sign up. If you don't track them, your taste vector is empty when they finally convert.
- Use **one resolver module**. Both write and read call through it. Don't inline cookie reads.
- The id you key on doesn't have to be a UUID — it just has to be **stable per device + survive sign-up handoff**. Our pattern: anon UUID → on signup, copy the anon's taste vector to the new auth user, then drop the anon row.
- Mint on **write paths only**. Read paths that mint cookies make every SSR pageload set-cookie, which thrashes CDN caching and (worse) burns through cookie budget on browsers that limit per-origin.

---

## 2. Content DNA — what we extract per video

Every video gets analyzed once on ingest. Output is **structured JSON** validated by Zod (we use Gemini's `responseSchema`/`responseMimeType: 'application/json'`, but any structured-output LLM works).

### The schema (file: `src/lib/analysis-prompt.ts`)

```ts
{
  humanScore: 91-100,                  // quality floor (we reject below 91)
  takeaways: string[3],                // 3 punchy "key lesson" lines, ≤75 chars each
  category: string,                    // free-form sub-genre ("Sales", "Mindset")
  content_tags: [                      // EXACTLY 3 — this is the Content DNA
    { tag: 'cold_emails', weight: 10, segment_start_pct: 0,  segment_end_pct: 45 },
    { tag: 'outreach',    weight: 8,  segment_start_pct: 30, segment_end_pct: 75 },
    { tag: 'tools',       weight: 5,  segment_start_pct: 65, segment_end_pct: 100 }
  ],
  quiz_questions: [...6 open-ended Qs, each tagged with a skill],

  // Routing
  verdict: 'approve' | 'reject',                    // gatekeeper
  feed_category: 'pulse' | 'forge' | 'alchemy',     // bucket — ALWAYS populated, even on reject
  category_confidence: 0.0-1.0,
  category_rationale: string,                       // 1-2 sentences
  category_signals: { is_tutorial, is_news, is_monetization, is_mindset, novelty_claim, novelty_substantiated }
}
```

### Key design choices and why

**1. Three weights: 10, 8, 5.** Forces the model to actually rank. "Everything is a 7" is the failure mode.

**2. Segment timestamps as percentages.** A user who watches the first 30% of a video shouldn't get scored for the topic discussed in the last 30%. We use percentages (not seconds) so the same logic works for a 90s short and a 35-min lecture. We currently **don't use the segments in the taste-vector path** (the cosine similarity assumes whole-video relevance), but they're load-bearing for the older `user_interest_scores` tag-overlap path and for the in-memory recommender. Capture them anyway — cheap to add later, expensive to backfill.

**3. `feed_category` is always populated, even on reject.** This means a human admin can override a reject without re-running Gemini. Saved us hours during catalog cleanup.

**4. `verdict` and `feed_category` are separate decisions.** "Should this exist on the platform" and "where does it live" are independent — collapsing them produces ambiguous prompts and the model thrashes.

**5. The classification prompt is a decision tree, walked in order.** Not "score each bucket and pick the highest" — that's non-deterministic. Read `src/lib/analysis-prompt.ts` Goal 6 for the exact shape. The prompt is enormous (~340 lines) because the edge cases ("how to build and sell X" — is that tutorial or sales?) need explicit examples.

### Take if applicable

- **For 60-90s vertical:** drop `quiz_questions`. Probably drop the segment timestamps too (everything is "0–100%" at that length). Keep `content_tags` (3 weighted), `feed_category`, `verdict`, `humanScore`.
- **3 tags, weighted, is the sweet spot.** We tried more — model picks padding. Fewer — not enough overlap to rank. 3 with explicit weights forces a real ranking.
- **Use structured output (`responseSchema`), not "respond in JSON".** The latter fails ~3% of the time and you'll spend a week chasing the parse errors. Wrap in Zod for a second-line type guarantee — when Zod fails, **insert the row with `classification_status='failed'`** so the video_id is tracked but invisible to readers. Recoverable via backfill, not a dropped record.
- **For TikTok-style:** instead of `verdict`/`feed_category`, you probably want `vibe_tags` (4-6 mood/aesthetic words: `cozy`, `chaotic`, `educational`, `aspirational`) — same shape, different vocabulary. Vibe tags + a hard NSFW/violation filter map cleanly onto our verdict+category split.

---

## 3. The taste vector — the actual ranking signal

**This is the algorithm.** Everything else is plumbing.

### Model

Each user has one row in `user_taste_vectors`:

```sql
CREATE TABLE user_taste_vectors (
  user_id     UUID PRIMARY KEY,        -- NO FK — keyspace is mixed (auth.users | mission | anon)
  embedding   vector(1536) NOT NULL,
  watch_count INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT now()
);
```

Migration: `supabase/migrations/20260416_add_embedding_1536_and_taste_vectors.sql`.

### Update rule (Exponential Moving Average)

On every meaningful watch, blend the watched video's embedding into the user's vector:

```
new_taste = l2_normalize( 0.85 * old_taste  +  (0.15 * watch_weight) * video_embedding )
```

- `0.15` is the EMA alpha. Empirically, 0.10 was too sticky (cold-start dragged on for 30+ watches), 0.20 made the feed jumpy after one accidental watch.
- `watch_weight = min(watchPct / 100, 1)` — a 30% watch contributes ~0.045, a 100% watch contributes 0.15. Lets long-form full-watches dominate without one accidental skim re-shaping taste.
- **First insert** stores `l2_normalize(video_embedding)` directly (no blend).
- **L2 normalize after every update** so cosine similarity stays well-defined.

### The actual SQL (the gnarly bits)

Function: `upsert_user_taste_vector(p_user_id, p_video_id, p_weight)`. Single statement, `INSERT ... ON CONFLICT DO UPDATE` — atomic under concurrent writes.

Two pgvector footguns we hit:

**1. There is no scalar-multiplication operator in pgvector.** Only `vector * vector` (element-wise). To scale a vector by a constant `k`, you have to build a constant vector of `[k, k, k, ...]` and multiply element-wise:

```sql
embedding * array_fill(0.85::real, ARRAY[1536])::vector(1536)
```

If you forget this you get `operator does not exist: vector * real`.

**2. We pass the `video_id` to the RPC, not the vector itself.** The RPC SELECTs `videos.embedding_1536` internally. Reason: Supabase JS serializes vectors as text (not binary), and any mismatch silently writes garbage. Server-side lookup keeps the bytes inside Postgres.

### When we update

Write path: `recordWatchProgress()` in `src/app/actions/interest-actions.ts`, called from `POST /api/watch-progress` (which `navigator.sendBeacon`s on `pagehide`/visibility change).

```ts
if (watchPct >= 25) {
  const weight = Math.min(watchPct / 100, 1);
  await supabase.rpc('upsert_user_taste_vector', {
    p_user_id: userId, p_video_id: videoId, p_weight: weight,
  });
}
```

`watchPct >= 25` gate: a 5% bounce shouldn't define taste. Tunable.

### Cold-start branch

In `get_personalized_feed`:

```sql
IF v_user_embedding IS NULL OR v_watch_count < 3 THEN
  -- fall through to pure chronological ordering
END IF;
```

Three watches before personalization kicks in. One-watch taste vectors are noise — they'll point in whatever direction the first video happened to lie and rank everything similar to it for the next session. Three is enough to start averaging.

### Take if applicable

- **EMA alpha 0.15 is a great default for ~hour-long content with whole-video signal.** For 60-90s vertical where users watch dozens per session, you probably want **alpha 0.05–0.08** so taste evolves smoothly across a session and isn't dictated by the third video they swiped.
- **Replace `watchPct >= 25`** with whatever signal matches your medium. For shorts: `watch_seconds >= duration * 0.7` OR `replays >= 1` OR `liked OR shared OR commented`. The principle is "did they actually engage" — not "did the video play."
- **Negative signal matters at short-form scale.** We didn't need it (long-form, opt-in catalog). You probably do — quick swipes (<3s) and immediate skips should *push the taste vector AWAY* from that video's embedding. Same EMA, negative alpha. Cap how much it can move per event so one bad video doesn't kill a niche.
- **Always L2-normalize after the blend.** Not optional.
- **Generate embeddings on the structured analysis output, not the raw transcript.** We embed `Title: X | Category: Y | Key Insights: [takeaways] | Topics: [tags]` — see `src/app/api/pipeline/process-video/route.ts:257`. Cleaner signal, no transcript noise (filler words, sponsor reads). For shorts: embed the title + transcript + auto-extracted topic words.

---

## 4. The feed — partial HNSW + cosine similarity

### The RPC

`get_personalized_feed(p_user_id, p_feed_category, p_limit, p_offset, p_exclude_ids, p_published_after)`. File: `supabase/migrations/20260416_get_personalized_feed_vector.sql`.

```sql
ORDER BY v.embedding_1536 <=> v_user_embedding ASC
LIMIT p_limit
-- NO OFFSET — HNSW is approximate, OFFSET will skip rows. Use p_exclude_ids cursor.
```

Returned `overlap_score = (1 - cosine_distance)` (higher = more similar). Lower distance = better match.

### Partial HNSW indexes — the trick

Three separate partial indexes, **one per feed bucket**:

```sql
CREATE INDEX videos_embedding_1536_forge_hnsw_idx
  ON videos USING hnsw (embedding_1536 vector_cosine_ops)
  WHERE status = 'verified' AND feed_category = 'forge';
```

Why partial: a single HNSW index over all videos plus a `WHERE feed_category = X` filter has **bad recall** (HNSW filters post-search, so the top-K candidates may all get filtered out). Partial indexes pre-filter the candidate pool and the planner picks the right index when the predicate is **literal**.

> **Critical:** the WHERE clause in the RPC must use a **literal** value (`'forge'`), not a plpgsql variable. A variable in `WHERE feed_category = p_feed_category` won't match the partial index predicate at plan time → seq scan → 200ms+ on a 5k catalog. We branch on `IF p_feed_category = 'forge' THEN ... ELSIF` to keep the predicate literal in each query block.

### Pagination via exclude-ids, not OFFSET

`p_exclude_ids` is a `TEXT[]` of every video id already shown in this scroll session. Pushed into the WHERE clause:

```sql
AND NOT (v.id = ANY(p_exclude_ids))
```

OFFSET on an approximate-NN scan returns garbage (HNSW doesn't promise stable ordering across calls). Exclude-ids cursor is honest.

There's a soft cap (~50 ids before the array gets unwieldy). We haven't hit it yet — long scroll sessions exhaust the catalog first. For a TikTok-style app with infinite scroll over a 100k+ catalog, you'll want to **truncate the exclude list to "last N seen" + a Bloom filter** for older history.

### Anon / cold-start fallthrough

`p_user_id IS NULL OR watch_count < 3` → pure chronological by `published_at DESC`. No second code path, no separate "anon RPC." One function, one cold-start branch.

### Security

`SECURITY INVOKER`. **Not granted to anon or authenticated** — service-role only. Reason: the ranking is a side-channel for taste. If anyone can call the RPC with someone else's `p_user_id`, they can scrape that user's interest profile by observing the order of returned videos. Always called from a service-role client on a server route that has independently resolved the viewer.

### The "Pulse" exception

Our app has a "Pulse" tab (latest news). It deliberately bypasses this entire RPC — plain `.order('published_at DESC')`. No HNSW index, no taste re-rank. Rationale: news content is consumed for *novelty*, not *similarity*. Re-ranking would suppress the breaking story to show a user something they've already seen.

### Take if applicable

- **For vertical-swipe with thousands of videos: this exact architecture works.** Partial HNSW per category/vertical (e.g. `cooking`, `fitness`, `comedy`), cosine-similarity ORDER BY, exclude-ids cursor.
- **Don't OFFSET on HNSW.** Cursor-based pagination is non-negotiable.
- **Branch literally on category in the function body** — variable-based predicates won't hit the partial index.
- **Categories vs. one giant index:** if your app has a "For You" feed that crosses verticals, also build one **non-partial** HNSW index on the whole verified pool for that branch. Partials are a perf optimization that pays off when filter selectivity is low.
- **Diversify within the top-K.** Pure cosine-sort tends to return clusters of near-duplicates (5 videos from the same creator on the same topic). Mitigations we'd add but haven't:
  - **MMR (Maximal Marginal Relevance)** — re-rank top 50 to penalize similarity to already-selected items.
  - **Per-creator cap per page** — never more than 2 videos from the same creator in a 10-card page.
  - For TikTok-style: also **time-since-last-shown** — don't surface a video the user saw 2 hours ago even if it's their highest-cosine match. We track this implicitly via the exclude-ids list scoped to the session; a persistent app probably wants `seen_at` persisted in `watch_history`.

---

## 5. Search — hybrid FTS + vector + viewer-taste re-rank

File: `supabase/migrations/20260416_match_videos_1536_personalized.sql`. RPC: `match_videos_1536(query_embedding, query_text, match_threshold, match_count, days_filter, viewer_taste)`.

### The blend

Two recall paths run in parallel CTEs:

```sql
fts_hits  = videos where to_tsvector(title || description) @@ websearch_to_tsquery(query_text)
vec_hits  = videos where (1 - (embedding_1536 <=> query_embedding)) > 0.65
candidate_ids = fts_hits ∪ vec_hits
```

Then score each candidate:

```
base_score = 0.6 * vector_sim
           + 0.4 * (fts_raw / (1 + fts_raw))    -- normalize Postgres ts_rank into [0,1)
           + 0.10 if BOTH fts AND vec matched   -- co-occurrence bonus
```

FTS-matched results get a **floor of 0.55** (`greatest(base_score, 0.55)` if `fts_matched`). Reason: a perfect literal-keyword match should always beat a mediocre semantic match, even if the title is short and the FTS rank is low.

### Viewer-taste re-rank (Phase 2)

Final score:

```
score = 0.7 * floored_score
      + 0.3 * (1 - cosine(video_embedding, viewer_taste))    -- if viewer_taste IS NOT NULL
```

Anon: `viewer_taste IS NULL` → byte-identical to the un-personalized version. No second code path.

70/30 split chosen so search remains *primarily* about the query — a personalization layer that overrides the literal search intent is a search bug.

### Logging (the underrated part)

`logSearchClick(query, videoId, rank, score)` writes an `analytics_events` row on every result click. Source: `src/app/actions/search-actions.ts:87`. Used to:

1. **Tune the threshold** (`match_threshold = 0.65`) — too high and we miss broad-intent queries, too low and we return irrelevant slop. Click-through-by-rank tells us where the floor should be.
2. **Find content gaps** — `logPriorityRequest` writes zero-result queries to `content_gaps`. Direct signal of what to commission next.

### Take if applicable

- **Hybrid is non-negotiable.** Pure-vector search misses literal keyword matches users expect (e.g. searching for a specific brand name). Pure-FTS misses semantic intent. The 0.6/0.4 blend with a co-occurrence bonus has been stable for us across ~2k catalog.
- **Thresholds need tuning data.** Ship with click logging from day 1, not after you notice the search is bad.
- **For short-form video search:** vector recall is often dominated by title/caption text — the videos themselves don't have transcripts long enough to embed meaningfully. Embed: `title + caption + auto-extracted hashtags + 3 most-frequent transcript nouns`. That's enough signal.
- **The "FTS floor" trick is the single highest-impact change we made.** Without it, an exact-title match could be outranked by a fuzzy semantic match. Users hate this and lose trust in search instantly.

---

## 6. Watch tracking — what we capture and why

Three tables, written in parallel from `recordWatchProgress`:

### `watch_history` — the ledger

```
user_id, video_id, watch_seconds (cumulative), last_watched_at
UNIQUE (user_id, video_id)
```

On each progress ping, **add the delta** (`reportedDelta`, server-validated). `last_watched_at` always bumped. Powers the "continue watching" UI and the profile page.

### `user_creator_stats` — super-fan signal

```
user_id, channel_id, total_watch_seconds, last_watched_at
UNIQUE (user_id, channel_id)
```

Aggregates watch time *per creator*. Used by the in-memory next-up recommender (`recommendation-actions.ts`) to bias toward "creators you follow without explicitly following." Cheap, surprisingly powerful.

### `analytics_events` — append-only audit

```
event_type, target_id, metadata jsonb
```

Every watch/search-click/feed-impression writes a row. Schema-flexible (jsonb metadata). Public INSERT policy, service-role read. Used for:
- Threshold tuning (search)
- Funnel analysis (search → click → watch → quiz)
- Debugging "why did this user see X" — we can replay their session

### The watch-time integrity trick

Frontend reports two numbers: `currentTime` (player position) and `realWatchSeconds` (wall-clock seconds the player was actually playing). The server uses `realWatchSeconds ?? max(0, currentTime - lastReportedTime)`.

Why both: a user who seeks from 10s → 50s → 10s → 50s would inflate their "watch time" by raw position-delta. Wall-clock guards against this. We trust the client because the only attack is "this user inflated their own watch counter," which leaks nothing and pollutes only their own taste vector.

The frontend enforces a **30s minimum** before sending to `user_creator_stats` — a 5-second flick shouldn't count.

### Take if applicable

- **Three tables, one write path.** Don't smear writes across multiple endpoints — that's how `watch_history` and `user_creator_stats` drift. Single `recordWatchProgress` function, called from one route, writes all three (taste vector + creator stats + watch history + analytics_events).
- **Use `navigator.sendBeacon` on `pagehide`/`visibilitychange`.** A `fetch()` mid-navigation gets cancelled. Beacon survives.
- **For vertical-swipe:** you probably want a richer event shape — `{ swiped_at_ms, completion_pct, replays, liked, shared, commented }`. Each becomes a different update weight to the taste vector. Likes/shares much heavier than passive completes.
- **Append-only events table is gold.** `analytics_events` cost us almost nothing to add and we've used it for ~80% of debug investigations since. JSONB metadata means no migrations when you add a new event type.

---

## 7. Quizzes & skills (a "proof of work" layer)

Probably overkill for short-form video, but documented in case you adapt.

Each video gets 6 open-ended questions on ingest (Gemini-generated). User answers; Gemini grades with `{passed, confidence, feedback}`. Passes increment a per-skill score in `profiles.skills_matrix` (jsonb), tiered Uncommon → Rare → Epic → Legendary → Mythical.

Trick: an **anti-cheat lock** via `UNIQUE(user_id, video_id)` on `quiz_attempts`. Second attempt returns "success" to the frontend silently but skips the points award — user never knows the dupe was trapped.

Hard-fail filter (profanity, give-up phrases, gibberish, single-letter answers) runs *before* Gemini, sets `passed=false` automatically, and the prompt instructs Gemini to give a *helpful tip* instead of explaining why they failed. Better UX than "you said 'idk', that's a 0."

File: `src/app/api/quiz/submit/route.ts`.

### Take if applicable

For TikTok-style: skip this whole section. Users won't quiz on a 60s video. The transferable bits:
- **Per-user JSON aggregates in a single jsonb column** are way easier than a normalized scores table when the structure is "score per category." Cheap upsert, one read, no joins.
- **UNIQUE constraint as silent anti-cheat** — return success, skip the side effect, log the trap. Users who probe stop probing when nothing happens.

---

## 8. The "in-memory next-up" recommender — intentional drift

File: `src/app/actions/recommendation-actions.ts`. Fires when a user finishes a video to suggest "what to watch next."

It does **NOT** use the taste vector. It uses a **3-tier fallback**:

1. **Tag overlap** — pull current video's tags + user's top 5 tags from `user_interest_scores` → score candidates by `tag_weight × interest_multiplier` + creator-affinity bonus + `human_score / 20`.
2. **Same category** — fall back to `category_tag` match, sorted by `human_score`.
3. **Cold start** — top-rated overall.

This is the older system (pre-taste-vector). **We deliberately did not consolidate it.** Two reasons:

1. Different use case. Feed = ranking a list. Next-up = picking ONE. The latter wants explainability ("Because you're interested in X") that the cosine similarity score doesn't give you.
2. Tag-overlap produces better "explainable" recommendations because tags are human-readable. Cosine distance is just a number.

Marked with a TODO to convert to a Postgres RPC if the catalog crosses ~2k.

### Take if applicable

- **Don't consolidate scorers prematurely.** "One ranking function" sounds clean but eliminates valuable variance. Different surfaces (feed vs. next-up vs. search) want different objectives.
- **Tag-based scoring still earns its keep when you need an "explanation string."** Embeddings give you ranking; tags give you reasons. Keep both signals available even after you adopt vector personalization.

---

## 9. Things we got wrong (use if applicable)

### Vector dimension mistake — `vector(3072)` → `vector(1536)`

Started with Gemini's full 3072-dim embeddings. pgvector HNSW has a **2000-dim limit per index**. Couldn't index. Migrated to 1536-dim via Gemini's `outputDimensionality` parameter. Lesson: **decide your embedding dim against your DB's index limits BEFORE you pick a model**. Ours: pgvector HNSW caps at 2000.

### Tag-JOIN ranking — abandoned

Original feed RPC used `SUM(video_tags.weight * user_interest_scores.score)` as the ranking signal. Looked clean. Didn't work in practice because:
- 3 tags per video × 5 top user tags = mostly zero overlap → most videos scored 0 → fell back to `published_at` ordering for everyone.
- Tag vocabulary drifted (`cold_emails` vs `cold_email` vs `cold_outreach`) and the join silently missed.

Embedding cosine doesn't have these problems. **Move to embeddings as soon as your catalog crosses ~500 items.**

### `OFFSET` with HNSW

Spent two days debugging "feed shows the same video twice on page 2." HNSW is approximate; `OFFSET 10` doesn't reliably skip the *same 10 rows* the previous call returned. **Always use exclude-ids or keyset pagination on approximate scans.**

### `SET LOCAL hnsw.ef_search` — landmine

Tried to widen the candidate pool with `SET LOCAL hnsw.ef_search = 100` inside the RPC. The GUC is only registered after pgvector's HNSW code runs once in the session — a `SET LOCAL` on an unregistered GUC **aborts the entire RPC**. Fix: wrap in `BEGIN ... PERFORM set_config('hnsw.ef_search', '100', true) ... EXCEPTION WHEN undefined_object`. We removed the SET entirely until needed.

### Filtered HNSW recall

Single big HNSW + `WHERE category = X` gave us empty result sets when category was a small fraction of the catalog. HNSW filters *after* the candidate scan, so the top-K candidates can all get filtered out. Partial indexes per category solved it.

### Plpgsql variables in `WHERE` against partial indexes

```sql
-- Plan time: planner can't prove p_feed_category matches the partial predicate
-- → seq scan, 200ms+ on a 5k row table.
WHERE feed_category = p_feed_category

-- Plan time: literal matches the partial WHERE clause → index hit, <5ms.
WHERE feed_category = 'forge'
```

We branch with `IF p_feed_category = 'forge' THEN <query with literal>` to keep the predicate literal.

### Vector serialization across the wire

Supabase JS serializes `vector` as text. Any character mismatch (extra space, wrong precision) silently writes garbage. **Pass IDs across the wire and `SELECT` the vector inside the RPC.** Never ship a 1536-float array as JS.

### Pgvector has no scalar multiplication

Already covered above. Worth saying twice. `array_fill(k::real, ARRAY[dim])::vector(dim)` is the workaround.

### Cookie chunking in Next.js

Supabase auth cookies get chunked (`sb-<ref>-auth-token.0`, `.1`) when JWT > ~3KB. Our resolver checks both formats. If you only check one, ~10% of sessions silently fail to authenticate.

### The pipeline `pipeline_jobs` orphan bug

Outer try/catch in `process-video/route.ts` returns 500 but doesn't update `pipeline_jobs.status`. Errors after the job row is created leave it stuck in `analyzing`/`generating_embedding` forever. Fix (not yet shipped): wrap in try/finally that marks orphans `failed`. Until then, a daily sweep query handles cleanup. Lesson: **any "job tracking" table needs a finally clause that marks the job terminal, even on uncaught exception.**

### Migration files are not proof of application

Stalled the pipeline for 20+ hours when `videos.thumbnail_url` was missing in production despite the migration file existing. The CI hadn't applied it. Lesson: **verify column existence via `information_schema.columns` in a healthcheck**, don't trust migration filenames as evidence the schema matches.

---

## 10. File index — where to find everything

### Schema
- `supabase/migrations/20260416_add_embedding_1536_and_taste_vectors.sql` — taste vectors + partial HNSW + EMA RPC
- `supabase/migrations/20260416_get_personalized_feed_vector.sql` — ranking RPC
- `supabase/migrations/20260416_match_videos_1536_personalized.sql` — search RPC
- `supabase/migrations/20260414_add_feed_category.sql` — feed bucket column
- `supabase/migrations/20260311_create_watch_history.sql` — ledger

### Server actions / routes
- `src/lib/viewer-identity.ts` — id resolution cascade
- `src/app/actions/interest-actions.ts` — `recordWatchProgress` (the main write path)
- `src/app/api/watch-progress/route.ts` — HTTP entry for watch updates
- `src/app/actions/video-actions.ts` — feed read path (calls `get_personalized_feed`)
- `src/app/actions/search-actions.ts` — search click logging + content-gap logging
- `src/app/api/search/route.ts` — search endpoint (calls `match_videos_1536`)
- `src/app/actions/recommendation-actions.ts` — in-memory next-up recommender
- `src/app/api/quiz/submit/route.ts` — quiz grading + skill matrix update

### Pipeline (content DNA generation)
- `src/lib/analysis-prompt.ts` — Gemini prompt + Zod schema (single source of truth)
- `src/app/api/pipeline/process-video/route.ts` — ingest pipeline (transcript → analyze → embed → insert)
- `src/lib/gemini.ts` — model wrappers + `generateEmbedding1536`
- `src/lib/pipeline-utils.ts` — job tracking, secret validation, RSS parsing

---

## 11. The minimum viable port

If you're starting from zero on a TikTok-style app and only want the algorithmic core, here's the minimum:

**Tables**
- `videos(id, embedding vector(1536), tags text[], category text, ...)`
- `user_taste_vectors(user_id pk, embedding vector(1536), watch_count int, updated_at)`
- `watch_events(user_id, video_id, watch_pct, created_at)` — append-only

**Indexes**
- One partial HNSW per category on `videos.embedding`

**RPCs**
- `upsert_user_taste_vector(user_id, video_id, weight)` — EMA blend, alpha 0.05–0.10 for short-form
- `get_feed(user_id, category, limit, exclude_ids)` — cosine ORDER BY, cold-start fallthrough at watch_count < 3

**Write path**
- One function called from one endpoint. Resolves identity via cascade. Writes taste vector + watch event. Negative signal on quick-skip.

**Identity**
- Persistent anon cookie minted on first write. Auth merge on signup copies the anon's vector.

**Content DNA**
- Structured-output LLM analysis on ingest. Embed `title + caption + tags`. 3 weighted tags + category.

That's it. Everything else (search, quizzes, super-fan stats, in-memory recommender, analytics_events) is value-add — bolt on as needed.

---

*Generated 2026-04-23. Verify against current code before lifting — repos drift.*
