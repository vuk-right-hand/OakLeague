// semantic-cache.ts — wraps Day-8 MIG-3 RPCs for the retrieval cache.
//
// ARCHITECTURE CONTRACT (Day-9 audit C1, load-bearing):
//   Cache key is derived from the REWRITTEN query, NOT the raw user
//   utterance. Sequence in the orchestrator (Day 11):
//     1. rewrite(rawUtterance, lastAssistant) -> rewritten
//     2. embed(rewritten) -> vec
//     3. lookupCache(creatorId, corpusVersion, vec, threshold)
//        - hit  -> return cached parent_unit_ids (skip retrieval)
//        - miss -> step 4
//     4. retrieve(creatorId, vec, tsq) -> parents
//     5. upsertCache(creatorId, corpusVersion, vec, hash(rewritten),
//                    parentIds, scores)
//   Hashing the raw utterance instead would collide "tell me more" across
//   unrelated sessions and serve cross-context retrieval. Reviewing this
//   contract before any change.
//
// ═════════════════════════════════════════════════════════════════════
// LOAD-BEARING ORCHESTRATOR RULE — REWRITE-FALLBACK CACHE BYPASS
// (Day-8/9/10 cross-cutting audit C2)
// ═════════════════════════════════════════════════════════════════════
//   When `rewriteQuery()` from `./query-rewrite.ts` returns
//   `fallback: true`, its `rewritten` field equals the RAW utterance
//   (passthrough). If the Day-11 orchestrator then calls
//   `hashQueryText(rewritten)` and uses it as a cache key, every user's
//   "tell me more" under degraded rewrite hashes to the same key per
//   (creator_id, corpus_version) — the UNIQUE constraint serves the
//   FIRST session's parent_unit_ids to every subsequent matching session
//   until the next successful rewrite. Cross-session retrieval leak.
//
//   The orchestrator MUST:
//     - SKIP `lookupCache` when `rewriteResult.fallback === true`
//     - SKIP `upsertCache` when `rewriteResult.fallback === true`
//     - Fall back to fresh retrieval (no cache touch) for that turn
//
//   This rule lives here because semantic-cache.ts cannot enforce it
//   internally — it doesn't see the rewrite result. The Day-11
//   orchestrator owns the gate. Cross-linked in `query-rewrite.ts`
//   header so any future contributor sees the rule from either entry
//   point.
// ═════════════════════════════════════════════════════════════════════
//
// STALE-CORPUS DRIFT TELEMETRY (Day-8/9/10 cross-cutting audit C1):
//   `upsertCache` returns `reason: 'stale_corpus'` when the RPC's FOR
//   SHARE check against `creators.current_corpus_version` rejects the
//   write (TOCTOU window between session-open snapshot and finalize
//   bump). Today both "session was always stale" and "finalize just
//   raced us" map to the same reason — operationally invisible.
//
//   The Day-11 orchestrator SHOULD, on receiving `stale_corpus`:
//     1. SELECT current_corpus_version FROM creators WHERE id = ...
//        (one extra query; rare path).
//     2. Compare to the session-captured value.
//     3. Emit PostHog `rag_session_corpus_drift` with both values so
//        ops can distinguish "session was opened pre-finalize" (one-off,
//        fine) from "finalize is racing us per-turn" (alert-worthy).
//
// All RPC calls require a service-role Supabase client — RLS is deny-all.
// Errors don't throw; cache writes/reads return typed Result so the
// caller decides whether to fire-and-forget or surface (CLAUDE.md
// "don't silently catch" — the *caller* decides what to swallow).
//
// COGS_LOG CONTRACT (cross-cutting unit audit S3):
//   This module makes NO paid-API calls — both lookup and upsert are
//   pure Postgres operations behind RPCs. CLAUDE.md's "every paid API
//   call writes cogs_log" does NOT apply here. Cogs_log entries for the
//   surrounding turn (embed, rewrite, rerank) are the responsibility of
//   their respective modules' callers.
//
// BUDGET ALLOCATION (cross-cutting unit audit M7):
//   This module is sub-50ms when healthy (single HNSW lookup or single
//   INSERT/UPDATE). It does NOT accept a `deadlineMs` parameter — DB
//   queries either complete within their statement_timeout or surface
//   as `db_error`. The orchestrator's per-turn budget is consumed by
//   the rewrite + rerank + embed steps, not by cache hits.

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { vectorToPgText, HALFVEC_DIM, VectorEncodingError } from './halfvec';

