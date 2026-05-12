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
const CREATOR_EMBEDDING_DAILY_CAP_USD = Number(
  process.env.CREATOR_EMBEDDING_DAILY_CAP_USD || '5',
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
