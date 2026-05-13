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
        // re-enqueue if the creator is later flipped back to v1.
        await markJobErrored(jobId, `creator_is_v${retrievalVersion}_skip_legacy_worker`);
        captureMessage('embedding.legacy_worker_skipped_v2_creator', 'info', {
          op: 'embed_worker.v2_skip',
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
// Gemini 2.5 Flash:
//   * Input:  $0.30 / 1M
//   * Output: $2.50 / 1M
const FLASH_USD_PER_M_INPUT  = Number(process.env.FLASH_USD_PER_M_INPUT  || '0.30');
const FLASH_USD_PER_M_OUTPUT = Number(process.env.FLASH_USD_PER_M_OUTPUT || '2.50');

// Day-5-audit M4: Retry-After max wait, bumped 5s → 30s so we honor
// Anthropic's published backoff window before retrying.
const CONTEXTUAL_GEN_RETRY_AFTER_MAX_MS = 30_000;

/** token_count CHECK on sample_content_chunks is BETWEEN 1 AND 2048.
 *  CJK-heavy content can produce char/4 > 2048 (old audit M1). Clamp here. */
function clampTokenCount(text) {
  const est = Math.ceil((text?.length ?? 0) / CHARS_PER_TOKEN);
  return Math.min(2048, Math.max(1, est));
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
  // Day-5-audit M5: HTTPS-only. The Fly→Vercel hop goes over the public
  // internet; an http:// base URL leaks the bearer secret cleartext on
  // every chunk call. Reject at construction time so a typo'd env never
  // ships.
  if (!/^https:\/\//i.test(internalApiBaseUrl)) {
    throw new Error(
      `internalApiBaseUrl must use https://; got "${internalApiBaseUrl}". Bearer secret would leak cleartext over plain http on every fetch.`,
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

  async function markJobErrored(jobId, errorMsg) {
    try {
      await supabase
        .from('corpus_reprocess_jobs')
        .update({
          status: 'errored',
          last_error: String(errorMsg).slice(0, 2000),
          finished_at: new Date().toISOString(),
        })
        .eq('id', jobId);
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
      await supabase
        .from('corpus_reprocess_jobs')
        .update({
          status: nextStatus,
          attempts: newAttempts,
          last_error: String(errorMsg).slice(0, 2000),
          claimed_by: null,
          claimed_at: null,
        })
        .eq('id', jobId);
    } catch (e) {
      captureException(e, { op: 'reprocess_worker.bumpFailure', jobId });
    }
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

    const deadlineAt = Date.now() + REPROCESS_CLAIM_TIMEOUT_MS;
    const timeLeft = () => deadlineAt - Date.now();

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
            model: process.env.NARRATIVE_CHUNK_MODEL || 'gemini-2.5-flash',
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
      // (sample_id, unit_index) would conflict. DELETE here; CASCADE on
      // sample_content_chunks.parent_unit_id cleans v2 children too. Empty
      // on the happy first-run case (DELETE 0). One round-trip cost; saves
      // a 5-attempt-then-errored death spiral.
      const { error: cleanupErr } = await supabase
        .from('sample_content_narrative_units')
        .delete()
        .eq('sample_id', sampleId);
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
              p_chunk_index:     i,
              p_text:            child.text,
              p_chunk_context:   childChunkContexts[i],
              p_token_count:     tokenCount,
              p_topic_tags:      topicTags,
              p_embedding:       `[${vec.join(',')}]`,
              p_embedding_model: EMBEDDING_MODEL,
            },
          );
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

      // Atomic version-checked finish.
      const { data: doneId, error: finErr } = await supabase.rpc(
        'corpus_reprocess_mark_done',
        { p_job_id: jobId, p_claimed_version: claimedVersion },
      );
      if (finErr) {
        await bumpFailure(jobId, `mark_done_failed:${finErr.message}`);
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