export const CACHE_DEFAULT_THRESHOLD = 0.92;
export const CACHE_DEFAULT_TTL_SECONDS = 604800; // 7 days; DB clamps to [60, 30d]
export const CACHE_MAX_PARENT_IDS = 50; // matches DB CHECK

export type CacheLookupHit = {
  parentUnitIds: string[];
  scores: number[];
  ageSeconds: number;
  cachedRowId: string;
};

export type CacheUpsertResult =
  | { ok: true; rowId: string }
  | {
      ok: false;
      reason:
        | 'malformed_input'
        | 'array_too_long'
        | 'array_length_mismatch'
        | 'empty_arrays'
        | 'invalid_creator_id'
        | 'stale_corpus' // RPC returned NULL after our pre-flight passed
        | 'vector_encoding_failed' // halfvec.ts threw; non-finite element in queryVec
        | 'db_error';
      detail?: string;
    };

/**
 * Deterministic hash for the REWRITTEN query text, encoded as a PostgREST-
 * compatible bytea literal. The query text is normalized (trim + lowercase
 * + collapse whitespace) before hashing so trivial paraphrase variants
 * ("Tell me MORE  about it" vs "tell me more about it") share a cache row.
 *
 * Returns `\x`-hex string, NOT a Node Buffer. supabase-js sends RPC args
 * as JSON, and a Buffer serializes as `{"type":"Buffer","data":[...]}` —
 * PostgREST refuses to bind that as bytea. The `\x` prefix is the
 * Postgres standard bytea text representation; PostgREST parses it
 * server-side to the correct 32-byte value. Day-9-final audit M7.
 *
 * Normalization is internal to this module — if any other module wants
 * to share a cache key, it must use the same normalization. Document
 * the rule here, don't re-implement.
 */
