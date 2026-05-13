// POST /api/admin/corpus-compare — admin runs a side-by-side cosine-top-K
// comparison against a creator's v1 (legacy 300-token windows) and v2
// (narrative + contextual) chunks for a given query text.
//
// Day-7 RAG-SOTA build (docs/_planning/RAG_SOTA_PLAN.md §5 step 4 + §11.Day7).
//
// Flow:
//   1. assertAdminFromSession
//   2. Same-origin + JSON content-type (mutation-free but writes nothing,
//      so origin check is for defense-in-depth, not CSRF)
//   3. Validate body: creator_id (uuid), query_text (1..2000 chars)
//   4. Embed query via Gemini RETRIEVAL_QUERY task type
//   5. Call _admin_compare_v1_v2_retrieval_unsafe with the query vector
//   6. Return parallel v1 + v2 result rows
//
// Cost: 1 embed call per query (~250 tokens, $0.00004). Negligible. The
// route does not enforce budget — admin tooling is rate-limited by human
// throughput.

import 'server-only';
import { type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { assertAdminFromSession, AuthGuardError } from '@/lib/auth-guards';
import { isSameOrigin, json, mapAuthGuardStatus } from '@/lib/session/http-helpers';
import { embedTexts, EmbedError, EMBEDDING_DIM, EMBEDDING_MODEL, EMBEDDING_USD_PER_TOKEN, vectorToPgText } from '@/lib/voice/embed';

type RejectReason = 'creator_not_found' | 'not_an_active_admin';
const COMPARE_REJECT_ACTION: Record<RejectReason, string> = {
  creator_not_found:   'creator_corpus_compare_rejected_creator_not_found',
  not_an_active_admin: 'creator_corpus_compare_rejected_not_an_active_admin',
};

async function writeCompareRejectionAudit(
  sb: ReturnType<typeof supabaseAdmin>,
  adminUserId: string,
  creatorId: string | null,
  reason: RejectReason,
  queryChars: number,
): Promise<void> {
  const { error } = await sb.from('admin_audit_log').insert({
    admin_user_id: adminUserId,
    action:        COMPARE_REJECT_ACTION[reason],
    target_kind:   'creator',
    target_id:     creatorId,
    before:        { requested_creator_id: creatorId, query_chars: queryChars },
    after:         { reason },
  });
  if (error) {
    Sentry.captureException(error, {
      extra: { op: 'audit_write_compare_rejection', reason, creator_id: creatorId, admin_user_id: adminUserId },
    });
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUERY_CHARS = 2000;

// Audit-3 M6: K-clamp single source of truth. Mirror in
// supabase/migrations/20260519000001_admin_compare_and_promote_v2.sql
// (`LEAST(GREATEST(COALESCE(p_k, 5), 1), 20)`). If you change either,
// change the other.
export const COMPARE_K_MIN     = 1;
export const COMPARE_K_DEFAULT = 5;
export const COMPARE_K_MAX     = 20;

type Body = { creator_id?: unknown; query_text?: unknown; k?: unknown };

type CompareRow = {
  chunker_version: number;
  chunk_id:        string;
  sample_id:       string;
  sample_title:    string | null;
  chunk_context:   string | null;
  text:            string;
  similarity:      number;
};

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json(403, { error: 'bad_origin' });
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().startsWith('application/json')) {
    return json(415, { error: 'bad_content_type' });
  }

  let admin: { userId: string };
  try {
    admin = await assertAdminFromSession();
  } catch (e) {
    if (e instanceof AuthGuardError) {
      const { status, body } = mapAuthGuardStatus(e.status);
      return json(status, body);
    }
    throw e;
  }
  Sentry.setUser({ id: admin.userId });

  let body: Body;
  try { body = (await req.json()) as Body; }
  catch { return json(400, { error: 'bad_json' }); }

  const creatorId = typeof body.creator_id === 'string' && UUID_RE.test(body.creator_id)
    ? body.creator_id : null;
  if (!creatorId) return json(400, { error: 'bad_creator_id' });

  const queryText = typeof body.query_text === 'string' ? body.query_text.trim() : '';
  if (queryText.length === 0) return json(400, { error: 'empty_query' });
  if (queryText.length > MAX_QUERY_CHARS) return json(400, { error: 'query_too_long' });

  // K clamp matches the DB-side clamp (see COMPARE_K_MIN/MAX constants and
  // the LEAST/GREATEST in the migration).
  const kRaw = typeof body.k === 'number' ? body.k : COMPARE_K_DEFAULT;
  const requestedK = kRaw;
  const k = Number.isFinite(kRaw)
    ? Math.min(Math.max(Math.floor(kRaw), COMPARE_K_MIN), COMPARE_K_MAX)
    : COMPARE_K_DEFAULT;

  // Embed the query.
  let queryVec: number[];
  let embedTokens = 0;
  let embedMs = 0;
  try {
    const r = await embedTexts({ texts: [queryText], taskType: 'RETRIEVAL_QUERY' });
    if (!r.vectors[0] || r.vectors[0].length !== EMBEDDING_DIM) {
      throw new EmbedError('dim_mismatch', `got ${r.vectors[0]?.length ?? 0}, expected ${EMBEDDING_DIM}`);
    }
    queryVec = r.vectors[0];
    embedTokens = r.tokens;
    embedMs = r.ms;
  } catch (e) {
    if (e instanceof EmbedError) {
      const code = e.code;
      if (code === 'api_key_missing') {
        // Misconfigured server — admin tool can't do its job. Sentry-fatal.
        Sentry.captureException(e, {
          level: 'fatal',
          extra: { op: 'admin_corpus_compare_embed', admin_user_id: admin.userId },
        });
        return json(500, { error: 'misconfigured' });
      }
      return json(500, { error: `embed_${code}` });
    }
    Sentry.captureException(e, {
      extra: { op: 'admin_corpus_compare_embed', admin_user_id: admin.userId },
    });
    return json(500, { error: 'embed_failed' });
  }

  const sb = supabaseAdmin();
  // Audit-2 C2: pass halfvec(768) as pgvector text literal '[v1,v2,...]'.
  // PostgREST JSON-serializes raw arrays as a JSON array which won't bind
  // to halfvec — mirrors retrieve-knowledge.ts:93.
  const { data, error } = await sb.rpc('_admin_compare_v1_v2_retrieval_unsafe', {
    p_admin_user_id: admin.userId,
    p_creator_id:    creatorId,
    p_query_vec:     vectorToPgText(queryVec),
    p_k:             k,
  });

  // Audit-2 C1: cogs_log row for the embed call (CLAUDE.md hard rule —
  // every paid API call writes cogs_log). Fire-and-forget; a cogs write
  // failure must not abort the compare response. Mirrors retrieve-knowledge.ts.
  void sb
    .from('cogs_log')
    .insert({
      user_id:    admin.userId,
      session_id: null,
      service:    'gemini',
      operation:  'embedding',
      units:      embedTokens,
      unit_label: 'tokens',
      cost_usd:   Number((embedTokens * EMBEDDING_USD_PER_TOKEN).toFixed(6)),
      metadata: {
        // Audit-3 M1: tag so the user-kill-switch / per-user-budget MV
        // can filter admin tooling spend out of user-quota math.
        is_admin_tool: true,
        op:            'admin_corpus_compare',
        model:         EMBEDDING_MODEL,
        creator_id:    creatorId,
        query_chars:   queryText.length,
        k,
        embed_ms:      embedMs,
      },
    })
    .then(({ error: cogsErr }) => {
      if (cogsErr) {
        // eslint-disable-next-line no-console
        console.warn('[corpus-compare] cogs_log insert failed:', cogsErr.message);
      }
    });

  if (error) {
    const msg = (error.message ?? '').toLowerCase();
    if (error.code === '42501' || msg.includes('not_an_active_admin')) {
      // Audit-3 M2: compare rejection-audit row (admin-revoked attempt).
      await writeCompareRejectionAudit(sb, admin.userId, creatorId, 'not_an_active_admin', queryText.length);
      return json(403, { error: 'forbidden' });
    }
    if (error.code === '42704' || msg.includes('creator_not_found')) {
      // Audit-3 M2: probe trail for stale/typo'd creator_id lookups.
      await writeCompareRejectionAudit(sb, admin.userId, creatorId, 'creator_not_found', queryText.length);
      return json(404, { error: 'creator_not_found' });
    }
    if (error.code === '22023') {
      return json(400, { error: 'invalid_argument' });
    }
    Sentry.captureException(error, {
      extra: { op: 'admin_corpus_compare_rpc', creator_id: creatorId, admin_user_id: admin.userId },
    });
    return json(500, { error: 'compare_failed' });
  }

  const rows = (data ?? []) as CompareRow[];
  const v1 = rows.filter((r) => r.chunker_version === 1);
  const v2 = rows.filter((r) => r.chunker_version === 2);

  return json(200, {
    ok: true,
    creator_id: creatorId,
    query_text: queryText,
    requested_k: requestedK,
    applied_k:   k,
    k,                              // back-compat (= applied_k); will deprecate.
    v1,
    v2,
    counts: { v1: v1.length, v2: v2.length },
  });
}
