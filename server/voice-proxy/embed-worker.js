// embed-worker.js — pgvector RAG plan M-worker.
//
// In-process worker spawned by server/voice-proxy/index.js alongside
// makeVoiceDeleteWorker / makeSimliFaceDeleteWorker / makeFaceUploadReaper.
// Same Fly app, same env (R3 M5).
//
// Per tick (5s):
//   1. reap_stuck_embedding_jobs() — in-process backstop for the pg_cron
//      schedule that also runs once/min (R3 C3).
//   2. Atomic claim: UPDATE one row FROM jobs WHERE status='pending' AND
//      attempts<5, SET status='processing' + claimed_by + claimed_at.
//      Capture enqueue_version.
//   3. Read sample_content.raw_text + creator_id + topic_tags.
//   4. R3 M4 pre-spend peek: creator_embedding_budget_peek + char-count
//      estimate → skip the embed entirely if (current + estimated) > cap.
//   5. Chunk via src/lib/voice/chunk-sample.ts (loaded dynamically to keep
//      the worker file ESM-importable without a tsx transpile step at boot).
//      Actually we re-implement minimal chunker inline below to keep the
//      worker boot independent of TS/ESM transpile. The chunker is small
//      and the chunking logic is mirrored exactly.
//   6. embedTexts batched ≤100 chunks/call.
//   7. Post-spend creator_embedding_budget_accumulate_and_check (R2 C3 atomic).
//   8. finalize_embedding_job RPC (R2 C2 atomic version-checked finish).
//   9. cogs_log row (kill-switch attribution).

import { captureException, captureMessage } from './sentry.js';
import { GoogleGenAI } from '@google/genai';

const TICK_MS = 5_000;
const CLAIM_TIMEOUT_MS = 45_000; // under the 60s reaper threshold
const EMBED_BATCH_MAX = 100;

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
const EMBEDDING_DIM = 768;
const EMBEDDING_USD_PER_TOKEN = Number(
  process.env.EMBEDDING_USD_PER_TOKEN || '0.00000015',
);
// Default bumped 5 → 10 on 2026-05-13 alongside migration
// 20260515000004_creator_embedding_budget_cap_bump.sql (audit-3 C2 +
// audit-5 C1: migration alone has zero runtime effect because the worker
// passes p_cap_usd EXPLICITLY on every RPC call AND uses this env constant
// for its pre-spend peek arithmetic — both must move together). If you bump
// the migration default, bump this default in the same PR.
const CREATOR_EMBEDDING_DAILY_CAP_USD = Number(
  process.env.CREATOR_EMBEDDING_DAILY_CAP_USD || '10',
);
const CHARS_PER_TOKEN = 4;

// Mirrors src/lib/voice/chunk-sample.ts. Pure function so we duplicate
// rather than dynamic-import a TS file at runtime (worker is plain ESM).
// Lowered from 500/80 on 2026-05-12 — see src/lib/voice/chunk-sample.ts comment.
// MUST stay in sync with chunk-sample.ts since this is the runtime path.
const TARGET_TOKENS = 300;
const OVERLAP_TOKENS = 100;
const HARD_MAX_TOKENS = 2048;
const HARD_MAX_CHARS = 8000;

function estimateTokens(s) {
  return Math.max(1, Math.ceil(s.length / CHARS_PER_TOKEN));
}

function splitOnBoundaries(s) {
  const paragraphs = s.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
  const segments = [];
  for (const p of paragraphs) {
    if (estimateTokens(p) <= HARD_MAX_TOKENS) {
      segments.push(p);
      continue;
    }
    const sentences = p.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [p];
    for (const sent of sentences) {
      const trimmed = sent.trim();
      if (!trimmed) continue;
      if (estimateTokens(trimmed) > HARD_MAX_TOKENS) {
        for (let i = 0; i < trimmed.length; i += HARD_MAX_CHARS) {
          segments.push(trimmed.slice(i, i + HARD_MAX_CHARS));
        }
      } else {
        segments.push(trimmed);
      }
    }
  }
  return segments;
}

function packChunks(segments) {
  const chunks = [];
  let cur = '';
  let curTokens = 0;
  let tailBuffer = [];
  let tailTokens = 0;
  const flush = () => {
    if (cur.trim().length > 0) chunks.push(cur.trim().slice(0, HARD_MAX_CHARS));
    cur = tailBuffer.join(' ');
    curTokens = tailTokens;
    tailBuffer = [];
    tailTokens = 0;
  };
  for (const seg of segments) {
    const segTok = estimateTokens(seg);
    if (segTok > HARD_MAX_TOKENS) {
      if (cur.trim().length > 0) flush();
      chunks.push(seg.slice(0, HARD_MAX_CHARS));
      cur = '';
      curTokens = 0;
      tailBuffer = [];
      tailTokens = 0;
      continue;
    }
    if (curTokens + segTok > TARGET_TOKENS && curTokens > 0) flush();
    if (cur.length > 0) cur += ' ';
    cur += seg;
    curTokens += segTok;
    tailBuffer.push(seg);
    tailTokens += segTok;
    while (tailTokens > OVERLAP_TOKENS && tailBuffer.length > 1) {
      const dropped = tailBuffer.shift();
      tailTokens -= estimateTokens(dropped);
    }
  }
  if (cur.trim().length > 0) chunks.push(cur.trim().slice(0, HARD_MAX_CHARS));
  return chunks;
}

function chunkSample({ rawText, topicTags }) {
  if (!rawText || rawText.trim().length === 0) return [];
  const segments = splitOnBoundaries(rawText);
  const packed = packChunks(segments);
  return packed.map((text, index) => ({
    chunk_index: index,
    text,
    token_count: estimateTokens(text),
    topic_tags: [...topicTags],
  }));
}

// True if the text has at least one word character (letter or number). The
// single source of the v3 "is there anything to lose?" predicate — used by the
// rescue below AND mirrored by the per-section pre-screen in processV3Job.
export function hasWordContent(text) {
  return /[\p{L}\p{N}]/u.test(String(text ?? ''));
}

// v3 unit_index is now PER-GENERATION unique (UNIQUE(sample_id,
// section_generation, unit_index) — mig 20260531000002), so the stride is no
// longer load-bearing for cross-section collision avoidance the way it was
// pre-C2/C3: any monotonic counter within a generation would satisfy the
// constraint. processV3Job still encodes section position as secIdx*10000 +
// unitIdx (a stable, debuggable layout), so a section emitting ≥10000 units
// would still overrun into the next section's stride band — this cap stays the
// loud guard against that pathological case. Verbatim packing (≤6000 chars/unit,
// ≤32K-char sections) tops out at ~6; Flash emits ~5-30.
export const MAX_UNITS_PER_SECTION = 9999;

// AUDIT ROUND-1 C1 + ROUND-2 M3 — split a parent unit into child chunks, with a
// rescue so a non-empty unit can NEVER be silently dropped. chunkSample returns
// [] when its text collapses to whitespace after paragraph/sentence split (runs
// of punctuation, formatting artifacts) — the OLD `continue` there was a silent
// word-loss path masked by sibling units' chunks (creator_v3_ready checks chunks
// per SECTION, not per unit). Returns { children, rescued }:
//   • chunkSample produced ≥1 child            → { children, rescued:false }
//   • chunkSample empty BUT unit has a word char → { [rawTextAsOneChild], rescued:true }
//   • chunkSample empty AND no word content      → { [], rescued:false }  (nothing to lose)
// Pure + exported so the guarantee is unit-tested without booting the worker.
export function chunkUnitWithRescue(unitText, topicTags) {
  const children = chunkSample({ rawText: unitText, topicTags });
  if (children.length > 0) return { children, rescued: false };
  if (!hasWordContent(unitText)) return { children: [], rescued: false };
  const text = String(unitText).slice(0, HARD_MAX_CHARS);
  return {
    children: [{
      chunk_index: 0,
      text,
      token_count: estimateTokens(text),
      topic_tags: [...topicTags],
    }],
    rescued: true,
  };
}

// Format halfvec for pgvector text wire format: '[v1,v2,...]'.
function vecToPgText(v) {
  return '[' + v.join(',') + ']';
}