export function hashQueryText(rewrittenText: string): string {
  const normalized = String(rewrittenText ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const hex = createHash('sha256').update(normalized, 'utf8').digest('hex');
  return '\\x' + hex;
}

export type LookupCacheInput = {
  client: SupabaseClient;
  creatorId: string;
  corpusVersion: number;
  queryVec: readonly number[];
  threshold?: number;
};

/**
 * Look up the closest cached entry. Returns null on miss, throws on a
 * non-miss DB error (so the caller can decide fail-open vs surface).
 */
export async function lookupCache(input: LookupCacheInput): Promise<CacheLookupHit | null> {
  // Day-9-final audit M6: warn on caller-bug inputs so a malformed call
  // doesn't masquerade as a healthy cache miss. We still return null
  // (don't break the orchestrator) but the log makes the misuse visible.
  if (!input.creatorId) {
    // eslint-disable-next-line no-console
    console.warn('[semantic-cache] lookupCache called with empty creatorId');
    return null;
  }
  if (!Number.isInteger(input.corpusVersion) || input.corpusVersion < 1) {
    // eslint-disable-next-line no-console
    console.warn(
      `[semantic-cache] lookupCache invalid corpusVersion=${input.corpusVersion}`,
    );
    return null;
  }
  if (!Array.isArray(input.queryVec) || input.queryVec.length !== HALFVEC_DIM) {
    // eslint-disable-next-line no-console
    console.warn(
      `[semantic-cache] lookupCache wrong queryVec dim=${input.queryVec?.length} (expected ${HALFVEC_DIM})`,
    );
    return null;
  }

  const threshold = clamp01(input.threshold ?? CACHE_DEFAULT_THRESHOLD);

  // Day-8/9/10 cross-cutting audit C3: vectorToPgText throws on
  // non-finite values. semantic-cache promises "never throw" — catch
  // and fail-open as cache miss so the orchestrator falls through to
  // fresh retrieval instead of crashing the turn.
  let pgVec: string;
  try {
    pgVec = vectorToPgText(input.queryVec);
  } catch (e) {
    if (e instanceof VectorEncodingError) {
      // eslint-disable-next-line no-console
      console.warn(`[semantic-cache] lookupCache vector_encoding_failed: ${e.message}`);
      return null;
    }
    throw e;
  }

  const { data, error } = await input.client.rpc('semantic_query_cache_lookup', {
    p_creator_id: input.creatorId,
    p_corpus_version: input.corpusVersion,
    p_query_vec: pgVec,
    p_threshold: threshold,
  });

  if (error) {
    throw new SemanticCacheError('lookup_failed', error.message);
  }

  // RPC returns SETOF; supabase-js wraps in an array. Miss = zero rows.
  if (!Array.isArray(data) || data.length === 0) return null;

  const row = data[0] as {
    parent_unit_ids: string[];
    scores: number[];
    age_seconds: number;
    cached_row_id: string;
  };
  return {
    parentUnitIds: row.parent_unit_ids,
    scores: row.scores,
    ageSeconds: row.age_seconds,
    cachedRowId: row.cached_row_id,
  };
}

export type UpsertCacheInput = {
  client: SupabaseClient;
  creatorId: string;
  corpusVersion: number;
  queryVec: readonly number[];
  /** Rewritten query text — NOT the raw utterance. See header. */
  rewrittenText: string;
  parentUnitIds: readonly string[];
  scores: readonly number[];
  ttlSeconds?: number;
};

/**
 * Upsert a cache row. Validates inputs client-side first so we can give
 * the caller a typed reason — the DB RPC returns NULL for any rejection
 * (stale corpus, malformed input, etc.) and we can't distinguish at the
 * SQL boundary.
 *
 * Returns ok:true with rowId on success; ok:false with typed reason on
 * any rejection. Never throws.
 */
export async function upsertCache(input: UpsertCacheInput): Promise<CacheUpsertResult> {
  // Client-side pre-flight. Mirrors the DB CHECK / RPC validation so we
  // can attribute rejection reasons accurately (Day-9 audit M3).
  if (!input.creatorId) {
    return { ok: false, reason: 'invalid_creator_id' };
  }
  if (!Number.isInteger(input.corpusVersion) || input.corpusVersion < 1) {
    return { ok: false, reason: 'malformed_input' };
  }
  if (!Array.isArray(input.queryVec) || input.queryVec.length !== HALFVEC_DIM) {
    return { ok: false, reason: 'malformed_input' };
  }

  const parentIds = input.parentUnitIds ?? [];
  const scores = input.scores ?? [];
  if (parentIds.length === 0 || scores.length === 0) {
    return { ok: false, reason: 'empty_arrays' };
  }
  if (parentIds.length !== scores.length) {
    return { ok: false, reason: 'array_length_mismatch' };
  }
  if (parentIds.length > CACHE_MAX_PARENT_IDS) {
    // Surface upstream — silent truncation past DB CHECK means a
    // retrieval-pipeline bug (Day-9 audit Small finding).
    return { ok: false, reason: 'array_too_long' };
  }

  const hash = hashQueryText(input.rewrittenText);
  const ttl = input.ttlSeconds ?? CACHE_DEFAULT_TTL_SECONDS;

  // Day-8/9/10 cross-cutting audit C3: catch VectorEncodingError so the
  // promised "never throw" contract holds. Map to typed reason.
  let pgVec: string;
  try {
    pgVec = vectorToPgText(input.queryVec);
  } catch (e) {
    if (e instanceof VectorEncodingError) {
      return { ok: false, reason: 'vector_encoding_failed', detail: e.message };
    }
    throw e;
  }

  const { data, error } = await input.client.rpc('semantic_query_cache_upsert', {
    p_creator_id: input.creatorId,
    p_corpus_version: input.corpusVersion,
    p_query_vec: pgVec,
    p_query_text_hash: hash,
    p_parent_unit_ids: [...parentIds],
    p_scores: [...scores],
    p_ttl_seconds: ttl,
  });

  if (error) {
    return { ok: false, reason: 'db_error', detail: error.message };
  }

  // RPC returns uuid scalar (or NULL on stale corpus / RPC-side validation).
  // supabase-js scalar-returning RPCs land the value directly in `data`.
  if (data == null) {
    return { ok: false, reason: 'stale_corpus' };
  }

  return { ok: true, rowId: data as string };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return CACHE_DEFAULT_THRESHOLD;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

export class SemanticCacheError extends Error {
  constructor(
    public readonly code: 'lookup_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SemanticCacheError';
  }
}
