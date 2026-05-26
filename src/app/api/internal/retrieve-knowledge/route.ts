// /api/internal/retrieve-knowledge — Day-13 HTTP shim.
//
// Wraps src/lib/voice/retrieve-knowledge.ts retrieveKnowledgeV2 for the
// Fly voice-proxy. The proxy POSTs once per user turn, gets back parents
// + telemetry, and the orchestrator stays out of the Fly process.
//
// Rationale for Option A (HTTP shim) over Option B (proxy duplicates TS):
//   * The TS orchestrator imports 'server-only' + supabase-js + Voyage SDK
//     + Gemini SDK. Putting all of that in a Fly worker means duplicating
//     200+ lines and re-implementing every audit fix. Sync drift is a
//     when-not-if (2026-05-09 .ts import bug recurrence risk).
//   * Vercel adds ~50ms RTT vs the 4000ms turn budget — negligible.
//   * Future provider swaps (Cohere fallback, embedder upgrade) ship via
//     Vercel deploy without touching Fly.
//
// AUTH MODEL (Day-13 audit C2):
//   This route is publicly addressable on Vercel. Plain Bearer auth is
//   insufficient because:
//     * Body claims user_id → side-effect on budget counter + cogs_log
//     * Body claims session_id → cross-tenant retrieval-pwnage
//     * No nonce → replay-attackable
//   Defense:
//     1. HMAC over (method|path|timestamp|body-sha256) with ±60s skew
//     2. Body user_id + creator_id are RECHECKED against sessions.id
//        ownership BEFORE calling the orchestrator
//     3. Single-shot: proxy MUST NOT retry on 5xx (audit M3) — a retry
//        re-increments the budget counter
//   The shim does NOT yet implement a seen-nonce store. 60s replay
//   window is acceptable for dogfood scale; revisit at 1000+ DAU.
//
// CLOCK CONTRACT (Day-13 audit C4):
//   Proxy sends `budget_ms` (RELATIVE duration), NOT `deadline_ms`
//   (absolute epoch). The shim computes `deadlineMs = Date.now() +
//   clamp(budget_ms, 1000, 8000)` ON THE VERCEL SIDE so any Fly↔Vercel
//   clock skew is irrelevant. Sending an absolute epoch across DCs was
//   the prior plan; rejected because Vercel leading Fly by >300ms would
//   trigger spurious deadline_exceeded on legitimate turns.
//
// SESSION OWNERSHIP RE-DERIVATION (Day-13 audit M5):
//   Body's user_id + creator_id are inputs but NOT trusted. Shim runs
//   SELECT user_id, creator_id FROM sessions WHERE id = body.session_id
//   and rejects 403 if either mismatches. This means a leaked secret
//   still cannot impersonate user A while reading creator B's parents —
//   the attacker would need a real session_id whose (user, creator)
//   tuple matches what they claim, and budget/cogs_log get attributed
//   correctly regardless of what they claimed.
//
// CONNECTION REUSE (Day-13 audit C3):
//   supabaseAdmin() memoizes a module-scope client. On warm Vercel
//   instances, the same client reuses pgbouncer pool slots across
//   invocations. Cold-start re-creates once; steady-state is reused.
//
// REVALIDATEPATH:
//   No UI surfaces depend on retrieval output. Do NOT add revalidatePath
//   on this hot path; the 80ms Next-side flush cost is the worst kind
//   of regression to chase later. (Day-13 audit S11.)

import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  retrieveKnowledgeV2,
  RetrieveKnowledgeV2Error,
} from '@/lib/voice/retrieve-knowledge';
import { toPostHogEventBatch } from '@/lib/voice/rag-telemetry';
import { verifyRequest, INTERNAL_SECRET_MIN_LENGTH } from '@/lib/voice/internal-request-signature';

export const runtime = 'nodejs';
export const maxDuration = 30;

// ── Request schema ────────────────────────────────────────────────────────

const RequestSchema = z.object({
  user_id: z.string().uuid(),
  creator_id: z.string().uuid(),
  // session_id is REQUIRED — the shim uses it for ownership re-derivation.
  // A null session_id would skip the check, defeating audit M5.
  session_id: z.string().uuid(),
  raw_utterance: z.string().min(1).max(8000),
  // last_assistant_response: nullable on first turn / post-resumption.
  // Cap matches VOICE_SESSION_STATE_MAX_CHARS (4000) — proxy must
  // pre-truncate; shim rejects oversize as a defense-in-depth signal of
  // bad-actor / drifted client.
  last_assistant_response: z.string().max(4000).nullable(),
  corpus_version_at_session: z.number().int().positive(),
  // RELATIVE duration in ms (Day-13 audit C4). Clamped server-side to
  // [1000, 8000] — below 1s no leg of the pipeline can complete; above
  // 8s violates the Vercel function maxDuration headroom.
  budget_ms: z.number().int().positive(),
  top_k: z.number().int().min(1).max(20).optional(),
});