export function makeEmbedWorker({ supabase, geminiApiKey, flyMachineId } = {}) {
  if (!supabase) throw new Error('supabase required');
  if (!geminiApiKey) throw new Error('geminiApiKey required');
  const claimedBy = `${flyMachineId || 'local'}:${process.pid}`;

  let genai = null;
  function ai() {
    if (genai) return genai;
    genai = new GoogleGenAI({ apiKey: geminiApiKey });
    return genai;
  }

  async function markJobErrored(jobId, errorMsg) {
    try {
      await supabase
        .from('sample_content_embedding_jobs')
        .update({
          status: 'errored',
          last_error: String(errorMsg).slice(0, 1000),
          finished_at: new Date().toISOString(),
        })
        .eq('id', jobId);
    } catch (e) {
      captureException(e, { op: 'embed_worker.markJobErrored', jobId });
    }
  }

  async function bumpFailure(jobId, errorMsg) {
    try {
      // Read attempts, bump, set back to pending or errored at attempts >= 5.
      const { data: row } = await supabase
        .from('sample_content_embedding_jobs')
        .select('attempts')
        .eq('id', jobId)
        .maybeSingle();
      const newAttempts = (row?.attempts || 0) + 1;
      const nextStatus = newAttempts >= 5 ? 'errored' : 'pending';
      await supabase
        .from('sample_content_embedding_jobs')
        .update({
          status: nextStatus,
          attempts: newAttempts,
          last_error: String(errorMsg).slice(0, 1000),
          claimed_by: null,
          claimed_at: null,
        })
        .eq('id', jobId);
    } catch (e) {
      captureException(e, { op: 'embed_worker.bumpFailure', jobId });
    }
  }

  async function tick() {
    // In-process reaper (R3 C3 backstop for pg_cron).
    try {
      await supabase.rpc('reap_stuck_embedding_jobs');
    } catch (e) {
      // Non-fatal — pg_cron is the primary, this is the backstop.
      // eslint-disable-next-line no-console
      console.warn('[embed-worker] reap rpc failed:', e?.message || e);
    }

    // Atomic claim — single row per tick to keep blast radius bounded.
    //
    // NOTE: PostgREST in Supabase rejects ORDER BY combined with UPDATE+LIMIT
    // ("column does not exist" even for columns that exist). Surfaced 2026-05-12
    // during the first prod deploy of vector mode — Spikes never exercised the
    // worker (Spike #4 path 2 stub-INSERTed chunks). Followup: move to a
    // SECURITY DEFINER claim_pending_embedding_job RPC for server-side ordering.
    // For now we rely on PG natural row order, which is fine at this scale
    // (one job per 5s tick, reaper handles fairness for stuck rows).
    const nowIso = new Date().toISOString();
    const { data: claim, error: claimErr } = await supabase
      .from('sample_content_embedding_jobs')
      .update({
        status: 'processing',
        claimed_by: claimedBy,
        claimed_at: nowIso,
      })
      .eq('status', 'pending')
      .lt('attempts', 5)
      .limit(1)
      .select('id, sample_id, enqueue_version')
      .maybeSingle();
    if (claimErr) {
      captureException(claimErr, { op: 'embed_worker.claim' });
      return;
    }
    if (!claim) return; // no work

    const jobId = claim.id;
    const sampleId = claim.sample_id;
    const claimedVersion = claim.enqueue_version;

    // Per-job timeout: enforce CLAIM_TIMEOUT_MS via an explicit deadline.
    // If we blow past this we let the reaper handle it on the next pg_cron tick.
    const deadlineAt = Date.now() + CLAIM_TIMEOUT_MS;
    function timeLeft() { return deadlineAt - Date.now(); }

    try {
      // Read source.
      const { data: sample, error: sampleErr } = await supabase
        .from('sample_content')
        .select('raw_text, creator_id, topic_tags, fetch_status')
        .eq('id', sampleId)
        .single();
      if (sampleErr || !sample) {
        await markJobErrored(jobId, 'sample_not_found_or_unreadable');
        return;
      }
      if (sample.fetch_status === 'errored') {
        await markJobErrored(jobId, 'sample_fetch_status_errored');
        return;
      }
      if (!sample.raw_text || sample.raw_text.trim().length === 0) {
        await markJobErrored(jobId, 'sample_raw_text_empty');
        return;
      }

      // Day-5 integration-audit C2 fix — skip v2 creators.
      //
      // Closes the concurrent-INSERT race: if a creator has been flipped to
      // retrieval_version=2, their corpus is rebuilt by the reprocess worker
      // (corpus_reprocess_jobs queue, separate pipeline). This legacy worker
      // running v1 chunker on a v2 creator's sample would (a) waste Gemini
      // embedding spend on chunks the v2 read path will ignore, AND (b) risk
      // (sample_id, chunk_index) UNIQUE-constraint conflicts with the
      // concurrent reprocess worker writing v2 chunks for the same sample.
      // The routing trigger (mig 20260516000003) already prevents NEW v2
      // edits from landing here, but pre-existing pending rows from BEFORE
      // a v1→v2 admin flip can still be in the legacy queue. Bail on them.
      const { data: creator, error: creatorErr } = await supabase
        .from('creators')
        .select('retrieval_version')
        .eq('id', sample.creator_id)
        .maybeSingle();
      if (creatorErr) {
        // Defer to next tick — RLS / transient errors retry-eligible.
        await bumpFailure(jobId, `creator_lookup_failed:${creatorErr.message}`);
        return;
      }
      const retrievalVersion = Number(creator?.retrieval_version ?? 1);
      if (retrievalVersion !== 1) {
        // Don't run v1 work. Mark errored so admin can see + manually
        // re-enqueue if the creator is later flipped back to v1. The `!== 1`
        // guard skips ANY non-v1 creator (v2 AND v3 — round-5 audit M1: the
        // event name below was renamed from the v2-specific form to a
        // version-agnostic one so v3 skips don't mis-bucket in dashboards).
        await markJobErrored(jobId, `creator_is_v${retrievalVersion}_skip_legacy_worker`);
        captureMessage('embedding.legacy_worker_skipped_non_v1_creator', 'info', {
          op: 'embed_worker.non_v1_skip',
          creator_id: sample.creator_id,
          retrieval_version: retrievalVersion,
        });
        return;
      }

      // R3 M4 pre-spend peek. Skip embed if creator's daily budget is
      // visibly blown after accounting for THIS job's estimated tokens.
      const estTokens = Math.ceil(sample.raw_text.length / CHARS_PER_TOKEN);
      const estUsd = estTokens * EMBEDDING_USD_PER_TOKEN;
      const { data: peeked, error: peekErr } = await supabase.rpc(
        'creator_embedding_budget_peek',
        { p_creator_id: sample.creator_id },
      );
      if (peekErr) {
        await bumpFailure(jobId, `budget_peek_failed:${peekErr.message}`);
        return;
      }
      const currentSpend = Number(peeked || 0);
      if (currentSpend + estUsd > CREATOR_EMBEDDING_DAILY_CAP_USD) {
        await markJobErrored(jobId, 'creator_daily_budget_blown_preflight');
        captureMessage('embedding.creator_daily_budget_blown_preflight', 'warning', {
          op: 'embed_worker.budget_preflight',
          creator_id: sample.creator_id,
          current_spend_usd: currentSpend,
          estimated_usd: estUsd,
          cap_usd: CREATOR_EMBEDDING_DAILY_CAP_USD,
        });
        return;
      }

      // Chunk + embed.
      const chunks = chunkSample({
        rawText: sample.raw_text,
        topicTags: sample.topic_tags || [],
      });
      if (chunks.length === 0) {
        // No content to embed (e.g., raw_text was whitespace-only after split).
        // Mark done with zero chunks; next paste will re-enqueue.
        await supabase.rpc('finalize_embedding_job', {
          p_job_id: jobId,
          p_sample_id: sampleId,
          p_chunks: [],
          p_vectors: [],
          p_claimed_version: claimedVersion,
        });
        return;
      }

      // Batch embed. ≤100 chunks per Gemini call.
      const allVectors = [];
      let realTokens = 0;
      for (let start = 0; start < chunks.length; start += EMBED_BATCH_MAX) {
        if (timeLeft() < 0) {
          await bumpFailure(jobId, 'claim_timeout_during_embed');
          return;
        }
        const batch = chunks.slice(start, start + EMBED_BATCH_MAX);
        let resp;
        try {
          resp = await ai().models.embedContent({
            model: EMBEDDING_MODEL,
            contents: batch.map((c) => c.text),
            config: {
              outputDimensionality: EMBEDDING_DIM,
              taskType: 'RETRIEVAL_DOCUMENT',
            },
          });
        } catch (e) {
          await bumpFailure(jobId, `embed_api_error:${e?.message || e}`);
          captureException(e, { op: 'embed_worker.embedContent', jobId, batchSize: batch.length });
          return;
        }
        const embeds = Array.isArray(resp?.embeddings) ? resp.embeddings : [];
        if (embeds.length !== batch.length) {
          await bumpFailure(jobId, `embed_response_count_mismatch ${embeds.length}!=${batch.length}`);
          return;
        }
        for (const e of embeds) {
          const vals = e?.values || [];
          if (vals.length !== EMBEDDING_DIM) {
            await bumpFailure(jobId, `embed_dim_mismatch ${vals.length}!=${EMBEDDING_DIM}`);
            return;
          }
          allVectors.push(vals);
        }
        const batchTokens = resp?.metadata?.totalTokenCount ?? 0;
        if (batchTokens > 0) {
          realTokens += batchTokens;
        } else {
          realTokens += batch.reduce((s, c) => s + estimateTokens(c.text), 0);
        }
      }

      // Post-spend atomic accumulate (R2 C3). We've already paid; this
      // bounds future spend. If over cap, log warning but continue
      // writing chunks (they're useful; the cap stops the NEXT job).
      const realUsd = Number((realTokens * EMBEDDING_USD_PER_TOKEN).toFixed(6));
      const { data: budgetOk, error: budgetErr } = await supabase.rpc(
        'creator_embedding_budget_accumulate_and_check',
        {
          p_creator_id: sample.creator_id,
          p_add_usd: realUsd,
          p_cap_usd: CREATOR_EMBEDDING_DAILY_CAP_USD,
        },
      );
      if (budgetErr) {
        captureException(budgetErr, { op: 'embed_worker.budget_accumulate', jobId });
      } else if (budgetOk === false) {
        captureMessage('embedding.creator_daily_budget_exceeded_postspend', 'warning', {
          op: 'embed_worker.budget_postspend',
          creator_id: sample.creator_id,
          usd_this_batch: realUsd,
        });
      }

      // R2 C2 atomic finish — finalize_embedding_job version-checks the job
      // row and ROLLBACKs the entire chunk replacement if a concurrent
      // re-enqueue bumped enqueue_version mid-flight. Returns NULL on
      // version mismatch — silent abandon.
      const vectorsPg = allVectors.map(vecToPgText);
      const { data: finalized, error: finErr } = await supabase.rpc(
        'finalize_embedding_job',
        {
          p_job_id: jobId,
          p_sample_id: sampleId,
          p_chunks: chunks,
          p_vectors: vectorsPg,
          p_claimed_version: claimedVersion,
        },
      );
      if (finErr) {
        await bumpFailure(jobId, `finalize_failed:${finErr.message}`);
        captureException(finErr, { op: 'embed_worker.finalize', jobId });
        return;
      }
      if (!finalized) {
        // Version mismatch — concurrent re-enqueue. Worker will re-claim on
        // next tick. No error; reset to pending.
        await supabase
          .from('sample_content_embedding_jobs')
          .update({
            status: 'pending',
            claimed_by: null,
            claimed_at: null,
          })
          .eq('id', jobId);
        return;
      }

      // cogs_log for kill-switch attribution.
      try {
        await supabase.from('cogs_log').insert({
          user_id: null,
          session_id: null,
          service: 'gemini',
          operation: 'embedding',
          units: realTokens,
          unit_label: 'tokens',
          cost_usd: realUsd,
          metadata: {
            model: EMBEDDING_MODEL,
            creator_id: sample.creator_id,
            sample_id: sampleId,
            chunks: allVectors.length,
          },
        });
      } catch (e) {
        captureException(e, { op: 'embed_worker.cogs_log', jobId });
      }
    } catch (e) {
      captureException(e, { op: 'embed_worker.tick_outer', jobId });
      await bumpFailure(jobId, `unhandled:${e?.message || e}`);
    }
  }

  function install() {
    tick().catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[embed-worker] init tick failed', e);
      captureException(e, { op: 'embed_worker.init' });
    });
    const handle = setInterval(() => {
      tick().catch(() => {});
    }, TICK_MS);
    return { handle, tick };
  }

  return { install, tick };
}


// ─────────────────────────────────────────────────────────────────────────────
// makeCorpusReprocessWorker — Day 5 v2 reprocess pipeline.
//
// Polls corpus_reprocess_jobs (Day-2 queue) and runs the full v2 pipeline:
//   sanitize → narrative-chunk (Flash via Vercel route) → for each child chunk:
//   contextual-gen (Haiku via Vercel route) → batch-embed → _insert_chunk_v2_unsafe.
//
// Runs on the same Fly instance as makeEmbedWorker; both have their own
// setInterval. Different queues + UNIQUE (sample_id, target_version) on the
// reprocess queue means no cross-queue race per sample (closes integration-
// audit C2 along with the legacy worker's v2-skip above).
//
// Three Vercel routes called per sample:
//   1. POST /api/internal/preprocess        (once per sample)
//   2. POST /api/internal/narrative-chunk   (once per sample)
//   3. POST /api/internal/contextual-gen    (once per child chunk)
// All authed with INTERNAL_API_SECRET bearer.
// ─────────────────────────────────────────────────────────────────────────────

const REPROCESS_TICK_MS = 5_000;
const REPROCESS_CLAIM_TIMEOUT_MS = 540_000;  // 9 min — under 600s reaper TTL
const CONTEXTUAL_GEN_MAX_FAILURE_RATE = 0.5; // plan §8.2 — abort if >50% chunks lose context

// Day-5-audit C1+C2: pricing constants for cogs_log accounting. All in
// USD per 1M tokens; env-overridable so a vendor price change is a Fly
// secret bump, not a code change. Defaults track plan §13 cost model.
//
// Anthropic Haiku 4.5:
//   * Base input: $1.00 / 1M
//   * Output:     $5.00 / 1M
//   * 1h cache write: 2.00× base input = $2.00 / 1M
//   * 1h cache read:  0.10× base input = $0.10 / 1M
// (Source: https://docs.claude.com/en/about-claude/pricing as of 2026-05-17.)
const ANTHROPIC_USD_PER_M_INPUT_BASE      = Number(process.env.ANTHROPIC_USD_PER_M_INPUT_BASE      || '1.00');
const ANTHROPIC_USD_PER_M_INPUT_CACHE_1H  = Number(process.env.ANTHROPIC_USD_PER_M_INPUT_CACHE_1H  || '2.00');
const ANTHROPIC_USD_PER_M_INPUT_CACHE_RD  = Number(process.env.ANTHROPIC_USD_PER_M_INPUT_CACHE_RD  || '0.10');
const ANTHROPIC_USD_PER_M_OUTPUT          = Number(process.env.ANTHROPIC_USD_PER_M_OUTPUT          || '5.00');
// Gemini 3.1 Flash-Lite (pinned 2026-05-30 alongside NARRATIVE_CHUNK_MODEL;
// verified ai.google.dev/gemini-api/docs/pricing 2026-05-31). Moved together
// with the model string per CLAUDE.md "bump model + price in the same PR":
//   * Input:  $0.25 / 1M
//   * Output: $1.50 / 1M
// (was gemini-2.5-flash $0.30/$2.50 — retires 2026-10-16.)
const FLASH_USD_PER_M_INPUT  = Number(process.env.FLASH_USD_PER_M_INPUT  || '0.25');
const FLASH_USD_PER_M_OUTPUT = Number(process.env.FLASH_USD_PER_M_OUTPUT || '1.50');

// Day-5-audit M4: Retry-After max wait, bumped 5s → 30s so we honor
// Anthropic's published backoff window before retrying.
const CONTEXTUAL_GEN_RETRY_AFTER_MAX_MS = 30_000;

// v3 step 4d audit M2 — partial Flash cogs_log flush cadence. Every Nth
// section the worker writes a partial-spend cogs_log row + resets the
// accumulator, so a mid-book crash loses at most N section's worth of
// Flash spend instead of the whole book's. 25 ≈ ~$0.10 max loss at the
// per-section Flash rate.
const V3_FLASH_PARTIAL_FLUSH_EVERY = Number(process.env.V3_FLASH_PARTIAL_FLUSH_EVERY || '25');

/** token_count CHECK on sample_content_chunks is BETWEEN 1 AND 2048.
 *  CJK-heavy content can produce char/4 > 2048 (old audit M1). Clamp here. */
function clampTokenCount(text) {
  const est = Math.ceil((text?.length ?? 0) / CHARS_PER_TOKEN);
  return Math.min(2048, Math.max(1, est));
}

// ── M1 zombie-claim guard (Step-9 deferred audit M1) ─────────────────────────
// A corpus_reprocess worker that woke AFTER losing its claim (the reaper
// reassigned its stuck job to another worker) must not clobber the NEW owner's
// job row (stomp its claim / burn its `attempts`). The failure writers below
// scope their UPDATE on `claimed_by` and treat a 0-row result as "claim moved".
//
// Why `claimed_by`, not `enqueue_version`: reap_stuck_corpus_reprocess_jobs does
// NOT bump enqueue_version (only admin re-enqueue does), so an enqueue_version
// guard would MISS the exact reaper-driven zombie this exists to stop.
// claimed_by IS the worker's unique identity (`reprocess:${machine}:${pid}`).
//
// These are PURE seams so the decision logic is unit-tested without mocking the
// whole worker (embed-worker-claim-guard.test.js).

/** Append `.eq('claimed_by', claimedBy)` to a PostgREST update/select builder
 *  when claimedBy is set; otherwise return the builder untouched (legacy/test
 *  path). Falsy claimedBy is treated as "no guard" — we never scope on an empty
 *  owner string. */
export function applyClaimGuard(query, claimedBy) {
  return claimedBy ? query.eq('claimed_by', claimedBy) : query;
}

/** True iff a guarded write (claimedBy set) matched 0 rows — i.e. the claim
 *  moved to another worker between claim and write, so the caller should no-op +
 *  breadcrumb rather than treat it as success. `updatedRows` must be the array
 *  returned by `.select('id')`; a non-array (null/undefined from an error path)
 *  is NOT a claim-moved signal (the catch block owns errors). */
export function isClaimMoved(claimedBy, updatedRows) {
  return Boolean(claimedBy) && Array.isArray(updatedRows) && updatedRows.length === 0;
}

export function makeCorpusReprocessWorker({
  supabase,
  geminiApiKey,
  internalApiBaseUrl,
  internalApiSecret,
  flyMachineId,
} = {}) {
  if (!supabase) throw new Error('supabase required');
  if (!geminiApiKey) throw new Error('geminiApiKey required');
  if (!internalApiBaseUrl) throw new Error('internalApiBaseUrl required');
  if (!internalApiSecret) throw new Error('internalApiSecret required');
  if (internalApiSecret.length < 32) {
    throw new Error('internalApiSecret too short (>=32 chars required)');
  }
  // Day-5-audit M5: HTTPS-only for non-localhost. The Fly→Vercel hop goes
  // over the public internet; an http:// base URL leaks the bearer secret
  // cleartext on every chunk call. Reject at construction time so a typo'd
  // env never ships. Exception: http://localhost or 127.0.0.1 — bytes never
  // leave the dev machine, so cleartext is fine; production deploys never
  // set such a URL.
  const isHttpLocalhost = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(
    internalApiBaseUrl,
  );
  if (!/^https:\/\//i.test(internalApiBaseUrl) && !isHttpLocalhost) {
    throw new Error(
      `internalApiBaseUrl must use https:// (or http://localhost for dev); got "${internalApiBaseUrl}". Bearer secret would leak cleartext over plain http on every fetch.`,
    );
  }

  const claimedBy = `reprocess:${flyMachineId || 'local'}:${process.pid}`.slice(0, 128);

  // Day-5-unit-audit C1: shutdown drain flag. SIGTERM clears the worker's
  // setInterval but a mid-flight tick can be 9 minutes deep; the global
  // 5s SIGKILL backstop would kill it mid-INSERT and leave partial state.
  // This flag is set by index.js's signal handler BEFORE intervals are
  // cleared. The tick body checks at safe checkpoints (between LLM/RPC
  // awaits) and bails via bumpFailure → finally block flushes cogs_log
  // for the partial spend. Reaper requeues at the 600s TTL with
  // enqueue_version bumped (Day-5-audit C5), so the next-deploy worker
  // claims a fresh row.
  let shuttingDown = false;
  function signalShutdown() {
    shuttingDown = true;
  }

  let genai = null;
  function ai() {
    if (genai) return genai;
    genai = new GoogleGenAI({ apiKey: geminiApiKey });
    return genai;
  }

  /** POST to an /api/internal/* route. Returns parsed JSON.
   *  Throws an Error with `{ retryable }` shape on non-2xx. */
  async function postInternal(path, body) {
    const url = `${internalApiBaseUrl.replace(/\/+$/, '')}${path}`;
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${internalApiSecret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const err = new Error(`fetch_failed:${e?.message || e}`);
      err.retryable = true;
      throw err;
    }
    let json;
    try {
      json = await resp.json();
    } catch {
      const err = new Error(`non_json_response_${resp.status}`);
      err.retryable = resp.status >= 500;
      throw err;
    }
    if (!resp.ok) {
      const err = new Error(json?.error ?? `http_${resp.status}`);
      err.status = resp.status;
      err.retryable = json?.retryable === true;
      err.retryAfterMs = json?.retry_after_ms;
      err.requestId = json?.request_id;
      throw err;
    }
    return json;
  }

  // M1: claim-scoped failure writers. `claimedBy` is the closure identity (set
  // at line ~622). Both updates are scoped on claimed_by via applyClaimGuard +
  // `.select('id')` so a 0-row result (claim reassigned to another worker) is a
  // no-op + breadcrumb, never a clobber of the new owner. The worker uses the
  // SERVICE-ROLE supabase client, so `.select()` is RLS-unaffected and
  // data.length faithfully reflects matched-and-updated rows — do NOT swap this
  // closure to a JWT-bound client without revisiting (RLS would zero the count).
  async function markJobErrored(jobId, errorMsg) {
    try {
      const { data, error } = await applyClaimGuard(
        supabase
          .from('corpus_reprocess_jobs')
          .update({
            status: 'errored',
            last_error: String(errorMsg).slice(0, 2000),
            finished_at: new Date().toISOString(),
          })
          .eq('id', jobId),
        claimedBy,
      ).select('id');
      // CODE-audit M1: supabase-js RETURNS update errors (doesn't throw), so the
      // catch below won't see them — surface explicitly or a failed error-write
      // leaves the job stuck `processing` until the reaper. Distinct from the
      // claim-moved (0-row) path.
      if (error) {
        captureException(error, { op: 'reprocess_worker.markJobErrored.update', jobId });
      } else if (isClaimMoved(claimedBy, data)) {
        // claim no longer ours (reaper reassigned, OR finalize already finished
        // it) — either way no-op; we don't own the row.
        captureMessage('reprocess.claim_moved_noop', 'warning', {
          op: 'reprocess_worker.markJobErrored', job_id: jobId, claimed_by: claimedBy,
        });
      }
    } catch (e) {
      captureException(e, { op: 'reprocess_worker.markJobErrored', jobId });
    }
  }

  async function bumpFailure(jobId, errorMsg) {
    try {
      const { data: row } = await supabase
        .from('corpus_reprocess_jobs')
        .select('attempts')
        .eq('id', jobId)
        .maybeSingle();
      const newAttempts = (row?.attempts || 0) + 1;
      const nextStatus = newAttempts >= 5 ? 'errored' : 'pending';
      const { data } = await applyClaimGuard(
        supabase
          .from('corpus_reprocess_jobs')
          .update({
            status: nextStatus,
            attempts: newAttempts,
            last_error: String(errorMsg).slice(0, 2000),
            claimed_by: null,
            claimed_at: null,
          })
          .eq('id', jobId),
        claimedBy,
      ).select('id');
      if (isClaimMoved(claimedBy, data)) {
        captureMessage('reprocess.claim_moved_noop', 'warning', {
          op: 'reprocess_worker.bumpFailure', job_id: jobId, claimed_by: claimedBy,
        });
      }
    } catch (e) {
      captureException(e, { op: 'reprocess_worker.bumpFailure', jobId });
    }
  }

  // ── v3 per-section ingestion path (RAG v3 step 4d) ───────────────────────
  //
  // Parallel to the v2 path in tick(). The v3 worker:
  //   1. Preprocess (same as v2 — pure-text sanitization)
  //   2. SEGMENT via /api/internal/segment (NEW — fixes Wall A by bounding
  //      Flash input to one section per call)
  //   3. DELETE sample_content_sections (CASCADE removes units + chunks)
  //   4. For each section:
  //        a. /api/internal/narrative-chunk-section → {units, sectionTitle,
  //           sectionSummary}; apply " (part k/N)" suffix when this section
  //           is part of a sub-packed chapter (audit round-4 C4)
  //        b. Embed (sectionTitle + ' ' + sectionSummary) → summary_embedding
  //        c. INSERT sample_content_sections row
  //        d. For each unit: INSERT narrative_unit (with section_id),
  //           chunkSample → children, per-child contextual-gen passing
  //           SECTION TEXT as `doc` (audit round-4 C3 — per-section cache key
  //           via prompt-prefix), batch-embed, INSERT via
  //           _insert_chunk_v3_unsafe (server-derives sample/creator/section_index)
  //        e. After all children land: centroid = length-weighted mean of
  //           unit-normalized child embeddings (plan §11/M1) → UPDATE section
  //   5. corpus_reprocess_mark_done_v3 → corpus_reprocess_finalize_v3: atomic
  //      generation SWAP (active_section_generation = targetGen), v1-chunk
  //      delete, corpus_version bump, job done (Step-9 audit C2/C3).
  //
  // SCOPE GUARDS preserved from v2: deadline / shutdown checkpoints, per-creator
  // budget cap (pre-flight + per-section accumulate), Anthropic failure-rate
  // mid-loop short-circuit, bumpFailure on retryable error, markJobErrored on
  // terminal. Plus step 4d's NEW per-section assertion (plan §8 step 4d /
  // audit round-4 M7): a section that produced ZERO units bumps a Sentry
  // breadcrumb so creator_v3_ready (step 6) doesn't stay false-with-no-cause.

  async function processV3Job(claim, opts) {
    const { jobId, sampleId, creatorId, claimedVersion, deadlineAt, timeLeft } = opts;

    // V3 COGS accumulators — separate from v2's so the v2 path's flushers
    // don't double-count. Same shape; pipeline tag is 'corpus_reprocess_v3'.
    let v3FlashPromptTokens     = 0;
    let v3FlashCandidatesTokens = 0;
    let v3FlashTotalTokens      = 0;
    let v3TotalContextualGenFailures     = 0;
    let v3TotalChildChunks               = 0;
    let v3TotalEmbedTokens               = 0;
    let v3TotalSummaryEmbedTokens        = 0;   // audit M4 — split out so the
                                                // metadata's `chunks` field
                                                // doesn't conflate per-section
                                                // summary embeds with per-chunk
                                                // child embeds in analytics
                                                // reconciliation.
    let v3AnthropicUncachedInputTokens   = 0;
    let v3AnthropicCacheCreation1hTokens = 0;
    let v3AnthropicCacheReadInputTokens  = 0;
    let v3AnthropicOutputTokens          = 0;
    let v3SectionsProcessed              = 0;
    let v3SectionsZeroUnits              = 0;   // retained for telemetry parity
    let v3SectionsFallback               = 0;   // sections rescued via verbatim
                                                // fallback (Flash failed OR
                                                // summarized) — audit round-1 M7
    let v3SectionsSkippedEmpty           = 0;   // sections with zero word
                                                // content (nothing to lose) —
                                                // audit round-1 C2/C3
    let v3FlashCogsLogged                = false;
    let v3SpendCogsLogged                = false;

    // Partial flush: write a cogs_log row for the CURRENT accumulator
    // delta and RESET the accumulator (so the next call only emits the
    // new spend). v3FlashCogsLogged stays unset so the final
    // `finally`-time v3FlushFlash() still fires for the residual. Each
    // row carries `metadata.partial = true` so analytics can union them.
    async function v3FlushFlashPartial() {
      if (v3FlashTotalTokens === 0) return;
      const promptTok = v3FlashPromptTokens;
      const candTok   = v3FlashCandidatesTokens;
      const totTok    = v3FlashTotalTokens;
      // Reset BEFORE the supabase INSERT so an in-flight crash during
      // the INSERT doesn't double-count on the next partial.
      v3FlashPromptTokens     = 0;
      v3FlashCandidatesTokens = 0;
      v3FlashTotalTokens      = 0;
      try {
        const flashCostUsd = Number(
          (
            (promptTok * FLASH_USD_PER_M_INPUT  / 1_000_000) +
            (candTok   * FLASH_USD_PER_M_OUTPUT / 1_000_000)
          ).toFixed(6),
        );
        await supabase.from('cogs_log').insert({
          user_id: null,
          session_id: null,
          service: 'gemini',
          operation: 'narrative_chunk',
          units: totTok,
          unit_label: 'tokens',
          cost_usd: flashCostUsd,
          metadata: {
            model: process.env.NARRATIVE_CHUNK_MODEL || 'gemini-3.1-flash-lite',
            creator_id: creatorId,
            sample_id:  sampleId,
            prompt_tokens:      promptTok,
            candidates_tokens:  candTok,
            sections_processed: v3SectionsProcessed,
            pipeline: 'corpus_reprocess_v3',
            partial: true,
            flush_reason: 'periodic',
          },
        });
      } catch (e) {
        captureException(e, { op: 'reprocess_worker.v3.cogs_log_flash_partial', jobId });
      }
    }

    async function v3FlushFlash() {
      if (v3FlashCogsLogged) return;
      if (v3FlashTotalTokens === 0) return;
      v3FlashCogsLogged = true;
      try {
        const flashCostUsd = Number(
          (
            (v3FlashPromptTokens     * FLASH_USD_PER_M_INPUT  / 1_000_000) +
            (v3FlashCandidatesTokens * FLASH_USD_PER_M_OUTPUT / 1_000_000)
          ).toFixed(6),
        );
        await supabase.from('cogs_log').insert({
          user_id: null,
          session_id: null,
          service: 'gemini',
          operation: 'narrative_chunk',
          units: v3FlashTotalTokens,
          unit_label: 'tokens',
          cost_usd: flashCostUsd,
          metadata: {
            model: process.env.NARRATIVE_CHUNK_MODEL || 'gemini-3.1-flash-lite',
            creator_id: creatorId,
            sample_id: sampleId,
            prompt_tokens:      v3FlashPromptTokens,
            candidates_tokens:  v3FlashCandidatesTokens,
            sections_processed: v3SectionsProcessed,
            pipeline: 'corpus_reprocess_v3',
          },
        });
      } catch (e) {
        captureException(e, { op: 'reprocess_worker.v3.cogs_log_flash', jobId });
      }
    }

    async function v3FlushSpend(reason) {
      if (v3SpendCogsLogged) return;
      v3SpendCogsLogged = true;
      // Embedding row
      if (v3TotalEmbedTokens > 0) {
        try {
          const embedCostUsd = Number((v3TotalEmbedTokens * EMBEDDING_USD_PER_TOKEN).toFixed(6));
          await supabase.from('cogs_log').insert({
            user_id: null,
            session_id: null,
            service: 'gemini',
            operation: 'embedding',
            units: v3TotalEmbedTokens,
            unit_label: 'tokens',
            cost_usd: embedCostUsd,
            metadata: {
              model: EMBEDDING_MODEL,
              creator_id: creatorId,
              sample_id: sampleId,
              sections_processed:     v3SectionsProcessed,
              sections_zero_units:    v3SectionsZeroUnits,
              sections_fallback:      v3SectionsFallback,      // audit round-1 M7
              sections_skipped_empty: v3SectionsSkippedEmpty,  // audit round-1 M7
              chunks:                 v3TotalChildChunks,
              // Audit M4 — split the per-section summary embeds out so
              // analytics can reconcile `tokens / chunks ≈ avg chunk tokens`
              // without the summaries inflating the denominator.
              summary_embed_tokens:   v3TotalSummaryEmbedTokens,
              child_embed_tokens:     v3TotalEmbedTokens - v3TotalSummaryEmbedTokens,
              contextual_gen_failures: v3TotalContextualGenFailures,
              pipeline: 'corpus_reprocess_v3',
              flush_reason: reason,
            },
          });
        } catch (e) {
          captureException(e, { op: 'reprocess_worker.v3.cogs_log_embed', jobId });
        }
      }
      // Anthropic row
      const v3AnthropicTotal =
        v3AnthropicUncachedInputTokens +
        v3AnthropicCacheCreation1hTokens +
        v3AnthropicCacheReadInputTokens +
        v3AnthropicOutputTokens;
      if (v3AnthropicTotal > 0) {
        try {
          const anthropicInputUsd =
            (v3AnthropicUncachedInputTokens   * ANTHROPIC_USD_PER_M_INPUT_BASE      / 1_000_000) +
            (v3AnthropicCacheCreation1hTokens * ANTHROPIC_USD_PER_M_INPUT_CACHE_1H  / 1_000_000) +
            (v3AnthropicCacheReadInputTokens  * ANTHROPIC_USD_PER_M_INPUT_CACHE_RD  / 1_000_000);
          const anthropicOutputUsd =
            v3AnthropicOutputTokens * ANTHROPIC_USD_PER_M_OUTPUT / 1_000_000;
          const anthropicCostUsd = Number((anthropicInputUsd + anthropicOutputUsd).toFixed(6));
          await supabase.from('cogs_log').insert({
            user_id: null,
            session_id: null,
            service: 'anthropic',
            operation: 'contextual_gen',
            units: v3AnthropicTotal,
            unit_label: 'tokens',
            cost_usd: anthropicCostUsd,
            metadata: {
              model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
              creator_id: creatorId,
              sample_id: sampleId,
              uncached_input_tokens:    v3AnthropicUncachedInputTokens,
              cache_creation_1h_tokens: v3AnthropicCacheCreation1hTokens,
              cache_read_input_tokens:  v3AnthropicCacheReadInputTokens,
              output_tokens:            v3AnthropicOutputTokens,
              chunks_with_context:      v3TotalChildChunks - v3TotalContextualGenFailures,
              chunks_without_context:   v3TotalContextualGenFailures,
              pipeline: 'corpus_reprocess_v3',
              flush_reason: reason,
            },
          });
        } catch (e) {
          captureException(e, { op: 'reprocess_worker.v3.cogs_log_anthropic', jobId });
        }
      }
    }

    try {
      // Read sample. source_type added for v3 cue-mode dispatch (audit C2).
      const { data: sample, error: sampleErr } = await supabase
        .from('sample_content')
        .select('raw_text, title, topic_tags, fetch_status, source_type')
        .eq('id', sampleId)
        .single();
      if (sampleErr || !sample) { await markJobErrored(jobId, 'sample_not_found_or_unreadable'); return; }
      if (sample.fetch_status === 'errored') { await markJobErrored(jobId, 'sample_fetch_status_errored'); return; }
      if (!sample.raw_text || sample.raw_text.trim().length === 0) {
        await markJobErrored(jobId, 'sample_raw_text_empty'); return;
      }

      const topicTags = Array.isArray(sample.topic_tags) ? sample.topic_tags : [];
      if (topicTags.length === 0) {
        await markJobErrored(jobId, 'sample_topic_tags_empty'); return;
      }

      // Pre-spend budget peek (same shape as v2). Section-level ingest has
      // the SAME embed-token total as v2 (sum of all child chunks), so the
      // estimate is identical.
      const estTokens = Math.ceil(sample.raw_text.length / CHARS_PER_TOKEN);
      const estUsd = estTokens * EMBEDDING_USD_PER_TOKEN;
      const { data: peeked, error: peekErr } = await supabase.rpc(
        'creator_embedding_budget_peek',
        { p_creator_id: creatorId },
      );
      if (peekErr) { await bumpFailure(jobId, `v3_budget_peek_failed:${peekErr.message}`); return; }
      if (Number(peeked || 0) + estUsd > CREATOR_EMBEDDING_DAILY_CAP_USD) {
        await markJobErrored(jobId, 'creator_daily_budget_blown_preflight');
        captureMessage('reprocess.v3.creator_daily_budget_blown_preflight', 'warning', {
          op: 'reprocess_worker.v3.budget_preflight',
          creator_id: creatorId,
          current_spend_usd: Number(peeked || 0),
          estimated_usd: estUsd,
        });
        return;
      }

      // Step 1: preprocess.
      let preprocessed;
      try {
        preprocessed = await postInternal('/api/internal/preprocess', {
          creator_id: creatorId,
          raw_text:   sample.raw_text,
        });
      } catch (e) {
        if (e.retryable) await bumpFailure(jobId, `v3_preprocess_retryable:${e.message}`);
        else             await markJobErrored(jobId, `v3_preprocess_terminal:${e.message}`);
        return;
      }
      const sanitizedDoc = preprocessed.sanitized_text;
      if (timeLeft() < 0) { await bumpFailure(jobId, 'v3_claim_timeout_after_preprocess'); return; }
      if (shuttingDown)   { await bumpFailure(jobId, 'v3_shutdown_after_preprocess');     return; }

      // Step 2: SEGMENT (the Wall-A fix). Audit C2 — cue_mode MUST be wired
      // off sample.source_type or book/textbook ingest mis-segments on
      // prose-embedded timestamps ("at 12:45 PM he said…") and produces
      // 200+ junk sections instead of the ~40 true chapter cuts, shredding
      // routing precision at the moat layer. Per section-segment.ts:32-34
      // contract (round-4 M2):
      //   book_or_doc / mastermind_or_course → 'book'    (suppress timestamps)
      //   youtube / transcript                → 'transcript' (timestamps fire)
      //   anything else                       → 'auto'   (high-precision defaults)
      const st = sample.source_type;
      const cueMode =
        (st === 'book_or_doc' || st === 'mastermind_or_course') ? 'book'
        : (st === 'youtube' || st === 'transcript')              ? 'transcript'
        : 'auto';
      let segResp;
      try {
        segResp = await postInternal('/api/internal/segment', {
          creator_id:    creatorId,
          sample_id:     sampleId,
          sanitized_doc: sanitizedDoc,
          cue_mode:      cueMode,
        });
      } catch (e) {
        if (e.retryable) await bumpFailure(jobId, `v3_segment_retryable:${e.message}`);
        else             await markJobErrored(jobId, `v3_segment_terminal:${e.message}`);
        return;
      }
      const segments = Array.isArray(segResp.sections) ? segResp.sections : null;
      if (!segments || segments.length === 0) {
        await markJobErrored(jobId, 'v3_segment_empty');
        return;
      }

      // Audit round-4 C3 (fixed in step 4d) — sub-pack title suffix is
      // PRE-COMPUTED per secIdx so the (k, N) label is stable across
      // section skips (when narrative-chunk-section returns null for a
      // middle section, the surviving siblings still get 1/N, 2/N, … with
      // N = original group size, not "successful sibling count"). The
      // alternative (increment inside the loop body) would shift later
      // siblings' labels when an earlier one fails — breaks the
      // sections-table dedup promise and confuses the routing render.
      const cueGroupSize = new Map();          // cue → original count
      const cueOrderInGroup = new Map();       // cue → running counter while iterating segments
      const partLabelBySecIdx = new Array(segments.length).fill(null);
      for (const s of segments) {
        if (s.cue) cueGroupSize.set(s.cue, (cueGroupSize.get(s.cue) || 0) + 1);
      }
      for (let i = 0; i < segments.length; i++) {
        const cue = segments[i].cue;
        if (!cue) continue;
        const n = cueGroupSize.get(cue) || 1;
        if (n <= 1) continue;
        const k = (cueOrderInGroup.get(cue) || 0) + 1;
        cueOrderInGroup.set(cue, k);
        partLabelBySecIdx[i] = { k, n };
      }

      // Step 3: GENERATION-AWARE additive build (Step-9 audit C2/C3, plan REV 3).
      //
      // Re-ingest builds a NEW generation (active+1) ALONGSIDE the live active
      // generation, which stays fully readable the whole rebuild. finalize_v3
      // swaps sample_content.active_section_generation atomically at the end; a
      // deferred GC reclaims old generations later (keeping active + prior for
      // rollback). This replaces the OLD "delete all sections up front, rebuild
      // in place" — that blanked an already-live-v3 creator mid-rebuild.
      //
      // targetGen = active + 1. DEFAULT 1 means a never-before-v3 sample has
      // active=1, so its first v3 build is gen 2 (plan M-1) — gen 1's only rows
      // are v2-legacy (section_id NULL) which the v3 read path never sees.
      let targetGen;
      {
        const { data: sampleGenRow, error: genErr } = await supabase
          .from('sample_content')
          .select('active_section_generation')
          .eq('id', sampleId)
          .single();
        if (genErr || !sampleGenRow) {
          await bumpFailure(jobId, `v3_active_gen_lookup_failed:${genErr?.message || 'no_row'}`);
          return;
        }
        targetGen = Number(sampleGenRow.active_section_generation) + 1;
      }

      // Idempotent re-claim cleanup: delete ONLY this run's PARTIAL target
      // generation (a crashed/re-claimed prior attempt at the SAME targetGen) →
      // CASCADE wipes its units + chunks. The ACTIVE generation (and any older
      // ones) are UNTOUCHED — they keep serving reads. This is scoped to
      // targetGen, never a blanket sample-wide delete.
      const { error: cleanupErr } = await supabase
        .from('sample_content_sections')
        .delete()
        .eq('sample_id', sampleId)
        .eq('section_generation', targetGen);
      if (cleanupErr) {
        await markJobErrored(jobId, `v3_pre_insert_sections_cleanup_failed:${cleanupErr.message}`);
        return;
      }

      // unit_index is now per-generation (UNIQUE(sample_id, section_generation,
      // unit_index) — migration 20260531000002). It restarts at 0 for this
      // generation, so the old v3UnitBase watermark + int4-overflow guard are
      // GONE (Step-9 audit C4): no cross-generation collision is possible, and
      // the index never grows unbounded across re-ingests. v2-legacy units stay
      // at gen 1 and never collide with a gen ≥ 2 v3 build.

      // Step 4: per-section loop.
      for (let secIdx = 0; secIdx < segments.length; secIdx++) {
        const sec = segments[secIdx];

        if (timeLeft() < 0) {
          await bumpFailure(jobId, `v3_claim_timeout_during_section_${secIdx}`); return;
        }
        if (shuttingDown) {
          await bumpFailure(jobId, `v3_shutdown_inflight_section_${secIdx}`); return;
        }

        // Pre-screen empty sections (audit round-1 C2/C3). The segmenter emits
        // heading-only / whitespace sections HONESTLY (section-segment.ts:36-39
        // does not filter them). A section with ZERO word characters has
        // nothing to lose — skip it WITHOUT inserting a row and exclude it from
        // the backstop denominator. Predicate is "no letter or number" (NOT a
        // word-count threshold — a 4-word aphorism is real content and must be
        // ingested). This is the ONLY legitimate skip; every section with word
        // content is guaranteed a row below.
        if (!hasWordContent(sec.text)) {
          v3SectionsSkippedEmpty += 1;
          continue;
        }

        // 4a — narrative-chunk-section. The route NEVER returns units:null
        // (audit round-1): on Flash failure OR low coverage it substitutes
        // deterministic VERBATIM units built from sec.text, so no section's
        // words are ever silently dropped. `fallback`/`fallback_reason` are
        // telemetry only.
        let secResp;
        try {
          secResp = await postInternal('/api/internal/narrative-chunk-section', {
            creator_id:        creatorId,
            sample_id:         sampleId,
            section_index:     secIdx,
            sanitized_section: sec.text,
            sample_title:      sample.title || undefined,
            section_cue:       sec.cue ?? null,
          });
        } catch (e) {
          if (e.retryable) await bumpFailure(jobId, `v3_section_${secIdx}_retryable:${e.message}`);
          else             await markJobErrored(jobId, `v3_section_${secIdx}_terminal:${e.message}`);
          return;
        }
        const sectionUnits = Array.isArray(secResp.units) ? secResp.units : null;
        if (!sectionUnits || sectionUnits.length === 0) {
          // The route returns an empty array ONLY when verbatimUnitsFromSection
          // also found no word content — i.e. this section is genuinely empty.
          // Our pre-screen above should have caught it; reaching here means the
          // route and worker disagreed on emptiness. Treat as empty (no words
          // to lose), record it, and skip. NOT the old silent-loss `continue`:
          // a section WITH content can no longer reach this branch.
          v3SectionsSkippedEmpty += 1;
          captureMessage('reprocess.v3.section_empty_after_route', 'warning', {
            op: 'reprocess_worker.v3.section_empty_after_route',
            creator_id: creatorId,
            sample_id:  sampleId,
            section_index: secIdx,
          });
          continue;
        }
        // Track verbatim-fallback rate (audit round-1 M7 + Sentry brownout
        // alert). A spike means Flash is degrading — visible, not silent.
        if (secResp.fallback === true) {
          v3SectionsFallback += 1;
          captureMessage('reprocess.v3.section_verbatim_fallback', 'info', {
            op: 'reprocess_worker.v3.section_verbatim_fallback',
            creator_id: creatorId,
            sample_id:  sampleId,
            section_index: secIdx,
            reason: secResp.fallback_reason || 'unknown',
            coverage: secResp.coverage || null,
          });
        }
        // Audit round-2 M1 — unit_index stride is secIdx*10000; a section with
        // ≥10000 units would collide into the next section's index range and hit
        // the (sample_id, unit_index) UNIQUE. Can't happen via verbatim packing
        // or normal Flash output, but fail LOUD if it ever does rather than
        // 23505-loop on every re-claim.
        if (sectionUnits.length > MAX_UNITS_PER_SECTION) {
          await markJobErrored(
            jobId,
            `v3_section_${secIdx}_too_many_units_${sectionUnits.length}`,
          );
          return;
        }

        // Accumulate Flash usage. Audit M2 — flush PARTIAL Flash cogs_log
        // every PERIODIC_FLUSH_EVERY sections so a mid-book crash doesn't
        // evaporate the entire Flash spend from cogs_log (the kill-switch
        // under-counts; budget peek next tick can let the same creator
        // burn through cap). The flush uses a per-row metadata.partial=true
        // marker; the final flush in the `finally` writes the residual.
        const fu = secResp.usage || {};
        v3FlashPromptTokens     += Number(fu.prompt_token_count     || 0);
        v3FlashCandidatesTokens += Number(fu.candidates_token_count || 0);
        v3FlashTotalTokens      += Number(fu.total_token_count      || 0);
        if ((secIdx + 1) % V3_FLASH_PARTIAL_FLUSH_EVERY === 0) {
          await v3FlushFlashPartial();
        }

        // 4b — apply " (part k/N)" suffix from pre-computed map (audit C3 fix).
        // partLabelBySecIdx is stable regardless of skipped sections; null
        // for singleton-cue sections and cue-less paragraph-packed sections.
        let finalSectionTitle = String(secResp.section_title || '').slice(0, 200);
        const partLabel = partLabelBySecIdx[secIdx];
        if (partLabel) {
          const suffix = ` (part ${partLabel.k}/${partLabel.n})`;
          // Reserve room for suffix; sample_content_sections.title CHECK ≤ 200.
          if (finalSectionTitle.length + suffix.length > 200) {
            finalSectionTitle = finalSectionTitle.slice(0, 200 - suffix.length);
          }
          finalSectionTitle = `${finalSectionTitle}${suffix}`;
        }
        const finalSectionSummary = String(secResp.section_summary || '').slice(0, 2000);

        // 4c — embed (title + ' ' + summary) → summary_embedding.
        let summaryVec;
        try {
          const resp = await ai().models.embedContent({
            model: EMBEDDING_MODEL,
            contents: [`${finalSectionTitle} ${finalSectionSummary}`],
            config: {
              outputDimensionality: EMBEDDING_DIM,
              taskType: 'RETRIEVAL_DOCUMENT',
            },
          });
          const vals = resp?.embeddings?.[0]?.values || [];
          if (vals.length !== EMBEDDING_DIM) {
            await bumpFailure(jobId, `v3_section_${secIdx}_summary_embed_dim_mismatch_${vals.length}`);
            return;
          }
          summaryVec = vals;
          // Audit M4 — count summary embeds separately from child chunk embeds.
          // Both contribute to v3TotalEmbedTokens for the overall COGS row, but
          // v3TotalSummaryEmbedTokens lets the cogs_log metadata reconcile
          // exactly how many of those tokens were per-section summaries vs
          // per-chunk children.
          const summaryTokens = Number(
            resp?.metadata?.totalTokenCount
            ?? estimateTokens(`${finalSectionTitle} ${finalSectionSummary}`),
          );
          v3TotalSummaryEmbedTokens += summaryTokens;
          v3TotalEmbedTokens        += summaryTokens;
        } catch (e) {
          await bumpFailure(jobId, `v3_section_${secIdx}_summary_embed_failed:${e?.message || e}`);
          captureException(e, { op: 'reprocess_worker.v3.summary_embed', jobId });
          return;
        }

        // 4d — INSERT section row (summary_embedding populated; centroid still
        // NULL until children land).
        const { data: sectionRow, error: secInsErr } = await supabase
          .from('sample_content_sections')
          .insert({
            sample_id:        sampleId,
            creator_id:       creatorId,
            section_index:    secIdx,
            section_generation: targetGen,   // Step-9 C2/C3 generation tag
            title:            finalSectionTitle,
            summary:          finalSectionSummary,
            summary_embedding: `[${summaryVec.join(',')}]`,
            // Audit S2 — nullish coalescing so legitimate charStart=0 isn't
            // masked. (sec.charStart || 0) === 0 when the section is the
            // first in the doc, which is the COMMON case.
            char_start:       Number(sec.charStart ?? 0),
            char_end:         Number(sec.charEnd   ?? sec.charStart ?? 0),
            topic_tags:       topicTags,
          })
          .select('id')
          .single();
        if (secInsErr || !sectionRow) {
          await bumpFailure(jobId, `v3_section_${secIdx}_insert_failed:${secInsErr?.message || 'no_row'}`);
          return;
        }
        const sectionId = sectionRow.id;

        // 4e — per-unit loop within this section. chunk_index is SECTION-LOCAL
        // (C5 / R2-C4 partial UNIQUE). Reset to 0 at each new section.
        let sectionChunkIndex = 0;
        const childVectorsForCentroid = [];   // [{vec: number[], len: int}]

        for (let unitIdx = 0; unitIdx < sectionUnits.length; unitIdx++) {
          if (timeLeft() < 0) {
            await bumpFailure(jobId, `v3_claim_timeout_during_section_${secIdx}_unit_${unitIdx}`); return;
          }
          if (shuttingDown) {
            await bumpFailure(jobId, `v3_shutdown_inflight_section_${secIdx}_unit_${unitIdx}`); return;
          }

          const unit = sectionUnits[unitIdx];
          const unitTokens = clampTokenCount(unit.text);
          // unit_index is now PER-GENERATION unique (UNIQUE(sample_id,
          // section_generation, unit_index) — migration 20260531000002). A
          // section-aware counter secIdx*10000 + unitIdx is unique WITHIN this
          // generation, which is all the constraint requires now. No cross-gen
          // or v2 collision is possible (each generation has its own index
          // space; v2-legacy units live at gen 1). The old v3UnitBase watermark
          // + the Round-6 M1 v2-coupling invariant are GONE (Step-9 audit C4).
          const unitIndexInGen = secIdx * 10000 + unitIdx;
          const { data: unitRow, error: unitErr } = await supabase
            .from('sample_content_narrative_units')
            .insert({
              sample_id:   sampleId,
              creator_id:  creatorId,
              unit_index:  unitIndexInGen,
              section_generation: targetGen,   // Step-9 C2/C3 generation tag
              title:       String(unit.title || '').slice(0, 200),
              text:        String(unit.text  || '').slice(0, 8000),
              token_count: unitTokens,
              topic_tags:  topicTags,
              section_id:  sectionId,
            })
            .select('id')
            .single();
          if (unitErr || !unitRow) {
            await bumpFailure(jobId, `v3_unit_insert_failed_sec_${secIdx}_unit_${unitIdx}:${unitErr?.message || 'no_row'}`);
            return;
          }
          const parentUnitId = unitRow.id;

          // Split unit into child chunks, with the C1 rescue (chunkUnitWithRescue
          // — pure, unit-tested). A non-empty unit can NEVER be silently dropped:
          // if the chunker collapses it to [], we embed its raw text as one child.
          // Only a unit with ZERO word content (nothing to lose) yields [].
          const { children, rescued } = chunkUnitWithRescue(unit.text, topicTags);
          if (children.length === 0) continue;   // truly nothing to lose
          if (rescued) {
            captureMessage('reprocess.v3.unit_chunker_empty_rescued', 'warning', {
              op: 'reprocess_worker.v3.unit_chunker_empty_rescued',
              creator_id: creatorId,
              sample_id:  sampleId,
              section_index: secIdx,
              unit_index: unitIdx,
            });
          }

          // Per-child contextual-gen. CRITICAL v3 change vs v2: `doc` is the
          // SECTION TEXT, not the whole sample. This makes the 1h prompt
          // cache key per-section (audit round-4 C3 / plan §11/M3 — without
          // this the whole-sample-prefix exceeds cache TTL at book scale).
          const childChunkContexts = [];
          for (const child of children) {
            if (timeLeft() < 0) {
              await bumpFailure(jobId, `v3_claim_timeout_contextual_gen_sec_${secIdx}`); return;
            }
            try {
              const cg = await postInternal('/api/internal/contextual-gen', {
                creator_id:   creatorId,
                doc:          sec.text,   // <-- SECTION (not whole sample)
                chunk_text:   child.text,
                sample_title: sample.title || undefined,
              });
              childChunkContexts.push(cg.chunk_context || null);
              const u = cg.usage || {};
              v3AnthropicUncachedInputTokens   += Number(u.uncached_input_tokens          || 0);
              v3AnthropicCacheCreation1hTokens += Number(u.cache_creation_1h_input_tokens || 0);
              v3AnthropicCacheReadInputTokens  += Number(u.cache_read_input_tokens        || 0);
              v3AnthropicOutputTokens          += Number(u.output_tokens                  || 0);
            } catch (e) {
              v3TotalContextualGenFailures += 1;
              childChunkContexts.push(null);
              if (e?.retryAfterMs && e.retryAfterMs > 0) {
                await new Promise((r) => setTimeout(r, Math.min(e.retryAfterMs, CONTEXTUAL_GEN_RETRY_AFTER_MAX_MS)));
              }
            }
          }
          v3TotalChildChunks += children.length;

          // Mid-loop short-circuit on systemic Anthropic failure (≥10 chunks).
          if (
            v3TotalChildChunks >= 10 &&
            v3TotalContextualGenFailures / v3TotalChildChunks > CONTEXTUAL_GEN_MAX_FAILURE_RATE
          ) {
            await markJobErrored(
              jobId,
              `v3_contextual_gen_failure_rate_mid_loop_${v3TotalContextualGenFailures}_of_${v3TotalChildChunks}`,
            );
            return;
          }

          // Batch-embed (chunk_context + chunk_text) inputs.
          const embedInputs = children.map((c, i) => {
            const ctx = childChunkContexts[i];
            return ctx ? `${ctx}\n\n${c.text}` : c.text;
          });

          let vectors;
          try {
            const resp = await ai().models.embedContent({
              model: EMBEDDING_MODEL,
              contents: embedInputs,
              config: {
                outputDimensionality: EMBEDDING_DIM,
                taskType: 'RETRIEVAL_DOCUMENT',
              },
            });
            const embeds = Array.isArray(resp?.embeddings) ? resp.embeddings : [];
            if (embeds.length !== embedInputs.length) {
              await bumpFailure(jobId, `v3_embed_count_mismatch ${embeds.length}!=${embedInputs.length}`);
              return;
            }
            vectors = [];
            for (const e of embeds) {
              const vals = e?.values || [];
              if (vals.length !== EMBEDDING_DIM) {
                await bumpFailure(jobId, `v3_embed_dim_mismatch ${vals.length}!=${EMBEDDING_DIM}`);
                return;
              }
              vectors.push(vals);
            }
            // Audit S1 — match v2's `batchTokens > 0 ?` ternary so a Gemini
            // response with `totalTokenCount === 0` correctly falls back to
            // the estimator instead of recording a $0 spend.
            const batchTokens = Number(resp?.metadata?.totalTokenCount ?? 0);
            const unitEmbedTokens = batchTokens > 0
              ? batchTokens
              : embedInputs.reduce((s, t) => s + estimateTokens(t), 0);
            v3TotalEmbedTokens += unitEmbedTokens;

            // Per-unit budget accumulate (mid-loop kill-switch).
            const unitEmbedUsd = Number((unitEmbedTokens * EMBEDDING_USD_PER_TOKEN).toFixed(6));
            const { data: budgetOk, error: budgetErr } = await supabase.rpc(
              'creator_embedding_budget_accumulate_and_check',
              {
                p_creator_id: creatorId,
                p_add_usd:    unitEmbedUsd,
                p_cap_usd:    CREATOR_EMBEDDING_DAILY_CAP_USD,
              },
            );
            if (budgetErr) {
              captureException(budgetErr, { op: 'reprocess_worker.v3.budget_accumulate', jobId });
            } else if (budgetOk === false) {
              captureMessage('reprocess.v3.creator_daily_budget_blown_postspend', 'warning', {
                op: 'reprocess_worker.v3.budget_postspend',
                creator_id: creatorId,
                usd_this_unit: unitEmbedUsd,
              });
              await markJobErrored(
                jobId,
                `v3_creator_daily_budget_blown_postspend_sec_${secIdx}_unit_${unitIdx}`,
              );
              return;
            }
          } catch (e) {
            await bumpFailure(jobId, `v3_embed_api_error:${e?.message || e}`);
            captureException(e, { op: 'reprocess_worker.v3.embedContent', jobId });
            return;
          }

          // INSERT children via _insert_chunk_v3_unsafe.
          for (let i = 0; i < children.length; i++) {
            const child = children[i];
            const vec = vectors[i];
            const tokenCount = clampTokenCount(child.text);
            const { error: insErr } = await supabase.rpc(
              '_insert_chunk_v3_unsafe',
              {
                p_parent_unit_id:  parentUnitId,
                p_section_id:     sectionId,
                p_chunk_index:    sectionChunkIndex,
                p_text:           child.text,
                p_chunk_context:  childChunkContexts[i],
                p_token_count:    tokenCount,
                p_topic_tags:     topicTags,
                p_embedding:      `[${vec.join(',')}]`,
                p_embedding_model: EMBEDDING_MODEL,
              },
            );
            sectionChunkIndex++;
            if (insErr) {
              await bumpFailure(jobId, `v3_chunk_insert_failed:${insErr.message}`);
              captureException(insErr, { op: 'reprocess_worker.v3.insert_chunk_v3', jobId });
              return;
            }
            // Track for centroid (length-weighted unit-normalized mean).
            childVectorsForCentroid.push({ vec, len: tokenCount });
          }
        }

        // 4f — compute centroid + UPDATE section.centroid_embedding.
        // Plan §11/M1: normalize each child to unit norm BEFORE the mean,
        // then renormalize the result, then store. halfvec at 768d is
        // ~3-4 sig digits; gemini-embedding-001 at outputDimensionality=768
        // (Matryoshka) is not guaranteed unit-norm.
        if (childVectorsForCentroid.length === 0) {
          // Pathological — Flash returned units but every unit produced zero
          // children. Section row exists with NULL centroid; creator_v3_ready
          // will reject this creator. Captured for visibility.
          captureMessage('reprocess.v3.section_zero_children', 'warning', {
            op: 'reprocess_worker.v3.section_zero_children',
            creator_id: creatorId,
            sample_id:  sampleId,
            section_id: sectionId,
            section_index: secIdx,
          });
        } else {
          const centroid = computeCentroidV3(childVectorsForCentroid);
          const { error: centErr } = await supabase
            .from('sample_content_sections')
            .update({ centroid_embedding: `[${centroid.join(',')}]` })
            .eq('id', sectionId);
          if (centErr) {
            await bumpFailure(jobId, `v3_section_${secIdx}_centroid_update_failed:${centErr.message}`);
            return;
          }
        }

        v3SectionsProcessed += 1;
      }

      // Plan §8.2 — sample-level abort if too many chunks lost context.
      if (
        v3TotalChildChunks > 0 &&
        v3TotalContextualGenFailures / v3TotalChildChunks > CONTEXTUAL_GEN_MAX_FAILURE_RATE
      ) {
        await markJobErrored(
          jobId,
          `v3_contextual_gen_failure_rate_${v3TotalContextualGenFailures}_of_${v3TotalChildChunks}`,
        );
        return;
      }

      // AUDIT ROUND-1 C2/C3/M3 — sample-level "no section silently dropped"
      // backstop. Every segment must have been EITHER ingested as a section
      // row OR skipped as genuinely-empty. The route's never-null contract +
      // the loud per-section error returns above make this assertion
      // belt-and-suspenders (it should never fire), but if it ever does we
      // fail LOUD instead of finalizing a partial book. This runs on the
      // single success path (after the contextual-gen abort, before finalize)
      // and `return`s rather than throws, so the `finally` still flushes COGS
      // honestly. Denominator math uses the SAME skip the loop applied
      // (v3SectionsSkippedEmpty), never a recomputed predicate.
      if (v3SectionsProcessed + v3SectionsSkippedEmpty !== segments.length) {
        await markJobErrored(
          jobId,
          `v3_section_count_mismatch processed=${v3SectionsProcessed} skipped_empty=${v3SectionsSkippedEmpty} expected=${segments.length}`,
        );
        captureMessage('reprocess.v3.section_count_mismatch', 'error', {
          op: 'reprocess_worker.v3.section_count_mismatch',
          creator_id: creatorId,
          sample_id:  sampleId,
          processed: v3SectionsProcessed,
          skipped_empty: v3SectionsSkippedEmpty,
          fallback: v3SectionsFallback,
          expected: segments.length,
        });
        return;
      }

      // AUDIT ROUND-1 M4 — persist the expected/skipped section counts on the
      // sample so creator_v3_ready (the DB-side flip gate) can assert the
      // actual section-row count matches, independent of any worker-side
      // reasoning. Written BEFORE finalize: if this UPDATE fails we requeue
      // (do NOT finalize a sample whose gate-invariant columns are stale).
      {
        const { error: countErr } = await supabase
          .from('sample_content')
          .update({
            v3_expected_section_count: segments.length,
            v3_skipped_empty_count:    v3SectionsSkippedEmpty,
          })
          .eq('id', sampleId);
        if (countErr) {
          await bumpFailure(jobId, `v3_section_count_write_failed:${countErr.message}`);
          return;
        }
      }

      // Brownout alert (audit round-1 Small) — a high verbatim-fallback rate
      // for one sample means Flash is degrading broadly; surface it so a
      // demo-day model hiccup is visible, not a silently-churning queue.
      if (segments.length > 0 && v3SectionsFallback / segments.length > 0.25) {
        captureMessage('reprocess.v3.high_fallback_rate', 'warning', {
          op: 'reprocess_worker.v3.high_fallback_rate',
          creator_id: creatorId,
          sample_id:  sampleId,
          fallback: v3SectionsFallback,
          sections: segments.length,
        });
      }

      // Atomic version-checked finish + GENERATION SWAP (Step-9 audit C2/C3,
      // M-1). p_target_generation activates the generation we just built; the
      // expected/skipped counts written above describe it.
      const { data: doneId, error: finErr } = await supabase.rpc(
        'corpus_reprocess_mark_done_v3',
        { p_job_id: jobId, p_claimed_version: claimedVersion, p_target_generation: targetGen },
      );
      if (finErr) {
        const code = finErr?.code || '';
        const msg = finErr?.message || '';
        if (code === '55P03' || /lock_not_available/i.test(msg)) return;   // reaper requeues
        if (code === '02000' || /creator_disappeared/i.test(msg)) {
          await markJobErrored(jobId, 'creator_deleted_during_v3_finalize');
          return;
        }
        await bumpFailure(jobId, `v3_mark_done_failed:${msg}`);
        return;
      }
      if (!doneId) return;   // silent abandon — admin re-enqueued
    } catch (e) {
      captureException(e, { op: 'reprocess_worker.v3.tick_outer', jobId });
      await bumpFailure(jobId, `v3_unhandled:${e?.message || e}`);
    } finally {
      // Audit M3 — match v2's flush_reason string ('finally_drain') so prod
      // analytics dashboards filtering on this key surface both pipelines.
      await v3FlushFlash();
      await v3FlushSpend('finally_drain');
    }
  }

  // Length-weighted unit-normalized mean (plan §11/M1).
  // Each child vec is normalized to unit norm BEFORE the weighted mean;
  // the result is then renormalized. Zero-magnitude AND non-finite inputs
  // are skipped (audit M5 — a single all-NaN child would otherwise poison
  // every acc[i] to NaN, the renormalize step divides by NaN, the stored
  // centroid becomes a NaN-vector, HNSW accepts it, retrieval cosine = NaN
  // → section permanently invisible to routing).
  function computeCentroidV3(weighted) {
    const dim = EMBEDDING_DIM;
    const acc = new Array(dim).fill(0);
    let totalWeight = 0;
    outer: for (const { vec, len } of weighted) {
      let norm = 0;
      for (let i = 0; i < dim; i++) {
        const v = vec[i];
        if (!Number.isFinite(v)) continue outer;   // skip non-finite child entirely
        norm += v * v;
      }
      norm = Math.sqrt(norm);
      if (!Number.isFinite(norm) || norm === 0) continue;
      const w = Math.max(1, len);   // weight by token count (≥1)
      for (let i = 0; i < dim; i++) acc[i] += (vec[i] / norm) * w;
      totalWeight += w;
    }
    if (totalWeight === 0) {
      // Degenerate — all inputs filtered out. Return zero vector; caller's
      // sample_content_sections.centroid_embedding is NULLable so the
      // step-6 creator_v3_ready reject keeps the read path off it.
      return acc;
    }
    // Renormalize the weighted sum to unit norm.
    let resNorm = 0;
    for (let i = 0; i < dim; i++) resNorm += acc[i] * acc[i];
    resNorm = Math.sqrt(resNorm);
    if (!Number.isFinite(resNorm) || resNorm === 0) return acc;
    for (let i = 0; i < dim; i++) acc[i] = acc[i] / resNorm;
    return acc;
  }

  async function tick() {
    // In-process reaper backstop (audit-5 C2 pattern from corpus_reprocess_jobs.sql).
    try {
      await supabase.rpc('reap_stuck_corpus_reprocess_jobs');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[reprocess-worker] reap rpc failed:', e?.message || e);
    }

    // Day-5-unit-audit C1: refuse to claim new work during shutdown. Any
    // claim would burn at least one tick body before the drain checkpoint
    // could bail; cleaner to just exit immediately.
    if (shuttingDown) return;

    // Atomic claim via RPC (Day-5 mig 20260516000002 — FOR UPDATE SKIP LOCKED).
    const { data: claimRows, error: claimErr } = await supabase.rpc(
      'claim_corpus_reprocess_job',
      { p_claimed_by: claimedBy },
    );
    if (claimErr) {
      captureException(claimErr, { op: 'reprocess_worker.claim' });
      return;
    }
    const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
    if (!claim || !claim.job_id) return;  // no work

    const jobId           = claim.job_id;
    const sampleId        = claim.sample_id;
    const creatorId       = claim.creator_id;
    const claimedVersion  = claim.enqueue_version;
    const targetVersion   = claim.target_version;   // step 4c R2-C2 added

    const deadlineAt = Date.now() + REPROCESS_CLAIM_TIMEOUT_MS;
    const timeLeft = () => deadlineAt - Date.now();

    // ── v3 dispatch (RAG v3 step 4d / plan §11 R2-C3) ──────────────────────
    // Per audit round-3 C5 / round-4 C5: a v3 session falling silently to
    // a v2 code path was THE catastrophic failure mode the plan exists to
    // prevent. Audit round-4-step-4d C4 strengthened the dispatch — STRICT
    // allow-list, fail-loud on anything unknown:
    //   • 3 → v3 worker branch (processV3Job)
    //   • 2 → v2 worker (the body below)
    //   • undefined → v2 fallback (the v2-only deploy window before
    //     migration 20260528000020 widens claim's RETURNS TABLE)
    //   • anything else → markJobErrored loud; the queue-infra CHECK
    //     accepts only IN (2, 3) so this branch shouldn't be reachable
    //     today, but a future migration that widens to 4 without updating
    //     the worker would otherwise silently run a v4 job under v2.
    if (targetVersion === 3) {
      await processV3Job(claim, { jobId, sampleId, creatorId, claimedVersion, deadlineAt, timeLeft });
      return;
    }
    if (targetVersion !== 2 && targetVersion !== undefined && targetVersion !== null) {
      // CODE-audit S4: the job was claimed earlier THIS tick, so claimed_by is
      // ours by construction here — markJobErrored's guard passes; this dispatch
      // path needs no extra ownership check.
      await markJobErrored(jobId, `unknown_target_version_${targetVersion}`);
      captureMessage('reprocess_worker.unknown_target_version', 'error', {
        op: 'reprocess_worker.dispatch',
        job_id: jobId,
        target_version: targetVersion,
      });
      return;
    }

    // Day-5-unit-audit C2+C3: accumulators MUST live outside the try block
    // so the finally clause can flush cogs_log on EVERY exit path (success,
    // bumpFailure-mid-loop, markJobErrored, unhandled throw, shutdown). The
    // previous design only emitted cogs_log on the success path, so any
    // mid-loop failure left already-paid Anthropic/Flash/Gemini spend
    // un-attributed — invisible to the CLAUDE.md kill-switch.
    let flashPromptTokens     = 0;
    let flashCandidatesTokens = 0;
    let flashTotalTokens      = 0;
    let totalContextualGenFailures     = 0;
    let totalChildChunks               = 0;
    let totalEmbedTokens               = 0;
    let totalEmbedUsdAccumulated       = 0;  // sum of per-unit budget RPC calls
    let anthropicUncachedInputTokens   = 0;
    let anthropicCacheCreation1hTokens = 0;
    let anthropicCacheReadInputTokens  = 0;
    let anthropicOutputTokens          = 0;
    // Idempotency flags — each cogs_log row writes AT MOST ONCE per tick.
    let flashCogsLogged     = false;
    let spendCogsLogged     = false;  // covers embed + anthropic rows

    // Helper: write Flash cogs_log immediately after narrative-chunk success.
    // One-shot, idempotent. Failure is non-fatal (captured to Sentry).
    async function flushFlashCogsLog() {
      if (flashCogsLogged) return;
      if (flashTotalTokens === 0) return;  // no tokens, no row
      flashCogsLogged = true;
      try {
        const flashCostUsd = Number(
          (
            (flashPromptTokens     * FLASH_USD_PER_M_INPUT  / 1_000_000) +
            (flashCandidatesTokens * FLASH_USD_PER_M_OUTPUT / 1_000_000)
          ).toFixed(6),
        );
        await supabase.from('cogs_log').insert({
          user_id: null,
          session_id: null,
          service: 'gemini',
          operation: 'narrative_chunk',
          units: flashTotalTokens,
          unit_label: 'tokens',
          cost_usd: flashCostUsd,
          metadata: {
            model: process.env.NARRATIVE_CHUNK_MODEL || 'gemini-3.1-flash-lite',
            creator_id: creatorId,
            sample_id: sampleId,
            prompt_tokens: flashPromptTokens,
            candidates_tokens: flashCandidatesTokens,
            pipeline: 'corpus_reprocess_v2',
          },
        });
      } catch (e) {
        captureException(e, { op: 'reprocess_worker.cogs_log_flash', jobId });
      }
    }

    // Helper: write Embed + Anthropic cogs_log rows. Idempotent via
    // spendCogsLogged flag. Called from the success path AND from the
    // finally block (which always fires regardless of failure path).
    // `reason` distinguishes success/failure paths in the metadata.
    async function flushSpendCogsLog(reason) {
      if (spendCogsLogged) return;
      spendCogsLogged = true;
      // Embed row
      if (totalEmbedTokens > 0) {
        try {
          // Compute cost from cumulative USD (per-unit budget RPC fed this).
          // Fall back to token-based estimate if accumulator didn't get
          // populated (legacy paths).
          const embedCostUsd = totalEmbedUsdAccumulated > 0
            ? Number(totalEmbedUsdAccumulated.toFixed(6))
            : Number((totalEmbedTokens * EMBEDDING_USD_PER_TOKEN).toFixed(6));
          await supabase.from('cogs_log').insert({
            user_id: null,
            session_id: null,
            service: 'gemini',
            operation: 'embedding',
            units: totalEmbedTokens,
            unit_label: 'tokens',
            cost_usd: embedCostUsd,
            metadata: {
              model: EMBEDDING_MODEL,
              creator_id: creatorId,
              sample_id: sampleId,
              chunks: totalChildChunks,
              contextual_gen_failures: totalContextualGenFailures,
              pipeline: 'corpus_reprocess_v2',
              flush_reason: reason,
            },
          });
        } catch (e) {
          captureException(e, { op: 'reprocess_worker.cogs_log_embed', jobId });
        }
      }
      // Anthropic row
      const anthropicTotal =
        anthropicUncachedInputTokens +
        anthropicCacheCreation1hTokens +
        anthropicCacheReadInputTokens +
        anthropicOutputTokens;
      if (anthropicTotal > 0) {
        try {
          const anthropicInputUsd =
            (anthropicUncachedInputTokens     * ANTHROPIC_USD_PER_M_INPUT_BASE      / 1_000_000) +
            (anthropicCacheCreation1hTokens   * ANTHROPIC_USD_PER_M_INPUT_CACHE_1H  / 1_000_000) +
            (anthropicCacheReadInputTokens    * ANTHROPIC_USD_PER_M_INPUT_CACHE_RD  / 1_000_000);
          const anthropicOutputUsd =
            anthropicOutputTokens * ANTHROPIC_USD_PER_M_OUTPUT / 1_000_000;
          const anthropicCostUsd = Number((anthropicInputUsd + anthropicOutputUsd).toFixed(6));
          await supabase.from('cogs_log').insert({
            user_id: null,
            session_id: null,
            service: 'anthropic',
            operation: 'contextual_gen',
            units: anthropicTotal,
            unit_label: 'tokens',
            cost_usd: anthropicCostUsd,
            metadata: {
              model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
              creator_id: creatorId,
              sample_id: sampleId,
              uncached_input_tokens:    anthropicUncachedInputTokens,
              cache_creation_1h_tokens: anthropicCacheCreation1hTokens,
              cache_read_input_tokens:  anthropicCacheReadInputTokens,
              output_tokens:            anthropicOutputTokens,
              chunks_with_context:      totalChildChunks - totalContextualGenFailures,
              chunks_without_context:   totalContextualGenFailures,
              pipeline: 'corpus_reprocess_v2',
              flush_reason: reason,
            },
          });
        } catch (e) {
          captureException(e, { op: 'reprocess_worker.cogs_log_anthropic', jobId });
        }
      }
    }

    try {
      // Read sample.
      const { data: sample, error: sampleErr } = await supabase
        .from('sample_content')
        .select('raw_text, title, topic_tags, fetch_status')
        .eq('id', sampleId)
        .single();
      if (sampleErr || !sample) {
        await markJobErrored(jobId, 'sample_not_found_or_unreadable');
        return;
      }
      if (sample.fetch_status === 'errored') {
        await markJobErrored(jobId, 'sample_fetch_status_errored');
        return;
      }
      if (!sample.raw_text || sample.raw_text.trim().length === 0) {
        await markJobErrored(jobId, 'sample_raw_text_empty');
        return;
      }

      // Pre-spend budget peek — same shape as legacy worker.
      const estTokens = Math.ceil(sample.raw_text.length / CHARS_PER_TOKEN);
      const estUsd = estTokens * EMBEDDING_USD_PER_TOKEN;
      const { data: peeked, error: peekErr } = await supabase.rpc(
        'creator_embedding_budget_peek',
        { p_creator_id: creatorId },
      );
      if (peekErr) {
        await bumpFailure(jobId, `budget_peek_failed:${peekErr.message}`);
        return;
      }
      if (Number(peeked || 0) + estUsd > CREATOR_EMBEDDING_DAILY_CAP_USD) {
        await markJobErrored(jobId, 'creator_daily_budget_blown_preflight');
        captureMessage('reprocess.creator_daily_budget_blown_preflight', 'warning', {
          op: 'reprocess_worker.budget_preflight',
          creator_id: creatorId,
          current_spend_usd: Number(peeked || 0),
          estimated_usd: estUsd,
        });
        return;
      }

      // ── Step 1: preprocess (canonical sanitized doc bytes) ───────────────
      let preprocessed;
      try {
        preprocessed = await postInternal('/api/internal/preprocess', {
          creator_id: creatorId,
          raw_text: sample.raw_text,
        });
      } catch (e) {
        if (e.retryable) {
          await bumpFailure(jobId, `preprocess_retryable:${e.message}`);
        } else {
          await markJobErrored(jobId, `preprocess_terminal:${e.message}`);
        }
        return;
      }
      const sanitizedDoc = preprocessed.sanitized_text;
      if (timeLeft() < 0) {
        await bumpFailure(jobId, 'claim_timeout_after_preprocess');
        return;
      }

      // ── Step 2: narrative-chunk (Flash → units) ──────────────────────────
      let chunkResp;
      try {
        chunkResp = await postInternal('/api/internal/narrative-chunk', {
          creator_id: creatorId,
          sanitized_doc: sanitizedDoc,
          sample_title: sample.title || undefined,
        });
      } catch (e) {
        if (e.retryable) {
          await bumpFailure(jobId, `narrative_chunk_retryable:${e.message}`);
        } else {
          await markJobErrored(jobId, `narrative_chunk_terminal:${e.message}`);
        }
        return;
      }
      const units = Array.isArray(chunkResp.units) ? chunkResp.units : null;
      if (!units || units.length === 0) {
        // Lib returned null → both attempts failed. Worker contract is "fall
        // back to v1 chunker", but on the reprocess pipeline there is no v1
        // path — mark errored. Admin can re-enqueue once the input quality
        // improves or the upstream model issue clears.
        await markJobErrored(jobId, 'narrative_chunk_fallback_to_v1');
        return;
      }

      // Day-5-unit-audit C2+C3: Flash usage → accumulator + IMMEDIATE
      // cogs_log emission. Writing here (right after the call succeeds)
      // means a downstream failure can't make the Flash spend disappear
      // from CLAUDE.md's kill-switch view.
      const flashUsage = chunkResp.usage || {};
      flashPromptTokens     = Number(flashUsage.prompt_token_count     || 0);
      flashCandidatesTokens = Number(flashUsage.candidates_token_count || 0);
      flashTotalTokens      = Number(flashUsage.total_token_count      || 0);
      await flushFlashCogsLog();

      // Day-5-unit-audit C1: shutdown checkpoint. Flash spend has been
      // logged; bail before paying for any Anthropic/Gemini work.
      if (shuttingDown) {
        await bumpFailure(jobId, 'shutdown_inflight_after_narrative_chunk');
        return;
      }

      // Day-5-audit C3: idempotent retries. If a previous attempt partially
      // INSERTed narrative_units before failing, the second claim's UNIQUE
      // would conflict. DELETE here; CASCADE on sample_content_chunks.
      // parent_unit_id cleans v2 children too.
      //
      // Step-9 audit M-6: scope to section_id IS NULL (v2-shape units ONLY).
      // The OLD blanket `.eq('sample_id')` delete wiped LIVE v3 units (CASCADE
      // their chunks) whenever a v2 reprocess ran against a sample that already
      // had v3 rows (e.g. a corpus edit on a v3 creator pre-purge) — blanking
      // the v3 read path. v3 units carry section_id NOT NULL; this filter
      // leaves them alone.
      const { error: cleanupErr } = await supabase
        .from('sample_content_narrative_units')
        .delete()
        .eq('sample_id', sampleId)
        .is('section_id', null);
      if (cleanupErr) {
        await bumpFailure(jobId, `pre_insert_cleanup_failed:${cleanupErr.message}`);
        return;
      }

      // Sample's topic_tags propagate to narrative_units AND child chunks.
      const topicTags = Array.isArray(sample.topic_tags) ? sample.topic_tags : [];
      if (topicTags.length === 0) {
        await markJobErrored(jobId, 'sample_topic_tags_empty');
        return;
      }

      // ── Step 3: per-unit insert + per-child contextual-gen + embed ──────
      //
      // For each parent narrative_unit:
      //   - INSERT into sample_content_narrative_units (service-role, bypass RLS)
      //   - Split unit.text into child chunks via chunkSample
      //   - For each child: contextual-gen (tolerant) + embed-input prep
      //   - Batch-embed all child inputs for this unit
      //   - INSERT each child via _insert_chunk_v2_unsafe RPC
      //
      // Pre-flight refusal of any unit aborts the whole sample. We do not
      // partial-commit — the corpus_reprocess_mark_done version-check is the
      // only commit point.

      // Accumulators (declared outside the outer try so the `finally`
      // block can flush them on any exit path — see flushSpendCogsLog).
      // Reset to zero here so each tick starts clean.
      totalContextualGenFailures     = 0;
      totalChildChunks               = 0;
      totalEmbedTokens               = 0;
      totalEmbedUsdAccumulated       = 0;
      anthropicUncachedInputTokens   = 0;
      anthropicCacheCreation1hTokens = 0;
      anthropicCacheReadInputTokens  = 0;
      anthropicOutputTokens          = 0;

      // chunk_index is unique per (sample_id, chunker_version) — must be a
      // sample-wide running counter across narrative units, NOT a per-unit
      // local index (would collide on the new 3-col UNIQUE added 2026-05-23).
      let sampleChunkIndex = 0;

      for (let unitIdx = 0; unitIdx < units.length; unitIdx++) {
        if (timeLeft() < 0) {
          await bumpFailure(jobId, 'claim_timeout_during_units');
          return;
        }
        // Day-5-unit-audit C1: per-unit shutdown checkpoint. Bail at the
        // unit boundary so the finally flushes whatever was paid so far.
        if (shuttingDown) {
          await bumpFailure(jobId, `shutdown_inflight_unit_${unitIdx}`);
          return;
        }
        const unit = units[unitIdx];

        // Insert parent narrative_unit (RLS bypassed via service-role on the
        // supabase client). topic_tags from sample; token_count clamped.
        const unitTokens = clampTokenCount(unit.text);
        const { data: unitRow, error: unitErr } = await supabase
          .from('sample_content_narrative_units')
          .insert({
            sample_id: sampleId,
            creator_id: creatorId,
            unit_index: unitIdx,
            title: String(unit.title || '').slice(0, 200),
            text:  String(unit.text  || '').slice(0, 8000),
            token_count: unitTokens,
            topic_tags: topicTags,
          })
          .select('id')
          .single();
        if (unitErr || !unitRow) {
          await bumpFailure(jobId, `narrative_unit_insert_failed:${unitErr?.message || 'no_row'}`);
          return;
        }
        const parentUnitId = unitRow.id;

        // Split unit text into child chunks (re-use the existing chunker —
        // smaller-target chunking is a future tuning concern).
        const children = chunkSample({
          rawText: unit.text,
          topicTags: topicTags,
        });
        if (children.length === 0) continue;

        // Per-child contextual-gen. Tolerant: on retryable HTTP failure or
        // retryable:true error body we store chunk_context=null and continue
        // (plan §8.2). >50% failure rate aborts the sample.
        const childChunkContexts = [];
        for (const child of children) {
          if (timeLeft() < 0) {
            await bumpFailure(jobId, 'claim_timeout_during_contextual_gen');
            return;
          }
          try {
            const cg = await postInternal('/api/internal/contextual-gen', {
              creator_id: creatorId,
              doc: sanitizedDoc,
              chunk_text: child.text,
              sample_title: sample.title || undefined,
            });
            childChunkContexts.push(cg.chunk_context || null);
            // Day-5-audit C1: accumulate Anthropic usage from the route's
            // response body for end-of-job cogs_log emission.
            const u = cg.usage || {};
            anthropicUncachedInputTokens   += Number(u.uncached_input_tokens          || 0);
            anthropicCacheCreation1hTokens += Number(u.cache_creation_1h_input_tokens || 0);
            anthropicCacheReadInputTokens  += Number(u.cache_read_input_tokens        || 0);
            anthropicOutputTokens          += Number(u.output_tokens                  || 0);
          } catch (e) {
            totalContextualGenFailures += 1;
            childChunkContexts.push(null);
            if (e?.retryAfterMs && e.retryAfterMs > 0) {
              // Day-5-audit M4: honor Anthropic's Retry-After up to 30s
              // (was 5s — that hammered the API right back into 429).
              await new Promise((r) => setTimeout(r, Math.min(e.retryAfterMs, CONTEXTUAL_GEN_RETRY_AFTER_MAX_MS)));
            }
          }
        }
        totalChildChunks += children.length;

        // Day-5-audit M3: mid-loop short-circuit on systemic failure.
        // Saves embedding spend + downstream Supabase INSERTs when Anthropic
        // is down. Requires ≥10 chunks before tripping to avoid bailing on
        // an early run of 2/2 failures.
        if (
          totalChildChunks >= 10 &&
          totalContextualGenFailures / totalChildChunks > CONTEXTUAL_GEN_MAX_FAILURE_RATE
        ) {
          await markJobErrored(
            jobId,
            `contextual_gen_failure_rate_mid_loop_${totalContextualGenFailures}_of_${totalChildChunks}`,
          );
          return;
        }

        // Batch-embed (chunk_context + chunk_text) inputs.
        const embedInputs = children.map((c, i) => {
          const ctx = childChunkContexts[i];
          return ctx ? `${ctx}\n\n${c.text}` : c.text;
        });

        let vectors;
        try {
          // Single batch per unit (units are 100-800 tokens typically;
          // each unit has 1-5 child chunks → well under EMBED_BATCH_MAX).
          const resp = await ai().models.embedContent({
            model: EMBEDDING_MODEL,
            contents: embedInputs,
            config: {
              outputDimensionality: EMBEDDING_DIM,
              taskType: 'RETRIEVAL_DOCUMENT',
            },
          });
          const embeds = Array.isArray(resp?.embeddings) ? resp.embeddings : [];
          if (embeds.length !== embedInputs.length) {
            await bumpFailure(jobId, `embed_count_mismatch ${embeds.length}!=${embedInputs.length}`);
            return;
          }
          vectors = [];
          for (const e of embeds) {
            const vals = e?.values || [];
            if (vals.length !== EMBEDDING_DIM) {
              await bumpFailure(jobId, `embed_dim_mismatch ${vals.length}!=${EMBEDDING_DIM}`);
              return;
            }
            vectors.push(vals);
          }
          const batchTokens = resp?.metadata?.totalTokenCount ?? 0;
          const unitEmbedTokens = batchTokens > 0
            ? batchTokens
            : embedInputs.reduce((s, t) => s + estimateTokens(t), 0);
          totalEmbedTokens += unitEmbedTokens;

          // Day-5-unit-audit C2: per-unit budget accumulate. Was at
          // end-of-job; moved here so the kill-switch trips MID-LOOP if a
          // creator exceeds their daily cap rather than after we've burned
          // through the rest of the units' Gemini spend.
          const unitEmbedUsd = Number((unitEmbedTokens * EMBEDDING_USD_PER_TOKEN).toFixed(6));
          totalEmbedUsdAccumulated += unitEmbedUsd;
          const { data: budgetOk, error: budgetErr } = await supabase.rpc(
            'creator_embedding_budget_accumulate_and_check',
            {
              p_creator_id: creatorId,
              p_add_usd: unitEmbedUsd,
              p_cap_usd: CREATOR_EMBEDDING_DAILY_CAP_USD,
            },
          );
          if (budgetErr) {
            captureException(budgetErr, { op: 'reprocess_worker.budget_accumulate_per_unit', jobId });
          } else if (budgetOk === false) {
            captureMessage('reprocess.creator_daily_budget_blown_postspend', 'warning', {
              op: 'reprocess_worker.budget_postspend',
              creator_id: creatorId,
              usd_this_unit: unitEmbedUsd,
            });
            // We've spent past the cap on this unit. Bail BEFORE the chunk
            // INSERT loop to bound additional spend. The finally block
            // flushes cogs_log so the over-cap spend is attributed.
            await markJobErrored(
              jobId,
              `creator_daily_budget_blown_postspend_unit_${unitIdx}`,
            );
            return;
          }
        } catch (e) {
          await bumpFailure(jobId, `embed_api_error:${e?.message || e}`);
          captureException(e, { op: 'reprocess_worker.embedContent', jobId });
          return;
        }

        // Insert each child via _insert_chunk_v2_unsafe (server-derives
        // sample_id + creator_id from the parent_unit row).
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          const vec = vectors[i];
          const tokenCount = clampTokenCount(child.text);
          const { error: insErr } = await supabase.rpc(
            '_insert_chunk_v2_unsafe',
            {
              p_parent_unit_id:  parentUnitId,
              p_chunk_index:     sampleChunkIndex,
              p_text:            child.text,
              p_chunk_context:   childChunkContexts[i],
              p_token_count:     tokenCount,
              p_topic_tags:      topicTags,
              p_embedding:       `[${vec.join(',')}]`,
              p_embedding_model: EMBEDDING_MODEL,
            },
          );
          sampleChunkIndex++;
          if (insErr) {
            await bumpFailure(jobId, `chunk_insert_failed:${insErr.message}`);
            captureException(insErr, { op: 'reprocess_worker.insert_chunk_v2', jobId });
            return;
          }
        }
      }

      // Plan §8.2 — abort the sample if too many chunks lost context.
      if (
        totalChildChunks > 0 &&
        totalContextualGenFailures / totalChildChunks > CONTEXTUAL_GEN_MAX_FAILURE_RATE
      ) {
        await markJobErrored(
          jobId,
          `contextual_gen_failure_rate_${totalContextualGenFailures}_of_${totalChildChunks}`,
        );
        return;
      }

      // Atomic version-checked finish (delegates to corpus_reprocess_finalize
      // since migration 20260528000001 — per-creator advisory lock + 5s
      // lock_timeout + DELETE chunker_version=1 + bump current_corpus_version).
      const { data: doneId, error: finErr } = await supabase.rpc(
        'corpus_reprocess_mark_done',
        { p_job_id: jobId, p_claimed_version: claimedVersion },
      );
      if (finErr) {
        // Step-1b audit M1/M2: distinguish the two errors mark_done can NOW
        // raise (via finalize) that the prior body never could, so we don't
        // burn 5 attempts → markJobErrored on transient/fatal-but-not-our-bug:
        //   55P03 lock_not_available — Day-7 admin_promote_v2_chunks holds the
        //     same advisory key beyond finalize's 5s lock_timeout. Transient;
        //     let the reaper requeue after 600s claim TTL. NO bumpFailure.
        //   02000 no_data_found — creator was DELETEd mid-finalize. CASCADE
        //     will reap the work; mark errored immediately, no retries.
        const code = finErr?.code || '';
        const msg = finErr?.message || '';
        if (code === '55P03' || /lock_not_available/i.test(msg)) {
          // cogs_log still flushed by `finally` — we paid for the embed work,
          // we attribute it; reaper picks the row back up.
          return;
        }
        if (code === '02000' || /creator_disappeared_during_finalize/i.test(msg)) {
          await markJobErrored(jobId, 'creator_deleted_during_finalize');
          return;
        }
        await bumpFailure(jobId, `mark_done_failed:${msg}`);
        return;
      }
      if (!doneId) {
        // Version mismatch — admin re-enqueued mid-flight. Silent abandon;
        // the new row will be re-claimed. cogs_log is still flushed by the
        // finally — we paid the tokens, we attribute the spend.
        return;
      }
    } catch (e) {
      captureException(e, { op: 'reprocess_worker.tick_outer', jobId });
      await bumpFailure(jobId, `unhandled:${e?.message || e}`);
    } finally {
      // Day-5-unit-audit C2+C3: ALWAYS flush spend cogs_log on EVERY exit
      // path — success, bumpFailure-mid-loop, markJobErrored, unhandled
      // throw, shutdown. Idempotency flags inside flushSpendCogsLog prevent
      // double-writes when the success path called this already (currently
      // it doesn't — finally is the single flush site). The flush_reason
      // metadata field distinguishes the path in cogs_log analytics.
      await flushSpendCogsLog('finally_drain');
    }
  }

  function install() {
    tick().catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[reprocess-worker] init tick failed', e);
      captureException(e, { op: 'reprocess_worker.init' });
    });
    const handle = setInterval(() => {
      tick().catch(() => {});
    }, REPROCESS_TICK_MS);
    return { handle, tick };
  }

  // signalShutdown exposed so index.js's SIGTERM handler can drain
  // gracefully (Day-5-unit-audit C1).
  return { install, tick, signalShutdown };
}