const BUDGET_MS_MIN = 1000;
const BUDGET_MS_MAX = 8000;

// ── Handler ───────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  Sentry.setTag('route', 'retrieve-knowledge');
  Sentry.setTag('request_id', requestId);

  // Auth FIRST. Fail-closed if env missing.
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret || secret.length < INTERNAL_SECRET_MIN_LENGTH) {
    console.error(
      '[retrieve-knowledge]', requestId,
      `INTERNAL_API_SECRET missing or too short (>= ${INTERNAL_SECRET_MIN_LENGTH} chars required)`,
    );
    Sentry.captureException(new Error('INTERNAL_API_SECRET misconfigured'), {
      level: 'fatal',
      tags: { request_id: requestId, stage: 'auth_env' },
    });
    return jsonError('misconfigured', 500, requestId, { retryable: false });
  }

  // Read raw body BEFORE JSON.parse — signature is over the exact bytes.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return jsonError('invalid_body', 400, requestId, { retryable: false });
  }

  const verify = verifyRequest({
    secret,
    method: 'POST',
    path: '/api/internal/retrieve-knowledge',
    rawBody,
    headers: {
      authorization: req.headers.get('authorization'),
      'x-internal-timestamp': req.headers.get('x-internal-timestamp'),
      'x-internal-body-sha256': req.headers.get('x-internal-body-sha256'),
    },
  });
  if (!verify.ok) {
    // 401 for ALL failure modes. Reason is logged server-side only —
    // returning it leaks an oracle to attackers.
    console.warn(
      '[retrieve-knowledge]', requestId,
      'signature verification failed:', verify.reason,
    );
    return jsonError('unauthorized', 401, requestId, { retryable: false });
  }

  // Body parse + validate.
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonError('invalid_json', 400, requestId, { retryable: false });
  }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError('invalid_body', 400, requestId, {
      retryable: false,
      details: parsed.error.issues.slice(0, 5),
    });
  }

  const admin = supabaseAdmin();

  // Day-13 audit M5 + audit-build C3: re-derive user_id + creator_id +
  // corpus_version_at_session from sessions.id. Body's claims are NOT
  // trusted; they become a check, not an input. Without this, a leaked
  // HMAC (or a buggy proxy with stale closure) could poison the
  // semantic_query_cache by passing a corpus_version that doesn't match
  // the session's snapshot.
  const { data: sess, error: sessErr } = await admin
    .from('sessions')
    .select(
      'user_id, creator_id, corpus_version_at_session, retrieval_version_at_session, ended_at',
    )
    .eq('id', parsed.data.session_id)
    .maybeSingle();
  if (sessErr) {
    console.error('[retrieve-knowledge]', requestId, 'sessions read failed:', sessErr.message);
    Sentry.captureException(sessErr, {
      level: 'error',
      tags: { request_id: requestId, stage: 'session_ownership' },
    });
    return jsonError('upstream_error', 500, requestId, { retryable: true });
  }
  // Day-13 audit-build M5: collapse all session-validation failures into
  // one opaque `forbidden` response. The discriminated codes (not_found
  // vs user_mismatch vs creator_mismatch vs ended vs wrong_version)
  // formed an existence/ownership/lifecycle oracle for any actor with
  // a valid HMAC. Log the reason server-side; never leak it to the wire.
  //
  // Same pattern the HMAC verify already uses (line 138-146).
  let denyReason: string | null = null;
  if (!sess) denyReason = 'session_not_found';
  else if (sess.user_id !== parsed.data.user_id) denyReason = 'session_user_mismatch';
  else if (sess.creator_id !== parsed.data.creator_id) denyReason = 'session_creator_mismatch';
  else if (sess.ended_at !== null) denyReason = 'session_ended';
  else if (sess.retrieval_version_at_session !== 2) denyReason = 'wrong_retrieval_version';
  if (denyReason !== null) {
    console.warn('[retrieve-knowledge]', requestId, `forbidden: ${denyReason}`);
    return jsonError('forbidden', 403, requestId, { retryable: false });
  }

  Sentry.setTag('user_id', parsed.data.user_id);
  Sentry.setTag('creator_id', parsed.data.creator_id);
  Sentry.setTag('session_id', parsed.data.session_id);

  // Clock contract (audit C4): budget_ms is RELATIVE; compute deadlineMs
  // on the Vercel side so Fly↔Vercel clock skew is irrelevant.
  const budgetMs = Math.max(BUDGET_MS_MIN, Math.min(parsed.data.budget_ms, BUDGET_MS_MAX));
  const deadlineMs = Date.now() + budgetMs;

  const geminiApiKey = process.env.GEMINI_API_KEY;
  const voyageApiKey = process.env.VOYAGE_API_KEY;
  if (!geminiApiKey || !voyageApiKey) {
    console.error(
      '[retrieve-knowledge]', requestId,
      `provider keys missing: gemini=${!!geminiApiKey} voyage=${!!voyageApiKey}`,
    );
    Sentry.captureException(new Error('provider_keys_misconfigured'), {
      level: 'fatal',
      tags: { request_id: requestId, stage: 'provider_keys' },
    });
    return jsonError('misconfigured', 500, requestId, { retryable: false });
  }

  // Day-13 audit-build C3: corpus_version_at_session comes from the
  // sessions snapshot, NOT from the body. The body's value is ignored
  // (kept in the schema for shape symmetry + future evolution, but the
  // snapshot wins). Cache key = (creator, snapshot_version, query_hash);
  // a stale body claim would otherwise poison the semantic_query_cache.
  const snapshotCorpusVersion = Number(
    (sess && sess.corpus_version_at_session) ?? 1,
  );

  try {
    const result = await retrieveKnowledgeV2({
      supabaseAdmin: admin,
      userId: parsed.data.user_id,
      creatorId: parsed.data.creator_id,
      sessionId: parsed.data.session_id,
      rawUtterance: parsed.data.raw_utterance,
      lastAssistantResponse: parsed.data.last_assistant_response,
      corpusVersionAtSession: snapshotCorpusVersion,
      deadlineMs,
      geminiApiKey,
      voyageApiKey,
      topK: parsed.data.top_k,
    });

    // Day-13 audit S3 — snake_case in JSON, camelCase in TS internals.
    // RetrievedParent.parentUnitId → parent_unit_id, etc.
    //
    // posthog_events: the shim pre-maps telemetry → event batch so the
    // Fly proxy doesn't have to port toPostHogEventBatch's switch tables.
    // Cross-cutting C4 disposition note: orchestrator stays transport-
    // agnostic; the route (with TS access to the canonical mapper) emits
    // the events, the proxy just relays to PostHog HTTP.
    const posthogEvents = toPostHogEventBatch(result.telemetry);
    return NextResponse.json(
      {
        parents: result.parents.map((p) => ({
          parent_unit_id: p.parentUnitId,
          text: p.text,
          title: p.title,
          source_type: p.sourceType,
          score: p.score,
          score_source: p.scoreSource,
        })),
        telemetry: result.telemetry,
        budget_exceeded: result.budgetExceeded,
        rewrite_fallback: result.rewriteFallback,
        posthog_events: posthogEvents,
        request_id: requestId,
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    if (e instanceof RetrieveKnowledgeV2Error) {
      // Map orchestrator's taxonomy to HTTP. 504 for deadline_exceeded
      // (rare but possible if budget_ms was too tight); 400 for empty
      // utterance / invalid corpus version; 500 otherwise.
      const isDeadline = /deadline_exceeded/i.test(e.message);
      if (e.code === 'empty_utterance' || e.code === 'invalid_corpus_version') {
        // Day-13 audit-build M6: `empty_utterance` 400 in prod means
        // the proxy's `shortUtterance` filter and the shim's empty-check
        // disagree — the proxy thought retrieval would happen, the shim
        // refused, the user gets persona-only with no PostHog signal.
        // Capture as a warning so it surfaces in metrics; the proxy
        // turn-lifecycle treats this as `parents: []`.
        if (e.code === 'empty_utterance') {
          Sentry.captureMessage('rag_proxy_filter_disagreement', {
            level: 'warning',
            tags: {
              request_id: requestId,
              user_id: parsed.data.user_id,
              creator_id: parsed.data.creator_id,
              raw_utterance_len: String(parsed.data.raw_utterance.length),
            },
          });
        }
        return jsonError(e.code, 400, requestId, {
          retryable: false,
          message: e.message,
        });
      }
      if (isDeadline) {
        return jsonError(e.code, 504, requestId, {
          retryable: false, // Day-13 audit M3: proxy MUST NOT retry — budget already incremented.
          message: e.message,
        });
      }
      // embed_failed, rpc_failed, budget_check_failed → 500
      Sentry.captureException(e, {
        level: 'warning',
        tags: { request_id: requestId, stage: 'orchestrator', code: e.code },
      });
      return jsonError(e.code, 500, requestId, {
        retryable: false,
        message: e.message,
      });
    }
    console.error('[retrieve-knowledge]', requestId, 'unexpected error:', e);
    Sentry.captureException(e, {
      level: 'error',
      tags: { request_id: requestId, stage: 'unknown' },
    });
    return jsonError('internal_error', 500, requestId, { retryable: false });
  }
}

// ── Response helpers ──────────────────────────────────────────────────────

function jsonError(
  error: string,
  status: number,
  requestId: string,
  extras: Record<string, unknown> & { retryable: boolean },
): NextResponse {
  return NextResponse.json(
    { error, request_id: requestId, ...extras },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}
